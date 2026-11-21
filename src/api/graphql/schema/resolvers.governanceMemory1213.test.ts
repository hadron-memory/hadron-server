/** #1213 S2: signal attempts join the memory handshake; ordinary content-only writes do not. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, createDbOrgAndGraph } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { writeNodeCore } from './resolvers.mutation.node.js';
import type { Context } from './resolvers.js';
import { Prisma } from '../../../generated/prisma/index.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
let memoryId: string;
let userId: string;
let nodeId: string;
const ctx = (): Context => ({ db, roles: ['ADMIN'], userId, clientId: `user:${userId}` });
beforeEach(async () => {
  await cleanDb(db);
  const { org, graph } = await createDbOrgAndGraph(db);
  memoryId = graph.id;
  const user = await db.user.create({ data: { id: generateId(), githubId: 121301, githubUsername: 'gov1213', roles: ['ADMIN'] } });
  userId = user.id;
  await db.orgMember.create({ data: { organizationId: org.id, userId, role: 'OWNER' } });
  nodeId = (await db.node.create({ data: { id: generateId(), memoryId, loc: 'ordinary', name: 'ordinary', content: 'before' } })).id;
});

async function observedWrite(patch: Record<string, unknown>, ownsKind?: 'review', mode: 'create' | 'update' = 'update') {
  const [{ key }] = await db.$queryRaw<Array<{ key: number }>>`SELECT hashtext(${'channel-host:' + memoryId}) AS key`;
  const acquisitions: number[] = [];
  await db.$transaction(async tx => {
    const observed = new Proxy(tx, { get(target, prop, receiver) {
      if (prop !== '$executeRaw') return Reflect.get(target, prop, receiver);
      return async (sql: TemplateStringsArray, ...values: unknown[]) => {
        if (/pg_advisory_xact_lock/.test(sql.join('')) && values.length === 1 && (values[0] === `channel-host:${memoryId}` || Number(values[0]) === key)) acquisitions.push(key);
        return tx.$executeRaw(sql, ...values);
      };
    } });
    await writeNodeCore({ memoryId, loc: mode === 'create' ? 'new-node' : 'ordinary', name: 'ordinary', content: 'after', ...patch } as Parameters<typeof writeNodeCore>[0],
      ctx(), mode, { authoring: { kind: 'carry' }, ownsKind,
        ...(mode === 'update' ? { targetNodeId: nodeId } : {}),
        transaction: { tx: observed as Prisma.TransactionClient, pooledDb: db, afterCommit: () => {} },
      });
  });
  return acquisitions;
}

describe('#1213 input-triggered writer participation', () => {
  it.each([
    ['role null', { role: null }],
    ['role whitespace clearing', { role: '  ' }],
    ['runnable false', { isRunnable: false }],
    ['runnable null', { isRunnable: null }],
  ])('%s acquires the own-memory key even without inline edges', async (_label, patch) => {
    expect(await observedWrite(patch as Record<string, unknown>)).toHaveLength(1);
  });
  it('a kind-door content-only update joins even with omitted signals', async () => {
    expect(await observedWrite({}, 'review')).toHaveLength(1);
  });
  it('a create joins even with omitted signals', async () => {
    expect(await observedWrite({}, undefined, 'create')).toHaveLength(1);
  });
  it('an ordinary content-only update adds no governance key', async () => {
    expect(await observedWrite({})).toEqual([]);
  });
});

function latch<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  void promise.catch(() => {});
  return { promise, resolve, reject };
}

/** A wait is attributed to THIS writer, THIS holder, database and physical one-argument memory key. */
async function waitForMemoryKey(waiter: number, holder: number, key: number) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const [{ waiting }] = await db.$queryRaw<Array<{ waiting: boolean }>>`
      SELECT EXISTS (SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND NOT granted
        AND pid = ${waiter} AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
        AND classid = ${key < 0 ? 4294967295 : 0}::bigint::oid AND objid = ${key >>> 0}::bigint::oid AND objsubid = 1
        AND ${holder} = ANY(pg_blocking_pids(${waiter}::int))) AS waiting`;
    if (waiting) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`writer ${waiter} never waited for holder ${holder} on memory key ${key}`);
}

