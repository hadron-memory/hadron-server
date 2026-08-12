// Team-chat operations — #939: createTeamChatMessage + teamChatMessages as
// platform operations (team logic lives server-side; CLI/MCP/portal are thin
// surfaces — the #935/#936 wrapper precedent).
//
// Placement (owned by this operation — the specific-product half of
// Q-2026-08-10-001, which deferred a placement scheme for the GENERIC chat
// surface only): the team chat is ONE well-known chat per team App, at loc
// `chats:team` in the TEAM AGENT's shared app-class memory (the
// `findOrCreateAppClassMemory` (app, agent) pair — D-2026-08-11: "the Team
// Agent's shared app memory is the team space"). It is bootstrapped on first
// post; reads never provision anything. Lookup is by loc across the App's
// app-class memories (oldest root wins, deterministically) so an
// already-bootstrapped chat is found without locating the Team Agent at all.
//
// Storage shape (D-2026-08-07-001/-004, kept field-compatible with the #921
// storage rework so it can absorb this surface without a data migration):
//   - chat root: nodeType `chat`, storage keys (`messageCount`,
//     `lastMessageAt`) top-level in `data`; `data.scope: 'shared'` is stamped
//     for compatibility with today's chat-scope invariants and retires with
//     D-2026-08-10-005.
//   - message: body in `Node.content`, envelope in `Node.data`, nodeType
//     `chat-message`, ordering key in `Node.seq` (allocated atomically by
//     `chatRoot.appendChatMessage` — #919; a hand-rolled node write here IS
//     the bug that operation exists to prevent).
//
// Envelope (`Node.data`) fields:
//   authorUserId  — the human author (no sessionRef; #914 parity)
//   authorAgentId — the persona author (sessionRef path)
//   authorName    — display convenience: persona name / user handle
//   sessionId     — the driving session (sessionRef path; D16 attribution)
//   mentions      — lowercased mention tokens extracted server-side at write
//   replyToSeq    — the seq this message replies to (also a `replies-to` edge)
import { GraphQLError } from 'graphql';
import type { Prisma } from '../../../generated/prisma/index.js';
import type { InputJsonValue } from '../../../generated/prisma/runtime/library.js';
import { generateId } from '../../../lib/id.js';
import { appendChatMessage } from '../../../lib/chatRoot.js';
import { lockAncestorsForCreateMany } from '../../../lib/nodeSubtreeLock.js';
import { deriveEdgeLoc, sanitizeLocAtom } from '../../../lib/edgeLoc.js';
import { resolveAppRef } from '../../../lib/entityRef/appRef.js';
import { resolveAgentRef } from '../../../lib/entityRef/agentRef.js';
import { resolveUserRef } from '../../../lib/entityRef/userRef.js';
import {
  getMemoryEncryptionInfo,
  decryptNodeFields,
  encryptNodeFields,
  type MemoryEncryptionInfo,
} from '../../../lib/nodeCrypto.js';
import {
  type Context,
  isAppParticipant,
  requireSessionWriteAccess,
  clampListTake,
} from './resolvers.helpers.js';
import { findOrCreateAppClassMemory } from './chat-scope.js';
import { locateTeamAgent } from './resolvers.mutation.teamPersona.js';

/** Canonical loc of the one team chat in a team App's shared memory (#939). */
export const TEAM_CHAT_LOC = 'chats:team';
/** Loc of the message container under the team chat root. */
export const TEAM_CHAT_MESSAGES_LOC = `${TEAM_CHAT_LOC}:messages`;
/**
 * Body size cap (#939 — documented decision): 64 KiB of text. Generous enough
 * for pasted diffs/logs (the working currency of a coding team), small enough
 * that a chat stays a chat — larger artifacts belong in their own node with a
 * link. Typed refusal: TEAM_CHAT_BODY_TOO_LARGE.
 */
export const TEAM_CHAT_BODY_MAX_CHARS = 65_536;

