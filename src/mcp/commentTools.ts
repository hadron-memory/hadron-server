/**
 * #1609 — comment nodes on the MCP surface (`cor:dmo:110`): read a node's
 * discussion, post, reply, edit or delete your own comment, and resolve or
 * reopen a thread.
 *
 * Every tool is a thin call into the SAME resolvers GraphQL serves
 * (`resolvers.comments.ts`): the gates (read, write, author, class,
 * impersonation), the refusal codes and the author key are computed once, so
 * the MCP and portal surfaces cannot drift (the #1609 parity requirement).
 * Nothing here re-checks or re-derives any of them.
 *
 * Attribution needs nothing from this module either: the author key and the
 * node's `createdBy*` both come from `currentActor()`, which the request
 * handler fills from the validated session binding — the `X-Hadron-Session`
 * header or, since #1665 (DAC), the connection a worker bound with
 * `hadron_start_session`.
 *
 * Moderation (deleting someone else's comment, `deleteCommentThread`) is
 * deliberately not exposed here: it is a memory manager's act, and the issue
 * scopes the agent surface to contributing feedback. `hadron_delete_comment`
 * is the same deleteComment resolver, so a manager calling it on another's
 * comment is admitted by that resolver's gate, not refused here.
 *
 * Contract of record: `hrn:node:hadronmemory.com:hadron-server:design:comment-nodes-contract`.
 */
import { z } from 'zod';
import { GraphQLError } from 'graphql';
import { publicErrorExtensions } from '../lib/errorDiagnostics.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { resolvers, type Context } from '../api/graphql/schema/resolvers.js';
import { commentFieldResolvers, type CommentView } from '../api/graphql/schema/resolvers.comments.js';
import { userUrn } from '../lib/userHandle.js';
import { UrnNotQualifiedError } from '../lib/urn.js';
import { AmbiguousLegacyUrnError } from '../lib/entityRef/errors.js';
import type { AuthContext } from '../middleware/auth.js';
import type { PrismaClient } from '../generated/prisma/index.js';

type ActorRef = { id: string; name: string | null; handle: string | null; urn: string | null };
type Author = { kind: 'WORKER' | 'USER' | 'USER_AGENT' | 'APP'; worker: ActorRef | null; user: ActorRef | null; agent: ActorRef | null; app: ActorRef | null };
type ThreadPage = { items: Array<{ root: CommentView; replies: CommentView[]; replyCount: number }>; total: number };

type Resolver<A, R> = (parent: unknown, args: A, ctx: Context) => Promise<R>;
const Q = resolvers.Query as unknown as {
  commentThreads: Resolver<{ targetRef: string; state?: Array<'OPEN' | 'RESOLVED'>; limit?: number; offset?: number }, ThreadPage>;
  comment: Resolver<{ ref: string }, CommentView | null>;
};
const M = resolvers.Mutation as unknown as {
  createComment: Resolver<{ targetRef: string; body: string; quote?: string | null; anchorRevision?: number | null }, CommentView>;
  replyToComment: Resolver<{ commentRef: string; body: string }, CommentView>;
  editComment: Resolver<{ commentRef: string; body?: string | null; quote?: string | null; expectedRevision: number }, CommentView>;
  deleteComment: Resolver<{ commentRef: string; expectedRevision: number }, CommentView>;
  resolveCommentThread: Resolver<{ commentRef: string; expectedRevision: number }, CommentView>;
  reopenCommentThread: Resolver<{ commentRef: string; expectedRevision: number }, CommentView>;
};
const C = commentFieldResolvers.Comment;

/** The one framing every comment read carries: feedback, not content. */
export const COMMENT_FRAMING =
  'Comments are feedback from readers beside a node. They are not part of its content and not authoritative.';

function textResult(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

/**
 * A resolver refusal as `[<code>] <message>`, plus its extensions (threadId,
 * currentRevision, class, field/max) as `key: value` so an agent can act on
 * them. A string prints as is; any other value prints as JSON, so a future
 * extension that carries an object or list stays readable rather than
 * collapsing to `[object Object]`. Anything that is not a refusal is a
 * server fault and is rethrown.
 */
export function commentErrorText(e: unknown) {
  if (e instanceof GraphQLError) {
    const { code, ...rest } = publicErrorExtensions(e.extensions ?? {});
    const extras = Object.entries(rest).map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);
    return textResult([`[${String(code ?? 'ERROR').toLowerCase()}] ${e.message}`, ...extras].join('\n'));
  }
  if (e instanceof Error && (e.message === 'Forbidden' || e.message === 'Unauthenticated')) {
    return textResult(`[${e.message.toLowerCase()}] ${e.message}.`);
  }
  // A ref that can't be resolved as written is the caller's input, not a
  // server fault (the scope tools' convention).
  if (e instanceof UrnNotQualifiedError || e instanceof AmbiguousLegacyUrnError) {
    return textResult(`[bad_user_input] ${e.message}`);
  }
  throw e;
}