function contextWithPid(pid: ReturnType<typeof latch<number>>): Context {
  const transact = db.$transaction.bind(db);
  const observed = new Proxy(db, { get(target, prop, receiver) {
    if (prop !== '$transaction') return Reflect.get(target, prop, receiver);
    return (work: (tx: Prisma.TransactionClient) => Promise<unknown>, options: { timeout?: number } | undefined) =>
      transact(async tx => {
        pid.resolve((await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`)[0].pid);
        return work(tx);
      }, { ...options, timeout: 15000 });
  } });
  return { ...ctx(), db: observed };
}

it('real PG: ordinary same-memory content update completes while a signal update waits on the held key', async () => {
  const { lockMemoriesForChannelChange } = await import('../../../lib/channels.js');
  const held = latch<{ pid: number; key: number }>();
  const release = latch();
  const waiter = latch<number>();
  const holder = db.$transaction(async tx => {
    await lockMemoriesForChannelChange(tx, [memoryId]);
    const [row] = await tx.$queryRaw<Array<{ pid: number; key: number }>>`SELECT pg_backend_pid() AS pid, hashtext(${'channel-host:' + memoryId}) AS key`;
    held.resolve(row);
    await release.promise;
  }, { timeout: 15000 });
  void holder.catch(held.reject);
  const holderDone = Promise.allSettled([holder]);
  let writerDone: Promise<PromiseSettledResult<unknown>[]> | undefined;
  try {
    const owner = await held.promise;
    await writeNodeCore({ memoryId, loc: 'ordinary', content: 'ordinary-finished' }, ctx(), 'update', { authoring: { kind: 'carry' }, targetNodeId: nodeId });
    expect((await db.node.findUniqueOrThrow({ where: { id: nodeId } })).content).toBe('ordinary-finished');
    const writer = writeNodeCore({ memoryId, loc: 'ordinary', isRunnable: false, content: 'signal-finished' }, contextWithPid(waiter), 'update',
      { authoring: { kind: 'carry' }, targetNodeId: nodeId });
    void writer.catch(waiter.reject);
    writerDone = Promise.allSettled([writer]);
    await waitForMemoryKey(await waiter.promise, owner.pid, owner.key);
    expect((await db.node.findUniqueOrThrow({ where: { id: nodeId } })).content).toBe('ordinary-finished');
    const source = await db.memory.findUniqueOrThrow({ where: { id: memoryId } });
    const other = await db.memory.create({ data: { id: generateId(), organizationId: source.organizationId, name: 'other', urn: source.urn + '-other', class: 'knowledge' } });
    const otherNode = await db.node.create({ data: { memoryId: other.id, loc: 'other', name: 'other' } });
    const [{ key: otherKey }] = await db.$queryRaw<Array<{ key: number }>>`SELECT hashtext(${'channel-host:' + other.id}) AS key`;
    expect(otherKey).not.toBe(owner.key); // the different-memory control requires distinct physical keys
    await writeNodeCore({ memoryId: other.id, loc: 'other', isRunnable: false, content: 'independent' }, ctx(), 'update',
      { authoring: { kind: 'carry' }, targetNodeId: otherNode.id });
    expect((await db.node.findUniqueOrThrow({ where: { id: otherNode.id } })).content).toBe('independent');
  } finally {
    release.resolve();
    for (const result of [...await holderDone, ...(writerDone ? await writerDone : [])]) {
      if (result.status === 'rejected') throw result.reason;
    }
  }
  expect((await db.node.findUniqueOrThrow({ where: { id: nodeId } })).content).toBe('signal-finished');
}, 20000);

/** Hold the first real deciding transaction AFTER its work, BEFORE commit. Later transactions run normally. */
function heldTransactionDb(ready: ReturnType<typeof latch<number>>, release: ReturnType<typeof latch<void>>) {
  let first = true;
  return new Proxy(db, { get(target, prop, receiver) {
    if (prop !== '$transaction') return Reflect.get(target, prop, receiver);
    return (work: (tx: Prisma.TransactionClient) => Promise<unknown>, options: { timeout?: number } | undefined) => {
      const hold = first; first = false;
      return db.$transaction(async tx => {
        const result = await work(tx);
        if (hold) {
          ready.resolve((await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`)[0].pid);
          await release.promise;
        }
        return result;
      }, { ...options, timeout: 15000 });
    };
  } });
}