const forbidden = (): GraphQLError =>
  new GraphQLError('You are not authorized to use this App\'s team chat.', {
    extensions: { code: 'FORBIDDEN' },
  });

/**
 * Extract mention tokens from a message body — the ONE mention format for
 * writer and reader (#939): `@` followed by a mention token
 * (`[A-Za-z0-9][A-Za-z0-9._-]*`, trailing punctuation dropped so "@iris."
 * mentions iris). The `@` must sit at a token boundary, so an email address
 * (`x@example.com`) is NOT a mention (Copilot review on PR #941). Tokens are
 * stored LOWERCASED and without the `@`; matching is case-insensitive on both
 * sides. hadron-client's client-side MENTION_RE retires with the dialect
 * change (see hadron-client#20).
 */
export function extractMentions(body: string): string[] {
  const seen = new Set<string>();
  for (const match of body.matchAll(/(?<=^|[^A-Za-z0-9._-])@([A-Za-z0-9][A-Za-z0-9._-]*)/g)) {
    const token = match[1].replace(/[^A-Za-z0-9]+$/, '').toLowerCase();
    if (token) seen.add(token);
  }
  return [...seen];
}

/**
 * Canonical mention token of a display name — the slug both sides of the
 * mention contract use (Codex P2 on PR #941): persona names may legally
 * contain spaces ("Mary Jane"), which the extraction atom cannot, so the
 * writer mentions `@mary-jane` and the reader slugs the resolved name the
 * same way. Lowercase; runs of out-of-atom characters collapse to `-`;
 * trimmed to alphanumeric ends. Returns null when nothing usable remains.
 */
export function mentionTokenOf(name: string): string | null {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .replace(/[^a-z0-9]+$/, '');
  return slug.length > 0 ? slug : null;
}

type AppRow = {
  id: string;
  name: string;
  urn: string;
  organizationId: string | null;
  ownerUserId: string | null;
  uninstalledAt: Date | null;
};

/**
 * #939 membership gate. Posting and reading are both team-member acts
 * (`cor:acl:030:01` — every member of the owning App is a participant in
 * every chat in its shared memory, so unlike persona minting the gate does
 * NOT exclude 'reader' AppMembers: participation follows the host memory's
 * audience, and app-class grants read and write to the same audience).
 * May post/read: an AppMember of the team App (any role), an org member with
 * CONTRIBUTOR+ on the App's org (parity with the persona-mint gate's org
 * branch), or the owner of a user-owned App.
 *
 * Principal shapes (findings:auth-appid-credential-vs-selection): a PURE
 * App-key principal is DENIED for `post` (the documented lean — a chat
 * message is authored, and authorship is a human or a session-driven persona
 * with a human driver behind it) but ALLOWED for `read` when the key IS this
 * App's (the App's own automation may read its team's chat). A hybrid
 * user+selection principal is judged solely on the USER's own rights.
 * Impersonation may read but never post, and its reads are bounded to the
 * support session's SINGLE org (#876 class; Copilot on PR #941): the org
 * check runs BEFORE the owner/AppMember shortcuts, so a target's user-owned
 * App or cross-org membership never widens the support view.
 */
async function requireTeamChatAccess(
  ctx: Context,
  app: AppRow,
  mode: 'post' | 'read',
): Promise<void> {
  if (ctx.impersonation) {
    if (
      mode === 'post' ||
      app.organizationId === null ||
      app.organizationId !== ctx.impersonation.orgId
    ) {
      throw forbidden();
    }
  }
  if (!ctx.userId) {
    // Pure App-key principal: read-only, and only for its own App.
    if (mode === 'read' && ctx.appId && ctx.appId === app.id) return;
    throw forbidden();
  }
  // The user branch is the shared App-participation predicate (#943 extracted
  // it to resolvers.helpers so startSession's appRef gate is the SAME rule,
  // not a second copy that can drift): AppMember at any role, org CONTRIBUTOR+,
  // or the owner of a user-owned App.
  if (await isAppParticipant(ctx, app)) return;
  throw forbidden();
}

