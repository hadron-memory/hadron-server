import { WORKER_SIGNATURE_DEFAULTS } from '../lib/workerSignature.js';
/**
 * #1609 — the comment tools on the MCP surface (cor:dmo:110).
 *
 * The rules themselves are pinned in resolvers.comments.test.ts; this covers
 * the SURFACE: a full thread round-trip through the tools, the node-read
 * feedback cue, refusals as `[code] message` envelopes, PARITY with the
 * GraphQL path (the same principal meets the same refusal code on both), and
 * worker authorship through the DAC connection binding over real HTTP.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { GraphQLError } from 'graphql';
import { createServer } from '../server.js';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { serveAgentBootPrompt } from '../test/servedBootPrompt.js';
import { generateId } from '../lib/id.js';
import { mintUserApiKey, type AuthContext } from '../middleware/auth.js';
import { resolvers, type Context } from '../api/graphql/schema/resolvers.js';
import { createTestableMcpServer } from './server.js';
import { COMMENT_FRAMING } from './commentTools.js';

vi.mock('../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

let org: { id: string };
let admin: { id: string };
let writer: { id: string };
let other: { id: string };
let reader: { id: string };
let outsider: { id: string };
let memory: { id: string; urn: string };
let target: { id: string; loc: string };

const M = resolvers.Mutation as unknown as Record<string, (p: unknown, a: unknown, c: Context) => Promise<any>>;
const Q = resolvers.Query as unknown as Record<string, (p: unknown, a: unknown, c: Context) => Promise<any>>;

const authOf = (userId: string, extra: Partial<AuthContext> = {}) =>
  ({ userId, roles: ['READER'], clientId: `user:${userId}`, organizationId: org.id, ...extra }) as AuthContext;
const mcp = (userId: string, extra: Partial<AuthContext> = {}) =>
  createTestableMcpServer(authOf(userId, extra), { sessionId: `cmt-${generateId()}`, cachedAppResolution: { kind: 'multi-app' } });
const gqlCtx = (userId: string, extra: Partial<Context> = {}): Context => ({ db, userId, roles: [], ...extra });

/** The refusal code a GraphQL call raises, or NO_ERROR. */
const gqlCode = async (p: Promise<unknown>) => {
  try { await p; return 'NO_ERROR'; } catch (e) {
    return e instanceof GraphQLError ? String(e.extensions.code) : (e as Error).message;
  }
};
/** The refusal code an MCP tool's text envelope carries, or NO_ERROR. */
const mcpCode = (text: string) => /^\[([a-z_]+)\]/.exec(text)?.[1].toUpperCase() ?? 'NO_ERROR';
const idOf = (text: string) => /\(id: ([0-9a-z]+)\)/.exec(text)![1];
const targetUrn = () => `hrn:node:${memory.urn}:${target.loc}`;

beforeEach(async () => {
  await cleanDb(db);
  org = await db.organization.create({ data: { id: generateId(), name: 'Comment MCP', urn: 'cmtmcp.example' } });
  admin = await db.user.create({ data: { githubId: 160901, githubUsername: 'cmt-admin', handle: 'cmt-admin', roles: [] } });
  writer = await db.user.create({ data: { githubId: 160902, githubUsername: 'cmt-writer', handle: 'cmt-writer', roles: [] } });
  other = await db.user.create({ data: { githubId: 160903, githubUsername: 'cmt-other', handle: 'cmt-other', roles: [] } });
  reader = await db.user.create({ data: { githubId: 160904, githubUsername: 'cmt-reader', handle: 'cmt-reader', roles: [] } });
  outsider = await db.user.create({ data: { githubId: 160905, githubUsername: 'cmt-outsider', handle: 'cmt-outsider', roles: [] } });
  await db.orgMember.createMany({ data: [
    { organizationId: org.id, userId: admin.id, role: 'ADMIN' },
    { organizationId: org.id, userId: writer.id, role: 'CONTRIBUTOR' },
    { organizationId: org.id, userId: other.id, role: 'CONTRIBUTOR' },
    { organizationId: org.id, userId: reader.id, role: 'READER' },
  ] });
  memory = await resolvers.Mutation.createMemory(null, { orgId: org.id, name: 'discussion' }, gqlCtx(admin.id));
  target = await db.node.create({
    data: { id: generateId(), memoryId: memory.id, loc: 'spec:1', name: 'The rule', abstract: 'A', content: 'The rule body' },
  });
});