async function extract(database: typeof db, move = false) {
  const { extractParentNodeGraph } = await import('../../../controller/operations/extractParentNode.js');
  const source = await db.memory.findUniqueOrThrow({ where: { id: memoryId } });
  return extractParentNodeGraph(database, { sourceMemoryId: memoryId, parentLoc: 'ordinary',
    name: 'extracted', rootLoc: 'extracted', newUrn: 'test-org:extracted', targetOrganizationId: source.organizationId!,
    newClass: 'knowledge', visibility: null, ownerUserId: null, groupOwnerUserId: null,
    vectorIndexEnabled: false, move, actorId: userId, copierReadableMemoryIds: null, principal: ctx() });
}
async function mergeInto(database: typeof db, targetMemoryId: string) {
  const { mergeMemoryGraph } = await import('../../../controller/operations/mergeMemories.js');
  return mergeMemoryGraph(database, { sourceMemoryId: memoryId, targetMemoryId, fields: new Set(), deleteSourceMem: false,
    editor: { userId }, principal: ctx() });
}
async function destination() {
  const source = await db.memory.findUniqueOrThrow({ where: { id: memoryId } });
  return db.memory.create({ data: { id: generateId(), organizationId: source.organizationId, name: 'target', urn: 'test-org:target', class: 'knowledge' } });
}
function signalWrite(context: Context, role: string | null = 'review') {
  return writeNodeCore({ memoryId, loc: 'ordinary', role }, context, 'update', {
    targetNodeId: nodeId, ownsKind: 'review', authoring: { kind: 'trustedHuman', authenticatedUserId: userId },
  });
}
async function settledSuccess(results: PromiseSettledResult<unknown>[]) {
  for (const result of results) if (result.status === 'rejected') throw result.reason;
}

it('real PG: a door committing first makes merge refuse the page, without relocating its source', async () => {
  const target = await destination();
  const held = latch<number>(); const release = latch(); const waiter = latch<number>();
  const door = signalWrite({ ...ctx(), db: heldTransactionDb(held, release) });
  void door.catch(held.reject); const doorDone = Promise.allSettled([door]);
  let bulkDone: Promise<PromiseSettledResult<unknown>[]> | undefined;
  try {
    const holderPid = await held.promise;
    const [{ key }] = await db.$queryRaw<Array<{ key: number }>>`SELECT hashtext(${'channel-host:' + memoryId}) AS key`;
    const bulk = mergeInto(contextWithPid(waiter).db, target.id);
    void bulk.catch(waiter.reject); bulkDone = Promise.allSettled([bulk]);
    await waitForMemoryKey(await waiter.promise, holderPid, key);
  } finally {
    release.resolve();
    const settledDoor = await doorDone;
    if (bulkDone) await bulkDone;
    await settledSuccess(settledDoor);
  }
  const [result] = await bulkDone!;
  expect(result.status).toBe('rejected');
  if (result.status === 'rejected') expect(result.reason.extensions.code).toBe('ROLE_GOVERNED');
  expect(await db.node.findUniqueOrThrow({ where: { id: nodeId } })).toMatchObject({ memoryId, role: 'review', deletedAt: null });
  expect(await db.node.count({ where: { memoryId: target.id } })).toBe(0);
}, 20000);

it('real PG: merge committing first holds the door until relocation; the stale source door refuses', async () => {
  const target = await destination();
  const held = latch<number>(); const release = latch(); const waiter = latch<number>();
  const bulk = mergeInto(heldTransactionDb(held, release), target.id);
  void bulk.catch(held.reject); const bulkDone = Promise.allSettled([bulk]);
  let doorDone: Promise<PromiseSettledResult<unknown>[]> | undefined;
  try {
    const holderPid = await held.promise;
    const [{ key }] = await db.$queryRaw<Array<{ key: number }>>`SELECT hashtext(${'channel-host:' + memoryId}) AS key`;
    const door = signalWrite(contextWithPid(waiter));
    void door.catch(waiter.reject); doorDone = Promise.allSettled([door]);
    await waitForMemoryKey(await waiter.promise, holderPid, key);
  } finally {
    release.resolve(); const settledBulk = await bulkDone;
    if (doorDone) await doorDone;
    await settledSuccess(settledBulk);
  }
  const [result] = await doorDone!;
  expect(result.status).toBe('rejected');
  if (result.status === 'rejected') expect(result.reason.extensions.code).toBe('NODE_WRITE_CONFLICT');
  expect(await db.node.findUniqueOrThrow({ where: { id: nodeId } })).toMatchObject({ memoryId: target.id, role: null });
}, 20000);