type ChatRootRow = { id: string; memoryId: string; loc: string };

/**
 * Find the team chat root among the App's app-class memories. Memory-scoped
 * by construction (findings:unscoped-loc-lookup-crosses-memories): the loc
 * match never leaves this App's own memories. Oldest root wins so the answer
 * is deterministic even if a second `chats:team` was hand-created in another
 * installed agent's shared memory.
 */
async function locateTeamChatRoot(ctx: Context, appId: string): Promise<ChatRootRow | null> {
  return ctx.db.node.findFirst({
    // loc-scope-ok: deliberately spans the App's OWN app-class memories (one
    // per installed agent) — the relation filter is the tenant scope (#939).
    where: {
      loc: TEAM_CHAT_LOC,
      deletedAt: null,
      memory: { appId, class: 'app', deletedAt: null },
    },
    orderBy: { createdAt: 'asc' },
    select: { id: true, memoryId: true, loc: true },
  });
}

/**
 * First-post bootstrap: provision the Team Agent's shared app-class memory
 * (idempotent, race-safe) and create the `chats` parent, the chat root, and
 * the `chats:team:messages` container in it. Race-safe: a concurrent first
 * post loses the root create on `@@unique([loc, memoryId])` (P2002) and
 * re-reads the winner's row.
 *
 * The Team Agent is located exactly as createTeamPersona does (the roles:
 * branch marker), with one chat-specific fallback: an App with EXACTLY ONE
 * installed Agent needs no marker to be unambiguous — a single-agent team App
 * without role definitions can still chat.
 */
