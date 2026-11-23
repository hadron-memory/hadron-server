/** #1213 S3: current governed state skips before revision/OCC, including for managers.
 * #4725 hardening: dual-signal counting, the missing race cases, the door-first spy's
 * positive control, the harness assumptions asserted (not assumed), and the
 * deleted-since-planning refusal pinned (soft and hard) behind the comment it backs. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GraphQLError } from 'graphql';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, createDbOrgAndGraph } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { writeNodeCore } from './resolvers.mutation.node.js';
import { resolvers, type Context } from './resolvers.js';
import { Prisma } from '../../../generated/prisma/index.js';
import * as revision from '../../../lib/nodeRevisionSnapshot.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
let orgId: string, memoryId: string, userId: string, nodeId: string, ordinaryId: string;
const ctx = (): Context => ({ db, roles: ['ADMIN'], userId, clientId: `user:${userId}` });
beforeEach(async () => {
  await cleanDb(db);
  const { org, graph } = await createDbOrgAndGraph(db);
  orgId = org.id;
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

/** #4725 (Byron F6/Abigail F6): the memory key the harness re-derives must be the
 * key production actually locks. Both sides are asserted against pg_locks — the
 * WAITER waiting on this exact key, the HOLDER holding it granted — so a change
 * to the key formula or namespace fails these pins loudly, not silently. */
async function expectHoldsMemoryKey(client: Prisma.TransactionClient, pid: number, key: number, what: string) {
  const [{ holds }] = await client.$queryRaw<Array<{ holds: boolean }>>`
    SELECT EXISTS (SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND granted
      AND pid = ${pid} AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
      AND classid = ${key < 0 ? 4294967295 : 0}::bigint::oid AND objid = ${key >>> 0}::bigint::oid AND objsubid = 1) AS holds`;
  if (!holds) throw new Error(`${what} (pid ${pid}) does not hold the physical memory key ${key}: the harness observed the wrong transaction`);
}

/** A wait is attributed to THIS writer, THIS holder, database and physical one-argument memory key.
 * #4725: the holder is now also proven to HOLD the key (granted), so the wait can
 * never pass on a different advisory lock that happens to block the waiter. */
async function waitForMemoryKey(waiter: number, holder: number, key: number) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const [{ waiting }] = await db.$queryRaw<Array<{ waiting: boolean }>>`
      SELECT EXISTS (SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND NOT granted
        AND pid = ${waiter} AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
        AND classid = ${key < 0 ? 4294967295 : 0}::bigint::oid AND objid = ${key >>> 0}::bigint::oid AND objsubid = 1
        AND ${holder} = ANY(pg_blocking_pids(${waiter}::int))) AS waiting`;
    if (waiting) { await expectHoldsMemoryKey(db, holder, key, `holder ${holder}`); return; }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`writer ${waiter} never waited for holder ${holder} on memory key ${key}`);
}

/**
 * #4725 (Byron F6/Abigail F6): resolves the PID of the FIRST `$transaction` only.
 * Assumption, asserted not assumed: that first transaction is the deciding write —
 * proven by waitForMemoryKey (its PID is the one waiting on the memory key, which
 * only the write transaction takes) and by the `nodesScanned` expectations below
 * (planning completed before the pause). If the resolver ever opens an earlier
 * helper transaction, those pins go red instead of the harness quietly targeting
 * the wrong backend.
 */
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

/** Hold the first real deciding transaction AFTER its work, BEFORE commit. Later transactions run normally.
 * #4725 (Byron F6): with `expectedKey`, the held transaction is PROVEN to be the one
 * that acquired the memory key (it holds the key granted at hold time) — the held
 * transaction is the deciding write, not merely the first one to open. */