it.each([['promotion', null, 'review'], ['demotion', 'review', null]] as const)(
  'real PG: %s committing first is carried by extract unchanged', async (_label, initial, next) => {
    await db.node.update({ where: { id: nodeId }, data: { role: initial, revisionContentHash: 'refresh' } });
    const held = latch<number>(); const release = latch(); const waiter = latch<number>();
    const door = signalWrite({ ...ctx(), db: heldTransactionDb(held, release) }, next);
    void door.catch(held.reject); const doorDone = Promise.allSettled([door]);
    let copyDone: Promise<PromiseSettledResult<Awaited<ReturnType<typeof extract>>>[]> | undefined;
    try {
      const holderPid = await held.promise;
      const [{ key }] = await db.$queryRaw<Array<{ key: number }>>`SELECT hashtext(${'channel-host:' + memoryId}) AS key`;
      const copy = extract(contextWithPid(waiter).db);
      void copy.catch(waiter.reject); copyDone = Promise.allSettled([copy]);
      await waitForMemoryKey(await waiter.promise, holderPid, key);
    } finally {
      release.resolve(); const settledDoor = await doorDone;
      if (copyDone) await copyDone;
      await settledSuccess(settledDoor);
    }
    const [result] = await copyDone!;
    if (result.status === 'rejected') throw result.reason;
    expect(await db.node.findFirstOrThrow({ where: { memoryId: result.value.memoryId, loc: 'extracted' } })).toMatchObject({ role: next, isRunnable: null });
    expect(await db.node.findUniqueOrThrow({ where: { id: nodeId } })).toMatchObject({ role: next, deletedAt: null });
  }, 20000,
);

it.each([false, true])('real PG: extract move=%s committing first keeps its copied signals stable; later door follows source liveness', async move => {
  const held = latch<number>(); const release = latch(); const waiter = latch<number>();
  const copy = extract(heldTransactionDb(held, release), move);
  void copy.catch(held.reject); const copyDone = Promise.allSettled([copy]);
  let doorDone: Promise<PromiseSettledResult<unknown>[]> | undefined;
  try {
    const holderPid = await held.promise;
    const [{ key }] = await db.$queryRaw<Array<{ key: number }>>`SELECT hashtext(${'channel-host:' + memoryId}) AS key`;
    const door = signalWrite(contextWithPid(waiter));
    void door.catch(waiter.reject); doorDone = Promise.allSettled([door]);
    await waitForMemoryKey(await waiter.promise, holderPid, key);
  } finally {
    release.resolve(); await copyDone;
    if (doorDone) await doorDone;
  }
  const [copied] = await copyDone;
  if (copied.status === 'rejected') throw copied.reason;
  expect(await db.node.findFirstOrThrow({ where: { memoryId: copied.value.memoryId, loc: 'extracted' } })).toMatchObject({ role: null, isRunnable: null });
  const [result] = await doorDone!;
  if (move) {
    expect(result.status).toBe('rejected');
    if (result.status === 'rejected') expect(result.reason.extensions.code).toBe('NODE_NOT_FOUND');
    expect((await db.node.findUniqueOrThrow({ where: { id: nodeId } })).deletedAt).not.toBeNull();
  } else {
    if (result.status === 'rejected') throw result.reason;
    expect(await db.node.findUniqueOrThrow({ where: { id: nodeId } })).toMatchObject({ role: 'review', deletedAt: null });
  }
}, 20000);