async function bootstrapTeamChat(ctx: Context, app: AppRow): Promise<ChatRootRow> {
  let teamAgent: { id: string; name: string; urn: string };
  try {
    teamAgent = await locateTeamAgent(ctx, app.id, null);
  } catch (e) {
    if (!(e instanceof GraphQLError) || e.extensions?.code !== 'TEAM_AGENT_NOT_FOUND') throw e;
    const installed = await ctx.db.appAgent.findMany({
      where: { appId: app.id },
      select: { agent: { select: { id: true, name: true, urn: true, deletedAt: true } } },
    });
    const live = installed.map((r) => r.agent).filter((a) => a && !a.deletedAt);
    if (live.length !== 1) throw e;
    teamAgent = live[0];
  }

  const memoryId = await findOrCreateAppClassMemory({
    appId: app.id,
    appUrn: app.urn,
    appName: app.name,
    agentUrn: teamAgent.urn,
    agentName: teamAgent.name,
    organizationId: app.organizationId,
    // Post requires a user identity (requireTeamChatAccess), so this is set.
    actingUserId: ctx.userId!,
    db: ctx.db,
  });

  const memEncInfo = await getMemoryEncryptionInfo(ctx.db, memoryId);
  // Storage keys top-level (D-2026-08-10-004 — no engine state here);
  // `scope: 'shared'` for compatibility with the live chat-scope invariant
  // (`shared ⇔ app`, spec 017) until D-2026-08-10-005 drops the marker.
  const rootFields = translateSessionExpired(memEncInfo, () =>
    encryptNodeFields(
      {
        content: null,
        data: { scope: 'shared', messageCount: 0, createdAt: new Date().toISOString() },
      },
      memEncInfo,
    ),
  );
  try {
    await ctx.db.$transaction(async (tx) => {
      // #664/#752: create under the ancestor-path lock so a concurrent
      // non-recursive delete of `chats` can't orphan the subtree.
      await lockAncestorsForCreateMany(tx, memoryId, [TEAM_CHAT_LOC, TEAM_CHAT_MESSAGES_LOC]);
      // Each of the three nodes is create-OR-RESTORE: a soft-deleted row
      // still occupies `@@unique([loc, memoryId])`, so a plain create would
      // P2002 forever and the canonical loc would be permanently bricked
      // (Copilot on PR #941). Restoring the root preserves its data, so
      // `messageCount` — and therefore seq uniqueness — survives the
      // delete/restore cycle (old messages stay deleted).
      const restoreOrCreate = async (
        loc: string,
        create: () => Promise<unknown>,
      ) => {
        const existing = await tx.node.findUnique({
          where: { loc_memoryId: { loc, memoryId } },
          select: { id: true, deletedAt: true },
        });
        if (existing) {
          if (existing.deletedAt) {
            await tx.node.update({
              where: { id: existing.id },
              data: { deletedAt: null, deletedBy: null },
            });
          }
          return;
        }
        await create();
      };
      await restoreOrCreate('chats', () =>
        tx.node.create({
          data: { id: generateId(), memoryId, loc: 'chats', name: 'chats', nodeType: 'record' },
        }),
      );
      await restoreOrCreate(TEAM_CHAT_LOC, () =>
        tx.node.create({
          data: {
            id: generateId(),
            memoryId,
            loc: TEAM_CHAT_LOC,
            name: 'Team chat',
            nodeType: 'chat',
            description: `Team chat — ${app.name}`,
            data: (rootFields.data ?? null) as InputJsonValue,
            // Provenance, never a gate (cor:acl:030:01).
            createdBy: ctx.userId ?? null,
          },
        }),
      );
      await restoreOrCreate(TEAM_CHAT_MESSAGES_LOC, () =>
        tx.node.create({
          data: {
            id: generateId(),
            memoryId,
            loc: TEAM_CHAT_MESSAGES_LOC,
            name: 'messages',
            nodeType: 'record',
            createdBy: ctx.userId ?? null,
          },
        }),
      );
    });
  } catch (e) {
    // Concurrent first post won the bootstrap race — use its rows.
    const isUniqueViolation =
      typeof e === 'object' && e !== null && (e as { code?: string }).code === 'P2002';
    if (!isUniqueViolation) throw e;
  }
  const root = await locateTeamChatRoot(ctx, app.id);
  if (!root) throw new Error(`Team chat bootstrap failed for App ${app.id}`);
  return root;
}

/**
 * Run an encrypt/decrypt step, mapping the crypto layer's plain
 * `SESSION_EXPIRED` Error to the typed GraphQLError — WITHOUT this, Apollo
 * stamps INTERNAL_SERVER_ERROR and the advertised code never reaches the
 * client (conventions:typed-error-must-be-registered-in-formaterror; the
 * encrypt side was Codex P2 on PR #941).
 */
function translateSessionExpired<T>(memEncInfo: MemoryEncryptionInfo, fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof Error && e.message.startsWith('SESSION_EXPIRED')) {
      throw new GraphQLError(
        `SESSION_EXPIRED: memory ${memEncInfo.id} is encrypted but no active session key is available.`,
        { extensions: { code: 'SESSION_EXPIRED', memoryId: memEncInfo.id } },
      );
    }
    throw e;
  }
}

/** Map a decrypt failure on an encrypted memory to the typed SESSION_EXPIRED. */
function decryptOrSessionExpired<T extends { content?: string | null; data?: unknown }>(
  node: T,
  memEncInfo: MemoryEncryptionInfo,
): T {
  return translateSessionExpired(memEncInfo, () => decryptNodeFields(node, memEncInfo));
}

/** GraphQL shape of one team-chat message. (Exported — TS4023: a resolver map
 * exported from resolvers.ts cannot use a non-exported interface.) */
export interface TeamChatMessageOut {
  nodeId: string;
  seq: number;
  body: string;
  at: Date;
  authorUserId: string | null;
  authorAgentId: string | null;
  authorName: string | null;
  sessionId: string | null;
  replyToSeq: number | null;
  mentions: string[];
}