function heldTransactionDb(ready: ReturnType<typeof latch<number>>, release: ReturnType<typeof latch<void>>, capture?: (tx: Prisma.TransactionClient) => Promise<void>, expectedKey?: number) {
  let first = true;
  return new Proxy(db, { get(target, prop, receiver) {
    if (prop !== '$transaction') return Reflect.get(target, prop, receiver);
    return (work: (tx: Prisma.TransactionClient) => Promise<unknown>, options: { timeout?: number } | undefined) => {
      const hold = first; first = false;
      return db.$transaction(async tx => {
        const result = await work(tx);
        if (hold) {
          await capture?.(tx);
          if (expectedKey !== undefined) {
            const pid = (await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`)[0].pid;
            await expectHoldsMemoryKey(tx, pid, expectedKey, 'the held first $transaction');
          }
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
/** The review door clearing its own kind (#4725: the demotion race case). */
function demote(context: Context) {
  return writeNodeCore({ memoryId, loc: 'candidate', role: null }, context, 'update',
    { targetNodeId: nodeId, ownsKind: 'review', authoring: { kind: 'trustedHuman', authenticatedUserId: userId } });
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
// #4725 (Byron F6/Abigail F6): the pause gates the FIRST `$transaction`, on the
// assumption that it is the deciding write (planning runs before any transaction).
// That assumption is asserted by the pins: nodesScanned proves planning happened
// before the pause, and the PID/key wait proves the first transaction took the
// memory key. An earlier helper transaction makes them red, not quietly wrong.
function pausedBeforeTransaction(ready: ReturnType<typeof latch<void>>, release: ReturnType<typeof latch<void>>, pid: ReturnType<typeof latch<number>>) {
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
  it.each([['review', true], ['task', true], ['review', false], ['task', false]] as const)('door first (%s, ordinary match=%s): skip once before reconciliation/OCC', async (signal, ordinaryMatches) => {
    if (!ordinaryMatches) await db.node.update({ where: { id: ordinaryId }, data: { content: 'unmatched' } });
    const planned = latch(), enterBulk = latch(), bulkPid = latch<number>();
    const held = latch<number>(), releaseDoor = latch();
    const [{ key }] = await db.$queryRaw<Array<{ key: number }>>`SELECT hashtext(${'channel-host:' + memoryId}) AS key`;
    const bulk = replace({ ...ctx(), db: pausedBeforeTransaction(planned, enterBulk, bulkPid) });
    void bulk.catch(planned.reject); const bulkDone = Promise.allSettled([bulk]);
    let doorDone: Promise<PromiseSettledResult<unknown>[]> | undefined;
    const ensure = vi.spyOn(revision, 'ensureCurrentNodeRevisionInTransaction');
    let before: Awaited<ReturnType<typeof snapshot>> | undefined;
    try {
      await planned.promise;
      const door = promote({ ...ctx(), db: heldTransactionDb(held, releaseDoor, async tx => { before = await snapshot(tx); }, key) }, signal);
      void door.catch(held.reject); doorDone = Promise.allSettled([door]);
      const holder = await held.promise;
      ensure.mockClear(); // door reconciliation finished; only the bulk remains
      enterBulk.resolve();
      await waitForMemoryKey(await bulkPid.promise, holder, key);
      releaseDoor.resolve(); await drain(await doorDone);
      // The baseline was captured inside the door after its work, before commit.
      // The bulk may now run, but it may add neither reconciliation nor revisions.
      const [result] = await bulkDone;
      expect(result.status, result.status === 'rejected' ? String(result.reason) : undefined).toBe('fulfilled');
      if (result.status !== 'fulfilled') throw result.reason;
      // #4725: nodesScanned 2 proves the pause fell AFTER planning — both rows were
      // scanned and planned, so the skip below is the LOCKED re-read's, not selection's.
      expect(result.value).toMatchObject({ nodesSelected: 2, nodesScanned: 2, nodesSkipped: 1, nodesChanged: ordinaryMatches ? 1 : 0,
        totalReplacements: ordinaryMatches ? 1 : 0, skipCounts: { governed: 1, protectedAddress: 0 } });
      expect((result.value as { results: Array<{ nodeId: string }> }).results.map(x => x.nodeId)).toEqual(ordinaryMatches ? [ordinaryId] : []);
      expect(ensure.mock.calls.filter(args => args[1] === nodeId).length).toBe(0);
      // #4725 (Byron BLIND F1) positive control: the spy DOES see the ordinary row's
      // reconciliation at args[1], so the zero-filter above cannot pass vacuously —
      // a signature change breaks THIS assertion first.
      expect(ensure.mock.calls).toHaveLength(ordinaryMatches ? 1 : 0);
      if (ordinaryMatches) expect(ensure.mock.calls[0]![1]).toBe(ordinaryId);
      expect(await snapshot()).toEqual(before);
      expect((await db.node.findUniqueOrThrow({ where: { id: ordinaryId } })).content).toBe(ordinaryMatches ? 'beta' : 'unmatched');
    } finally {
      enterBulk.resolve(); releaseDoor.resolve();
      await Promise.all([bulkDone, ...(doorDone ? [doorDone] : [])]); ensure.mockRestore();
    }
  }, 20000);

  it.each(['review', 'task'] as const)('bulk first (%s): door waits on the same key, both writes succeed in order', async signal => {
    const held = latch<number>(), release = latch(), doorPid = latch<number>();
    const [{ key }] = await db.$queryRaw<Array<{ key: number }>>`SELECT hashtext(${'channel-host:' + memoryId}) AS key`;
    const bulk = replace({ ...ctx(), db: heldTransactionDb(held, release, undefined, key) });
    void bulk.catch(held.reject); const bulkDone = Promise.allSettled([bulk]);
    let doorDone: Promise<PromiseSettledResult<unknown>[]> | undefined;
    let primary: { error: unknown } | undefined;
    try {
      const holder = await held.promise;
      const door = promote(contextWithPid(doorPid), signal);
      void door.catch(doorPid.reject); doorDone = Promise.allSettled([door]);
      await waitForMemoryKey(await doorPid.promise, holder, key);
    } catch (e) {
      primary = { error: e }; // #4725 (Byron F7): keep the ORIGINAL error; the finally must not replace it
    } finally {
      release.resolve();
      const settled = [...(await bulkDone), ...(doorDone ? await doorDone : [])];
      if (primary) {
        // Surface the harness failure itself; a secondary rejection is attached, not thrown in its place.
        const secondary = settled.find(result => result.status === 'rejected');
        if (secondary && primary.error instanceof Error) primary.error.cause = (secondary as PromiseRejectedResult).reason;
        throw primary.error;
      }
      await drain(settled);
    }
    const [result] = await bulkDone;
    if (result.status !== 'fulfilled') throw result.reason;
    // #4725: both rows scanned and planned (the door joined after the bulk's own
    // planning), so the door's promotion lands after the committed bulk write.
    expect(result.value).toMatchObject({ nodesScanned: 2, nodesSkipped: 0, nodesChanged: 2, skipCounts: { governed: 0, protectedAddress: 0 } });
    expect(await db.node.findUniqueOrThrow({ where: { id: nodeId } })).toMatchObject({ content: 'beta',
      ...(signal === 'review' ? { role: 'review' } : { isRunnable: true }) });
    expect((await db.node.findUniqueOrThrow({ where: { id: ordinaryId } })).content).toBe('beta');
  }, 20000);
});

// #1213 S3 (Abigail's BLIND F1): a dry run returns before the locked write, so it sees only the selection-time skip.
describe('#1213 S3 dry run reads governed state at planning, like selection', () => {
  const preview = () => resolvers.Mutation.searchReplaceInNodes({}, { input: { ...input(), dryRun: true } }, ctx());
  it.each(['review', 'task'] as const)('governed before the preview (%s): the preview skips it, and the real run agrees', async signal => {
    await promote(ctx(), signal);
    const dry = await preview();
    expect(dry).toMatchObject({ dryRun: true, nodesSkipped: 1, nodesChanged: 1, skipCounts: { governed: 1, protectedAddress: 0 } });
    expect((dry as { results: Array<{ nodeId: string }> }).results.map(x => x.nodeId)).toEqual([ordinaryId]);
    expect((await db.node.findUniqueOrThrow({ where: { id: nodeId } })).content).toBe('alpha');
    const real = await replace(ctx());
    expect(real).toMatchObject({ dryRun: false, nodesSkipped: 1, nodesChanged: 1, skipCounts: { governed: 1, protectedAddress: 0 } });
    expect((await db.node.findUniqueOrThrow({ where: { id: nodeId } })).content).toBe('alpha');
  });
  it.each(['review', 'task'] as const)('governed after the preview (%s): the preview is a planning-time snapshot that listed it; the later real run skips it (here at its own selection; a flip racing the write is skipped under the lock, pinned by the interleavings above)', async signal => {
    const dry = await preview();
    expect(dry).toMatchObject({ dryRun: true, nodesSkipped: 0, nodesChanged: 2, skipCounts: { governed: 0, protectedAddress: 0 } });
    expect((await db.node.findUniqueOrThrow({ where: { id: nodeId } })).content).toBe('alpha');
    await promote(ctx(), signal);
    const real = await replace(ctx());
    expect(real).toMatchObject({ dryRun: false, nodesSkipped: 1, nodesChanged: 1, skipCounts: { governed: 1, protectedAddress: 0 } });
    expect((await db.node.findUniqueOrThrow({ where: { id: nodeId } })).content).toBe('alpha');
    expect((await db.node.findUniqueOrThrow({ where: { id: ordinaryId } })).content).toBe('beta');
  });
});

// #4725 item 1 (Bianca SEC10 F1, mutant M4): one unique planned id contributes ONE
// governed skip however many signals it carries. No row carried both signals, so a
// per-signal counter survived every pin; both counting sites are pinned now.
describe('#4725 a dual-signal row (a runnable review) skips ONCE, at selection and under the lock', () => {
  it('fixture row with BOTH signals: selection counts one governed skip, not one per signal', async () => {
    const dualId = (await db.node.create({ data: { memoryId, loc: 'dual', name: 'dual', content: 'alpha', role: 'review', isRunnable: true } })).id;
    const result = await resolvers.Mutation.searchReplaceInNodes({}, { input: { nodeIds: [dualId, ordinaryId],
      fields: ['content'], oldText: 'alpha', newText: 'beta', dryRun: false } }, ctx());
    expect(result).toMatchObject({ nodesSelected: 2, nodesScanned: 1, nodesSkipped: 1, nodesChanged: 1,
      totalReplacements: 1, skipCounts: { governed: 1, protectedAddress: 0 } });
    expect((result as { results: Array<{ nodeId: string }> }).results.map(x => x.nodeId)).toEqual([ordinaryId]);
    expect((await db.node.findUniqueOrThrow({ where: { id: dualId } })).content).toBe('alpha');
  });

  it('both signals staged after planning: the locked re-read counts one governed skip, not one per signal', async () => {
    const planned = latch(), enterBulk = latch(), pid = latch<number>();
    const bulk = replace({ ...ctx(), db: pausedBeforeTransaction(planned, enterBulk, pid) });
    const bulkDone = Promise.allSettled([bulk]);
    try {
      await planned.promise;
      // No door can produce this state (assertGovernedWrite: one ownsKind never
      // covers two affected kinds — the task door may not edit a review), so the
      // dual combination is staged directly on the columns the counter reads; the
      // door-reachable single-signal paths are pinned by the interleavings above.
      await db.node.update({ where: { id: nodeId }, data: { role: 'review', isRunnable: true } });
      enterBulk.resolve();
      const [result] = await bulkDone;
      expect(result.status, result.status === 'rejected' ? String(result.reason) : undefined).toBe('fulfilled');
      if (result.status !== 'fulfilled') throw result.reason;
      expect(result.value).toMatchObject({ nodesSelected: 2, nodesScanned: 2, nodesSkipped: 1, nodesChanged: 1,
        totalReplacements: 1, skipCounts: { governed: 1, protectedAddress: 0 } });
      expect((result.value as { results: Array<{ nodeId: string }> }).results.map(x => x.nodeId)).toEqual([ordinaryId]);
      expect(await snapshot()).toMatchObject({ node: { role: 'review', isRunnable: true, content: 'alpha' } });
    } finally {
      enterBulk.resolve();
      await bulkDone;
    }
  }, 20000);
});

// #4725 item 2 (Abigail BLIND F7, Betty DESIGN N1): the race cases the S3 pins did not cover.
describe('#4725 more governed-skip race cases', () => {
  it('already governed before planning: the race harness still skips ONCE, at selection (scanned 1, not re-judged under the lock)', async () => {
    await promote(ctx(), 'review'); // committed before the bulk starts: planning itself sees a governed row
    const planned = latch(), enterBulk = latch(), bulkPid = latch<number>();
    const held = latch<number>(), releaseDoor = latch();
    const [{ key }] = await db.$queryRaw<Array<{ key: number }>>`SELECT hashtext(${'channel-host:' + memoryId}) AS key`;
    const bulk = replace({ ...ctx(), db: pausedBeforeTransaction(planned, enterBulk, bulkPid) });
    void bulk.catch(planned.reject); const bulkDone = Promise.allSettled([bulk]);
    let doorDone: Promise<PromiseSettledResult<unknown>[]> | undefined;
    const ensure = vi.spyOn(revision, 'ensureCurrentNodeRevisionInTransaction');
    let before: Awaited<ReturnType<typeof snapshot>> | undefined;
    try {
      await planned.promise;
      // A live door write on the already-governed row holds the memory key while the bulk waits.
      const door = promote({ ...ctx(), db: heldTransactionDb(held, releaseDoor, async tx => { before = await snapshot(tx); }, key) }, 'review');
      void door.catch(held.reject); doorDone = Promise.allSettled([door]);
      const holder = await held.promise;
      ensure.mockClear();
      enterBulk.resolve();
      await waitForMemoryKey(await bulkPid.promise, holder, key);
      releaseDoor.resolve(); await drain(await doorDone);
      const [result] = await bulkDone;
      expect(result.status, result.status === 'rejected' ? String(result.reason) : undefined).toBe('fulfilled');
      if (result.status !== 'fulfilled') throw result.reason;
      // nodesScanned 1 is the pin: the row was skipped at SELECTION (before the scan),
      // so the write transaction never re-judges it — a selection-skip removal makes
      // this 2 with the same skipCounts, which is exactly the drift this case catches.
      expect(result.value).toMatchObject({ nodesSelected: 2, nodesScanned: 1, nodesSkipped: 1, nodesChanged: 1,
        totalReplacements: 1, skipCounts: { governed: 1, protectedAddress: 0 } });
      expect((result.value as { results: Array<{ nodeId: string }> }).results.map(x => x.nodeId)).toEqual([ordinaryId]);
      expect(ensure.mock.calls).toHaveLength(1);
      expect(ensure.mock.calls[0]![1]).toBe(ordinaryId);
      expect(await snapshot()).toEqual(before);
    } finally {
      enterBulk.resolve(); releaseDoor.resolve();
      await Promise.all([bulkDone, ...(doorDone ? [doorDone] : [])]); ensure.mockRestore();
    }
  }, 20000);

  it('a non-manager contributor gets the same governed skip, not a stale-plan conflict', async () => {
    const member = (await db.user.create({ data: { id: generateId(), githubId: 121304, githubUsername: 'skip-member' } })).id;
    await db.orgMember.create({ data: { organizationId: orgId, userId: member, role: 'CONTRIBUTOR' } });
    const memberCtx = (): Context => ({ db, roles: [], userId: member, clientId: `user:${member}` });
    const planned = latch(), enterBulk = latch(), bulkPid = latch<number>();
    const held = latch<number>(), releaseDoor = latch();
    const [{ key }] = await db.$queryRaw<Array<{ key: number }>>`SELECT hashtext(${'channel-host:' + memoryId}) AS key`;
    const bulk = replace({ ...memberCtx(), db: pausedBeforeTransaction(planned, enterBulk, bulkPid) });
    void bulk.catch(planned.reject); const bulkDone = Promise.allSettled([bulk]);
    let doorDone: Promise<PromiseSettledResult<unknown>[]> | undefined;
    try {
      await planned.promise;
      const door = promote({ ...ctx(), db: heldTransactionDb(held, releaseDoor, undefined, key) }, 'review');
      void door.catch(held.reject); doorDone = Promise.allSettled([door]);
      const holder = await held.promise;
      enterBulk.resolve();
      await waitForMemoryKey(await bulkPid.promise, holder, key);
      releaseDoor.resolve(); await drain(await doorDone);
      const [result] = await bulkDone;
      expect(result.status, result.status === 'rejected' ? String(result.reason) : undefined).toBe('fulfilled');
      if (result.status !== 'fulfilled') throw result.reason;
      expect(result.value).toMatchObject({ nodesSelected: 2, nodesScanned: 2, nodesSkipped: 1, nodesChanged: 1,
        totalReplacements: 1, skipCounts: { governed: 1, protectedAddress: 0 } });
      expect((result.value as { results: Array<{ nodeId: string }> }).results.map(x => x.nodeId)).toEqual([ordinaryId]);
      expect(await snapshot()).toMatchObject({ node: { role: 'review', content: 'alpha' } });
      expect((await db.node.findUniqueOrThrow({ where: { id: ordinaryId } })).content).toBe('beta');
    } finally {
      enterBulk.resolve(); releaseDoor.resolve();
      await Promise.all([bulkDone, ...(doorDone ? [doorDone] : [])]);
    }
  }, 20000);

  it('roleWritersRefusal regression (#1331 arm of the combined condition): a tightened writer level skips, at planning and under the lock; an org admin in the audience still replaces', async () => {
    const member = (await db.user.create({ data: { id: generateId(), githubId: 121305, githubUsername: 'skip-rw-member' } })).id;
    const orgAdmin = (await db.user.create({ data: { id: generateId(), githubId: 121306, githubUsername: 'skip-rw-admin' } })).id;
    await db.orgMember.createMany({ data: [
      { organizationId: orgId, userId: member, role: 'CONTRIBUTOR' },
      { organizationId: orgId, userId: orgAdmin, role: 'ADMIN' },
    ] });
    const notesId = (await db.node.create({ data: { memoryId, loc: 'notes', name: 'notes', content: 'alpha', role: 'notes' } })).id;
    const notesInput = () => ({ nodeIds: [notesId, ordinaryId],
      fields: ['content'], oldText: 'alpha', newText: 'beta', dryRun: false });
    const run = (who: string) => resolvers.Mutation.searchReplaceInNodes({}, { input: notesInput() },
      { db, roles: [], userId: who, clientId: `user:${who}` });
    const config = await db.memoryConfig.create({ data: { id: generateId(), memoryId } });
    const tighten = () => db.nodeRoleRule.create({ data: { id: generateId(), configId: config.id, role: 'notes', writers: 'ADMIN' } });

    // Planning site: the rule already exists, so the member's plan skips the row before scanning.
    await tighten();
    const atPlanning = await run(member);
    expect(atPlanning).toMatchObject({ nodesSelected: 2, nodesScanned: 1, nodesSkipped: 1, nodesChanged: 1,
      skipCounts: { governed: 1, protectedAddress: 0 } });
    expect((atPlanning as { results: Array<{ nodeId: string }> }).results.map(x => x.nodeId)).toEqual([ordinaryId]);
    expect((await db.node.findUniqueOrThrow({ where: { id: notesId } })).content).toBe('alpha');

    // Locked site: planned while unruled, ruled while the bulk waits before its write transaction.
    await db.nodeRoleRule.deleteMany({ where: { configId: config.id } });
    await db.node.update({ where: { id: ordinaryId }, data: { content: 'alpha' } }); // reset for the second run
    const planned = latch(), enterBulk = latch(), pid = latch<number>();
    const bulk = resolvers.Mutation.searchReplaceInNodes({}, { input: notesInput() },
      { db: pausedBeforeTransaction(planned, enterBulk, pid), roles: [], userId: member, clientId: `user:${member}` });
    const bulkDone = Promise.allSettled([bulk]);
    try {
      await planned.promise;
      await tighten();
      enterBulk.resolve();
      const [result] = await bulkDone;
      expect(result.status, result.status === 'rejected' ? String(result.reason) : undefined).toBe('fulfilled');
      if (result.status !== 'fulfilled') throw result.reason;
      expect(result.value).toMatchObject({ nodesSelected: 2, nodesScanned: 2, nodesSkipped: 1, nodesChanged: 1,
        skipCounts: { governed: 1, protectedAddress: 0 } });
      expect((result.value as { results: Array<{ nodeId: string }> }).results.map(x => x.nodeId)).toEqual([ordinaryId]);
      expect((await db.node.findUniqueOrThrow({ where: { id: notesId } })).content).toBe('alpha');
    } finally {
      enterBulk.resolve();
      await bulkDone;
    }

    // Control: the same rule and the same batch for an org admin in the audience — no skip.
    await db.node.update({ where: { id: ordinaryId }, data: { content: 'alpha' } });
    const asAdmin = await run(orgAdmin);
    expect(asAdmin).toMatchObject({ nodesSelected: 2, nodesScanned: 2, nodesSkipped: 0, nodesChanged: 2,
      skipCounts: { governed: 0, protectedAddress: 0 } });
    expect((await db.node.findUniqueOrThrow({ where: { id: notesId } })).content).toBe('beta');
  }, 20000);

  it('demotion: governed at plan time, ordinary at lock time — the selection-time skip stands, the row is not resurrected', async () => {
    await promote(ctx(), 'review'); // planning will see a governed row and skip it at selection
    const planned = latch(), enterBulk = latch(), pid = latch<number>();
    const bulk = replace({ ...ctx(), db: pausedBeforeTransaction(planned, enterBulk, pid) });
    const bulkDone = Promise.allSettled([bulk]);
    try {
      await planned.promise;
      await demote(ctx()); // the review door clears its own kind while the bulk waits
      enterBulk.resolve();
      const [result] = await bulkDone;
      expect(result.status, result.status === 'rejected' ? String(result.reason) : undefined).toBe('fulfilled');
      if (result.status !== 'fulfilled') throw result.reason;
      // The row was never planned, so the locked re-read never re-judges it: the
      // selection-time skip is final even though the row is ordinary again at the
      // lock. A selection-skip removal would plan it and write it (nodesChanged 2).
      expect(result.value).toMatchObject({ nodesSelected: 2, nodesScanned: 1, nodesSkipped: 1, nodesChanged: 1,
        totalReplacements: 1, skipCounts: { governed: 1, protectedAddress: 0 } });
      expect((result.value as { results: Array<{ nodeId: string }> }).results.map(x => x.nodeId)).toEqual([ordinaryId]);
      expect(await snapshot()).toMatchObject({ node: { role: null, isRunnable: null, content: 'alpha' } });
      expect((await db.node.findUniqueOrThrow({ where: { id: ordinaryId } })).content).toBe('beta');
    } finally {
      enterBulk.resolve();
      await bulkDone;
    }
  }, 20000);
});

// #4725 item 6 (Byron BLIND F2): the "deleted since planning" sentence in the S3
// comment is backed by pins, not prose. Soft-deleted (present in lockedRoles) and
// hard-deleted (missing from lockedRoles) both refuse the batch NODE_WRITE_CONFLICT
// at the per-row locked deletedAt/missing check, and nothing is written.
describe('#4725 deleted since planning refuses the batch (soft and hard)', () => {
  it.each(['soft', 'hard'] as const)('%s delete between planning and the locked write: NODE_WRITE_CONFLICT, all-or-nothing', async kind => {
    const revisionsBefore = await db.nodeRevision.count({ where: { nodeId: ordinaryId } });
    const planned = latch(), enterBulk = latch(), pid = latch<number>();
    const bulk = replace({ ...ctx(), db: pausedBeforeTransaction(planned, enterBulk, pid) });
    const bulkDone = Promise.allSettled([bulk]);
    try {
      await planned.promise;
      if (kind === 'soft') await db.node.update({ where: { id: nodeId }, data: { deletedAt: new Date() } });
      else await db.node.delete({ where: { id: nodeId } });
      enterBulk.resolve();
      const [result] = await bulkDone;
      expect(result.status).toBe('rejected');
      const reason = (result as PromiseRejectedResult).reason;
      expect(reason).toBeInstanceOf(GraphQLError);
      expect((reason as GraphQLError).extensions.code).toBe('NODE_WRITE_CONFLICT');
      // All-or-nothing: the ordinary row was planned and writable, but the batch refused.
      expect((await db.node.findUniqueOrThrow({ where: { id: ordinaryId } })).content).toBe('alpha');
      expect(await db.nodeRevision.count({ where: { nodeId: ordinaryId } })).toBe(revisionsBefore);
      if (kind === 'soft') {
        const tombstone = await db.node.findUniqueOrThrow({ where: { id: nodeId } });
        expect(tombstone.deletedAt).not.toBeNull();
        expect(tombstone.content).toBe('alpha');
      } else {
        expect(await db.node.findUnique({ where: { id: nodeId } })).toBeNull();
      }
    } finally {
      enterBulk.resolve();
      await bulkDone;
    }
  }, 20000);
});