it.each(['role promotion', 'runnable promotion', 'role clear', 'runnable false', 'runnable null', 'create', 'revive', 'kind content'])
('real PG: %s waits on the exact held own-memory key', async name => {
  const { lockMemoriesForChannelChange } = await import('../../../lib/channels.js');
  if (name === 'revive') await db.node.update({ where: { id: nodeId }, data: { deletedAt: new Date() } });
  const held = latch<{ pid: number; key: number }>(); const release = latch(); const waiter = latch<number>();
  const holder = db.$transaction(async tx => {
    await lockMemoriesForChannelChange(tx, [memoryId]);
    held.resolve((await tx.$queryRaw<Array<{ pid: number; key: number }>>`SELECT pg_backend_pid() AS pid, hashtext(${'channel-host:' + memoryId}) AS key`)[0]);
    await release.promise;
  }, { timeout: 15000 });
  void holder.catch(held.reject); const holderDone = Promise.allSettled([holder]);
  let writerDone: Promise<PromiseSettledResult<unknown>[]> | undefined;
  try {
    const owner = await held.promise;
    const mode = name === 'create' || name === 'revive' ? 'create' : 'update';
    const patch = name === 'role promotion' ? { role: 'review' } : name === 'runnable promotion' ? { isRunnable: true }
      : name === 'role clear' ? { role: null } : name === 'runnable false' ? { isRunnable: false }
      : name === 'runnable null' ? { isRunnable: null } : {};
    const kind = name === 'role promotion' || name === 'kind content' ? 'review' : name === 'runnable promotion' ? 'task' : undefined;
    const writer = writeNodeCore({ memoryId, loc: name === 'create' ? 'new' : 'ordinary', name: 'ordinary', ...patch }, contextWithPid(waiter), mode,
      { authoring: { kind: 'trustedHuman', authenticatedUserId: userId }, ownsKind: kind,
        ...(mode === 'update' ? { targetNodeId: nodeId } : {}) });
    void writer.catch(waiter.reject); writerDone = Promise.allSettled([writer]);
    await waitForMemoryKey(await waiter.promise, owner.pid, owner.key);
  } finally {
    release.resolve(); const a = await holderDone; const b = writerDone ? await writerDone : [];
    await settledSuccess([...a, ...b]);
  }
}, 20000);

it('authority prefix completes before the memory handshake, which precedes loc locks', async () => {
  const install = await import('./installMemory.js');
  const channels = await import('../../../lib/channels.js');
  const subtree = await import('../../../lib/nodeSubtreeLock.js');
  const authority = install.lockInstallAuthorityFirst;
  const memories = channels.lockMemoriesForChannelChange;
  const loc = subtree.lockLocForWrite;
  const order: string[] = [];
  const spies = [
    vi.spyOn(install, 'lockInstallAuthorityFirst').mockImplementation(async (...args) => { await authority(...args); order.push('authority complete'); }),
    vi.spyOn(channels, 'lockMemoriesForChannelChange').mockImplementation(async (...args) => { order.push('memory'); return memories(...args); }),
    vi.spyOn(subtree, 'lockLocForWrite').mockImplementation(async (...args) => { order.push('loc'); return loc(...args); }),
  ];
  try {
    await writeNodeCore({ memoryId, loc: 'ordinary', isRunnable: false }, ctx(), 'update', { targetNodeId: nodeId, authoring: { kind: 'carry' } });
    expect(order.indexOf('authority complete')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('memory')).toBeGreaterThan(order.indexOf('authority complete'));
    expect(order.indexOf('loc')).toBeGreaterThan(order.indexOf('memory'));
  } finally { for (const spy of spies) spy.mockRestore(); }
});

async function assertOperationJoins(operation: (context: Context) => Promise<unknown>, whileWaiting?: (pid: number) => Promise<void>) {
  const { lockMemoriesForChannelChange } = await import('../../../lib/channels.js');
  const held = latch<{ pid: number; key: number }>(); const release = latch(); const waiter = latch<number>();
  const holder = db.$transaction(async tx => {
    await lockMemoriesForChannelChange(tx, [memoryId]);
    held.resolve((await tx.$queryRaw<Array<{ pid: number; key: number }>>`SELECT pg_backend_pid() AS pid, hashtext(${'channel-host:' + memoryId}) AS key`)[0]);
    await release.promise;
  }, { timeout: 15000 });
  void holder.catch(held.reject); const holderDone = Promise.allSettled([holder]);
  let writeDone: Promise<PromiseSettledResult<unknown>[]> | undefined;
  try {
    const owner = await held.promise;
    const writing = operation(contextWithPid(waiter));
    void writing.catch(waiter.reject); writeDone = Promise.allSettled([writing]);
    const pid = await waiter.promise;
    await waitForMemoryKey(pid, owner.pid, owner.key);
    await whileWaiting?.(pid);
  } finally {
    release.resolve(); const a = await holderDone; const b = writeDone ? await writeDone : [];
    await settledSuccess([...a, ...b]);
  }
}

