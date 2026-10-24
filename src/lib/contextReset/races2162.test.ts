/**
 * #2162 (cor:agt:050:27) — the fence under real concurrency. Every writer that decides whether a worker may take work
 * or be reset takes the per-worker lock (src/lib/agentTasks/workerLock.ts) BEFORE any row lock, so:
 *   - a claim and an assignment, a bind or a finish serialize on it, and whichever commits second sees the first;
 *   - a writer waiting on it holds neither the worker row nor the task row (no inversion with the matcher's order).
 * Each race holds one side open in a transaction and proves the other is waiting on the advisory lock before release.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../integrations/db/client.js';
import type { Prisma } from '../../generated/prisma/index.js';
import { generateId } from '../id.js';
import { waitForLockWaitersOfType } from '../../test/lockWait.js';
import { ctx, M, PROC, setUpResetFixture, type ResetFixture } from '../../test/contextResetFixture.js';
import { claimContextReset, isWorkerResetting } from './contextReset.js';
import { lockWorkersForAssignment } from '../agentTasks/workerLock.js';

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
 * Is the row free of every SHARE / UPDATE lock right now (FOR NO KEY UPDATE NOWAIT from a third connection)? The
 * holder's foreign-key checks take KEY SHARE on the worker row, which this does not conflict with; a waiter that had
 * already locked the row FOR SHARE or FOR UPDATE would.
 */