describe('comment tools: a thread through MCP', () => {
  it('create → list → reply → edit → resolve → reopen → delete, with the feedback cue on node reads', async () => {
    const asWriter = mcp(writer.id);
    const asOther = mcp(other.id);

    // No feedback yet: the cue is omitted.
    expect(await asWriter.callToolText('hadron_get_node', { urn: targetUrn() })).not.toContain('Feedback:');

    const created = await asWriter.callToolText('hadron_create_comment', { targetRef: targetUrn(), body: 'Is this right?', quote: 'The rule' });
    expect(created).toContain('Commented.');
    expect(created).toContain(`user hrn:user:cmt-writer (you)`);
    expect(created).toContain('OPEN · anchored at r1 (current)');
    expect(created).toContain('  > The rule');
    expect(created).toContain('Next write to it: expectedRevision 1.');
    const rootId = idOf(created);
    const root = await db.node.findUniqueOrThrow({ where: { id: rootId }, select: { nodeType: true, commentMeta: { select: { authorKey: true, targetNodeId: true } } } });
    expect(root).toEqual({ nodeType: 'comment', commentMeta: { authorKey: `u:${writer.id}`, targetNodeId: target.id } });

    // The target node read now carries the cue; a comment read says what it is.
    const nodeRead = await asOther.callToolText('hadron_get_node', { urn: targetUrn() });
    expect(nodeRead).toContain('Feedback: 1 open thread, 0 resolved, 1 comment');
    const batch = await asOther.callToolText('hadron_get_nodes', { refs: [targetUrn()] });
    expect(batch).toContain('Feedback: 1 open thread, 0 resolved, 1 comment');
    const commentRead = await asOther.callToolText('hadron_get_node', { urn: `hrn:node:${memory.urn}:comments:${rootId}` });
    expect(commentRead).toContain('Feedback: this node is a comment');

    const replied = await asOther.callToolText('hadron_reply_to_comment', { commentRef: rootId, body: 'Yes, see the spec.' });
    expect(replied).toContain(`reply in thread ${rootId}`);
    expect(replied).toContain('user hrn:user:cmt-other (you)');

    const edited = await asWriter.callToolText('hadron_edit_comment', { commentRef: rootId, body: 'Is this still right?', expectedRevision: 1 });
    expect(edited).toContain('Is this still right?');
    expect(edited).toContain('expectedRevision 2.');

    // Any writer may resolve, not only the author.
    const resolved = await asOther.callToolText('hadron_resolve_comment_thread', { commentRef: rootId, expectedRevision: 2 });
    expect(resolved).toContain('RESOLVED by user hrn:user:cmt-other');

    const listed = await asWriter.callToolText('hadron_list_comments', { targetRef: targetUrn() });
    expect(listed).toContain(`Feedback on ${targetUrn()} (The rule, now r1): threads 1–1 of 1.`);
    expect(listed).toContain(COMMENT_FRAMING);
    expect(listed).toContain('Is this still right?');
    expect(listed).toContain('    - '); // the reply, nested
    expect(listed).toContain('Yes, see the spec.');
    expect(await asWriter.callToolText('hadron_list_comments', { targetRef: targetUrn(), state: ['OPEN'] })).toContain('No comment threads in state OPEN');

    // #1721: resolve and reopen change only the thread state, not the revision.
    await asWriter.callToolText('hadron_reopen_comment_thread', { commentRef: rootId, expectedRevision: 2 });
    // It has a reply, so deleting it leaves a stub.
    const deleted = await asWriter.callToolText('hadron_delete_comment', { commentRef: rootId, expectedRevision: 2 });
    expect(deleted).toContain('[deleted');
    expect(deleted).not.toContain('Is this still right?');

    const got = await asOther.callToolText('hadron_get_comment', { commentRef: `hrn:node:${memory.urn}:comments:${rootId}` });
    expect(got).toContain(`Comment on ${targetUrn()} (The rule).`);
    expect(got).toContain('[deleted');
  });

  it('describes every tool as feedback, and names the DAC worker binding on create', async () => {
    const s = mcp(writer.id);
    for (const name of ['hadron_list_comments', 'hadron_get_comment']) expect(s.toolDescription(name)).toContain(COMMENT_FRAMING);
    expect(s.toolDescription('hadron_create_comment')).toContain('feedback beside it, never an edit of it');
    expect(s.toolDescription('hadron_create_comment')).toContain('hadron_start_session');
  });
});