it('real PG: caller-owned task-export merge joins before its node lock', async () => {
  const { resolvers } = await import('./resolvers.js');
  await assertOperationJoins(context => (resolvers.Mutation as unknown as Record<string, (...args: any[]) => Promise<unknown>>).updateTaskNode({},
    { input: { id: nodeId, properties: { keep: 'present' } }, mergeExports: true }, context), async pid => {
      const [{ locked }] = await db.$queryRaw<Array<{ locked: boolean }>>`
        SELECT EXISTS (SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND granted AND pid = ${pid}
          AND objid = (hashtext(${nodeId})::bigint & 4294967295)::oid AND objsubid = 1) AS locked`;
      expect(locked, 'the caller must not own its node key while waiting for the memory set').toBe(false);
    });
  expect((await db.node.findUniqueOrThrow({ where: { id: nodeId } })).properties).toMatchObject({ keep: 'present' });
}, 20000);

it('real PG: revision restore joins even for an ordinary snapshot', async () => {
  const { resolvers } = await import('./resolvers.js');
  await writeNodeCore({ memoryId, loc: 'ordinary', content: 'second' }, ctx(), 'update', { authoring: { kind: 'carry' }, targetNodeId: nodeId });
  const revision = await db.nodeRevision.findFirstOrThrow({ where: { nodeId }, orderBy: { createdAt: 'asc' } });
  await assertOperationJoins(context => resolvers.Mutation.restoreNodeRevision({}, { revisionId: revision.id }, context));
  expect((await db.node.findUniqueOrThrow({ where: { id: nodeId } })).content).toBe('before');
}, 20000);

it('real PG: standalone memory clone takes the source key before copying stored signals', async () => {
  const { cloneMemoryGraph } = await import('../../../controller/operations/cloneMemory.js');
  const source = await db.memory.findUniqueOrThrow({ where: { id: memoryId } });
  await assertOperationJoins(context => cloneMemoryGraph(context.db, { sourceMemoryId: memoryId,
    name: 'copy', newUrn: 'test-org:copy', targetOrganizationId: source.organizationId!,
    ownerUserId: null, groupOwnerUserId: null, actorId: userId, copierReadableMemoryIds: null }));
  const copy = await db.memory.findFirstOrThrow({ where: { urn: 'test-org:copy' } });
  expect(await db.node.findFirstOrThrow({ where: { memoryId: copy.id, loc: 'ordinary' } })).toMatchObject({ role: null, isRunnable: null });
}, 20000);

it('real PG: single-node clone joins the source/destination handshake through one transaction', async () => {
  const { resolvers } = await import('./resolvers.js');
  const target = await destination();
  await assertOperationJoins(context => resolvers.Mutation.cloneNode({}, { sourceRef: nodeId, targetMemoryRef: target.id }, context));
  expect(await db.node.findFirstOrThrow({ where: { memoryId: target.id, loc: 'ordinary' } })).toMatchObject({ role: null, isRunnable: null, content: 'before' });
}, 20000);

it('real PG: owning node merge joins even when it copies only ordinary content', async () => {
  const { resolvers } = await import('./resolvers.js');
  const target = await db.node.create({ data: { memoryId, loc: 'target', name: 'target', content: 'target' } });
  await assertOperationJoins(context => resolvers.Mutation.mergeNodes({}, { input: { source: nodeId, target: target.id, include: ['CONTENT'] } }, context));
  expect((await db.node.findUniqueOrThrow({ where: { id: target.id } })).content).toContain('before');
}, 20000);

it('real PG: GraphQL move joins the source memory before relocating its node', async () => {
  const { resolvers } = await import('./resolvers.js');
  const target = await destination();
  await assertOperationJoins(context => resolvers.Mutation.moveNode({}, { sourceRef: nodeId, targetMemoryRef: target.id }, context));
  expect((await db.node.findUniqueOrThrow({ where: { id: nodeId } })).memoryId).toBe(target.id);
}, 20000);