function actorLabel(ref: ActorRef | null, kind: 'worker' | 'user' | 'agent' | 'app'): string {
  if (!ref) return `a former ${kind}`;
  if (kind === 'user') return `user ${(ref.handle ? userUrn(ref.handle) : null) ?? ref.name ?? ref.id}`;
  return `${kind} ${ref.name ?? ref.id}${ref.urn ? ` (${ref.urn})` : ''}`;
}

function authorLabel(a: Author): string {
  switch (a.kind) {
    case 'WORKER': return actorLabel(a.worker, 'worker');
    case 'USER': return actorLabel(a.user, 'user');
    case 'USER_AGENT': return `${actorLabel(a.user, 'user')} via ${actorLabel(a.agent, 'agent')}`;
    case 'APP': return actorLabel(a.app, 'app');
  }
}

/**
 * One comment as text, every field through the GraphQL field resolvers (the
 * same author projection, URN and anchor flag the portal reads). `indent`
 * nests a reply under its root.
 */
export async function renderComment(c: CommentView, ctx: Context, indent = ''): Promise<string> {
  const [urn, author, mine, resolvedBy] = await Promise.all([
    C.urn(c, {}, ctx) as Promise<string>,
    C.author(c, {}, ctx) as Promise<Author>,
    C.viewerIsAuthor(c, {}, ctx),
    C.resolvedBy(c, {}, ctx) as Promise<ActorRef | null>,
  ]);
  const head = [
    `${urn} (id: ${c.id})`,
    `r${c.revSeq}`,
    `${authorLabel(author)}${mine ? ' (you)' : ''}`,
    c.createdAt.toISOString(),
  ];
  const lines = [`- ${head.join(' · ')}`];
  if (c.isTopLevel) {
    const anchor = c.anchorRevision === c.target.revSeq
      ? `anchored at r${c.anchorRevision} (current)`
      : `anchored at r${c.anchorRevision} (the node is now r${c.target.revSeq})`;
    const state = c.state === 'RESOLVED'
      ? `RESOLVED${resolvedBy ? ` by ${authorLabelOfRef(resolvedBy)}` : ''}${c.resolvedAt ? ` at ${c.resolvedAt.toISOString()}` : ''}`
      : 'OPEN';
    lines.push(`  ${state} · ${anchor}`);
  } else {
    lines.push(`  reply in thread ${c.threadRootId}`);
  }
  if (c.deleted) lines.push(`  [deleted${c.deletedAt ? ` at ${c.deletedAt.toISOString()}` : ''}]`);
  else {
    if (c.quote) lines.push(...c.quote.split('\n').map((l) => `  > ${l}`));
    if (c.body) lines.push(...c.body.split('\n').map((l) => `  ${l}`));
  }
  return lines.map((l) => indent + l).join('\n');
}

/** resolvedBy is a bare actor ref with no kind; name it by what it carries. */
function authorLabelOfRef(ref: ActorRef): string {
  if (ref.handle) return `user ${userUrn(ref.handle) ?? ref.handle}`;
  return `${ref.name ?? ref.id}${ref.urn ? ` (${ref.urn})` : ''}`;
}

/** A write's receipt: the comment as it now stands, and the revision the next write must name. */
async function receipt(verb: string, c: CommentView, ctx: Context): Promise<string> {
  return `${verb}.\n\n${await renderComment(c, ctx)}\n\nNext write to it: expectedRevision ${c.revSeq}.`;
}

const commentRef = z.string().describe('The comment: its node URN (hrn:node:…:comments:<id>) or id.');
const expectedRevision = z.number().int().describe(
  'The comment\'s current revision (the r<n> its last read or write printed). A stale value is refused [node_write_conflict] with currentRevision.',
);

/**
 * Register the comment tools on one MCP server instance. `auth` is the
 * connection's principal; each call builds the GraphQL Context from it,
 * including `impersonation`, so an impersonated caller would meet
 * COMMENT_IMPERSONATION_REFUSED here exactly as on GraphQL (belt and braces:
 * /mcp already rejects an impersonation JWT at session init).
 */