describe('comment tools: parity with the GraphQL gate (no drift)', () => {
  /**
   * Each case runs the SAME request as the same principal through GraphQL and
   * through the MCP tool, and expects the same refusal code from both.
   */
  type Case = {
    name: string;
    userId: () => string;
    extra?: () => { auth: Partial<AuthContext>; ctx: Partial<Context> };
    setup?: () => Promise<Record<string, unknown>>;
    gql: (s: Record<string, unknown>, ctx: Context) => Promise<unknown>;
    tool: string;
    args: (s: Record<string, unknown>) => Record<string, unknown>;
    expected: string;
  };
  const writerThread = async () => ({ root: (await M.createComment(null, { targetRef: target.id, body: 'mine' }, gqlCtx(writer.id))).id });
  const cases: Case[] = [
    {
      name: 'a reader cannot comment', userId: () => reader.id, expected: 'COMMENT_FORBIDDEN',
      gql: (_, ctx) => M.createComment(null, { targetRef: target.id, body: 'x' }, ctx),
      tool: 'hadron_create_comment', args: () => ({ targetRef: target.id, body: 'x' }),
    },
    {
      name: 'an outsider cannot see the target (no oracle) — write', userId: () => outsider.id, expected: 'COMMENT_TARGET_NOT_FOUND',
      gql: (_, ctx) => M.createComment(null, { targetRef: target.id, body: 'x' }, ctx),
      tool: 'hadron_create_comment', args: () => ({ targetRef: target.id, body: 'x' }),
    },
    {
      name: 'an outsider cannot see the target (no oracle) — read', userId: () => outsider.id, expected: 'COMMENT_TARGET_NOT_FOUND',
      gql: (_, ctx) => Q.commentThreads(null, { targetRef: target.id }, ctx),
      tool: 'hadron_list_comments', args: () => ({ targetRef: target.id }),
    },
    {
      name: 'one open thread per author', userId: () => writer.id, expected: 'COMMENT_OPEN_THREAD_EXISTS', setup: writerThread,
      gql: (_, ctx) => M.createComment(null, { targetRef: target.id, body: 'again' }, ctx),
      tool: 'hadron_create_comment', args: () => ({ targetRef: target.id, body: 'again' }),
    },
    {
      name: 'only the author edits', userId: () => other.id, expected: 'COMMENT_NOT_AUTHOR', setup: writerThread,
      gql: (s, ctx) => M.editComment(null, { commentRef: s.root, body: 'hijack', expectedRevision: 1 }, ctx),
      tool: 'hadron_edit_comment', args: (s) => ({ commentRef: s.root, body: 'hijack', expectedRevision: 1 }),
    },
    {
      name: 'a writer who is neither author nor manager cannot delete', userId: () => other.id, expected: 'COMMENT_NOT_AUTHOR', setup: writerThread,
      gql: (s, ctx) => M.deleteComment(null, { commentRef: s.root, expectedRevision: 1 }, ctx),
      tool: 'hadron_delete_comment', args: (s) => ({ commentRef: s.root, expectedRevision: 1 }),
    },
    {
      name: 'a stale revision conflicts', userId: () => writer.id, expected: 'NODE_WRITE_CONFLICT', setup: writerThread,
      gql: (s, ctx) => M.editComment(null, { commentRef: s.root, body: 'b', expectedRevision: 7 }, ctx),
      tool: 'hadron_edit_comment', args: (s) => ({ commentRef: s.root, body: 'b', expectedRevision: 7 }),
    },
    {
      name: 'a reply cannot be resolved', userId: () => writer.id, expected: 'COMMENT_NOT_TOP_LEVEL',
      setup: async () => {
        const { root } = await writerThread();
        return { reply: (await M.replyToComment(null, { commentRef: root, body: 'r' }, gqlCtx(other.id))).id };
      },
      gql: (s, ctx) => M.resolveCommentThread(null, { commentRef: s.reply, expectedRevision: 1 }, ctx),
      tool: 'hadron_resolve_comment_thread', args: (s) => ({ commentRef: s.reply, expectedRevision: 1 }),
    },
    {
      name: 'a comment is not a target', userId: () => other.id, expected: 'COMMENT_TARGET_IS_COMMENT', setup: writerThread,
      gql: (s, ctx) => M.createComment(null, { targetRef: s.root, body: 'x' }, ctx),
      tool: 'hadron_create_comment', args: (s) => ({ targetRef: s.root, body: 'x' }),
    },
    {
      name: 'an empty body is invalid', userId: () => writer.id, expected: 'COMMENT_BODY_INVALID',
      gql: (_, ctx) => M.createComment(null, { targetRef: target.id, body: '   ' }, ctx),
      tool: 'hadron_create_comment', args: () => ({ targetRef: target.id, body: '   ' }),
    },
    {
      name: 'a private memory is not commentable', userId: () => writer.id, expected: 'COMMENT_MEMORY_NOT_COMMENTABLE',
      setup: async () => {
        const priv = await db.memory.create({ data: {
          id: generateId(), organizationId: org.id, urn: 'cmtmcp.example:writer-private', name: 'p', class: 'private', userId: writer.id,
        } });
        return { node: (await db.node.create({ data: { id: generateId(), memoryId: priv.id, loc: 'note', name: 'Note', content: 'n' } })).id };
      },
      gql: (s, ctx) => M.createComment(null, { targetRef: s.node, body: 'x' }, ctx),
      tool: 'hadron_create_comment', args: (s) => ({ targetRef: s.node, body: 'x' }),
    },
    {
      name: 'an anchor past the current revision is invalid', userId: () => writer.id, expected: 'COMMENT_ANCHOR_REVISION_INVALID',
      gql: (_, ctx) => M.createComment(null, { targetRef: target.id, body: 'x', anchorRevision: 5 }, ctx),
      tool: 'hadron_create_comment', args: () => ({ targetRef: target.id, body: 'x', anchorRevision: 5 }),
    },
    {
      name: 'a deleted stub takes no reply', userId: () => other.id, expected: 'COMMENT_DELETED',
      setup: async () => {
        const { root } = await writerThread();
        // #1721: only a comment with replies leaves a stub to refuse.
        await M.replyToComment(null, { commentRef: root, body: 'keeps the stub' }, gqlCtx(other.id));
        await M.deleteComment(null, { commentRef: root, expectedRevision: 1 }, gqlCtx(writer.id));
        return { root };
      },
      gql: (s, ctx) => M.replyToComment(null, { commentRef: s.root, body: 'r' }, ctx),
      tool: 'hadron_reply_to_comment', args: (s) => ({ commentRef: s.root, body: 'r' }),
    },
    {
      name: "a stub a manager left cannot be edited by its author", userId: () => writer.id, expected: 'COMMENT_DELETED',
      setup: async () => {
        const { root } = await writerThread();
        await M.replyToComment(null, { commentRef: root, body: 'keeps the stub' }, gqlCtx(other.id));
        await M.deleteComment(null, { commentRef: root, expectedRevision: 1 }, gqlCtx(admin.id));
        return { root };
      },
      gql: (s, ctx) => M.editComment(null, { commentRef: s.root, body: 'b', expectedRevision: 2 }, ctx),
      tool: 'hadron_edit_comment', args: (s) => ({ commentRef: s.root, body: 'b', expectedRevision: 2 }),
    },
    {
      name: 'an open thread cannot be reopened', userId: () => writer.id, expected: 'COMMENT_THREAD_STATE', setup: writerThread,
      gql: (s, ctx) => M.reopenCommentThread(null, { commentRef: s.root, expectedRevision: 1 }, ctx),
      tool: 'hadron_reopen_comment_thread', args: (s) => ({ commentRef: s.root, expectedRevision: 1 }),
    },
    {
      name: 'a missing comment is not found', userId: () => writer.id, expected: 'COMMENT_NOT_FOUND',
      setup: async () => ({ missing: generateId() }),
      gql: (s, ctx) => M.replyToComment(null, { commentRef: s.missing, body: 'r' }, ctx),
      tool: 'hadron_reply_to_comment', args: (s) => ({ commentRef: s.missing, body: 'r' }),
    },
    {
      name: 'a non-comment is not a comment', userId: () => writer.id, expected: 'COMMENT_NOT_FOUND',
      gql: (_, ctx) => M.deleteComment(null, { commentRef: target.id, expectedRevision: 1 }, ctx),
      tool: 'hadron_delete_comment', args: () => ({ commentRef: target.id, expectedRevision: 1 }),
    },
    {
      name: 'impersonation never writes a comment', userId: () => writer.id, expected: 'COMMENT_IMPERSONATION_REFUSED',
      extra: () => {
        const impersonation = { sessionId: generateId(), actorUserId: admin.id, orgId: org.id, expiresAt: new Date(Date.now() + 3_600_000) };
        return { auth: { impersonation, roles: [] }, ctx: { impersonation } };
      },
      gql: (_, ctx) => M.createComment(null, { targetRef: target.id, body: 'x' }, ctx),
      tool: 'hadron_create_comment', args: () => ({ targetRef: target.id, body: 'x' }),
    },
  ];

  for (const c of cases) {
    it(c.name, async () => {
      const state = (await c.setup?.()) ?? {};
      const extra = c.extra?.() ?? { auth: {}, ctx: {} };
      const viaGraphql = await gqlCode(c.gql(state, gqlCtx(c.userId(), extra.ctx)));
      const text = await mcp(c.userId(), extra.auth).callToolText(c.tool, c.args(state));
      expect(viaGraphql).toBe(c.expected);
      expect(mcpCode(text), text).toBe(c.expected);
    });
  }

  it('carries the refusal extensions an agent acts on (threadId, currentRevision)', async () => {
    const { root } = await writerThread();
    const asWriter = mcp(writer.id);
    expect(await asWriter.callToolText('hadron_create_comment', { targetRef: target.id, body: 'again' })).toContain(`threadId: ${root}`);
    expect(await asWriter.callToolText('hadron_edit_comment', { commentRef: root, body: 'b', expectedRevision: 9 })).toContain('currentRevision: 1');
  });

  it('an empty page under a nonzero total answers cleanly (limit 0, offset past the end; #1676 review P2)', async () => {
    await writerThread();
    const asReader = mcp(reader.id);
    for (const args of [{ limit: 0 }, { offset: 5 }]) {
      const viaGraphql = await Q.commentThreads(null, { targetRef: target.id, ...args }, gqlCtx(reader.id));
      expect(viaGraphql).toMatchObject({ items: [], total: 1 });
      const text = await asReader.callToolText('hadron_list_comments', { targetRef: target.id, ...args });
      expect(text, JSON.stringify(args)).toContain(`No threads on this page: offset ${args.offset ?? 0} of 1 thread on ${target.id}.`);
      expect(text).toContain(COMMENT_FRAMING);
    }
  });

  it("a stub a manager left reads as a stub through every tool; an unreadable target shows no Feedback line", async () => {
    const { root } = await writerThread();
    await M.replyToComment(null, { commentRef: root, body: 'keeps the stub' }, gqlCtx(other.id));
    await M.deleteComment(null, { commentRef: root, expectedRevision: 1 }, gqlCtx(admin.id));
    const asReader = mcp(reader.id);
    for (const text of [
      await asReader.callToolText('hadron_list_comments', { targetRef: target.id }),
      await asReader.callToolText('hadron_get_comment', { commentRef: root }),
    ]) {
      expect(text).toContain('[deleted');
      expect(text).not.toContain('mine');
    }
    const outsiderRead = await mcp(outsider.id).callToolText('hadron_get_node', { urn: targetUrn() });
    expect(outsiderRead).not.toContain('Feedback:');
    expect(outsiderRead).not.toContain(target.id);
  });

  it('a malformed ref is the caller\'s input: a [bad_user_input] envelope, not an internal error', async () => {
    const text = await mcp(writer.id).callToolText('hadron_reply_to_comment', { commentRef: 'not-a-ref', body: 'r' });
    expect(text).toMatch(/^\[bad_user_input\] /);
  });

  it('a comment the caller cannot read is not found, never described', async () => {
    const { root } = await writerThread();
    expect(await mcp(outsider.id).callToolText('hadron_get_comment', { commentRef: root })).toMatch(/^\[comment_not_found\]/);
  });
});