type MessageRow = {
  id: string;
  seq: number | null;
  content: string | null;
  data: unknown;
  createdAt: Date;
};

/** Decrypt a message row and project it onto the GraphQL shape. */
function projectMessage(row: MessageRow, memEncInfo: MemoryEncryptionInfo): TeamChatMessageOut {
  const dec = decryptOrSessionExpired({ content: row.content, data: row.data }, memEncInfo);
  const env = (dec.data as Record<string, unknown> | null) ?? {};
  return {
    nodeId: row.id,
    seq: row.seq ?? 0,
    body: dec.content ?? '',
    at: row.createdAt,
    authorUserId: typeof env.authorUserId === 'string' ? env.authorUserId : null,
    authorAgentId: typeof env.authorAgentId === 'string' ? env.authorAgentId : null,
    authorName: typeof env.authorName === 'string' ? env.authorName : null,
    sessionId: typeof env.sessionId === 'string' ? env.sessionId : null,
    replyToSeq: typeof env.replyToSeq === 'number' ? env.replyToSeq : null,
    mentions: Array.isArray(env.mentions) ? env.mentions.filter((m): m is string => typeof m === 'string') : [],
  };
}

/**
 * Resolve the author of a sessionRef post: the session's bound persona.
 * Refuses a session the caller couldn't write (requireSessionWriteAccess
 * semantics, cor:dmo:070:05 — attributed user only here, since the membership
 * gate already denied pure App-key principals for posts), a session that is
 * not bound to the TARGET App (Codex P1 on PR #941 — without this, a member
 * of Apps A and B could author into B's chat as A's persona), a session that
 * has ended (its persona may since have been freed and taken over — the
 * cor:agt:020:03 liveness model), and a session bound to no persona.
 */
async function resolveSessionAuthor(
  ctx: Context,
  appId: string,
  sessionRef: string,
): Promise<{ agentId: string; name: string; sessionId: string }> {
  const session = await ctx.db.session.findUnique({
    where: { id: sessionRef },
    select: { id: true, appId: true, userId: true, agentId: true, endedAt: true },
  });
  if (!session) {
    throw new GraphQLError(`Session "${sessionRef}" not found.`, {
      extensions: { code: 'SESSION_NOT_FOUND' },
    });
  }
  try {
    requireSessionWriteAccess(ctx, session);
  } catch {
    throw new GraphQLError('You cannot post as a session you are not attributed to.', {
      extensions: { code: 'FORBIDDEN' },
    });
  }
  if (session.appId !== appId) {
    throw new GraphQLError(
      `Session "${sessionRef}" is not a session of this App — its persona cannot author messages in this team chat.`,
      { extensions: { code: 'SESSION_NOT_IN_APP', appId } },
    );
  }
  if (session.endedAt) {
    throw new GraphQLError(
      `Session "${sessionRef}" has ended — its persona can no longer author messages through it.`,
      { extensions: { code: 'SESSION_ENDED' } },
    );
  }
  if (!session.agentId) {
    throw new GraphQLError(
      `Session "${sessionRef}" is not bound to a persona (no agent attribution) — omit sessionRef to post as yourself.`,
      { extensions: { code: 'SESSION_NOT_PERSONA_BOUND' } },
    );
  }
  const agent = await ctx.db.agent.findUnique({
    where: { id: session.agentId },
    select: { id: true, name: true, personaName: true },
  });
  if (!agent) {
    throw new GraphQLError(
      `Session "${sessionRef}" is bound to an agent that no longer exists.`,
      { extensions: { code: 'SESSION_NOT_PERSONA_BOUND' } },
    );
  }
  return { agentId: agent.id, name: agent.personaName ?? agent.name, sessionId: session.id };
}