it('signal and inline-edge reasons acquire their complete union before any loc lock', async () => {
  const targetMemory = await destination();
  const target = await db.node.create({ data: { memoryId: targetMemory.id, loc: 'endpoint', name: 'endpoint' } });
  const channels = await import('../../../lib/channels.js');
  const subtree = await import('../../../lib/nodeSubtreeLock.js');
  const acquire = channels.lockMemoriesForChannelChange;
  const lockLoc = subtree.lockLocForWrite;
  const events: Array<string[] | 'loc'> = [];
  const spies = [
    vi.spyOn(channels, 'lockMemoriesForChannelChange').mockImplementation(async (tx, ids) => { events.push([...ids]); return acquire(tx, ids); }),
    vi.spyOn(subtree, 'lockLocForWrite').mockImplementation(async (...args) => { events.push('loc'); return lockLoc(...args); }),
  ];
  try {
    await writeNodeCore({ memoryId, loc: 'ordinary', isRunnable: false, edges: [{ targetId: target.id, name: 'rel' }] }, ctx(), 'update',
      { targetNodeId: nodeId, authoring: { kind: 'carry' } });
    expect(new Set(events[0])).toEqual(new Set([memoryId, targetMemory.id]));
    expect(events.findIndex(event => event === 'loc')).toBeGreaterThan(0);
    expect(await db.edge.count({ where: { sourceId: nodeId, targetId: target.id } })).toBe(1);
  } finally { for (const spy of spies) spy.mockRestore(); }
});

it('a caller-owned transaction refuses an endpoint outside its predeclared set instead of appending a late key', async () => {
  const targetMemory = await destination();
  const target = await db.node.create({ data: { memoryId: targetMemory.id, loc: 'endpoint', name: 'endpoint' } });
  await expect(db.$transaction(tx => writeNodeCore({ memoryId, loc: 'ordinary', content: 'must roll back',
    edges: [{ targetId: target.id, name: 'rel' }] }, ctx(), 'update', { targetNodeId: nodeId, authoring: { kind: 'carry' },
      transaction: { tx, pooledDb: db, coordinationMemories: [memoryId], afterCommit: () => {} },
    }))).rejects.toMatchObject({ extensions: { code: 'NODE_WRITE_CONFLICT' } });
  expect((await db.node.findUniqueOrThrow({ where: { id: nodeId } })).content).toBe('before');
  expect(await db.edge.count({ where: { sourceId: nodeId } })).toBe(0);
});

it.each(['extract', 'merge'] as const)('%s takes its memory set before the initial stored-signal snapshot, not just the later re-read', async operation => {
  const channels = await import('../../../lib/channels.js');
  const acquire = channels.lockMemoriesForChannelChange;
  const events: string[] = [];
  const spy = vi.spyOn(channels, 'lockMemoriesForChannelChange').mockImplementation(async (...args) => {
    await acquire(...args); events.push('memory acquired');
  });
  const observed = new Proxy(db, { get(target, prop, receiver) {
    if (prop !== '$transaction') return Reflect.get(target, prop, receiver);
    return (work: (tx: Prisma.TransactionClient) => Promise<unknown>, options: object) => db.$transaction(tx => work(new Proxy(tx, {
      get(inner, key, recv) {
        if (key !== 'node') return Reflect.get(inner, key, recv);
        return new Proxy(tx.node, { get(delegate, method, delegateReceiver) {
          if (method !== 'findMany') return Reflect.get(delegate, method, delegateReceiver);
          const findMany = tx.node.findMany.bind(tx.node) as (args: unknown) => Promise<unknown>;
          return (args: unknown) => { events.push('node snapshot'); return findMany(args); };
        } });
      },
    })), options);
  } });
  try {
    if (operation === 'extract') await extract(observed);
    else await mergeInto(observed, (await destination()).id);
    expect(events[0]).toBe('memory acquired');
    expect(events).toContain('node snapshot');
  } finally { spy.mockRestore(); }
});

it('real PG: MCP move waits on its source memory key before overwriting the destination', async () => {
  const { createTestableMcpServer } = await import('../../../mcp/server.js');
  const sourceMemory = await db.memory.findUniqueOrThrow({ where: { id: memoryId } });
  const target = await destination();
  await db.node.create({ data: { memoryId: target.id, loc: 'ordinary', name: 'evicted' } });
  await assertOperationJoins(async context => {
    // Narrow the instrumentation surface rather than instantiating Prisma's full overloaded mock type.
    const host = db as unknown as { $transaction: (work: (tx: Prisma.TransactionClient) => Promise<unknown>, options?: { timeout?: number }) => Promise<unknown> };
    const spy = vi.spyOn(host, '$transaction').mockImplementation((work, options) => context.db.$transaction(work, options));
    try {
      const text = await createTestableMcpServer({ userId, roles: ['ADMIN'], clientId: `user:${userId}` }).callToolText('hadron_move_node', {
        urn: `hrn:node:${sourceMemory.urn}:ordinary`, targetUrn: `hrn:node:${target.urn}:ordinary`, overwrite: true,
      });
      expect(text).not.toContain('[node_write_conflict]');
    } finally { spy.mockRestore(); }
  });
  expect((await db.node.findUniqueOrThrow({ where: { id: nodeId } })).memoryId).toBe(target.id);
}, 20000);


