/** #2175: explicit writer-only recovery, preserving ordinary read and single-node restore semantics. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';
import { encryptNodeFieldsWithKey } from '../../../lib/nodeCrypto.js';
import { parseDataKey } from '../../../lib/crypto.js';
import { requestKeyStorage } from '../../../lib/requestKeys.js';
import { writeNodeToGit } from '../../../integrations/github/writeNodeToGit.js';
import { waitForLockWaiters } from '../../../test/lockWait.js';
import { lockAuthorityAnchors } from '../../../lib/auth/authorityAnchors.js';
import { lockMemoryConfigExclusive } from '../../../lib/governedRole.js';
import { lockMemoryForChannelChange } from '../../../lib/channels.js';
import { acquireLockSet } from '../../../lib/nodeSubtreeLock.js';
import { createTestableMcpServer } from '../../../mcp/server.js';
import { buildSchema, defaultFieldResolver, graphql } from 'graphql';
import { typeDefs } from './typeDefs.js';
import { publishNodeWritten } from '../../../lib/events/nodeWritten.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../lib/events/nodeWritten.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../lib/events/nodeWritten.js')>(),
  publishNodeWritten: vi.fn().mockResolvedValue(undefined),
}));
const Q = resolvers.Query as unknown as Record<string, (p: unknown, a: any, c: Context) => Promise<any>>;
const M = resolvers.Mutation as unknown as Record<string, (p: unknown, a: any, c: Context) => Promise<any>>;
let memoryId: string, writerId: string, readerId: string;
const ctx = (userId = writerId): Context => ({ db, userId, roles: [] });
const node = (loc: string, extra: Record<string, unknown> = {}) => db.node.create({ data: {
  id: generateId(), memoryId, loc, name: loc, content: 'raw {{missing}}', deletedAt: new Date('2026-01-01'), ...extra,
} });
beforeEach(async () => {
  vi.clearAllMocks();
  await cleanDb(db);
  const org = await db.organization.create({ data: { name: 'Recovery', urn: 'recovery2175.example' } });
  writerId = (await db.user.create({ data: { handle: 'recovery-writer' } })).id;
  readerId = (await db.user.create({ data: { handle: 'recovery-reader' } })).id;
  await db.orgMember.createMany({ data: [
    { organizationId: org.id, userId: writerId, role: 'CONTRIBUTOR' },
    { organizationId: org.id, userId: readerId, role: 'READER' },
  ] });
  memoryId = (await db.memory.create({ data: { organizationId: org.id, class: 'knowledge', name: 'Recovery', urn: 'recovery2175.example:corpus' } })).id;
});

describe('explicit recovery reads', () => {
  it.each([{}, { query: 'feedback', mode: 'keyword' }, { query: 'feedback', mode: 'regex' }])('keeps independently deleted comments out of generic recovery and inventory: %j', async (search) => {
    const target = await node('comments', { deletedAt: null, content: 'ordinary target' });
    const removed = await M.createComment({}, { targetRef: target.id, body: 'removed feedback' }, ctx());
    await M.deleteComment({}, { commentRef: removed.id, expectedRevision: 1 }, ctx());
    expect((await db.node.findUniqueOrThrow({ where: { id: removed.id } })).content).toBe('removed feedback');
    const live = await M.createComment({}, { targetRef: target.id, body: 'current feedback' }, ctx());
    expect(await Q.recoveryNode({}, { nodeRef: removed.id }, ctx())).toBeNull();
    expect(await Q.recoveryNodes({}, { memoryRef: memoryId }, ctx())).toMatchObject({ total: 0, items: [] });
    const graph = await Q.recoveryEdges({}, { memoryRef: memoryId }, ctx());
    expect(graph.total).toBe(1);
    expect(graph.items.every((edge: any) => edge.source.id !== removed.id && edge.target.id !== removed.id)).toBe(true);
    const inventory = await Q.findNodes({}, { ...search, filter: { memoryIds: [memoryId], includeDeleted: true, contentScope: 'COMMENTS' }, sort: 'loc', limit: 1 }, ctx());
    expect(inventory.hits.map((hit: any) => hit.node.id)).toEqual([live.id]);
    const both = await Q.findNodes({}, { ...search, filter: { memoryIds: [memoryId], includeDeleted: true, contentScope: 'BOTH', nodeType: 'comment' }, sort: 'loc', limit: 1 }, ctx());
    expect(both.hits.map((hit: any) => hit.node.id)).toEqual([live.id]);
    const mcp = createTestableMcpServer({ userId: writerId, roles: [], clientId: `user:${writerId}` });
    expect(await mcp.callTool('hadron_get_recovery_node', { nodeRef: removed.id })).toMatchObject({ isError: true });
    expect(JSON.parse(await mcp.callToolText('hadron_list_recovery_nodes', { memoryRef: memoryId }))).toMatchObject({ total: 0, items: [] });
    expect(await mcp.callToolText('hadron_list_recovery_edges', { memoryRef: memoryId })).not.toContain(removed.id);
    await expect(M.restoreNode({}, { nodeRef: removed.id }, ctx())).rejects.toMatchObject({ extensions: { code: 'ROLE_GOVERNED', kind: 'comment' } });
  });
  it('filters appNodes deleted inventory before its limit for readers while retaining writer recovery', async () => {
    const memory = await db.memory.findUniqueOrThrow({ where: { id: memoryId } });
    const app = await db.app.create({ data: { name: 'Recovery app', urn: 'recovery2175.example:app', organizationId: memory.organizationId } });
    const agent = await db.agent.create({ data: { name: 'Recovery agent', urn: 'recovery2175.example:agent', organizationId: memory.organizationId } });
    await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
    await db.agentMemoryItem.create({ data: { agentId: agent.id, memoryId, role: 'read-write' } });
    const retained = await node('a'), live = await node('z', { deletedAt: null });
    const request = { appRef: app.id, filter: { includeDeleted: true }, limit: 1 };
    expect((await Q.appNodes({}, request, ctx(readerId))).map((item: any) => item.id)).toEqual([live.id]);
    expect((await Q.appNodes({}, request, ctx())).map((item: any) => item.id)).toEqual([retained.id]);
  });
  it('keeps user-owned recovery owner-scoped when both callers share an unrelated organization', async () => {
    await db.memory.update({ where: { id: memoryId }, data: { organizationId: null, ownerUserId: writerId, urn: 'recovery-writer:corpus' } });
    const retained = await node('a');
    expect(await Q.recoveryNode({}, { nodeRef: retained.id }, ctx(readerId))).toBeNull();
    await expect(Q.recoveryNodes({}, { memoryRef: memoryId }, ctx(readerId))).rejects.toThrow();
    expect(await Q.recoveryNode({}, { nodeRef: retained.id }, ctx())).toMatchObject({ id: retained.id });
    expect(await M.restoreNode({}, { nodeRef: retained.id }, ctx())).toMatchObject({ deletedAt: null });
  });
  it('executes real GraphQL recovery DTO fields, nullable edge names, and restore selection', async () => {
    const retained = await node('a'), live = await node('b', { deletedAt: null });
    await db.edge.create({ data: { memoryId, sourceId: live.id, targetId: retained.id, loc: 'b:related:a' } });
    const schema = buildSchema(typeDefs);
    const execute = (source: string) => graphql({ schema, source, contextValue: ctx(), fieldResolver: (parent, args, context, info) => {
      const fields = resolvers[info.parentType.name as keyof typeof resolvers] as Record<string, Function> | undefined;
      const resolver = fields?.[info.fieldName];
      return typeof resolver === 'function' ? resolver(parent, args, context, info) : defaultFieldResolver(parent, args, context, info);
    } });
    const read = await execute(`{ recoveryNode(nodeRef: "${retained.id}") { id content } recoveryEdges(memoryRef: "${memoryId}") { total items { name target { id } } } }`);
    expect(read.errors).toBeUndefined();
    expect(read.data).toMatchObject({ recoveryNode: { id: retained.id, content: retained.content }, recoveryEdges: { total: 1, items: [{ name: null, target: { id: retained.id } }] } });
    const restored = await execute(`mutation { restoreNode(nodeRef: "${retained.id}") { id deletedAt } }`);
    expect(restored.errors).toBeUndefined();
    expect(restored.data).toMatchObject({ restoreNode: { id: retained.id, deletedAt: null } });
  });
  it('keeps MCP recovery and restore behind the same reader/writer gates', async () => {
    const retained = await node('a');
    const writer = createTestableMcpServer({ userId: writerId, roles: [], clientId: `user:${writerId}` });
    const reader = createTestableMcpServer({ userId: readerId, roles: [], clientId: `user:${readerId}` });
    expect(await reader.callTool('hadron_get_recovery_node', { nodeRef: retained.id })).toMatchObject({
      isError: true, content: [{ type: 'text', text: '[not_found] No deleted node you can recover at that reference.' }],
    });
    expect(await reader.callTool('hadron_restore_node', { nodeRef: retained.id })).toMatchObject({ isError: true });
    const raw = JSON.parse(await writer.callToolText('hadron_get_recovery_node', { nodeRef: retained.id }));
    expect(raw.content).toBe('raw {{missing}}');
    expect(raw).not.toHaveProperty('_retainedNode');
    const page = JSON.parse(await writer.callToolText('hadron_list_recovery_nodes', { memoryRef: memoryId, limit: null }));
    expect(page.total).toBe(1);
    const restored = JSON.parse(await writer.callToolText('hadron_restore_node', { nodeRef: retained.id }));
    expect(restored).toMatchObject({ id: retained.id, deletedAt: null });
    for (const ref of [retained.id, generateId()]) {
      expect(await writer.callTool('hadron_get_recovery_node', { nodeRef: ref })).toMatchObject({
        isError: true, content: [{ type: 'text', text: '[not_found] No deleted node you can recover at that reference.' }],
      });
    }
  });
  it.each([
    {},
    { filter: { where: { path: ['kind'], eq: 'retained' } } },
    { query: 'recoveryneedle', mode: 'keyword' },
    { query: 'recoveryneedle', mode: 'regex' },
  ])('filters legacy deleted inventory before paging for reader and writer: %j', async (args) => {
    const hidden = await node('a', { name: 'recoveryneedle', properties: { kind: 'retained' } });
    const live = await node('z', { name: 'recoveryneedle', properties: { kind: 'retained' }, deletedAt: null });
    const filter = { memoryIds: [memoryId], includeDeleted: true, ...((args as any).filter ?? {}) };
    const request = { ...args, filter, sort: 'loc', limit: 1 };
    const reader = await Q.findNodes({}, request, ctx(readerId));
    expect(reader.hits.map((hit: any) => hit.node.id)).toEqual([live.id]);
    const writer = await Q.findNodes({}, request, ctx());
    expect(writer.hits.map((hit: any) => hit.node.id)).toEqual([hidden.id]);
  });
  it('returns an old retained tombstone without compiling its stored body; normal node read remains null', async () => {
    const n = await node('a');
    expect(await Q.node({}, { ref: n.id }, ctx())).toBeNull();
    const recovered = await Q.recoveryNode({}, { nodeRef: n.id }, ctx());
    expect(recovered).toMatchObject({ id: n.id, deletedAt: n.deletedAt });
    // Content is a selection-time resolver so encrypted metadata inspection needs no plaintext key.
    const R = resolvers.RecoveryNode as unknown as Record<string, (...a: any[]) => Promise<unknown>>;
    expect(await R.content(recovered, {}, ctx())).toBe('raw {{missing}}');
    expect(recovered.urn).toBe('hrn:node:recovery2175.example:corpus:a');
  });
  it('conceals deleted content from a reader and treats live nodes as absent on the recovery point read', async () => {
    const n = await node('a');
    expect(await Q.recoveryNode({}, { nodeRef: n.id }, ctx(readerId))).toBeNull();
    await db.node.update({ where: { id: n.id }, data: { deletedAt: null } });
    expect(await Q.recoveryNode({}, { nodeRef: n.id }, ctx())).toBeNull();
  });
  it('defaults omitted and null pages to20, with exact total and continuation', async () => {
    for (let i = 0; i < 23; i++) await node(`n${String(i).padStart(2, '0')}`);
    await node('live', { deletedAt: null });
    for (const args of [{ memoryRef: memoryId }, { memoryRef: memoryId, limit: null }]) {
      const p = await Q.recoveryNodes({}, args, ctx());
      expect(p.total).toBe(23); expect(p.items).toHaveLength(20);
    }
    const tail = await Q.recoveryNodes({}, { memoryRef: memoryId, offset: 20 }, ctx());
    expect(tail.total).toBe(23); expect(tail.items).toHaveLength(3);
  });
  it('caps explicit pages at200 and clamps a negative offset', async () => {
    await db.node.createMany({ data: Array.from({ length: 201 }, (_, index) => ({ id: generateId(), memoryId,
      loc: `n${String(index).padStart(3, '0')}`, name: 'Retained', deletedAt: new Date() })) });
    const page = await Q.recoveryNodes({}, { memoryRef: memoryId, limit: 999, offset: -4 }, ctx());
    expect(page.total).toBe(201); expect(page.items).toHaveLength(200);
    expect(page.items[0].loc).toBe('n000');
  });
  it.each([
    { userId: undefined },
    { appKeyId: 'synthetic-app-key' },
    { impersonation: { orgId: 'synthetic-org' } },
    { clientId: 'run:synthetic' },
  ])('does not infer a recovery audience from excluded principal %j', async (principal) => {
    const retained = await node('a');
    const excluded = { ...ctx(), ...principal } as Context;
    if (excluded.impersonation) {
      excluded.impersonation = { ...excluded.impersonation,
        orgId: (await db.memory.findUniqueOrThrow({ where: { id: memoryId } })).organizationId! };
      const live = await node('live', { deletedAt: null });
      expect(await Q.node({}, { ref: live.id }, excluded)).toMatchObject({ id: live.id });
    }
    expect(await Q.recoveryNode({}, { nodeRef: retained.id }, excluded)).toBeNull();
    await expect(Q.recoveryNodes({}, { memoryRef: memoryId }, excluded)).rejects.toThrow();
    await expect(M.restoreNode({}, { nodeRef: retained.id }, excluded)).rejects.toThrow();
  });
  it('refuses a reader-only listing rather than exposing its count', async () => {
    await node('a');
    await expect(Q.recoveryNodes({}, { memoryRef: memoryId }, ctx(readerId))).rejects.toThrow();
  });
  it('never opens a tombstone inside a deleted memory', async () => {
    const n = await node('a');
    await db.memory.update({ where: { id: memoryId }, data: { deletedAt: new Date() } });
    expect(await Q.recoveryNode({}, { nodeRef: n.id }, ctx())).toBeNull();
  });
});

describe('single-node restore', () => {
  it('restores TARGET-deleted thread members but preserves independent ADMIN and AUTHOR deletions', async () => {
    await db.orgMember.updateMany({ where: { userId: writerId }, data: { role: 'ADMIN' } });
    const target = await node('discussion', { deletedAt: null, content: 'body' });
    const adminDeleted = await M.createComment({}, { targetRef: target.id, body: 'removed by manager' }, ctx());
    await M.deleteCommentThread({}, { commentRef: adminDeleted.id, reason: 'explicit removal' }, ctx());
    const authorDeleted = await M.createComment({}, { targetRef: target.id, body: 'removed by author' }, ctx());
    await M.deleteComment({}, { commentRef: authorDeleted.id, expectedRevision: 1 }, ctx());
    const kept = await M.createComment({}, { targetRef: target.id, body: 'discussion retained' }, ctx());
    const reply = await M.replyToComment({}, { commentRef: kept.id, body: 'reply retained' }, ctx());
    await M.deleteNode({}, { nodeRef: target.id }, ctx());
    for (const id of [kept.id, reply.id]) expect(await db.commentMeta.findUniqueOrThrow({ where: { nodeId: id } })).toMatchObject({ threadDeletedCause: 'TARGET' });
    await M.restoreNode({}, { nodeRef: target.id }, ctx());
    for (const id of [kept.id, reply.id]) {
      expect(await db.node.findUniqueOrThrow({ where: { id } })).toMatchObject({ deletedAt: null, deletedBy: null });
      expect(await db.commentMeta.findUniqueOrThrow({ where: { nodeId: id } })).toMatchObject({ threadDeletedCause: null, threadDeletedAt: null });
    }
    for (const [id, cause] of [[adminDeleted.id, 'ADMIN'], [authorDeleted.id, 'AUTHOR']]) {
      expect((await db.node.findUniqueOrThrow({ where: { id } })).deletedAt).not.toBeNull();
      expect((await db.commentMeta.findUniqueOrThrow({ where: { nodeId: id } })).threadDeletedCause).toBe(cause);
    }
  });
  it('keeps a retained destination occupied while an actual destination move waits ahead of restore', async () => {
    const retained = await node('a'), source = await node('source', { deletedAt: null, content: 'source body' });
    let held!: () => void, release!: () => void;
    const holding = new Promise<void>((resolve) => { held = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const blocker = db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM memories WHERE id = ${memoryId} FOR UPDATE`;
      held(); await gate;
    }, { timeout: 15_000 });
    await holding;
    const moving = M.moveNode({}, { sourceRef: source.id, targetUrn: 'hrn:node:recovery2175.example:corpus:a' }, ctx()).then(() => null, (error: unknown) => error);
    let restoration: Promise<any>;
    try {
      await waitForLockWaiters(db, 1);
      restoration = M.restoreNode({}, { nodeRef: retained.id }, ctx()).then(
        (value: any) => ({ value, error: undefined }), (error: any) => ({ value: undefined, error }));
      await waitForLockWaiters(db, 2);
    } finally { release(); }
    await blocker;
    expect(await moving).toBeInstanceOf(Error);
    expect((await restoration!).error).toBeUndefined();
    expect(await db.node.findUniqueOrThrow({ where: { id: source.id } })).toMatchObject({ loc: 'source', content: 'source body' });
    expect(await db.node.findUniqueOrThrow({ where: { id: retained.id } })).toMatchObject({ loc: 'a', deletedAt: null, content: retained.content });
  });
  it('does not follow an idempotent restore target after the actual move resolver wins its address wait', async () => {
    const live = await node('a', { deletedAt: null, content: 'live body' });
    let held!: () => void, release!: () => void;
    const holding = new Promise<void>((resolve) => { held = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const blocker = db.$transaction(async (tx) => {
      await acquireLockSet(tx, [{ memoryId, loc: 'a' }]); held(); await gate;
    }, { timeout: 15_000 });
    await holding;
    const moving = M.moveNode({}, { sourceRef: live.id, targetUrn: 'hrn:node:recovery2175.example:corpus:moved' }, ctx()).then(
      (value: any) => ({ value, error: undefined }), (error: any) => ({ value: undefined, error }));
    let restoration: Promise<any>;
    try {
      await waitForLockWaiters(db, 1);
      restoration = M.restoreNode({}, { nodeRef: live.id }, ctx()).then(() => null, (error: unknown) => error);
      await waitForLockWaiters(db, 2);
    } finally { release(); }
    await blocker;
    expect((await moving).error).toBeUndefined();
    expect(await restoration!).toMatchObject({ extensions: { code: 'NODE_WRITE_CONFLICT' } });
    expect(await db.node.findUniqueOrThrow({ where: { id: live.id } })).toMatchObject({ loc: 'moved', content: 'live body', deletedAt: null });
  });
  it('conceals the target when the actual transfer resolver wins an authority-anchor wait', async () => {
    const retained = await node('a');
    const memory = await db.memory.findUniqueOrThrow({ where: { id: memoryId } });
    const manager = await db.user.create({ data: { handle: 'recovery-manager' } });
    const destination = await db.organization.create({ data: { name: 'Destination', urn: 'recovery-destination.example' } });
    await db.orgMember.createMany({ data: [memory.organizationId!, destination.id].map((organizationId) => ({ organizationId, userId: manager.id, role: 'ADMIN' as const })) });
    const input = { memoryRef: memoryId, orgRef: destination.id };
    const preview = await M.transferMemoryOwnership({}, { ...input, dryRun: true }, ctx(manager.id));
    let held!: () => void, release!: () => void;
    const holding = new Promise<void>((resolve) => { held = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const blocker = db.$transaction(async (tx) => {
      await lockAuthorityAnchors(tx, [{ kind: 'memory', id: memoryId }], 'exclusive'); held(); await gate;
    }, { timeout: 15_000 });
    await holding;
    const transfer = M.transferMemoryOwnership({}, { ...input, expectedNewUrn: preview.newUrn }, ctx(manager.id)).then(
      (value: any) => ({ value, error: undefined }), (error: any) => ({ value: undefined, error }));
    let restoration: Promise<any>;
    try {
      await waitForLockWaiters(db, 1);
      restoration = M.restoreNode({}, { nodeRef: retained.id }, ctx()).then(() => null, (error: unknown) => error);
      await waitForLockWaiters(db, 2);
    } finally { release(); }
    await blocker;
    expect((await transfer).error).toBeUndefined();
    expect(await restoration!).toMatchObject({ extensions: { code: 'NODE_NOT_FOUND' } });
    expect((await db.node.findUniqueOrThrow({ where: { id: retained.id } })).deletedAt).toEqual(retained.deletedAt);
  });
  it('refuses stale restore after the actual encryption flip wins a Memory row wait', async () => {
    await db.memory.update({ where: { id: memoryId }, data: { class: 'private', userId: writerId, vectorIndexEnabled: false } });
    const retained = await node('a');
    let held!: () => void, release!: () => void;
    const holding = new Promise<void>((resolve) => { held = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const blocker = db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM memories WHERE id = ${memoryId} FOR UPDATE`;
      held(); await gate;
    }, { timeout: 15_000 });
    await holding;
    const conversion = M.encryptMemory({}, { memoryId, dataKey: Buffer.alloc(32, 37).toString('base64') }, ctx()).then(
      (value: any) => ({ value, error: undefined }), (error: any) => ({ value: undefined, error }));
    let restoration: Promise<any>;
    try {
      await waitForLockWaiters(db, 1);
      restoration = M.restoreNode({}, { nodeRef: retained.id }, ctx()).then(() => null, (error: unknown) => error);
      await waitForLockWaiters(db, 2);
    } finally { release(); }
    await blocker;
    expect((await conversion).error).toBeUndefined();
    expect(await restoration!).toMatchObject({ extensions: { code: 'NODE_WRITE_CONFLICT' } });
    const row = await db.node.findUniqueOrThrow({ where: { id: retained.id } });
    expect(row.deletedAt).toEqual(retained.deletedAt);
    expect(row.content).not.toBe(retained.content);
  });
  it.each(['hard-target', 'soft-ancestor', 'hard-ancestor'])('serializes the actual delete resolver before restore: %s', async (schedule) => {
    const parent = await node('a', { deletedAt: null }), child = await node('a:b');
    let held!: () => void, release!: () => void;
    const holding = new Promise<void>((resolve) => { held = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const blocker = db.$transaction(async (tx) => {
      await lockMemoryForChannelChange(tx, memoryId);
      held(); await gate;
    }, { timeout: 15_000 });
    await holding;
    const deletion = M.deleteNode({}, { nodeRef: schedule === 'hard-target' ? child.id : parent.id,
      hard: schedule !== 'soft-ancestor', recursive: schedule !== 'hard-target' }, ctx()).then(
        (value: any) => ({ value, error: undefined }), (error: any) => ({ value: undefined, error }));
    let restoration: Promise<any>;
    try {
      await waitForLockWaiters(db, 1);
      restoration = M.restoreNode({}, { nodeRef: child.id }, ctx()).then(() => null, (error: unknown) => error);
      await waitForLockWaiters(db, 2);
    } finally { release(); }
    await blocker;
    expect((await deletion).error).toBeUndefined();
    expect(await restoration!).toBeInstanceOf(Error);
    const row = await db.node.findUnique({ where: { id: child.id } });
    if (schedule === 'soft-ancestor') expect(row?.deletedAt).toEqual(child.deletedAt);
    else expect(row).toBeNull();
  });
  it('judges an ordinary role against the rulebook committed while restore waits', async () => {
    const retained = await node('a', { role: 'notes' });
    const config = await db.memoryConfig.create({ data: { memoryId } });
    const rule = await db.nodeRoleRule.create({ data: { configId: config.id, role: 'notes', writers: 'ALL' } });
    let held!: () => void, release!: () => void;
    const holding = new Promise<void>((resolve) => { held = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const competing = db.$transaction(async (tx) => {
      await lockMemoryConfigExclusive(tx, memoryId);
      await tx.nodeRoleRule.update({ where: { id: rule.id }, data: { writers: 'ADMIN' } });
      held(); await gate;
    }, { timeout: 15_000 });
    await holding;
    const pending = M.restoreNode({}, { nodeRef: retained.id }, ctx()).then(() => null, (error: any) => error);
    try { await waitForLockWaiters(db); } finally { release(); }
    await competing;
    expect(await pending).toMatchObject({ extensions: { code: 'ROLE_WRITER_LEVEL_REQUIRED' } });
    expect((await db.node.findUniqueOrThrow({ where: { id: retained.id } })).deletedAt).toEqual(retained.deletedAt);
    expect(publishNodeWritten).not.toHaveBeenCalled();
    expect(writeNodeToGit).not.toHaveBeenCalled();
  });
  it('observes an ancestor deletion committed during its row-lock wait', async () => {
    const parent = await node('a', { deletedAt: null }), child = await node('a:b');
    let held!: () => void, release!: () => void;
    const holding = new Promise<void>((resolve) => { held = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const competing = db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM nodes WHERE id = ${parent.id} FOR NO KEY UPDATE`;
      held(); await gate;
      await tx.node.update({ where: { id: parent.id }, data: { deletedAt: new Date() } });
    }, { timeout: 15_000 });
    await holding;
    const pending = M.restoreNode({}, { nodeRef: child.id }, ctx()).then(() => null, (error: any) => error);
    try { await waitForLockWaiters(db); } finally { release(); }
    await competing;
    expect(await pending).toMatchObject({ extensions: { code: 'NODE_PARENT_DELETED' } });
    expect((await db.node.findUniqueOrThrow({ where: { id: child.id } })).deletedAt).toEqual(child.deletedAt);
  });
  it.each(['rekey', 'hard-delete', 'replace', 'govern', 'already-restored'])('rechecks a target after a deterministic row-lock wait: %s', async (change) => {
    const retained = await node('a');
    let held!: () => void, release!: () => void;
    const holding = new Promise<void>((resolve) => { held = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const competing = db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM nodes WHERE id = ${retained.id} FOR NO KEY UPDATE`;
      held();
      await gate;
      if (change === 'hard-delete' || change === 'replace') {
        await tx.node.delete({ where: { id: retained.id } });
        if (change === 'replace') await tx.node.create({ data: { memoryId, loc: retained.loc, name: 'Successor', content: 'new successor' } });
      }
      else await tx.node.update({ where: { id: retained.id }, data:
        change === 'rekey' ? { loc: 'moved' } : change === 'govern' ? { role: 'review' } : { deletedAt: null, deletedBy: null } });
    }, { timeout: 15_000 });
    await holding;
    const pending = M.restoreNode({}, { nodeRef: retained.id }, ctx()).then(
      (value: any) => ({ value, error: undefined }), (error: any) => ({ value: undefined, error }));
    try { await waitForLockWaiters(db); } finally { release(); }
    await competing;
    const result = await pending;
    if (change === 'already-restored') expect(result.value?.deletedAt).toBeNull();
    else {
      expect(result.error).toBeDefined();
      const row = await db.node.findUnique({ where: { id: retained.id } });
      if (row) expect(row.deletedAt).toEqual(retained.deletedAt);
      if (change === 'replace') expect(await db.node.findFirst({ where: { memoryId, loc: retained.loc } })).toMatchObject({ name: 'Successor', content: 'new successor', deletedAt: null });
    }
  });
  it('rechecks revoked membership after an authority-anchor wait', async () => {
    const retained = await node('a');
    const memory = await db.memory.findUniqueOrThrow({ where: { id: memoryId } });
    let held!: () => void, release!: () => void;
    const holding = new Promise<void>((resolve) => { held = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const revoker = db.$transaction(async (tx) => {
      await lockAuthorityAnchors(tx, [{ kind: 'org', id: memory.organizationId! }], 'exclusive');
      held(); await gate;
      await tx.orgMember.updateMany({ where: { organizationId: memory.organizationId!, userId: writerId }, data: { deletedAt: new Date() } });
    }, { timeout: 15_000 });
    await holding;
    const pending = M.restoreNode({}, { nodeRef: retained.id }, ctx()).then(() => null, (error: unknown) => error);
    try { await waitForLockWaiters(db); } finally { release(); }
    await revoker;
    expect(await pending).toBeInstanceOf(Error);
    expect((await db.node.findUniqueOrThrow({ where: { id: retained.id } })).deletedAt).toEqual(retained.deletedAt);
  });
  it('keeps encrypted metadata inspectable and requires the request key to restore, but never mirrors the restore to Git (R206)', async () => {
    const key = parseDataKey(Buffer.alloc(32, 37).toString('base64'));
    const stored = encryptNodeFieldsWithKey({ content: 'retained secret' }, key);
    const retained = await node('encrypted', { content: stored.content });
    await db.memory.update({ where: { id: memoryId }, data: { isEncrypted: true, vectorIndexEnabled: false } });
    const point = await Q.recoveryNode({}, { nodeRef: retained.id }, ctx());
    expect(point).toMatchObject({ id: retained.id });
    await requestKeyStorage.run(new Map(), async () => {
      await expect(M.restoreNode({}, { nodeRef: retained.id }, ctx())).rejects.toThrow();
    });
    expect((await db.node.findUniqueOrThrow({ where: { id: retained.id } })).deletedAt).toEqual(retained.deletedAt);
    await requestKeyStorage.run(new Map([[memoryId, key]]), async () => {
      const out = await M.restoreNode({}, { nodeRef: retained.id }, ctx());
      expect(out.content).toBe('retained secret');
      expect(vi.mocked(writeNodeToGit)).not.toHaveBeenCalled();
    });
    expect((await db.node.findUniqueOrThrow({ where: { id: retained.id } })).content).toBe(stored.content);
  });
  it('shows retained endpoints only in recovery DTOs and restores independently live edges without reviving deleted edges', async () => {
    const retained = await node('a');
    const live = await node('b', { deletedAt: null });
    const edge = await db.edge.create({ data: { memoryId, sourceId: live.id, targetId: retained.id, loc: 'b:related:a', name: 'related' } });
    await db.edge.create({ data: { memoryId, sourceId: live.id, targetId: retained.id, loc: 'b:removed:a', name: 'removed', deletedAt: new Date() } });
    expect((await Q.memoryEdges({}, { memoryRef: memoryId }, ctx())).total).toBe(0);
    const E = resolvers.Edge as unknown as Record<string, (...a: any[]) => Promise<unknown>>;
    expect(await E.target(edge, {}, ctx())).toBeNull();
    const recovered = await Q.recoveryEdges({}, { memoryRef: memoryId }, ctx());
    expect(recovered.total).toBe(1);
    expect(recovered.items[0]).toMatchObject({ id: edge.id, target: { id: retained.id, deletedAt: retained.deletedAt } });
    expect(recovered.items[0].target).not.toHaveProperty('content');
    await M.restoreNode({}, { nodeRef: retained.id }, ctx());
    expect((await Q.memoryEdges({}, { memoryRef: memoryId }, ctx())).total).toBe(1);
    expect((await Q.recoveryEdges({}, { memoryRef: memoryId }, ctx())).total).toBe(1);
  });
  it('drops a live endpoint under any deleted ancestor at a \':\' boundary, never under a mere string prefix (#2810)', async () => {
    const hub = await node('hub', { deletedAt: null });
    await node('d');
    await node('x:y');
    await node('e:');
    await node('ab');
    const live = (loc: string) => node(loc, { deletedAt: null });
    const hidden = [await live('d:c'), await live('x:y:z:w'), await live('e::f')];
    const shown = [await live('abc:q'), await live('x:yz'), await live('e')];
    for (const target of [...hidden, ...shown]) {
      await db.edge.create({ data: { memoryId, sourceId: hub.id, targetId: target.id, loc: `hub:to:${target.id}` } });
    }
    const graph = await Q.recoveryEdges({}, { memoryRef: memoryId, limit: 200 }, ctx());
    expect(graph.items.map((edge: any) => edge.target.id).sort()).toEqual(shown.map((target) => target.id).sort());
    expect(graph.total).toBe(shown.length);
  });
  it('removes a foreign reader-only tombstone from recovery graph count and page', async () => {
    const live = await node('a', { deletedAt: null });
    const foreignMemory = await db.memory.create({ data: { class: 'knowledge', name: 'Other', urn: 'other2175.example:corpus',
      organization: { create: { name: 'Other', urn: 'other2175.example' } } } });
    await db.orgMember.create({ data: { organizationId: foreignMemory.organizationId!, userId: writerId, role: 'READER' } });
    const readable = await db.node.create({ data: { memoryId: foreignMemory.id, loc: 'live', name: 'Readable' } });
    expect(await Q.node({}, { ref: readable.id }, ctx())).toMatchObject({ id: readable.id });
    const denied = await db.node.create({ data: { memoryId: foreignMemory.id, loc: 'private', name: 'Private', deletedAt: new Date() } });
    await db.edge.create({ data: { memoryId, sourceId: live.id, targetId: denied.id, loc: 'a:foreign:private' } });
    const retained = await node('z');
    const visible = await db.edge.create({ data: { memoryId, sourceId: live.id, targetId: retained.id, loc: 'z:local:z' } });
    const page = await Q.recoveryEdges({}, { memoryRef: memoryId, limit: 1 }, ctx());
    expect(page.total).toBe(1);
    expect(page.items.map((item: any) => item.id)).toEqual([visible.id]);
  });
  it('clears only deletion state, retains body/history, and repeats without modifying a live node', async () => {
    const n = await node('a');
    const before = await db.nodeRevision.count({ where: { nodeId: n.id } });
    const out = await M.restoreNode({}, { nodeRef: n.id }, ctx());
    expect(out).toMatchObject({ id: n.id, content: n.content, deletedAt: null, deletedBy: null });
    const first = await db.node.findUniqueOrThrow({ where: { id: n.id } });
    await M.restoreNode({}, { nodeRef: n.id }, ctx());
    expect(await db.node.findUniqueOrThrow({ where: { id: n.id } })).toEqual(first);
    expect(await db.nodeRevision.count({ where: { nodeId: n.id } })).toBe(before);
    expect(publishNodeWritten).toHaveBeenCalledTimes(1);
  });
  it('requires the parent to be restored first', async () => {
    const parent = await node('a'), child = await node('a:b'), leaf = await node('a:b:c');
    await expect(M.restoreNode({}, { nodeRef: child.id }, ctx())).rejects.toMatchObject({
      message: 'Restore the deleted ancestor hrn:node:recovery2175.example:corpus:a first.',
      extensions: { code: 'NODE_PARENT_DELETED', ancestorUrn: 'hrn:node:recovery2175.example:corpus:a' },
    });
    await expect(M.restoreNode({}, { nodeRef: leaf.id }, ctx())).rejects.toMatchObject({ extensions: { ancestorUrn: 'hrn:node:recovery2175.example:corpus:a' } });
    await M.restoreNode({}, { nodeRef: parent.id }, ctx());
    await expect(M.restoreNode({}, { nodeRef: leaf.id }, ctx())).rejects.toMatchObject({ extensions: { ancestorUrn: 'hrn:node:recovery2175.example:corpus:a:b' } });
    expect((await M.restoreNode({}, { nodeRef: child.id }, ctx())).deletedAt).toBeNull();
    expect((await M.restoreNode({}, { nodeRef: leaf.id }, ctx())).deletedAt).toBeNull();
  });
  it.each([{ role: 'review' }, { role: 'spec.rule' }, { isRunnable: true }])('refuses governed tombstone %j without writing', async (signal) => {
    const n = await node('g', signal);
    await expect(M.restoreNode({}, { nodeRef: n.id }, ctx())).rejects.toMatchObject({ extensions: { code: 'ROLE_GOVERNED' } });
    const refusal = await M.restoreNode({}, { nodeRef: n.id }, ctx()).catch((error: any) => error);
    expect(refusal.message).toMatch(/generic restore cannot restore it/);
    expect(refusal.message).not.toMatch(/update|revision|hadron node/);
    expect(refusal.extensions).toMatchObject({ code: 'ROLE_GOVERNED', door: null, mcpDoor: null, op: 'restore' });
    expect((await db.node.findUniqueOrThrow({ where: { id: n.id } })).deletedAt).toEqual(n.deletedAt);
    expect(publishNodeWritten).not.toHaveBeenCalled();
    expect(writeNodeToGit).not.toHaveBeenCalled();
  });
  it('does not grant recovery to a run acting on behalf of a writer', async () => {
    const n = await node('a');
    await expect(M.restoreNode({}, { nodeRef: n.id }, { ...ctx(), clientId: 'run:synthetic' })).rejects.toThrow();
  });
});

describe('recoveryEdges(edgeIds:) (#2818)', () => {
  /** Shown, ancestor-hidden, unreadable, unrecoverable and deleted edges, plus a foreign memory's edge. */
  async function graph() {
    const hub = await node('hub', { deletedAt: null });
    const retained = await node('r');
    await node('p');
    const underDeleted = await node('p:c', { deletedAt: null });
    const live = await node('l', { deletedAt: null });
    const readOnly = await db.memory.create({ data: { class: 'knowledge', name: 'ReadOnly', urn: 'readonly2818.example:corpus',
      organization: { create: { name: 'ReadOnly', urn: 'readonly2818.example' } } } });
    await db.orgMember.create({ data: { organizationId: readOnly.organizationId!, userId: writerId, role: 'READER' } });
    const readable = await db.node.create({ data: { memoryId: readOnly.id, loc: 'live', name: 'Readable' } });
    const unrecoverable = await db.node.create({ data: { memoryId: readOnly.id, loc: 'gone', name: 'Gone', deletedAt: new Date() } });
    const sealed = await db.memory.create({ data: { class: 'knowledge', name: 'Sealed', urn: 'sealed2818.example:corpus',
      organization: { create: { name: 'Sealed', urn: 'sealed2818.example' } } } });
    const secret = await db.node.create({ data: { memoryId: sealed.id, loc: 'secret', name: 'Secret' } });
    const edge = (sourceId: string, targetId: string, loc: string, extra: Record<string, unknown> = {}) =>
      db.edge.create({ data: { memoryId, sourceId, targetId, loc, ...extra } });
    const edges = {
      retained: await edge(hub.id, retained.id, 'hub:to:r'),
      underDeleted: await edge(hub.id, underDeleted.id, 'hub:to:pc'),
      live: await edge(hub.id, live.id, 'hub:to:l'),
      readable: await edge(hub.id, readable.id, 'hub:to:readable'),
      unrecoverable: await edge(hub.id, unrecoverable.id, 'hub:to:gone'),
      sealed: await edge(hub.id, secret.id, 'hub:to:secret'),
      deleted: await edge(hub.id, live.id, 'hub:gone:l', { deletedAt: new Date() }),
      foreign: await db.edge.create({ data: { memoryId: readOnly.id, sourceId: readable.id, targetId: readable.id, loc: 'live:self:live' } }),
    };
    return { hub, readOnly, sealed, edges };
  }
  const ids = (page: any) => page.items.map((item: any) => item.id);

  it('equals the unrestricted result filtered to the requested ids, items and total', async () => {
    const { hub, edges: e } = await graph();
    const full = await Q.recoveryEdges({}, { memoryRef: memoryId, limit: 200 }, ctx());
    expect(ids(full).sort()).toEqual([e.retained.id, e.live.id, e.readable.id].sort());
    const sets = [
      Object.values(e).map((edge) => edge.id).concat(generateId(), hub.id),
      [e.underDeleted.id, e.unrecoverable.id, e.sealed.id, e.deleted.id, e.foreign.id],
      [e.live.id, e.live.id, e.underDeleted.id],
      [e.retained.id, e.readable.id],
    ];
    for (const set of sets) {
      const expected = full.items.filter((item: any) => set.includes(item.id));
      const restricted = await Q.recoveryEdges({}, { memoryRef: memoryId, edgeIds: set, limit: 200 }, ctx());
      expect(restricted).toEqual({ total: expected.length, items: expected });
    }
    const paged = await Q.recoveryEdges({}, { memoryRef: memoryId, edgeIds: [e.retained.id, e.readable.id, e.live.id], limit: 1, offset: 1 }, ctx());
    expect(paged).toEqual({ total: 3, items: full.items.slice(1, 2) });
  });
  it('keeps an unreadable or unrecoverable endpoint absent with and without edgeIds', async () => {
    const { edges: e } = await graph();
    for (const masked of [e.sealed.id, e.unrecoverable.id, e.underDeleted.id]) {
      expect(ids(await Q.recoveryEdges({}, { memoryRef: memoryId, limit: 200 }, ctx()))).not.toContain(masked);
      expect(await Q.recoveryEdges({}, { memoryRef: memoryId, edgeIds: [masked] }, ctx())).toEqual({ total: 0, items: [] });
    }
  });
  it('authorizes only the endpoint memories of the requested edges', async () => {
    const { readOnly, sealed, edges: e } = await graph();
    const lookups = vi.spyOn(db.memory, 'findUnique');
    try {
      await Q.recoveryEdges({}, { memoryRef: memoryId, edgeIds: [e.live.id] }, ctx());
      const looked = lookups.mock.calls.map(([args]) => (args as { where: { id?: string } }).where.id);
      expect(looked).toContain(memoryId);
      expect(looked).not.toContain(readOnly.id);
      expect(looked).not.toContain(sealed.id);
    } finally { lookups.mockRestore(); }
  });
  it.each([0, 201])('refuses %i ids as BAD_USER_INPUT before resolving the memory or querying', async (count) => {
    const raw = vi.spyOn(db, '$queryRaw');
    try {
      const edgeIds = Array.from({ length: count }, () => generateId());
      for (const memoryRef of [memoryId, generateId()]) {
        await expect(Q.recoveryEdges({}, { memoryRef, edgeIds }, ctx())).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
      }
      expect(raw).not.toHaveBeenCalled();
    } finally { raw.mockRestore(); }
  });
  it('accepts exactly 200 ids and treats null as omitted', async () => {
    const { edges: e } = await graph();
    const edgeIds = [e.live.id, ...Array.from({ length: 199 }, () => generateId())];
    expect(ids(await Q.recoveryEdges({}, { memoryRef: memoryId, edgeIds }, ctx()))).toEqual([e.live.id]);
    expect((await Q.recoveryEdges({}, { memoryRef: memoryId, edgeIds: null }, ctx())).total).toBe(3);
  });
  it('serves the same restriction over GraphQL and MCP', async () => {
    const { edges: e } = await graph();
    const set = [e.retained.id, e.sealed.id, e.readable.id];
    const direct = JSON.parse(JSON.stringify(await Q.recoveryEdges({}, { memoryRef: memoryId, edgeIds: set }, ctx())));
    const schema = buildSchema(typeDefs);
    const read = await graphql({ schema, source: `query($m: ID!, $ids: [ID!]) { recoveryEdges(memoryRef: $m, edgeIds: $ids) { total items { id } } }`,
      variableValues: { m: memoryId, ids: set }, contextValue: ctx(), fieldResolver: (parent, args, context, info) => {
        const fields = resolvers[info.parentType.name as keyof typeof resolvers] as Record<string, Function> | undefined;
        const resolver = fields?.[info.fieldName];
        return typeof resolver === 'function' ? resolver(parent, args, context, info) : defaultFieldResolver(parent, args, context, info);
      } });
    expect(read.errors).toBeUndefined();
    expect(read.data).toEqual({ recoveryEdges: { total: 2, items: direct.items.map((item: any) => ({ id: item.id })) } });
    const writer = createTestableMcpServer({ userId: writerId, roles: [], clientId: `user:${writerId}` });
    expect(JSON.parse(await writer.callToolText('hadron_list_recovery_edges', { memoryRef: memoryId, edgeIds: set }))).toEqual(direct);
    expect(await writer.callTool('hadron_list_recovery_edges', { memoryRef: memoryId, edgeIds: [] })).toMatchObject({
      isError: true, content: [{ type: 'text', text: expect.stringMatching(/^\[bad_user_input\] /) }],
    });
  });
});
