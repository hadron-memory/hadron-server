/**
 * Writer-level evaluation over the complete node state, and over dependent edge writes.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GraphQLError } from 'graphql';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';
import { createTestableMcpServer } from '../../../mcp/server.js';
import { lockMemoryConfigExclusive } from '../../../lib/governedRole.js';
import { waitForLockWaiters } from '../../../test/lockWait.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

let orgId: string;
let memoryId: string;
let memoryUrn: string;
let admin: { id: string };
let contrib: { id: string };
let reader: { id: string };

const as = (u: { id: string }): Context => ({ db, userId: u.id, roles: [], clientId: `user:${u.id}` });
const REFUSED = 'ROLE_WRITER_LEVEL_REQUIRED';

async function code(p: Promise<unknown>): Promise<string> {
  try { await p; return 'OK'; } catch (e) {
    return e instanceof GraphQLError ? String(e.extensions.code) : (e as Error).message;
  }
}

async function rule(role: string, extra: Record<string, unknown> = {}) {
  const config = (await db.memoryConfig.findUnique({ where: { memoryId } }))
    ?? await db.memoryConfig.create({ data: { id: generateId(), memoryId } });
  return db.nodeRoleRule.create({ data: { id: generateId(), configId: config.id, role, ...extra } });
}
const node = (loc: string, extra: Record<string, unknown> = {}) => db.node.create({
  data: { id: generateId(), memoryId, loc, name: loc, content: 'body', ...extra },
});
const state = (loc: string) => db.node.findFirst({ where: { memoryId, loc } });
const door = (name: string, u: { id: string }, input: Record<string, unknown>) =>
  (resolvers.Mutation as any)[name](null, { input: { memoryId, name: String(input.loc), content: 'x', ...input } }, as(u));
const edgeCount = () => db.edge.count({ where: { memoryId } });
const mcp = (u: { id: string }) => createTestableMcpServer({ userId: u.id, roles: [], clientId: `user:${u.id}` });
const urn = (loc: string) => `hrn:node:${memoryUrn}:${loc}`;

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), name: 'rn-org', urn: 'rn-org' } });
  orgId = org.id;
  admin = await db.user.create({ data: { githubId: 600100, githubUsername: 'rn-admin', handle: 'rn-admin' } });
  contrib = await db.user.create({ data: { githubId: 600101, githubUsername: 'rn-contrib', handle: 'rn-contrib' } });
  reader = await db.user.create({ data: { githubId: 600102, githubUsername: 'rn-reader', handle: 'rn-reader' } });
  await db.orgMember.createMany({ data: [
    { organizationId: org.id, userId: admin.id, role: 'ADMIN' },
    { organizationId: org.id, userId: contrib.id, role: 'CONTRIBUTOR' },
    { organizationId: org.id, userId: reader.id, role: 'READER' },
  ] });
  memoryUrn = `${org.urn}:mem`;
  memoryId = (await db.memory.create({
    data: { id: generateId(), organizationId: org.id, urn: memoryUrn, name: 'mem', class: 'knowledge' },
  })).id;
});

describe('writer levels: node state judged before and after', () => {
  beforeEach(async () => { await rule('task', { writers: 'ADMIN' }); });

  it('create: state with no role', async () => {
    expect(await code(door('createTaskNode', contrib, { loc: 't1', isRunnable: true }))).toBe(REFUSED);
    expect(await code(door('createTaskNode', contrib, { loc: 't2', isRunnable: true, role: 'notes' }))).toBe(REFUSED);
    expect(await state('t1')).toBeNull();
    expect(await state('t2')).toBeNull();
    expect(await code(door('createTaskNode', admin, { loc: 't3', isRunnable: true }))).toBe('OK');
  });

  it('update: state transitions on both sides', async () => {
    await node('plain');
    await node('task', { isRunnable: true });
    expect(await code(door('updateTaskNode', contrib, { loc: 'plain', isRunnable: true }))).toBe(REFUSED);
    expect(await code(door('updateTaskNode', contrib, { loc: 'task', isRunnable: false }))).toBe(REFUSED);
    expect(await code(door('updateTaskNode', contrib, { loc: 'task', content: 'edited' }))).toBe(REFUSED);
    expect((await state('plain'))!.isRunnable).not.toBe(true);
    expect((await state('task'))!.isRunnable).toBe(true);
    expect((await state('task'))!.content).toBe('body');
    expect(await code(door('updateTaskNode', admin, { loc: 'plain', isRunnable: true }))).toBe('OK');
    expect(await code(door('updateTaskNode', admin, { loc: 'task', isRunnable: false }))).toBe('OK');
  });

  it('generic door routing is unchanged', async () => {
    await node('task', { isRunnable: true });
    expect(await code(resolvers.Mutation.updateNode(null, { input: { memoryId, loc: 'task', content: 'x' } }, as(admin)))).toBe('ROLE_GOVERNED');
  });

  it('MCP kind writers', async () => {
    await node('task', { isRunnable: true });
    const created = await mcp(contrib).callToolText('hadron_create_task', { urn: urn('mt1'), name: 'mt1', content: 'x' });
    expect(created).toContain('role_writer_level_required');
    expect(await state('mt1')).toBeNull();
    const updated = await mcp(contrib).callToolText('hadron_update_task', { urn: urn('task'), content: 'mcp edit' });
    expect(updated).toContain('role_writer_level_required');
    expect((await state('task'))!.content).toBe('body');
    expect(await mcp(admin).callToolText('hadron_update_task', { urn: urn('task'), content: 'admin edit' })).not.toContain('role_writer_level_required');
  });

  it('combined rules', async () => {
    await rule('review', { writers: 'ADMIN' });
    expect(await code(door('createTaskNode', contrib, { loc: 'rr', isRunnable: true, role: 'review' }))).not.toBe('OK');
  });

  it('move: destination is judged', async () => {
    const other = await db.memory.create({
      data: { id: generateId(), organizationId: orgId, urn: 'rn-org:other', name: 'other', class: 'knowledge' },
    });
    const t = await db.node.create({ data: { id: generateId(), memoryId: other.id, loc: 'mv', name: 'mv', content: 'x', isRunnable: true } });
    expect(await code(resolvers.Mutation.moveNode(null, { sourceRef: t.id, targetUrn: urn('mv') }, as(contrib)))).not.toBe('OK');
    expect(await state('mv')).toBeNull();
    expect(await db.node.findUnique({ where: { id: t.id } })).toMatchObject({ memoryId: other.id });
    expect(await code(resolvers.Mutation.moveNode(null, { sourceRef: t.id, targetUrn: urn('mv') }, as(admin)))).toBe('OK');
  });

  it('controls: other rule, ALL, no rule, reader', async () => {
    await db.nodeRoleRule.deleteMany({});
    await rule('policy', { writers: 'ADMIN' });
    expect(await code(door('createTaskNode', contrib, { loc: 'c1', isRunnable: true }))).toBe('OK');
    await db.nodeRoleRule.deleteMany({});
    await rule('task', { writers: 'ALL' });
    expect(await code(door('createTaskNode', contrib, { loc: 'c2', isRunnable: true }))).toBe('OK');
    expect(await code(door('createTaskNode', reader, { loc: 'c3', isRunnable: true }))).not.toBe('OK');
    await db.nodeRoleRule.deleteMany({});
    expect(await code(door('createTaskNode', contrib, { loc: 'c4', isRunnable: true }))).toBe('OK');
  });

  it('OWNER is not read as ALL', async () => {
    await db.nodeRoleRule.deleteMany({});
    await rule('task', { writers: 'OWNER' });
    expect(await code(door('createTaskNode', admin, { loc: 'o1', isRunnable: true }))).toBe('ROLE_WRITERS_UNSUPPORTED');
  });

  it('bulk replacement skips rows the caller may not write', async () => {
    await node('task', { isRunnable: true, content: 'alpha' });
    await node('plain', { content: 'alpha' });
    await resolvers.Mutation.searchReplaceInNodes(null, {
      input: { memoryIds: [memoryId], fields: ['content'], oldText: 'alpha', newText: 'beta', dryRun: false },
    }, as(contrib)).catch(() => null);
    expect((await state('task'))!.content).toBe('alpha');
    expect((await state('plain'))!.content).toBe('beta');
  });
});

describe('writer levels: dependent edge writes', () => {
  let task: { id: string };
  let other: { id: string };
  let prose: { id: string };
  beforeEach(async () => {
    await rule('task', { writers: 'ADMIN' });
    task = await node('task', { isRunnable: true });
    other = await node('other');
    prose = await node('prose');
  });
  const mkEdge = (sourceId: string, loc: string) => db.edge.create({
    data: { id: generateId(), memoryId, sourceId, targetId: other.id, loc, name: loc },
  });

  it('GraphQL edge create, update and delete', async () => {
    const existing = await mkEdge(task.id, 'task:e1');
    const before = await edgeCount();
    expect(await code(resolvers.Mutation.createEdge(null, { sourceRef: task.id, targetRef: other.id, name: 'x' }, as(contrib)))).toBe(REFUSED);
    expect(await code(resolvers.Mutation.updateEdge(null, { edgeRef: existing.id, name: 'renamed' }, as(contrib)))).toBe(REFUSED);
    expect(await code(resolvers.Mutation.deleteEdge(null, { edgeRef: existing.id }, as(contrib)))).toBe(REFUSED);
    expect(await edgeCount()).toBe(before);
    expect((await db.edge.findUniqueOrThrow({ where: { id: existing.id } })).name).toBe('task:e1');
    expect(await code(resolvers.Mutation.updateEdge(null, { edgeRef: existing.id, name: 'by-admin' }, as(admin)))).toBe('OK');
    expect(await code(resolvers.Mutation.createEdge(null, { sourceRef: task.id, targetRef: other.id, name: 'y' }, as(admin)))).toBe('OK');
    expect(await code(resolvers.Mutation.deleteEdge(null, { edgeRef: existing.id }, as(admin)))).toBe('OK');
  });

  it('edge write, ungoverned source', async () => {
    const e = await mkEdge(prose.id, 'prose:e1');
    expect(await code(resolvers.Mutation.createEdge(null, { sourceRef: prose.id, targetRef: other.id, name: 'x' }, as(contrib)))).toBe('OK');
    expect(await code(resolvers.Mutation.updateEdge(null, { edgeRef: e.id, name: 'renamed' }, as(contrib)))).toBe('OK');
    expect(await code(resolvers.Mutation.deleteEdge(null, { edgeRef: e.id }, as(contrib)))).toBe('OK');
  });

  it('edge write, governed target', async () => {
    expect(await code(resolvers.Mutation.createEdge(null, { sourceRef: prose.id, targetRef: task.id, name: 'x' }, as(contrib)))).toBe('OK');
  });

  it('inline edges', async () => {
    await mkEdge(task.id, 'task:e1');
    const withEdges = (u: { id: string }) => door('updateTaskNode', u, { loc: 'task', edges: [{ targetId: other.id, name: 'new' }] });
    expect(await code(withEdges(contrib))).toBe(REFUSED);
    expect((await db.edge.findMany({ where: { sourceId: task.id } })).map((e) => e.name)).toEqual(['task:e1']);
    expect(await code(withEdges(admin))).toBe('OK');
  });

  it('MCP edge tools', async () => {
    const existing = await mkEdge(task.id, 'task:e1');
    const created = await mcp(contrib).callToolText('hadron_create_edge', { sourceUrn: urn('task'), targetUrn: urn('other'), name: 'via-mcp' });
    expect(created).toContain('role_writer_level_required');
    expect(await mcp(contrib).callToolText('hadron_update_edge', { edgeRef: existing.id, name: 'renamed' })).toContain('role_writer_level_required');
    expect(await mcp(contrib).callToolText('hadron_delete_edge', { edgeRef: existing.id })).toContain('role_writer_level_required');
    expect(await edgeCount()).toBe(1);
    expect(await mcp(admin).callToolText('hadron_create_edge', { sourceUrn: urn('task'), targetUrn: urn('other'), name: 'via-mcp' })).not.toContain('role_writer_level_required');
    expect(await edgeCount()).toBe(2);
  });
});

describe('writer levels: concurrent changes', () => {
  it('node write queued behind a rule change', async () => {
    const r = await rule('task', { writers: 'ALL' });
    let held!: () => void;
    const holding = new Promise<void>((res) => (held = res));
    let release!: () => void;
    const gate = new Promise<void>((res) => (release = res));
    const ruleWrite = db.$transaction(async (tx) => {
      await lockMemoryConfigExclusive(tx, memoryId);
      await tx.nodeRoleRule.update({ where: { id: r.id }, data: { writers: 'ADMIN' } });
      held();
      await gate;
    }, { timeout: 15_000 });
    await holding;
    const pending = code(door('createTaskNode', contrib, { loc: 'late', isRunnable: true }));
    await waitForLockWaiters(db);
    release();
    await ruleWrite;
    expect(await pending).toBe(REFUSED);
    expect(await state('late')).toBeNull();
  });

  it('edge write queued behind a rule change', async () => {
    const r = await rule('task', { writers: 'ALL' });
    const t = await node('task', { isRunnable: true });
    const tgt = await node('other');
    let held!: () => void;
    const holding = new Promise<void>((res) => (held = res));
    let release!: () => void;
    const gate = new Promise<void>((res) => (release = res));
    const ruleWrite = db.$transaction(async (tx) => {
      await lockMemoryConfigExclusive(tx, memoryId);
      await tx.nodeRoleRule.update({ where: { id: r.id }, data: { writers: 'ADMIN' } });
      held();
      await gate;
    }, { timeout: 15_000 });
    await holding;
    const pending = code(resolvers.Mutation.createEdge(null, { sourceRef: t.id, targetRef: tgt.id, name: 'late' }, as(contrib)));
    await waitForLockWaiters(db);
    release();
    await ruleWrite;
    expect(await pending).toBe(REFUSED);
    expect(await edgeCount()).toBe(0);
  });

  it('state change committing while an edge write waits', async () => {
    await rule('task', { writers: 'ADMIN' });
    const src = await node('src'); // not runnable yet
    const tgt = await node('other');
    let held!: () => void;
    const holding = new Promise<void>((res) => (held = res));
    let release!: () => void;
    const gate = new Promise<void>((res) => (release = res));
    const flip = db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM nodes WHERE id = ${src.id} FOR UPDATE`;
      await tx.node.update({ where: { id: src.id }, data: { isRunnable: true } });
      held();
      await gate;
    }, { timeout: 15_000 });
    await holding;
    const pending = code(resolvers.Mutation.createEdge(null, { sourceRef: src.id, targetRef: tgt.id, name: 'late' }, as(contrib)));
    await waitForLockWaiters(db);
    release();
    await flip;
    expect(await pending).toBe(REFUSED);
    expect(await edgeCount()).toBe(0);
  });
});

describe('writer levels: lock order and locked rows', () => {
  async function holdOpen<T>(work: (tx: Parameters<Parameters<typeof db.$transaction>[0]>[0]) => Promise<T>) {
    let release!: () => void;
    const gate = new Promise<void>((res) => (release = res));
    let locked!: () => void;
    const ready = new Promise<void>((res) => (locked = res));
    const done = db.$transaction(async (tx) => { await work(tx); locked(); await gate; }, { timeout: 20_000 });
    await ready;
    return { release, done };
  }

  it('edge delete after the source changed while it waited', async () => {
    await rule('task', { writers: 'ADMIN' });
    const a = await node('a');
    const t = await node('task', { isRunnable: true });
    const x = await node('x');
    const e = await db.edge.create({ data: { id: generateId(), memoryId, sourceId: a.id, targetId: x.id, loc: 'a:e', name: 'e' } });
    const held = await holdOpen(async (tx) => {
      await tx.$queryRaw`SELECT id FROM edges WHERE id = ${e.id} FOR UPDATE`;
      await tx.edge.update({ where: { id: e.id }, data: { sourceId: t.id } });
    });
    const pending = code(resolvers.Mutation.deleteEdge(null, { edgeRef: e.id }, as(contrib)));
    await waitForLockWaiters(db);
    held.release();
    await held.done;
    // The source changed under the edge lock: refused as a conflict, never judged by taking a new node lock while the
    // edge row is held (that would reverse the node-before-edge order).
    expect(await pending).toBe('NODE_WRITE_CONFLICT');
    expect(await db.edge.findUnique({ where: { id: e.id } })).toMatchObject({ sourceId: t.id });
  });

  it('edge update lock order against an inline-edge node write', async () => {
    const n = await node('n');
    const tgt = await node('t');
    const e = await db.edge.create({ data: { id: generateId(), memoryId, sourceId: n.id, targetId: tgt.id, loc: 'n:e', name: 'e' } });
    // The node writer's order: the node row first, then its edges. It takes the node and, while the edge update waits
    // behind it, reaches for the edge row. If updateEdge held the edge row while waiting for the node, this would deadlock.
    let release!: () => void;
    const gate = new Promise<void>((res) => (release = res));
    let locked!: () => void;
    const ready = new Promise<void>((res) => (locked = res));
    const writer = db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM nodes WHERE id = ${n.id} FOR UPDATE`;
      locked();
      await gate;
      await tx.edge.deleteMany({ where: { sourceId: n.id, governedKind: null } });
    }, { timeout: 20_000 }).then(() => 'ok', (err: Error) => err.message);
    await ready;
    const updating = code(resolvers.Mutation.updateEdge(null, { edgeRef: e.id, name: 'renamed' }, as(admin)));
    await waitForLockWaiters(db); // updateEdge waits for the node row, holding no edge lock
    release();
    expect(await writer).toBe('ok');
    expect(['OK', 'EDGE_NOT_FOUND']).toContain(await updating);
  });

  it('MCP section writer: locked state change while it waits', async () => {
    await rule('task', { writers: 'ADMIN' });
    const sec = await node('sec', { nodeType: 'info', content: 'body' });
    const held = await holdOpen(async (tx) => {
      await tx.$queryRaw`SELECT id FROM nodes WHERE id = ${sec.id} FOR UPDATE`;
      await tx.node.update({ where: { id: sec.id }, data: { isRunnable: true } });
    });
    const pending = mcp(contrib).callToolText('hadron_create_parent_node', { urn: urn('sec') });
    await waitForLockWaiters(db);
    held.release();
    await held.done;
    const text = await pending;
    expect(text).toMatch(/role_governed|role_writer_level_required/);
    expect((await state('sec'))!.content).toBe('body');
  });

  it('MCP section writer: locked role change while it waits', async () => {
    await rule('policy', { writers: 'ADMIN' });
    const sec = await node('sec', { nodeType: 'info', content: 'body' });
    const held = await holdOpen(async (tx) => {
      await tx.$queryRaw`SELECT id FROM nodes WHERE id = ${sec.id} FOR UPDATE`;
      await tx.node.update({ where: { id: sec.id }, data: { role: 'policy' } });
    });
    const pending = mcp(contrib).callToolText('hadron_create_parent_node', { urn: urn('sec') });
    await waitForLockWaiters(db);
    held.release();
    await held.done;
    expect(await pending).toContain('role_writer_level_required');
    expect((await state('sec'))!.content).toBe('body');
  });

  it('MCP section writer: controls', async () => {
    await rule('task', { writers: 'ADMIN' });
    await node('plain', { nodeType: 'info', content: 'body' });
    expect(await mcp(contrib).callToolText('hadron_create_parent_node', { urn: urn('plain') })).toContain('Node saved');
    await node('run', { nodeType: 'info', isRunnable: true });
    expect(await mcp(contrib).callToolText('hadron_create_parent_node', { urn: urn('run') })).toMatch(/role_governed|role_writer_level_required/);
  });
});