it('real PG: Agent snapshot restore waits on its memory key before tombstones or role restoration', async () => {
  const { resolvers } = await import('./resolvers.js');
  const { lockMemoriesForChannelChange } = await import('../../../lib/channels.js');
  const orgId = (await db.memory.findUniqueOrThrow({ where: { id: memoryId } })).organizationId!;
  const agent = await resolvers.Mutation.createAgent({}, { orgId, name: 'restore-s2', visibility: 'PERSONAL' }, ctx());
  memoryId = agent.systemMemoryId!;
  nodeId = (await db.node.create({ data: { id: generateId(), memoryId, loc: 'current', name: 'current', content: 'before' } })).id;
  const revisionLoc = 'revisions:rev-1';
  await db.node.create({ data: { id: generateId(), memoryId, loc: revisionLoc, name: 'revision', nodeType: 'system',
    data: { label: 'rev-1', snapshot: { nodes: [{ loc: 'restored:review', name: 'review', nodeType: 'info', role: 'review', content: 'restored' }], edges: [] } },
  } });
  const held = latch<{ pid: number; key: number }>(); const release = latch();
  const holder = db.$transaction(async tx => {
    await lockMemoriesForChannelChange(tx, [memoryId]);
    held.resolve((await tx.$queryRaw<Array<{ pid: number; key: number }>>`SELECT pg_backend_pid() AS pid, hashtext(${'channel-host:' + memoryId}) AS key`)[0]);
    await release.promise;
  }, { timeout: 15000 });
  void holder.catch(held.reject); const holderDone = Promise.allSettled([holder]);
  // Observe every owned transaction, including the auto-save. Attribute the wait by the exact held
  // key/holder, not by assuming the first transaction is the one doing the destructive restore.
  const pids: number[] = []; const transact = db.$transaction.bind(db);
  const observed = new Proxy(db, { get(target, prop, receiver) {
    if (prop !== '$transaction') return Reflect.get(target, prop, receiver);
    return (work: (tx: Prisma.TransactionClient) => Promise<unknown>, options?: { timeout?: number; maxWait?: number }) =>
      transact(async tx => { pids.push((await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`)[0].pid); return work(tx); }, options);
  } });
  let done: Promise<PromiseSettledResult<unknown>[]> | undefined;
  try {
    const owner = await held.promise;
    done = Promise.allSettled([resolvers.Mutation.restoreRevision({}, { agentRef: agent.id, revisionLoc }, { ...ctx(), db: observed })]);
    await vi.waitFor(async () => {
      expect(pids.length).toBeGreaterThan(0);
      const waiting = await db.$queryRaw<Array<{ pid: number }>>`
        SELECT pid FROM pg_locks WHERE locktype = 'advisory' AND NOT granted
          AND pid IN (${Prisma.join(pids)})
          AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
          AND classid = ${owner.key < 0 ? 4294967295 : 0}::bigint::oid
          AND objid = ${owner.key >>> 0}::bigint::oid AND objsubid = 1
          AND ${owner.pid} = ANY(pg_blocking_pids(pid))`;
      expect(waiting, 'the actual restore must wait on C before touching live rows').toHaveLength(1);
    }, { timeout: 5000, interval: 20 });
    expect((await db.node.findUniqueOrThrow({ where: { id: nodeId } })).deletedAt).toBeNull();
    expect(await db.node.findFirst({ where: { memoryId, loc: 'restored:review' } })).toBeNull();
  } finally {
    release.resolve(); await settledSuccess([...(await holderDone), ...(done ? await done : [])]);
  }
  expect(await db.node.findFirstOrThrow({ where: { memoryId, loc: 'restored:review' } })).toMatchObject({ role: 'review', content: 'restored', deletedAt: null });
}, 20000);
