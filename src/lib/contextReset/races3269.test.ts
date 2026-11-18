/**
 * #3269 (cor:agt:050:27 §4, R118; the §10 review of #3250, P3-2) — the create paths take the #2162 per-worker lock.
 * `createAgentTask` and `createAgentTasks` create a task straight onto a worker, so a resetting worker's claim must
 * serialize with them like every other assignment path (races2162.test.ts pins hand assign, bind and finish; this
 * file pins the two creates). Each race holds a claim of a collected reset open, proves the create is WAITING on the
 * per-worker advisory lock with no row lock of any strength on the worker or the parent task taken (the order in
 * src/lib/agentTasks/workerLock.ts), then releases: the create is refused WORKER_RESETTING and writes nothing.
 *
 * Without the lock the create does not wait: it sees the worker as not yet resetting (the claim is uncommitted),
 * commits a task onto it, and the claim then lands on a worker that took new work. The `settled` and advisory-waiter
 * assertions fail at that point, before the outcome is read.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../integrations/db/client.js';
import type { Prisma } from '../../generated/prisma/index.js';
import { waitForLockWaitersOfType } from '../../test/lockWait.js';
import { ctx, M, PROC, setUpResetFixture, type ResetFixture } from '../../test/contextResetFixture.js';
import { claimContextReset, isWorkerResetting } from './contextReset.js';

vi.mock('../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));

let f: ResetFixture;
beforeEach(async () => {
  f = await setUpResetFixture();
});

/** Run `work` in a transaction held open until released; `locked` resolves once `work` is done. */
function holdOpen(work: (tx: Prisma.TransactionClient) => Promise<void>) {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  let ready!: () => void;
  const locked = new Promise<void>((r) => { ready = r; });
  const done = db.$transaction(async (tx) => { await work(tx); ready(); await gate; }, { timeout: 30_000 });
  return { locked, release, done };
}

/**
 * The row-level locks the advisory-lock WAITER already holds on `workers` or `agent_tasks`, read from pg_locks for the
 * waiting backend itself. A row lock of any strength (FOR KEY SHARE up to FOR UPDATE) shows as a granted
 * RowShareLock / RowExclusiveLock (or stronger) on the table; plain reads take only AccessShareLock and are ignored.
 * This replaces a FOR NO KEY UPDATE NOWAIT probe from a third connection, which is compatible with KEY SHARE and so
 * missed a waiter that had taken the worker row FOR KEY SHARE before the advisory lock (LOCAL review, Diego, P2-1).
 */
async function waiterRowLocks(): Promise<string[]> {
  const rows = await db.$queryRaw<Array<{ relname: string; mode: string }>>`
    SELECT c.relname, l.mode FROM pg_locks l
    JOIN pg_class c ON c.oid = l.relation
    WHERE l.granted
      AND l.pid IN (
        SELECT pid FROM pg_locks
        WHERE locktype = 'advisory' AND NOT granted
          AND pid IN (SELECT pid FROM pg_stat_activity WHERE datname = current_database()))
      AND c.relname IN ('workers', 'agent_tasks')
      AND l.mode IN ('RowShareLock', 'RowExclusiveLock', 'ShareUpdateExclusiveLock', 'ShareLock', 'ShareRowExclusiveLock', 'ExclusiveLock', 'AccessExclusiveLock')`;
  return rows.map((r) => `${r.relname}:${r.mode}`);
}

/**
 * Hold a claim of Kit's collected reset open, start `contender`, prove it waits on the advisory lock holding no row
 * lock of any strength on `workers` or `agent_tasks` (so neither Kit's worker row nor the parent's task row), then release. Returns the contender's outcome (value or thrown error).
 */
async function raceClaim<T>(resetId: string, contender: () => Promise<T>): Promise<T | unknown> {
  const hold = holdOpen(async (tx) => {
    expect((await claimContextReset(tx, { appId: f.app.id, hostId: 'orca1' }, resetId, 0, PROC, new Date())).refused).toBeNull();
  });
  await hold.locked;
  let settled = false;
  const p = contender().then((v) => v, (e: unknown) => e).finally(() => { settled = true; });
  try {
    await waitForLockWaitersOfType(db, 'advisory', 1);
    expect(settled).toBe(false);
    // The per-worker lock comes before any row: a waiter holding the worker or the parent here could cycle with the holder.
    expect(await waiterRowLocks()).toEqual([]);
  } finally {
    hold.release();
    await hold.done;
  }
  return p;
}

const ext = (e: unknown) => (e as { extensions?: { code?: string; position?: number; workerId?: string } })?.extensions ?? {};
const realTasks = () => db.agentTask.count({ where: { appId: f.app.id, handle: { not: 'AT0' } } });
const parentTask = async () => (await M.createAgentTask({}, { input: { appRef: f.app.id, title: 'Parent', source: 'https://example.test/p', assignee: { user: f.manager.id } } }, ctx(f.manager.id))) as { id: string };

describe('a create onto a worker waits for a claim in flight (#3269)', () => {
  it('createAgentTask with assignee Kit waits, is refused WORKER_RESETTING, and creates no task', async () => {
    const s = await f.collectedReset();
    const parent = await parentTask();
    const before = await realTasks();
    const out = await raceClaim(s.resetId, () => M.createAgentTask({}, {
      input: { parentTaskId: parent.id, title: 'Child onto Kit', source: 'https://example.test/c', assignee: { worker: f.kit.id } },
    }, ctx(f.manager.id)));
    expect(ext(out).code).toBe('WORKER_RESETTING');
    expect(ext(out).workerId).toBe(f.kit.id);
    expect(await realTasks()).toBe(before);
    expect(await db.agentTask.count({ where: { assigneeWorkerId: f.kit.id, title: 'Child onto Kit' } })).toBe(0);
  });

  it('createAgentTasks with Kit at position 3 waits, is refused WORKER_RESETTING at position 3, and creates nothing', async () => {
    const s = await f.collectedReset();
    const parent = await parentTask();
    const before = await realTasks();
    const item = (task: Record<string, unknown>) => ({ task: { source: 'https://example.test/b', parentTaskId: parent.id, ...task } });
    const out = await raceClaim(s.resetId, () => M.createAgentTasks({}, {
      appRef: f.app.id,
      tasks: [item({ title: 'First' }), item({ title: 'Second' }), item({ title: 'Third onto Kit', assignee: { worker: f.kit.id } })],
    }, ctx(f.manager.id)));
    expect(ext(out).code).toBe('WORKER_RESETTING');
    expect(ext(out).position).toBe(3);
    // All or none: the two tasks written before the refusal roll back with it.
    expect(await realTasks()).toBe(before);
  });

  it('the claim, not the create, commits first: Kit is resetting afterwards and holds no new task', async () => {
    const s = await f.collectedReset();
    const parent = await parentTask();
    await raceClaim(s.resetId, () => M.createAgentTask({}, {
      input: { parentTaskId: parent.id, title: 'Child onto Kit', source: 'https://example.test/c', assignee: { worker: f.kit.id } },
    }, ctx(f.manager.id)));
    expect(await isWorkerResetting(db, f.kit.id, f.app.id, new Date())).toBe(true);
  });
});