/**
 * Resolve a mentionsRef filter argument to the set of tokens it can appear as
 * in stored envelopes: an Agent ref → the slugs of its persona name and plain
 * name (via {@link mentionTokenOf} — the canonical mention atom), a user ref
 * → their handle. Returns null when the ref resolves to nothing OR to a
 * principal outside this App's roster — the caller collapses both to the
 * empty page identically. The roster restriction is the anti-oracle guard
 * (Codex P1 on PR #941): the mention filter must not distinguish a private
 * foreign Agent/user from a nonexistent one, so an Agent ref only resolves
 * when the Agent is INSTALLED in this App, and a user ref only when the user
 * is an AppMember of it (or the caller themself).
 */
async function resolveMentionTokens(
  ctx: Context,
  appId: string,
  mentionsRef: string,
): Promise<string[] | null> {
  try {
    const { id } = await resolveAgentRef(ctx.db, mentionsRef);
    const installed = await ctx.db.appAgent.findUnique({
      where: { appId_agentId: { appId, agentId: id } },
      select: { agent: { select: { name: true, personaName: true } } },
    });
    if (installed?.agent) {
      const tokens = [installed.agent.personaName, installed.agent.name]
        .filter((t): t is string => typeof t === 'string' && t.length > 0)
        .map((t) => mentionTokenOf(t))
        .filter((t): t is string => t !== null);
      if (tokens.length > 0) return [...new Set(tokens)];
    }
    return null;
  } catch {
    // not an agent ref — try user
  }
  // User path: accept an id, an hrn:user:<handle> URN, or (as a convenience
  // for the MCP tool) a BARE handle — resolveUserRef rejects a bare handle as
  // not fully qualified, so retry with the user URN prefix.
  const userCandidates = mentionsRef.includes(':')
    ? [mentionsRef]
    : [mentionsRef, `hrn:user:${mentionsRef}`];
  for (const candidate of userCandidates) {
    try {
      const { id } = await resolveUserRef(ctx.db, candidate);
      const isSelf = ctx.userId === id;
      const member = isSelf
        ? null
        : await ctx.db.appMember.findUnique({
            where: { appId_userId: { appId, userId: id } },
            select: { userId: true },
          });
      if (!isSelf && !member) return null;
      const user = await ctx.db.user.findUnique({ where: { id }, select: { handle: true } });
      const token = user?.handle ? mentionTokenOf(user.handle) : null;
      if (token) return [token];
      return null;
    } catch {
      // try the next spelling
    }
  }
  return null;
}