describe('comment tools over HTTP: a GraphQL-started worker attributes comments through its header (#3082)', () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    server = createHttpServer(await createServer());
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); });

  it('records w:<worker> as the author and renders the worker, not the binding user', async () => {
    const agent = await db.agent.create({ data: { id: generateId(), urn: 'cmtmcp.example:server-engineer', name: 'server-engineer', organizationId: org.id } });
    const app = await db.app.create({ data: { id: generateId(), name: 'Team', urn: 'cmtmcp.example:team', organizationId: org.id } });
    const appMemory = await db.memory.create({ data: {
      id: generateId(), urn: 'cmtmcp.example:team-shared', name: 'team-shared', class: 'app', appId: app.id, organizationId: org.id,
    } });
    await serveAgentBootPrompt(db, agent.id, 'Test boot prompt.'); // #2712: the bind is served the Agent's boot prompt
    await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
    await db.appMember.create({ data: { appId: app.id, userId: writer.id, role: 'owner' } });
    const iris = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId: app.id, agentId: agent.id, name: 'Iris', slug: 'iris' } });
    const appTarget = await db.node.create({ data: { id: generateId(), memoryId: appMemory.id, loc: 'plan', name: 'Plan', content: 'p' } });
    const { rawKey } = await mintUserApiKey(db, { userId: writer.id, label: null, createdBy: writer.id, issuedVia: 'test' });

    const session = await resolvers.Mutation.startSession({}, { input: { id: generateId(), workerRef: iris.id, tool: 'vitest' } }, { db, userId: writer.id, appId: app.id, roles: ['READER'] });
    const headers = { 'x-hadron-session': session.id, authorization: `Bearer ${rawKey}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
    const init = await fetch(`${baseUrl}/mcp`, {
      method: 'POST', headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: '1609', version: '1' } } }),
    });
    expect(init.status).toBe(200);
    const sid = init.headers.get('mcp-session-id')!;
    let id = 10;
    const call = async (name: string, args: Record<string, unknown>) => {
      const res = await fetch(`${baseUrl}/mcp`, {
        method: 'POST', headers: { ...headers, 'mcp-session-id': sid },
        body: JSON.stringify({ jsonrpc: '2.0', id: id++, method: 'tools/call', params: { name, arguments: args } }),
      });
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text, text).not.toContain('"isError":true');
      return text;
    };

    const created = await call('hadron_create_comment', { targetRef: `hrn:node:cmtmcp.example:team-shared:plan`, body: 'From Iris' });
    expect(created).toContain('worker Iris (hrn:worker:cmtmcp.example:team:iris) (you)');

    const meta = await db.commentMeta.findFirstOrThrow({ where: { targetNodeId: appTarget.id }, include: { node: { select: { createdBy: true, createdByWorkerId: true } } } });
    expect(meta.authorKey).toBe(`w:${iris.id}`);
    // The binding user is provenance only, recorded beside the worker.
    expect(meta.node).toEqual({ createdBy: writer.id, createdByWorkerId: iris.id });
  });
});
