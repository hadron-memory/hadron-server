/**
 * #2987 (ruling V13) — a message node (`chat-message` / `record`) outside any
 * Channel is protected history: no generic door rewrites or sets its `seq`.
 *
 * Doors: GraphQL createNode/updateNode and MCP hadron_create_node /
 * hadron_update_node (the MCP tools carry their own inline copy of the write
 * gates, so each is pinned on its own). Scope is `seq` only: a content edit, an
 * ordinary node's seq, and every allocator path stay allowed.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GraphQLError } from 'graphql';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';
import { createTestableMcpServer } from '../../../mcp/server.js';
import { appendChatMessage } from '../../../lib/chatRoot.js';
import { getMemoryEncryptionInfo } from '../../../lib/nodeCrypto.js';
import { buildNodeRevisionSnapshot, createNodeRevision, editorFromAuth } from '../../../lib/nodeRevisionSnapshot.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

const M = resolvers.Mutation as unknown as Record<string, (p: unknown, a: unknown, c: Context) => Promise<any>>;

let admin: { id: string };
let member: { id: string };
let memory: { id: string; urn: string };

const as = (userId = member.id): Context => ({ db, userId, roles: [] });
const mcpFor = (userId: string, roles: string[] = []) =>
  createTestableMcpServer({ userId, roles, clientId: `user:${userId}` } as never, { sessionId: `seq-${generateId()}`, cachedAppResolution: { kind: 'multi-app' } });
const urn = (loc: string) => `hrn:node:${memory.urn}:${loc}`;
const errorOf = async (p: Promise<unknown>): Promise<GraphQLError> => {
  try { await p; } catch (e) { return e as GraphQLError; }
  throw new Error('expected a refusal');
};
const mk = (loc: string, nodeType: string, seq: number | null, extra: Record<string, unknown> = {}) =>
  db.node.create({ data: { id: generateId(), memoryId: memory.id, loc, name: loc, nodeType, seq, content: `c ${loc}`, ...extra } });
const revisions = (nodeId: string) => db.nodeRevision.count({ where: { nodeId } });

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), name: 'Seq Org', urn: 'seq2987.example' } });
  admin = await db.user.create({ data: { githubId: 298701, githubUsername: 'seq-admin', handle: 'seq-admin', roles: ['ADMIN'] } });
  member = await db.user.create({ data: { githubId: 298702, githubUsername: 'seq-member', handle: 'seq-member', roles: [] } });
  await db.orgMember.createMany({ data: [
    { organizationId: org.id, userId: admin.id, role: 'ADMIN' },
    { organizationId: org.id, userId: member.id, role: 'ADMIN' },
  ] });
  memory = await resolvers.Mutation.createMemory(null, { orgId: org.id, name: 'seq' }, as());
  // A legacy chat: a root and ordered messages with no Channel row anywhere.
  await mk('chats:legacy', 'chat', null);
  await mk('chats:legacy:messages', 'record', null);
  await mk('chats:legacy:messages:001', 'chat-message', 1);
  await mk('chats:legacy:messages:002', 'chat-message', 2);
  await mk('chats:legacy:messages:003', 'record', 3);
});

describe('GraphQL doors refuse a generic seq write on a legacy message (V13)', () => {
  it.each(['chats:legacy:messages:001', 'chats:legacy:messages:003'])('updateNode(seq) on %s is refused and writes nothing', async (loc) => {
    const row = await db.node.findFirstOrThrow({ where: { loc, memoryId: memory.id } });
    const before = await revisions(row.id);
    const err = await errorOf(M.updateNode(null, { input: { id: row.id, seq: 99 } }, as()));
    expect(err.extensions.code).toBe('SEQ_PROTECTED');
    const after = await db.node.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.seq).toBe(row.seq);
    expect(after.revSeq).toBe(row.revSeq);
    expect(await revisions(row.id)).toBe(before);
  });

  it('createNode(seq) for a chat-message or record outside a Channel is refused and creates no row', async () => {
    for (const nodeType of ['chat-message', 'record']) {
      const loc = `chats:legacy:messages:new-${nodeType}`;
      const err = await errorOf(M.createNode(null, { input: { memoryId: memory.id, loc, name: 'x', nodeType, seq: 7 } }, as()));
      expect(err.extensions.code).toBe('SEQ_PROTECTED');
      expect(await db.node.count({ where: { memoryId: memory.id, loc } })).toBe(0);
    }
  });

  it('applies to a platform admin too, and to converting an ordinary node into a message with a seq', async () => {
    const row = await db.node.findFirstOrThrow({ where: { loc: 'chats:legacy:messages:002', memoryId: memory.id } });
    expect((await errorOf(M.updateNode(null, { input: { id: row.id, seq: 5 } }, { db, userId: admin.id, roles: ['ADMIN'] }))).extensions.code).toBe('SEQ_PROTECTED');
    const plain = await mk('notes:plain', 'info', 4);
    expect((await errorOf(M.updateNode(null, { input: { id: plain.id, nodeType: 'chat-message', seq: 9 } }, as()))).extensions.code).toBe('SEQ_PROTECTED');
    expect((await db.node.findUniqueOrThrow({ where: { id: plain.id } })).nodeType).toBe('info');
  });

  it('clearing a message seq (seq: null) is a seq write too', async () => {
    const row = await db.node.findFirstOrThrow({ where: { loc: 'chats:legacy:messages:001', memoryId: memory.id } });
    expect((await errorOf(M.updateNode(null, { input: { id: row.id, seq: null } }, as()))).extensions.code).toBe('SEQ_PROTECTED');
    expect((await db.node.findUniqueOrThrow({ where: { id: row.id } })).seq).toBe(1);
  });
});

describe('changing the type away from a message does not escape the gate (Bruno BLIND P2)', () => {
  it('updateNode and hadron_update_node refuse seq + nodeType: info on a legacy message, changing neither field nor history', async () => {
    const row = await db.node.findFirstOrThrow({ where: { loc: 'chats:legacy:messages:002', memoryId: memory.id } });
    expect((await errorOf(M.updateNode(null, { input: { id: row.id, nodeType: 'info', seq: 99 } }, as()))).extensions.code).toBe('SEQ_PROTECTED');
    expect(await mcpFor(member.id).callToolText('hadron_update_node', { urn: urn(row.loc), nodeType: 'info', seq: 99 })).toMatch(/^\[seq_protected\]/);
    const after = await db.node.findUniqueOrThrow({ where: { id: row.id } });
    expect([after.nodeType, after.seq, after.revSeq]).toEqual([row.nodeType, row.seq, row.revSeq]);
    expect(await revisions(row.id)).toBe(0);
  });

  it('a create over a soft-deleted message loc cannot swap the type and set a seq (GraphQL and MCP)', async () => {
    for (const loc of ['chats:legacy:messages:001', 'chats:legacy:messages:002']) {
      await db.node.updateMany({ where: { loc, memoryId: memory.id }, data: { deletedAt: new Date() } });
    }
    expect((await errorOf(M.createNode(null, { input: { memoryId: memory.id, loc: 'chats:legacy:messages:001', name: 'x', nodeType: 'info', seq: 55 } }, as()))).extensions.code).toBe('SEQ_PROTECTED');
    expect(await mcpFor(member.id).callToolText('hadron_create_node', { urn: urn('chats:legacy:messages:002'), name: 'x', nodeType: 'info', seq: 56 })).toMatch(/^\[seq_protected\]/);
    for (const loc of ['chats:legacy:messages:001', 'chats:legacy:messages:002']) {
      const r = await db.node.findFirstOrThrow({ where: { loc, memoryId: memory.id } });
      expect([r.nodeType, r.deletedAt !== null]).toEqual(['chat-message', true]);
    }
  });
});

describe('MCP doors refuse the same, with the same message (V13)', () => {
  it('hadron_update_node and hadron_create_node carry the GraphQL refusal verbatim', async () => {
    const mcp = mcpFor(member.id);
    const row = await db.node.findFirstOrThrow({ where: { loc: 'chats:legacy:messages:001', memoryId: memory.id } });
    const gql = await errorOf(M.updateNode(null, { input: { id: row.id, seq: 99 } }, as()));
    const updated = await mcp.callToolText('hadron_update_node', { urn: urn(row.loc), seq: 99 });
    expect(updated).toBe(`[seq_protected] ${gql.message}`);
    expect((await db.node.findUniqueOrThrow({ where: { id: row.id } })).seq).toBe(1);
    expect(await revisions(row.id)).toBe(0);

    const loc = 'chats:legacy:messages:mcp-new';
    const created = await mcp.callToolText('hadron_create_node', { urn: urn(loc), name: 'x', nodeType: 'chat-message', seq: 8 });
    expect(created).toMatch(/^\[seq_protected\]/);
    expect(await db.node.count({ where: { memoryId: memory.id, loc } })).toBe(0);
  });

  it('a platform admin over MCP is refused too', async () => {
    const mcp = mcpFor(admin.id, ['ADMIN']);
    expect(await mcp.callToolText('hadron_update_node', { urn: urn('chats:legacy:messages:002'), seq: 50 })).toMatch(/^\[seq_protected\]/);
  });
});

describe('no over-reach', () => {
  it('an ordinary node keeps its seq writes on update and create, through both doors', async () => {
    const plain = await mk('notes:ord', 'info', 1);
    await M.updateNode(null, { input: { id: plain.id, seq: 42 } }, as());
    expect((await db.node.findUniqueOrThrow({ where: { id: plain.id } })).seq).toBe(42);
    await M.createNode(null, { input: { memoryId: memory.id, loc: 'notes:ord2', name: 'o', nodeType: 'info', seq: 5 } }, as());
    expect((await db.node.findFirstOrThrow({ where: { loc: 'notes:ord2', memoryId: memory.id } })).seq).toBe(5);
    const mcp = mcpFor(member.id);
    expect(await mcp.callToolText('hadron_update_node', { urn: urn('notes:ord'), seq: 43 })).not.toMatch(/seq_protected/);
    expect(await mcp.callToolText('hadron_create_node', { urn: urn('notes:ord3'), name: 'o', nodeType: 'info', seq: 6 })).not.toMatch(/seq_protected/);
    expect((await db.node.findFirstOrThrow({ where: { loc: 'notes:ord' , memoryId: memory.id } })).seq).toBe(43);
    expect((await db.node.findFirstOrThrow({ where: { loc: 'notes:ord3', memoryId: memory.id } })).seq).toBe(6);
  });

  it('a content edit of a legacy message (no seq, or the unchanged seq) is not a seq write', async () => {
    const row = await db.node.findFirstOrThrow({ where: { loc: 'chats:legacy:messages:001', memoryId: memory.id } });
    await M.updateNode(null, { input: { id: row.id, content: 'edited' } }, as());
    await M.updateNode(null, { input: { id: row.id, content: 'edited again', seq: 1 } }, as());
    const after = await db.node.findUniqueOrThrow({ where: { id: row.id } });
    expect([after.content, after.seq]).toEqual(['edited again', 1]);
    expect(await mcpFor(member.id).callToolText('hadron_update_node', { urn: urn(row.loc), content: 'via mcp', seq: 1 })).not.toMatch(/seq_protected/);
  });

  it('a message created without a seq outside a Channel is still allowed', async () => {
    await M.createNode(null, { input: { memoryId: memory.id, loc: 'chats:legacy:messages:004', name: 'm', nodeType: 'chat-message' } }, as());
    expect(await db.node.count({ where: { memoryId: memory.id, loc: 'chats:legacy:messages:004' } })).toBe(1);
  });

  it('a Channel message keeps its existing LOC_PROTECTED refusal (not SEQ_PROTECTED)', async () => {
    const channel = await M.createChannel(null, { input: { memoryRef: memory.urn, loc: 'chats:room', name: 'room' } }, as());
    await M.createChannelMessage(null, { channelRef: channel.id, body: 'hello' }, as());
    const msg = await db.node.findFirstOrThrow({ where: { memoryId: memory.id, loc: { startsWith: 'chats:room:' }, nodeType: { in: ['chat-message', 'record'] }, seq: { not: null } } });
    expect((await errorOf(M.updateNode(null, { input: { id: msg.id, seq: 77 } }, as()))).extensions.code).toBe('LOC_PROTECTED');
    expect(await mcpFor(member.id).callToolText('hadron_update_node', { urn: urn(msg.loc), seq: 77 })).toMatch(/^\[loc_protected\]/);
  });
});

describe('LOCAL review P2s on 0f581af6 (Beckett)', () => {
  it('MCP create under a Channel keeps LOC_PROTECTED, like GraphQL, even with a seq', async () => {
    const channel = await M.createChannel(null, { input: { memoryRef: memory.urn, loc: 'chats:guarded', name: 'guarded' } }, as());
    const loc = 'chats:guarded:messages:forged';
    const gql = await errorOf(M.createNode(null, { input: { memoryId: memory.id, loc, name: 'x', nodeType: 'chat-message', seq: 9 } }, as()));
    expect(gql.extensions.code).toBe('LOC_PROTECTED');
    // The create door's tx catch has no LocProtectedError mapping (unchanged by #2987), so the Channel refusal
    // surfaces as the thrown LocProtectedError; what is pinned is WHICH refusal wins, not its envelope.
    const text = await mcpFor(member.id).callToolText('hadron_create_node', { urn: urn(loc), name: 'x', nodeType: 'chat-message', seq: 9 })
      .catch((e: Error) => `${e.name}: ${e.message}`);
    expect(text).toMatch(/LocProtectedError|loc_protected/i);
    expect(text).not.toMatch(/seq_protected/i);
    expect(channel.id).toBeTruthy();
    expect(await db.node.count({ where: { memoryId: memory.id, loc } })).toBe(0);
  });

  it('recreating a soft-deleted message at its own seq is not a seq write, on both doors', async () => {
    const mcp = mcpFor(member.id);
    for (const [loc, seq] of [['chats:legacy:messages:001', 1], ['chats:legacy:messages:002', 2]] as const) {
      await db.node.updateMany({ where: { loc, memoryId: memory.id }, data: { deletedAt: new Date() } });
      const out = loc.endsWith('001')
        ? await M.createNode(null, { input: { memoryId: memory.id, loc, name: 'back', nodeType: 'chat-message', seq } }, as()).then(() => 'ok')
        : await mcp.callToolText('hadron_create_node', { urn: urn(loc), name: 'back', nodeType: 'chat-message', seq });
      expect(out).not.toMatch(/seq_protected/);
      const r = await db.node.findFirstOrThrow({ where: { loc, memoryId: memory.id } });
      expect([r.deletedAt, r.seq]).toEqual([null, seq]);
    }
  });
});

describe('SECURITY §10 P2s on 7b2276e1 (Rico)', () => {
  it('P2-1: retype away, set a seq, retype back never ends with a moved message, on both doors', async () => {
    const mcp = mcpFor(member.id);
    const g = await db.node.findFirstOrThrow({ where: { loc: 'chats:legacy:messages:001', memoryId: memory.id } });
    // The three single-purpose writes, each judged on its own: the LAST one (becoming a message while carrying a seq) is refused.
    await M.updateNode(null, { input: { id: g.id, nodeType: 'info' } }, as());
    await M.updateNode(null, { input: { id: g.id, seq: 99 } }, as());
    expect((await errorOf(M.updateNode(null, { input: { id: g.id, nodeType: 'chat-message' } }, as()))).extensions.code).toBe('SEQ_PROTECTED');
    expect((await db.node.findUniqueOrThrow({ where: { id: g.id } })).nodeType).toBe('info');

    const m = await db.node.findFirstOrThrow({ where: { loc: 'chats:legacy:messages:002', memoryId: memory.id } });
    await mcp.callToolText('hadron_update_node', { urn: urn(m.loc), nodeType: 'info' });
    await mcp.callToolText('hadron_update_node', { urn: urn(m.loc), seq: 77 });
    expect(await mcp.callToolText('hadron_update_node', { urn: urn(m.loc), nodeType: 'chat-message' })).toMatch(/^\[seq_protected\]/);
    expect((await db.node.findUniqueOrThrow({ where: { id: m.id } })).nodeType).toBe('info');
  });

  it('P2-1 variant: an info node carrying a seq cannot become a message (insert at a position), on both doors', async () => {
    const a = await mk('chats:legacy:messages:ins-a', 'info', 1);
    const b = await mk('chats:legacy:messages:ins-b', 'info', 2);
    expect((await errorOf(M.updateNode(null, { input: { id: a.id, nodeType: 'chat-message' } }, as()))).extensions.code).toBe('SEQ_PROTECTED');
    expect(await mcpFor(member.id).callToolText('hadron_update_node', { urn: urn(b.loc), nodeType: 'record' })).toMatch(/^\[seq_protected\]/);
    expect(await db.node.count({ where: { id: { in: [a.id, b.id] }, nodeType: 'info' } })).toBe(2);
    // a seq-less node may become a message: only an allocator-less message is unordered
    const c = await mk('chats:legacy:messages:ins-c', 'info', null);
    await M.updateNode(null, { input: { id: c.id, nodeType: 'chat-message' } }, as());
    expect((await db.node.findUniqueOrThrow({ where: { id: c.id } })).nodeType).toBe('chat-message');
  });

  it('P2-2: restoreNodeRevision cannot rewrite a message seq from a revision', async () => {
    const row = await db.node.findFirstOrThrow({ where: { loc: 'chats:legacy:messages:003', memoryId: memory.id } });
    await db.node.update({ where: { id: row.id }, data: { seq: 3 } });
    await createNodeRevision(db, buildNodeRevisionSnapshot(await db.node.findUniqueOrThrow({ where: { id: row.id } }), editorFromAuth({ userId: member.id }), { revLabel: 'edit', changes: ['content'] }));
    await db.node.update({ where: { id: row.id }, data: { seq: 40 } });
    const rev = await db.nodeRevision.findFirstOrThrow({ where: { nodeId: row.id } });
    expect((await errorOf(M.restoreNodeRevision(null, { revisionId: rev.id }, as()))).extensions.code).toBe('SEQ_PROTECTED');
    expect((await db.node.findUniqueOrThrow({ where: { id: row.id } })).seq).toBe(40);
  });

  it('P3-1: cloneNode of a message with a seq still works (the copiesSeq exemption)', async () => {
    const src = await db.node.findFirstOrThrow({ where: { loc: 'chats:legacy:messages:001', memoryId: memory.id } });
    const copy = await M.cloneNode(null, { sourceRef: src.id, targetUrn: urn('chats:legacy:messages:copy-of-001') }, as());
    expect([copy.nodeType, copy.seq]).toEqual(['chat-message', 1]);
  });
});

describe('allocator paths still assign seq', () => {
  it('createChannelMessage, createTeamChatMessage-style appends and the chat-root allocator', async () => {
    const channel = await M.createChannel(null, { input: { memoryRef: memory.urn, loc: 'chats:alloc', name: 'alloc' } }, as());
    const a = await M.createChannelMessage(null, { channelRef: channel.id, body: 'one' }, as());
    const b = await M.createChannelMessage(null, { channelRef: channel.id, body: 'two' }, as());
    expect([a.seq, b.seq]).toEqual([1, 2]);

    // The legacy chat allocator (sendChatMessage / processChatResponse use it).
    const root = await db.node.findFirstOrThrow({ where: { loc: 'chats:legacy', memoryId: memory.id } });
    const enc = await getMemoryEncryptionInfo(db, memory.id);
    const out = await appendChatMessage(db, { id: root.id, memoryId: memory.id, loc: root.loc } as never, enc, async ({ tx, seq, msgNum }) => {
      await tx.node.create({ data: { id: generateId(), memoryId: memory.id, loc: `chats:legacy:messages:${msgNum}-x-user`, name: 'm', nodeType: 'chat-message', seq } });
      return seq;
    });
    expect(out.seq).toBeGreaterThan(0);
    expect(await db.node.count({ where: { memoryId: memory.id, loc: { contains: '-x-user' }, seq: out.seq } })).toBe(1);
  });
});