export const teamChatMutations = {
  /**
   * #939 — post a message into the team App's chat as a platform operation:
   * resolve the App (cor:api:140), gate on team membership, locate (or
   * bootstrap) the team chat, derive the author (sessionRef → the session's
   * persona; else the calling human), extract mentions server-side, and write
   * the message through `chatRoot.appendChatMessage` (atomic seq, #919),
   * wiring a `replies-to` edge for replyToSeq.
   */
  createTeamChatMessage: async (
    _: unknown,
    {
      appRef,
      body,
      replyToSeq,
      sessionRef,
    }: { appRef: string; body: string; replyToSeq?: number | null; sessionRef?: string | null },
    ctx: Context,
  ): Promise<TeamChatMessageOut> => {
    if (typeof body !== 'string' || body.trim() === '') {
      throw new GraphQLError('body must be a non-empty string.', {
        extensions: { code: 'BAD_USER_INPUT' },
      });
    }
    if (body.length > TEAM_CHAT_BODY_MAX_CHARS) {
      throw new GraphQLError(
        `body exceeds the team-chat cap of ${TEAM_CHAT_BODY_MAX_CHARS} characters (got ${body.length}). Store large artifacts as their own node and link them.`,
        { extensions: { code: 'TEAM_CHAT_BODY_TOO_LARGE', maxChars: TEAM_CHAT_BODY_MAX_CHARS } },
      );
    }

    const { id: appId } = await resolveAppRef(ctx.db, appRef);
    const app = await ctx.db.app.findUniqueOrThrow({ where: { id: appId } });
    if (app.uninstalledAt) {
      throw new GraphQLError('Cannot post into an uninstalled App\'s team chat.', {
        extensions: { code: 'APP_UNINSTALLED', appId },
      });
    }
    await requireTeamChatAccess(ctx, app, 'post');

    // Author derivation (#939): sessionRef → the session's persona, with the
    // driving session stamped in the envelope; no sessionRef → the calling
    // human. The membership gate above guarantees ctx.userId is set here.
    let envelope: Record<string, unknown>;
    let authorLabel: string;
    if (sessionRef) {
      const author = await resolveSessionAuthor(ctx, appId, sessionRef);
      authorLabel = author.name;
      envelope = {
        authorAgentId: author.agentId,
        authorName: author.name,
        sessionId: author.sessionId,
      };
    } else {
      const user = await ctx.db.user.findUniqueOrThrow({
        where: { id: ctx.userId! },
        select: { handle: true },
      });
      authorLabel = user.handle;
      envelope = { authorUserId: ctx.userId, authorName: user.handle };
    }

    // Mentions are extracted server-side at write time (#939) — ONE extractor
    // for every surface; readers filter on the stored envelope, never re-parse.
    const mentions = extractMentions(body);
    if (mentions.length > 0) envelope.mentions = mentions;
    if (replyToSeq != null) envelope.replyToSeq = replyToSeq;

    const root =
      (await locateTeamChatRoot(ctx, appId)) ?? (await bootstrapTeamChat(ctx, app));
    const memEncInfo = await getMemoryEncryptionInfo(ctx.db, root.memoryId);
    const msgFields = translateSessionExpired(memEncInfo, () =>
      encryptNodeFields({ content: body, data: envelope }, memEncInfo),
    );

    const messageId = generateId();
    const createdBy = ctx.userId ?? null;
    const { seq, inserted: createdAt } = await appendChatMessage(ctx.db, root, memEncInfo, async ({ tx, seq, msgNum }) => {
      // replyToSeq is validated INSIDE the allocating transaction, under the
      // chat lock, so the target can't be soft-deleted out from under us and
      // a reply can never cite its own (still-uncommitted) seq.
      let replyTarget: { id: string; loc: string } | null = null;
      if (replyToSeq != null) {
        replyTarget = await tx.node.findFirst({
          // nodeType-constrained (Copilot on PR #941): the generic write
          // surface may put off-road nodes under the prefix
          // (D-2026-08-10-003) — a reply must cite a canonical message.
          where: {
            memoryId: root.memoryId,
            loc: { startsWith: `${TEAM_CHAT_MESSAGES_LOC}:` },
            nodeType: 'chat-message',
            seq: replyToSeq,
            deletedAt: null,
          },
          select: { id: true, loc: true },
        });
        if (!replyTarget) {
          throw new GraphQLError(
            `replyToSeq ${replyToSeq} does not name a message in this team chat.`,
            { extensions: { code: 'TEAM_CHAT_REPLY_NOT_FOUND', replyToSeq } },
          );
        }
      }
      // The random component is the #916 backstop, not the uniqueness carrier
      // (#919 makes seq unique); the suffix atom is the author label, a
      // display convenience in an address that lands in URNs and search.
      const loc = `${TEAM_CHAT_MESSAGES_LOC}:${msgNum}-${generateId().slice(-8)}-${sanitizeLocAtom(authorLabel).toLowerCase()}`;
      const row = await tx.node.create({
        data: {
          id: messageId,
          memoryId: root.memoryId,
          loc,
          name: `${msgNum}-${authorLabel}`,
          nodeType: 'chat-message',
          content: msgFields.content ?? null,
          data: (msgFields.data ?? null) as InputJsonValue,
          seq,
          // #914: the SENDER's user id — for persona posts, the human driver.
          createdBy,
        },
      });
      if (replyTarget) {
        await tx.edge.create({
          data: {
            id: generateId(),
            memoryId: root.memoryId,
            sourceId: messageId,
            targetId: replyTarget.id,
            loc: deriveEdgeLoc(loc, 'replies-to', replyTarget.loc),
            name: 'replies-to',
            createdBy,
          },
        });
      }
      return row.createdAt;
    });

    return {
      nodeId: messageId,
      seq,
      body,
      at: createdAt,
      authorUserId: (envelope.authorUserId as string | undefined) ?? null,
      authorAgentId: (envelope.authorAgentId as string | undefined) ?? null,
      authorName: authorLabel,
      sessionId: (envelope.sessionId as string | undefined) ?? null,
      replyToSeq: replyToSeq ?? null,
      mentions,
    };
  },
};