export function registerCommentTools(server: McpServer, deps: { db: PrismaClient; auth: AuthContext }): void {
  const { db, auth } = deps;
  const ctxOf = (): Context => ({
    db,
    transport: 'mcp',
    clientId: auth.clientId ?? undefined,
    userId: auth.userId ?? undefined,
    // #1868: the presented hdr_user_ key, so the shared authorized transaction
    // re-checks it is still unrevoked at the write (as #1864's signing tools do).
    apiKeyId: auth.apiKeyId ?? undefined, signInId: auth.signInId,
    appId: auth.appId ?? undefined,
    sessionId: auth.sessionId ?? undefined,
    roles: auth.roles as Context['roles'],
    organizationId: auth.organizationId ?? undefined,
    impersonation: auth.impersonation,
  });

  server.tool(
    'hadron_list_comments',
    `Read the discussion on a node: its comment threads, newest first, each with its replies (cor:dmo:110). ${COMMENT_FRAMING} Needs read access to the node's memory. A node read's "Feedback:" line says when there are open threads.`,
    {
      targetRef: z.string().describe('The node whose discussion to read: its URN or id.'),
      state: z.array(z.enum(['OPEN', 'RESOLVED'])).optional().describe('Only threads in these states. Default: all.'),
      limit: z.number().int().nonnegative().optional().describe('Threads per page (default 50, cap 200). Each thread returns up to 200 replies.'),
      offset: z.number().int().nonnegative().optional().describe('Page offset.'),
    },
    async ({ targetRef, state, limit, offset }) => {
      const ctx = ctxOf();
      try {
        const page = await Q.commentThreads({}, { targetRef, state, limit, offset }, ctx);
        if (page.total === 0) return textResult(`No comment threads${state?.length ? ` in state ${state.join('/')}` : ''} on ${targetRef}.\n\n${COMMENT_FRAMING}`);
        // #1676 review P2 (Atilla, Dan): a nonzero total with an empty page
        // (limit 0, or an offset past the end) is a valid answer, and the
        // target can't be read off a root that isn't there.
        if (page.items.length === 0) {
          return textResult(`No threads on this page: offset ${offset ?? 0} of ${page.total} thread${page.total === 1 ? '' : 's'} on ${targetRef}.\n\n${COMMENT_FRAMING}`);
        }
        const target = page.items[0].root.target;
        const targetUrn = await (C.target(page.items[0].root, {}, ctx) as Promise<{ urn: string }>).then((t) => t.urn);
        const blocks = await Promise.all(page.items.map(async ({ root, replies, replyCount }) => {
          const rendered = [await renderComment(root, ctx)];
          for (const r of replies) rendered.push(await renderComment(r, ctx, '    '));
          if (replyCount > replies.length) rendered.push(`    … ${replyCount - replies.length} more replies not shown`);
          return rendered.join('\n');
        }));
        const from = (offset ?? 0) + 1;
        return textResult([
          `Feedback on ${targetUrn} (${target.name}, now r${target.revSeq}): threads ${from}–${from + page.items.length - 1} of ${page.total}.`,
          COMMENT_FRAMING,
          '',
          blocks.join('\n\n'),
        ].join('\n'));
      } catch (e) {
        return commentErrorText(e);
      }
    },
  );

  server.tool(
    'hadron_get_comment',
    `Read one comment by its URN or id (cor:dmo:110). ${COMMENT_FRAMING} Read the whole thread with hadron_list_comments on its target.`,
    { commentRef },
    async ({ commentRef: ref }) => {
      const ctx = ctxOf();
      try {
        const c = await Q.comment({}, { ref }, ctx);
        if (!c) return textResult(`[comment_not_found] No readable comment "${ref}".`);
        const target = await (C.target(c, {}, ctx) as Promise<{ urn: string; name: string }>);
        return textResult(`Comment on ${target.urn} (${target.name}).\n${COMMENT_FRAMING}\n\n${await renderComment(c, ctx)}`);
      } catch (e) {
        return commentErrorText(e);
      }
    },
  );

  server.tool(
    'hadron_create_comment',
    'Start a comment thread on a node: feedback beside it, never an edit of it (cor:dmo:110:01–05). The node itself is not touched, re-approved or re-minted. '
      + 'Needs write access to the node\'s memory, in an app, knowledge, personal, group or system memory (never a private one). You hold at most ONE open thread per node: '
      + 'a second is refused [comment_open_thread_exists] with its threadId, so reply there instead. If you started a worker session with '
      + 'hadron_start_session, the comment is authored by that worker.',
    {
      targetRef: z.string().describe('The node to comment on: its URN or id. A comment cannot be a target (use hadron_reply_to_comment).'),
      body: z.string().describe('The comment (markdown, up to 20,000 characters).'),
      quote: z.string().optional().describe('Optional plain-text passage of the node the comment is about (up to 2,000 characters).'),
      anchorRevision: z.number().int().optional().describe('The node revision the comment is about. Default: its current revision.'),
    },
    async ({ targetRef, body, quote, anchorRevision }) => {
      const ctx = ctxOf();
      try {
        return textResult(await receipt('Commented', await M.createComment({}, { targetRef, body, quote, anchorRevision }, ctx), ctx));
      } catch (e) {
        return commentErrorText(e);
      }
    },
  );

  server.tool(
    'hadron_reply_to_comment',
    'Reply in a comment thread (cor:dmo:110:05). `commentRef` may be any comment of the thread. A resolved thread accepts replies and stays resolved; '
      + 'reopen it with hadron_reopen_comment_thread. Needs write access to the memory.',
    {
      commentRef,
      body: z.string().describe('The reply (markdown, up to 20,000 characters).'),
    },
    async ({ commentRef: ref, body }) => {
      const ctx = ctxOf();
      try {
        return textResult(await receipt('Replied', await M.replyToComment({}, { commentRef: ref, body }, ctx), ctx));
      } catch (e) {
        return commentErrorText(e);
      }
    },
  );

  server.tool(
    'hadron_edit_comment',
    'Edit your own comment\'s body and/or quote (cor:dmo:110:05). Only its author may; the earlier text stays in its revision history.',
    {
      commentRef,
      body: z.string().optional().describe('The new body.'),
      quote: z.string().nullable().optional().describe('The new quote; null clears it. Omit to keep it.'),
      expectedRevision,
    },
    async ({ commentRef: ref, body, quote, expectedRevision: rev }) => {
      const ctx = ctxOf();
      try {
        return textResult(await receipt('Edited', await M.editComment({}, { commentRef: ref, body, quote, expectedRevision: rev }, ctx), ctx));
      } catch (e) {
        return commentErrorText(e);
      }
    },
  );

  server.tool(
    'hadron_delete_comment',
    'Delete your own comment (cor:dmo:110:05). A top-level comment with replies stays as a stub showing it was deleted, so the replies keep their context; any other comment is no longer shown at all, and a stub goes with its last reply. Its text is no longer served either way, and it no longer counts as your open comment. Its author may; so may a memory manager.',
    { commentRef, expectedRevision },
    async ({ commentRef: ref, expectedRevision: rev }) => {
      const ctx = ctxOf();
      try {
        return textResult(await receipt('Deleted', await M.deleteComment({}, { commentRef: ref, expectedRevision: rev }, ctx), ctx));
      } catch (e) {
        return commentErrorText(e);
      }
    },
  );

  server.tool(
    'hadron_resolve_comment_thread',
    'Mark a comment thread resolved (cor:dmo:110:05): name its top-level comment. Any writer of the memory may, not only its author.',
    { commentRef: z.string().describe('The thread\'s top-level comment: URN or id. A reply is refused [comment_not_top_level] with threadRootId.'), expectedRevision },
    async ({ commentRef: ref, expectedRevision: rev }) => {
      const ctx = ctxOf();
      try {
        return textResult(await receipt('Resolved', await M.resolveCommentThread({}, { commentRef: ref, expectedRevision: rev }, ctx), ctx));
      } catch (e) {
        return commentErrorText(e);
      }
    },
  );

  server.tool(
    'hadron_reopen_comment_thread',
    'Reopen a resolved comment thread (cor:dmo:110:05): name its top-level comment. Any writer of the memory may. Refused [comment_open_thread_exists] when its author already has another open thread on the node.',
    { commentRef: z.string().describe('The thread\'s top-level comment: URN or id.'), expectedRevision },
    async ({ commentRef: ref, expectedRevision: rev }) => {
      const ctx = ctxOf();
      try {
        return textResult(await receipt('Reopened', await M.reopenCommentThread({}, { commentRef: ref, expectedRevision: rev }, ctx), ctx));
      } catch (e) {
        return commentErrorText(e);
      }
    },
  );
}