async function rowFree(table: 'workers' | 'agent_tasks', id: string): Promise<boolean> {
  try {
    await db.$transaction(async (tx) => {
      await tx.$queryRawUnsafe(`SELECT id FROM ${table} WHERE id = $1 FOR NO KEY UPDATE NOWAIT`, id);
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Hold `hold` open, start `contender`, prove it waits on an advisory lock with the worker row (and `taskId`'s row)
 * still free, then release. Returns the contender's outcome (its value, or the error it threw).
 */
async function race<T>(hold: ReturnType<typeof holdOpen>, contender: () => Promise<T>, taskId?: string): Promise<T | unknown> {
  await hold.locked;
  let settled = false;
  const p = contender().then((v) => v, (e: unknown) => e).finally(() => { settled = true; });
  try {
    await waitForLockWaitersOfType(db, 'advisory', 1);
    expect(settled).toBe(false);
    // The order: the per-worker lock before any row. A waiter holding a row here could cycle with the holder.
    expect(await rowFree('workers', f.kit.id)).toBe(true);
    if (taskId) expect(await rowFree('agent_tasks', taskId)).toBe(true);
  } finally {
    hold.release();
    await hold.done;
  }
  return p;
}

const host = () => ({ appId: f.app.id, hostId: 'orca1' });
const errCode = (e: unknown) => (e as { extensions?: { code?: string } })?.extensions?.code;

describe('a claim in flight is waited for', () => {
  it('a hand assign onto Kit waits, then is refused WORKER_RESETTING', async () => {
    const s = await f.collectedReset();
    const free = await db.agentTask.create({ data: { appId: f.app.id, title: 'Free', ownerUserId: f.manager.id, status: 'backlog', closeSessionWhenDone: false }, select: { id: true } });
    const hold = holdOpen(async (tx) => {
      expect((await claimContextReset(tx, host(), s.resetId, 0, PROC, new Date())).refused).toBeNull();
    });
    const out = await race(hold, () => M.assignAgentTask({}, { taskId: free.id, assignee: { worker: f.kit.id } }, ctx(f.manager.id)), free.id);
    expect(errCode(out)).toBe('WORKER_RESETTING');
    expect((await db.agentTask.findUniqueOrThrow({ where: { id: free.id } })).assigneeWorkerId).toBeNull();
  });

  it('a forced bind waits, then is refused WORKER_RESETTING; Kit keeps one open session', async () => {
    const s = await f.collectedReset();
    const hold = holdOpen(async (tx) => {
      expect((await claimContextReset(tx, host(), s.resetId, 0, PROC, new Date())).refused).toBeNull();
    });
    const out = await race(hold, () => M.startSession({}, { input: { id: generateId(), workerRef: f.kit.id, appRef: f.app.id, force: true } }, ctx(f.holder.id)));
    expect(errCode(out)).toBe('WORKER_RESETTING');
    expect(await db.session.count({ where: { workerId: f.kit.id, endedAt: null } })).toBe(1);
  });
});

describe('a writer in flight is waited for by the claim', () => {
  it('an assignment committed first: the claim is refused OTHER_WORK', async () => {
    const s = await f.collectedReset();
    const hold = holdOpen(async (tx) => {
      await lockWorkersForAssignment(tx, [f.kit.id]);
      await tx.agentTask.create({ data: { appId: f.app.id, title: 'Raced', ownerUserId: f.manager.id, assigneeWorkerId: f.kit.id, status: 'pending', assignedAt: new Date(), closeSessionWhenDone: false } });
    });
    const out = await race(hold, () => f.step('claimContextReset', { resetId: s.resetId, epoch: 0, process: PROC }));
    expect((out as { refused: string }).refused).toBe('OTHER_WORK');
    expect(await isWorkerResetting(db, f.kit.id, f.app.id, new Date())).toBe(false);
  });

  it('a bind committed first: the claim is refused SESSION_CHANGED', async () => {
    const s = await f.collectedReset();
    const hold = holdOpen(async (tx) => {
      await lockWorkersForAssignment(tx, [f.kit.id]);
      await tx.session.create({ data: { id: generateId(), appId: f.app.id, workerId: f.kit.id, agentId: f.agentId, userId: f.holder.id } });
    });
    const out = await race(hold, () => f.step('claimContextReset', { resetId: s.resetId, epoch: 0, process: PROC }));
    expect((out as { refused: string }).refused).toBe('SESSION_CHANGED');
  });
});

describe('the finish takes the per-worker lock before the task row', () => {
  it('a finish by the assignee waits on a held per-worker lock without holding the task or worker row, then commits', async () => {
    const t = await f.startedTask();
    const hold = holdOpen(async (tx) => {
      await lockWorkersForAssignment(tx, [f.kit.id]);
    });
    const out = await race(hold, () => f.finish(t.id), t.id);
    expect(out).toMatchObject({ status: 'finished' });
    expect(await db.contextReset.count({ where: { taskId: t.id } })).toBe(1);
  });

  it('a finish racing a claim of an earlier reset: never a deadlock; whichever commits second sees the first', async () => {
    const first = await f.collectedReset();
    const t2 = await f.startedTask();
    const gate = holdOpen(async (tx) => {
      await lockWorkersForAssignment(tx, [f.kit.id]);
    });
    await gate.locked;
    const finishing = f.finish(t2.id).then((v) => v, (e: unknown) => e);
    await waitForLockWaitersOfType(db, 'advisory', 1);
    const claiming = f.step('claimContextReset', { resetId: first.resetId, epoch: 0, process: PROC }).then((v) => v, (e: unknown) => e);
    await waitForLockWaitersOfType(db, 'advisory', 2);
    gate.release();
    await gate.done;
    const [fin, cl] = await Promise.all([finishing, claiming]);
    expect(fin).toMatchObject({ status: 'finished' });
    const refused = (cl as { refused: string | null }).refused;
    // Claim second: task 2 had ended, so nothing blocks it. Claim first: task 2 was still open.
    expect([null, 'OTHER_WORK']).toContain(refused);
    // A second reset requested by the finish can never take the fence while the first holds it.
    const second = await db.contextReset.findUnique({ where: { taskId: t2.id } });
    if (refused === null && second) {
      await M.collectHostOperations({}, { appRef: f.app.id }, f.keyCtx());
      expect((await f.step('claimContextReset', { resetId: second.id, epoch: 0, process: PROC })).refused).toBe('UNAVAILABLE');
    }
  });
});

describe('the matcher and a hand assign share the order', () => {
  it('a hand assign waiting on the matcher\'s per-worker lock holds no row the matcher takes next', async () => {
    const free = await db.agentTask.create({ data: { appId: f.app.id, title: 'Free', ownerUserId: f.manager.id, status: 'backlog', closeSessionWhenDone: false }, select: { id: true } });
    const hold = holdOpen(async (tx) => {
      await lockWorkersForAssignment(tx, [f.kit.id]);
      // What the matcher does next under that lock: the worker row, then the task row.
      await tx.$queryRaw`SELECT id FROM workers WHERE id = ${f.kit.id} FOR SHARE`;
    });
    await hold.locked;
    let settled = false;
    const p = M.assignAgentTask({}, { taskId: free.id, assignee: { worker: f.kit.id } }, ctx(f.manager.id))
      .then((v: unknown) => v, (e: unknown) => e).finally(() => { settled = true; });
    try {
      await waitForLockWaitersOfType(db, 'advisory', 1);
      expect(settled).toBe(false);
      expect(await rowFree('agent_tasks', free.id)).toBe(true);
    } finally {
      hold.release();
      await hold.done;
    }
    expect(await p).toMatchObject({ assigneeWorkerId: f.kit.id });
  });
});