export const teamChatQueries = {
  /**
   * #939 — read the team chat, seq-ordered ascending, as a uniform
   * `{ items, total }` page (conventions:uniform-read-surface). `sinceSeq` is
   * a watermark cursor: only messages with seq STRICTLY GREATER are returned
   * (so a client passes the last seq it has seen). `mentionsRef` filters on
   * the STORED envelope mentions (resolved to a persona name or user handle —
   * the one mention format); because the envelope lives in `data`, which is
   * ciphertext in an encrypted memory, the mentions filter decrypts and
   * filters in memory over the seq window rather than in SQL. An unresolvable
   * mentionsRef collapses to the empty page (never an existence oracle).
   */
  teamChatMessages: async (
    _: unknown,
    {
      appRef,
      sinceSeq,
      mentionsRef,
      limit,
      offset,
    }: {
      appRef: string;
      sinceSeq?: number | null;
      mentionsRef?: string | null;
      limit?: number | null;
      offset?: number | null;
    },
    ctx: Context,
  ): Promise<{ items: TeamChatMessageOut[]; total: number }> => {
    const { id: appId } = await resolveAppRef(ctx.db, appRef);
    const app = await ctx.db.app.findUniqueOrThrow({ where: { id: appId } });
    await requireTeamChatAccess(ctx, app, 'read');

    const root = await locateTeamChatRoot(ctx, appId);
    if (!root) return { items: [], total: 0 };

    const memEncInfo = await getMemoryEncryptionInfo(ctx.db, root.memoryId);
    const take = clampListTake(limit);
    const skip = Math.max(0, offset ?? 0);
    const where: Prisma.NodeWhereInput = {
      memoryId: root.memoryId,
      loc: { startsWith: `${TEAM_CHAT_MESSAGES_LOC}:` },
      // Only canonical messages (Copilot on PR #941): the generic write
      // surface stays open (D-2026-08-10-003), so off-road nodes under the
      // prefix must not surface as fabricated transcript entries.
      nodeType: 'chat-message',
      deletedAt: null,
      seq: sinceSeq != null ? { gt: sinceSeq } : { not: null },
    };
    // #919 reader order: seq is unique going forward; createdAt + loc break
    // ties on pre-fix rows so the order is at least stable between reads.
    const orderBy = [
      { seq: 'asc' as const },
      { createdAt: 'asc' as const },
      { loc: 'asc' as const },
    ];
    const select = {
      id: true, seq: true, content: true, data: true, createdAt: true,
    };

    if (mentionsRef) {
      const tokens = await resolveMentionTokens(ctx, appId, mentionsRef);
      if (!tokens) return { items: [], total: 0 };
      const rows = await ctx.db.node.findMany({ where, orderBy, select });
      const matching = rows
        .map((r) => projectMessage(r, memEncInfo))
        .filter((m) => m.mentions.some((t) => tokens.includes(t)));
      return { items: take === 0 ? [] : matching.slice(skip, skip + take), total: matching.length };
    }

    const total = await ctx.db.node.count({ where });
    if (take === 0) return { items: [], total };
    const rows = await ctx.db.node.findMany({ where, orderBy, select, skip, take });
    return { items: rows.map((r) => projectMessage(r, memEncInfo)), total };
  },
};
