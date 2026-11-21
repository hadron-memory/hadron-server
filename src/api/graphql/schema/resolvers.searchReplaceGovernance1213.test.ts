/** #1213 S3: current governed state skips before revision/OCC, including for managers. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, createDbOrgAndGraph } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { writeNodeCore } from './resolvers.mutation.node.js';
import { resolvers, type Context } from './resolvers.js';
import { Prisma } from '../../../generated/prisma/index.js';
import * as revision from '../../../lib/nodeRevisionSnapshot.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
let memoryId: string, userId: string, nodeId: string, ordinaryId: string;
const ctx = (): Context => ({ db, roles: ['ADMIN'], userId, clientId: `user:${userId}` });
beforeEach(async () => {
  await cleanDb(db);
  const { org, graph } = await createDbOrgAndGraph(db);
  memoryId = graph.id;
  userId = (await db.user.create({ data: { id: generateId(), githubId: 121303, githubUsername: 'skip-manager', roles: ['ADMIN'] } })).id;
  await db.orgMember.create({ data: { organizationId: org.id, userId, role: 'OWNER' } });
  nodeId = (await db.node.create({ data: { memoryId, loc: 'candidate', name: 'candidate', content: 'alpha' } })).id;
  ordinaryId = (await db.node.create({ data: { memoryId, loc: 'ordinary', name: 'ordinary', content: 'alpha' } })).id;
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

/** Hold the first real deciding transaction AFTER its work, BEFORE commit. Later transactions run normally. */
function heldTransactionDb(ready: ReturnType<typeof latch<number>>, release: ReturnType<typeof latch<void>>, capture?: (tx: Prisma.TransactionClient) => Promise<void>) {
  let first = true;
  return new Proxy(db, { get(target, prop, receiver) {
    if (prop !== '$transaction') return Reflect.get(target, prop, receiver);
    return (work: (tx: Prisma.TransactionClient) => Promise<unknown>, options: { timeout?: number } | undefined) => {
      const hold = first; first = false;
      return db.$transaction(async tx => {
        const result = await work(tx);
        if (hold) {
          await capture?.(tx);
          ready.resolve((await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`)[0].pid);
          await release.promise;
        }
        return result;
      }, { ...options, timeout: 15000 });
    };
  } });
}


const input = () => ({ memoryIds: [memoryId], nodeIds: [nodeId, nodeId, ordinaryId],
  fields: ['content'], oldText: 'alpha', newText: 'beta', dryRun: false });
const replace = (context: Context) => resolvers.Mutation.searchReplaceInNodes({}, { input: input() }, context);
function promote(context: Context, signal: 'review' | 'task') {
  return writeNodeCore({ memoryId, loc: 'candidate', ...(signal === 'review' ? { role: 'review' } : { isRunnable: true }) },
    context, 'update', { targetNodeId: nodeId, ownsKind: signal,
      authoring: { kind: 'trustedHuman', authenticatedUserId: userId } });
}
async function drain(results: PromiseSettledResult<unknown>[]) {
  for (const result of results) if (result.status === 'rejected') throw result.reason;
}
async function snapshot(client: Prisma.TransactionClient = db) {
  return { node: await client.node.findUniqueOrThrow({ where: { id: nodeId } }),
    revisions: await client.nodeRevision.findMany({ where: { nodeId }, orderBy: { id: 'asc' } }) };
}

// The planner must finish on ordinary rows before the promoting door starts. This
// wrapper pauses before opening the real write transaction; it fabricates no reads.
function pausedBeforeTransaction(ready: ReturnType<typeof latch>, release: ReturnType<typeof latch>, pid: ReturnType<typeof latch<number>>) {
  const observed = contextWithPid(pid).db;
  return new Proxy(observed, { get(target, prop, receiver) {
    if (prop !== '$transaction') return Reflect.get(target, prop, receiver);
    return async (work: (tx: Prisma.TransactionClient) => Promise<unknown>, options?: { timeout?: number }) => {
      ready.resolve(); await release.promise;
      return observed.$transaction(work, options);
    };
  } });
}

describe('#1213 S3 authorized-manager interleavings', () => {
  it.each(['review', 'task'] as const)('door first (%s): skip once before reconciliation/OCC; ordinary survivor commits', async signal => {
    const planned = latch(), enterBulk = latch(), bulkPid = latch<number>();
    const held = latch<number>(), releaseDoor = latch();
    const bulk = replace({ ...ctx(), db: pausedBeforeTransaction(planned, enterBulk, bulkPid) });
    void bulk.catch(planned.reject); const bulkDone = Promise.allSettled([bulk]);
    let doorDone: Promise<PromiseSettledResult<unknown>[]> | undefined;
    const ensure = vi.spyOn(revision, 'ensureCurrentNodeRevisionInTransaction');
    let before: Awaited<ReturnType<typeof snapshot>> | undefined;
    try {
      await planned.promise;
      const door = promote({ ...ctx(), db: heldTransactionDb(held, releaseDoor, async tx => { before = await snapshot(tx); }) }, signal);
      void door.catch(held.reject); doorDone = Promise.allSettled([door]);
      const holder = await held.promise;
      ensure.mockClear(); // door reconciliation finished; only the bulk remains
      const [{ key }] = await db.$queryRaw<Array<{ key: number }>>`SELECT hashtext(${'channel-host:' + memoryId}) AS key`;
      enterBulk.resolve();
      await waitForMemoryKey(await bulkPid.promise, holder, key);
      releaseDoor.resolve(); await drain(await doorDone);
      // The baseline was captured inside the door after its work, before commit.
      // The bulk may now run, but it may add neither reconciliation nor revisions.
      const [result] = await bulkDone;
      expect(result.status).toBe('fulfilled');
      if (result.status !== 'fulfilled') throw result.reason;
      expect(result.value).toMatchObject({ nodesSelected: 2, nodesSkipped: 1, nodesChanged: 1,
        totalReplacements: 1, skipCounts: { governed: 1, protectedAddress: 0 } });
      expect((result.value as { results: Array<{ nodeId: string }> }).results.map(x => x.nodeId)).toEqual([ordinaryId]);
      expect(ensure.mock.calls.filter(args => args[1] === nodeId)).toEqual([]);
      expect(await snapshot()).toEqual(before);
      expect((await db.node.findUniqueOrThrow({ where: { id: ordinaryId } })).content).toBe('beta');
    } finally {
      enterBulk.resolve(); releaseDoor.resolve();
      await Promise.all([bulkDone, ...(doorDone ? [doorDone] : [])]); ensure.mockRestore();
    }
  }, 20000);

  it.each(['review', 'task'] as const)('bulk first (%s): door waits on the same key, both writes succeed in order', async signal => {
    const held = latch<number>(), release = latch(), doorPid = latch<number>();
    const bulk = replace({ ...ctx(), db: heldTransactionDb(held, release) });
    void bulk.catch(held.reject); const bulkDone = Promise.allSettled([bulk]);
    let doorDone: Promise<PromiseSettledResult<unknown>[]> | undefined;
    try {
      const holder = await held.promise;
      const [{ key }] = await db.$queryRaw<Array<{ key: number }>>`SELECT hashtext(${'channel-host:' + memoryId}) AS key`;
      const door = promote(contextWithPid(doorPid), signal);
      void door.catch(doorPid.reject); doorDone = Promise.allSettled([door]);
      await waitForMemoryKey(await doorPid.promise, holder, key);
    } finally {
      release.resolve(); await drain([...(await bulkDone), ...(doorDone ? await doorDone : [])]);
    }
    const [result] = await bulkDone;
    if (result.status !== 'fulfilled') throw result.reason;
    expect(result.value).toMatchObject({ nodesSkipped: 0, nodesChanged: 2, skipCounts: { governed: 0, protectedAddress: 0 } });
    expect(await db.node.findUniqueOrThrow({ where: { id: nodeId } })).toMatchObject({ content: 'beta',
      ...(signal === 'review' ? { role: 'review' } : { isRunnable: true }) });
    expect((await db.node.findUniqueOrThrow({ where: { id: ordinaryId } })).content).toBe('beta');
  }, 20000);
});
