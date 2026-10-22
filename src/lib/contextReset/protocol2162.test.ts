/**
 * #2162 (cor:agt:050:27) — the host's protocol for a reset it collected: claim → registerRecovery → authorizeStop →
 * agentStopped → relaunched, then the 070:02 report. The fence (no new work, no new session while `resetting`), the
 * epoch, replay, cancellation by a hand clear or a host marking the worker down, and the sweep.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { generateId } from '../id.js';
import { code, ctx, M, MIN, NEW_PROC, PROC, setUpResetFixture, type ResetFixture } from '../../test/contextResetFixture.js';
import { CONTEXT_RESET_DONE_EVENT, CONTEXT_RESET_FAILED_EVENT, isWorkerResetting, sweepContextResets } from './contextReset.js';
import { CLAIM_LEASE_MS, STOP_LEASE_MS, stopLeaseEnd } from './types.js';
import { taskStallTick } from '../../jobs/taskStallEvaluator.js';
import { taskMatcherTick } from '../../jobs/taskMatcher.js';
import { HOST_REPORT_TIMEOUT_DEFAULT_MINUTES } from '../hostOperations/settle.js';

vi.mock('../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));

let f: ResetFixture;
beforeEach(async () => {
  f = await setUpResetFixture();
});

const reset = (id: string) => db.contextReset.findUniqueOrThrow({ where: { id } });
const mark = () => db.workerAvailability.findUnique({ where: { workerId: f.kit.id } });
const resetting = () => isWorkerResetting(db, f.kit.id, f.app.id, new Date());

type Stage = { taskId: string; resetId: string; operationId: string };
const claim = (s: Stage, extra: Record<string, unknown> = {}) => f.step('claimContextReset', { resetId: s.resetId, epoch: 0, process: PROC, ...extra });
const register = async (s: Stage, extra: Record<string, unknown> = {}) =>
  f.step('registerContextResetRecovery', { resetId: s.resetId, epoch: 1, checkpointNode: (await f.checkpoint()).id, sessionId: f.session.id, taskId: s.taskId, ...extra });
const authorize = (s: Stage, extra: Record<string, unknown> = {}) => f.step('authorizeContextResetStop', { resetId: s.resetId, epoch: 1, process: PROC, ...extra });
const stopped = (s: Stage) => f.step('reportContextResetAgentStopped', { resetId: s.resetId, epoch: 1 });
const relaunched = (s: Stage) => f.step('reportContextResetRelaunched', { resetId: s.resetId, epoch: 1, process: NEW_PROC });
const report = (s: Stage, input: Record<string, unknown>) =>
  M.reportHostOperation({}, { input: { appRef: f.app.id, id: s.operationId, ...input } }, f.keyCtx());

async function claimed(): Promise<Stage> {
  const s = await f.collectedReset();
  expect((await claim(s)).refused).toBeNull();
  return s;
}
async function checkpointed(): Promise<Stage> {
  const s = await claimed();
  expect((await register(s)).refused).toBeNull();
  return s;
}
async function granted(): Promise<Stage> {
  const s = await checkpointed();
  expect((await authorize(s)).refused).toBeNull();
  return s;
}
async function agentStopped(): Promise<Stage> {
  const s = await granted();
  expect((await stopped(s)).refused).toBeNull();
  return s;
}

describe('the happy path (cor:agt:050:27 §1.5–§4)', () => {
  it('claim → recovery → stop → stopped → relaunched → SUCCEEDED; the mark lifts on the relaunched agent\'s first activity', async () => {
    const s = await f.collectedReset();
    const c = await claim(s);
    expect(c).toMatchObject({ refused: null, replayed: false, reset: { phase: 'claimed', epoch: 1 } });
    expect(await mark()).toMatchObject({ state: 'unavailable', reason: 'resetting', setBy: 'context-reset' });
    const m1 = (await mark())!;
    expect(m1.until!.getTime() - m1.setAt.getTime()).toBe(CLAIM_LEASE_MS);
    expect(await resetting()).toBe(true);

    expect(await register(s)).toMatchObject({ refused: null, reset: { phase: 'checkpointed' } });
    const g = await authorize(s);
    expect(g).toMatchObject({ refused: null, reset: { phase: 'stop-granted', stopLeaseMs: STOP_LEASE_MS } });
    expect((await mark())!.until!.getTime()).toBe(stopLeaseEnd(new Date(g.reset.stopGrantedAt), STOP_LEASE_MS).getTime());

    expect(await stopped(s)).toMatchObject({ refused: null, reset: { phase: 'agent-stopped' } });
    const m3 = (await mark())!;
    expect(m3).toMatchObject({ reason: 'resetting' });
    expect(m3.clearsOnActivityAfter).not.toBeNull();
    expect(await relaunched(s)).toMatchObject({ refused: null, reset: { phase: 'relaunched', relaunchProcess: NEW_PROC } });

    expect(await report(s, { outcome: 'SUCCEEDED' })).toMatchObject({ status: 'succeeded' });
    const done = await reset(s.resetId);
    expect(done).toMatchObject({ phase: 'done', reason: null });
    expect(await db.agentTeamEvent.count({ where: { type: CONTEXT_RESET_DONE_EVENT } })).toBe(1);

    // Still resetting until the relaunched agent acts; then the stall tick writes the mark down.
    expect(await resetting()).toBe(true);
    const later = new Date(Date.now() + 2_000);
    await db.session.update({ where: { id: f.session.id }, data: { updatedAt: later } });
    await taskStallTick(db, new Date(later.getTime() + 1_000));
    expect(await mark()).toMatchObject({ state: 'available', reason: null, setBy: 'context-reset', clearsOnActivityAfter: null });
    // The session and the binding survive the whole reset (a shed, never a session end).
    expect((await db.session.findUniqueOrThrow({ where: { id: f.session.id } })).endedAt).toBeNull();
  });

  it('every step is idempotent: a replay answers replayed with the same record, and a stop is granted once', async () => {
    const s = await f.collectedReset();
    await claim(s);
    expect(await claim(s)).toMatchObject({ replayed: true, refused: null, reset: { phase: 'claimed', epoch: 1 } });
    await register(s);
    expect((await register(s)).replayed).toBe(true);
    const g1 = await authorize(s);
    const g2 = await authorize(s);
    expect(g2.replayed).toBe(true);
    expect(new Date(g2.reset.stopGrantedAt).getTime()).toBe(new Date(g1.reset.stopGrantedAt).getTime());
    await stopped(s);
    expect((await stopped(s)).replayed).toBe(true);
    await relaunched(s);
    expect((await relaunched(s)).replayed).toBe(true);
  });
});

describe('who may act, and on what (cor:agt:070:04)', () => {
  it('another host\'s key, a person, and a guessed id read as not found; an uncollected operation is refused', async () => {
    const t = await f.startedTask();
    await f.finish(t.id);
    const r = await db.contextReset.findUniqueOrThrow({ where: { taskId: t.id } });
    expect(await code(f.step('claimContextReset', { resetId: r.id, epoch: 0, process: PROC }))).toBe('HOST_OPERATION_NOT_COLLECTED');
    const orca2 = await f.hostKey('orca2');
    await f.register(orca2);
    expect(await code(f.step('claimContextReset', { resetId: r.id, epoch: 0, process: PROC }, orca2))).toBe('CONTEXT_RESET_NOT_FOUND');
    expect(await code(f.step('claimContextReset', { resetId: generateId(), epoch: 0, process: PROC }))).toBe('CONTEXT_RESET_NOT_FOUND');
    expect(await code(M.claimContextReset({}, { input: { appRef: f.app.id, resetId: r.id, epoch: 0, process: PROC } }, ctx(f.manager.id)))).toBeDefined();
    expect(await code(f.asWorker(f.kit, () => M.claimContextReset({}, { input: { appRef: f.app.id, resetId: r.id, epoch: 0, process: PROC } }, ctx(f.holder.id))))).toBeDefined();
    expect((await reset(r.id)).phase).toBe('requested');
  });

  it('a stale epoch is refused and changes nothing; a malformed process is refused', async () => {
    const s = await f.collectedReset();
    expect(await code(claim(s, { epoch: 3 }))).toBe('STALE_EPOCH');
    expect(await code(claim(s, { process: { pid: -1, startTime: 'x' } }))).toBe('BAD_CONTEXT_RESET_INPUT');
    expect(await code(claim(s, { process: { pid: 7, startTime: '../etc' } }))).toBe('BAD_CONTEXT_RESET_INPUT');
    expect((await reset(s.resetId)).phase).toBe('requested');
    await claim(s);
    expect(await code(authorize(s, { epoch: 0 }))).toBe('STALE_EPOCH');
  });

  it('steps out of order are refused WRONG_PHASE', async () => {
    const s = await claimed();
    expect(await code(stopped(s))).toBe('CONTEXT_RESET_WRONG_PHASE');
    expect(await code(relaunched(s))).toBe('CONTEXT_RESET_WRONG_PHASE');
  });
});

describe('the claim\'s fence (§1.5): the first failing check refuses and ends the reset', () => {
  it('SESSION_CHANGED: the worker has another open session', async () => {
    const s = await f.collectedReset();
    await f.bind(f.kit);
    expect(await claim(s)).toMatchObject({ refused: 'SESSION_CHANGED', reset: { phase: 'refused', epoch: 1 } });
    expect(await mark()).toBeNull();
    expect(await db.agentTeamEvent.count({ where: { type: CONTEXT_RESET_FAILED_EVENT } })).toBe(1);
  });

  it('OTHER_WORK: a task was assigned meanwhile', async () => {
    const s = await f.collectedReset();
    await db.agentTask.create({ data: { appId: f.app.id, title: 'More', ownerUserId: f.manager.id, assigneeWorkerId: f.kit.id, status: 'pending', assignedAt: new Date(), closeSessionWhenDone: false } });
    expect((await claim(s)).refused).toBe('OTHER_WORK');
  });

  it('UNAVAILABLE: another record is in effect', async () => {
    const s = await f.collectedReset();
    await M.setWorkerAvailability({}, { input: { worker: f.kit.id, appRef: f.app.id, state: 'UNAVAILABLE', reason: 'OTHER' } }, ctx(f.manager.id));
    expect((await claim(s)).refused).toBe('UNAVAILABLE');
    expect(await mark()).toMatchObject({ reason: 'other' });
  });

  it('PAUSED, SETTING_OFF and WORKER_GONE', async () => {
    const a = await f.collectedReset();
    await db.app.update({ where: { id: f.app.id }, data: { teamPausedAt: new Date() } });
    expect((await claim(a)).refused).toBe('PAUSED');
    await db.app.update({ where: { id: f.app.id }, data: { teamPausedAt: null } });
    const b = await f.collectedReset();
    await M.updateAgent({}, { ref: f.agentId, resetContextAfterTask: false }, ctx(f.manager.id));
    expect((await claim(b)).refused).toBe('SETTING_OFF');
    await M.updateAgent({}, { ref: f.agentId, resetContextAfterTask: true }, ctx(f.manager.id));
    const c = await f.collectedReset();
    await db.worker.update({ where: { id: f.kit.id }, data: { retiredAt: new Date() } });
    expect((await claim(c)).refused).toBe('WORKER_GONE');
  });

  it('a refused claim replays its refusal at the epoch it was made at', async () => {
    const s = await f.collectedReset();
    await f.bind(f.kit);
    await claim(s);
    expect(await claim(s)).toMatchObject({ refused: 'SESSION_CHANGED', replayed: true });
  });
});

describe('no new work and no new session while resetting (§4, R118)', () => {
  it('assign, reassign and create onto Kit are refused WORKER_RESETTING; to Ada they go through', async () => {
    await claimed();
    const free = await db.agentTask.create({ data: { appId: f.app.id, title: 'Free', ownerUserId: f.manager.id, status: 'backlog', closeSessionWhenDone: false }, select: { id: true } });
    expect(await code(M.assignAgentTask({}, { taskId: free.id, assignee: { worker: f.kit.id } }, ctx(f.manager.id)))).toBe('WORKER_RESETTING');
    const adas = await db.agentTask.create({ data: { appId: f.app.id, title: 'Ada\'s', ownerUserId: f.manager.id, assigneeWorkerId: f.ada.id, status: 'pending', assignedAt: new Date(), closeSessionWhenDone: false }, select: { id: true } });
    expect(await code(M.reassignAgentTask({}, { taskId: adas.id, assignee: { worker: f.kit.id } }, ctx(f.manager.id)))).toBe('WORKER_RESETTING');
    expect(await code(M.createAgentTask({}, { input: { appRef: f.app.id, title: 'New', assignee: { worker: f.kit.id } } }, ctx(f.manager.id)))).toBe('WORKER_RESETTING');
    expect(await code(M.assignAgentTask({}, { taskId: free.id, assignee: { worker: f.ada.id } }, ctx(f.manager.id)))).toBeUndefined();
    expect(await db.agentTask.count({ where: { assigneeWorkerId: f.kit.id, status: { in: ['pending', 'started'] } } })).toBe(0);
  });

  it('the matcher skips Kit', async () => {
    await claimed();
    const queued = await db.agentTask.create({ data: { appId: f.app.id, title: 'Queued', ownerUserId: f.manager.id, status: 'pending', closeSessionWhenDone: false }, select: { id: true } });
    await taskMatcherTick(db, new Date());
    expect((await db.agentTask.findUniqueOrThrow({ where: { id: queued.id } })).assigneeWorkerId).toBeNull();
  });

  it('a new session bind is refused WORKER_RESETTING, force included', async () => {
    await claimed();
    const bindIt = (force: boolean) => M.startSession({}, { input: { id: generateId(), workerRef: f.kit.id, appRef: f.app.id, force } }, ctx(f.holder.id));
    expect(await code(bindIt(true))).toBe('WORKER_RESETTING');
    expect(await db.session.count({ where: { workerId: f.kit.id, endedAt: null } })).toBe(1);
  });

  it('after the reset ends, Kit takes work again', async () => {
    const s = await claimed();
    await f.step('reportContextResetRelaunchFailed', { resetId: s.resetId, epoch: 1, reason: 'CHECKPOINT_FAILED' });
    expect(await resetting()).toBe(false);
    const free = await db.agentTask.create({ data: { appId: f.app.id, title: 'Free', ownerUserId: f.manager.id, status: 'backlog', closeSessionWhenDone: false }, select: { id: true } });
    expect(await code(M.assignAgentTask({}, { taskId: free.id, assignee: { worker: f.kit.id } }, ctx(f.manager.id)))).toBeUndefined();
  });
});

describe('recovery before process control (§3.4)', () => {
  it('RECOVERY_REF_INVALID: another session, another task, a node outside Kit\'s memory, a missing node; nothing changes', async () => {
    const s = await claimed();
    const other = await db.memory.create({ data: { id: generateId(), organizationId: f.orgId, appId: f.app.id, urn: `x-${generateId()}:other`, name: 'Other', class: 'app' }, select: { id: true } });
    expect(await code(register(s, { sessionId: generateId() }))).toBe('RECOVERY_REF_INVALID');
    expect(await code(register(s, { taskId: generateId() }))).toBe('RECOVERY_REF_INVALID');
    expect(await code(register(s, { checkpointNode: (await f.checkpoint(other.id)).id }))).toBe('RECOVERY_REF_INVALID');
    expect(await code(register(s, { checkpointNode: generateId() }))).toBe('RECOVERY_REF_INVALID');
    expect((await reset(s.resetId)).phase).toBe('claimed');
    expect((await register(s)).refused).toBeNull();
  });

  it('NO_RECOVERY_REF: a stop asked before recovery is registered refuses the reset and releases the mark', async () => {
    const s = await claimed();
    expect(await authorize(s)).toMatchObject({ refused: 'NO_RECOVERY_REF', reset: { phase: 'refused' } });
    expect(await mark()).toMatchObject({ state: 'available', setBy: 'context-reset' });
    expect(await resetting()).toBe(false);
  });
});

describe('the stop grant (§2.1)', () => {
  it('PROCESS_CHANGED: the process to stop is not the one the claim observed', async () => {
    const s = await checkpointed();
    expect((await authorize(s, { process: NEW_PROC })).refused).toBe('PROCESS_CHANGED');
  });

  it('NOT_IDLE: the session acted after the claim', async () => {
    const s = await checkpointed();
    await db.session.update({ where: { id: f.session.id }, data: { updatedAt: new Date(Date.now() + 1_000) } });
    expect((await authorize(s)).refused).toBe('NOT_IDLE');
    expect(await resetting()).toBe(false);
  });

  it('CLAIM_LAPSED: a stop asked after the claim lease', async () => {
    const s = await checkpointed();
    await db.contextReset.update({ where: { id: s.resetId }, data: { claimedAt: new Date(Date.now() - CLAIM_LEASE_MS - 1_000) } });
    expect((await authorize(s)).refused).toBe('CLAIM_LAPSED');
  });

  it('a replayed grant for another process is refused, and grants nothing new', async () => {
    const s = await granted();
    const before = (await reset(s.resetId)).stopGrantedAt!.getTime();
    expect(await code(authorize(s, { process: NEW_PROC }))).toBe('CONTEXT_RESET_WRONG_PHASE');
    expect((await reset(s.resetId)).stopGrantedAt!.getTime()).toBe(before);
  });
});

describe('cancellation by another writer (§2.4)', () => {
  it('a hand clear before the grant: the reset ends CANCELLED_BY_CLEAR at once, the epoch moves, the worker is available', async () => {
    const s = await checkpointed();
    await M.setWorkerAvailability({}, { input: { worker: f.kit.id, appRef: f.app.id, state: 'AVAILABLE' } }, ctx(f.manager.id));
    expect(await reset(s.resetId)).toMatchObject({ phase: 'failed', reason: 'CANCELLED_BY_CLEAR', epoch: 2, releasePendingAt: null });
    expect(await mark()).toMatchObject({ state: 'available' });
    expect(await code(authorize(s))).toBe('STALE_EPOCH');
  });

  it('a hand clear after the grant: the reset ends, but the worker stays resetting until the stop lease ends', async () => {
    const s = await granted();
    const r0 = await reset(s.resetId);
    const leaseEnd = stopLeaseEnd(r0.stopGrantedAt!, r0.stopLeaseMs!);
    await M.setWorkerAvailability({}, { input: { worker: f.kit.id, appRef: f.app.id, state: 'AVAILABLE' } }, ctx(f.manager.id));
    const r = await reset(s.resetId);
    expect(r).toMatchObject({ phase: 'failed', reason: 'CANCELLED_BY_CLEAR' });
    expect(r.releasePendingAt!.getTime()).toBe(leaseEnd.getTime());
    expect(await mark()).toMatchObject({ state: 'unavailable', reason: 'resetting' });
    expect((await mark())!.until!.getTime()).toBe(leaseEnd.getTime());
    expect(await isWorkerResetting(db, f.kit.id, f.app.id, new Date(leaseEnd.getTime() - 1))).toBe(true);
    expect(await isWorkerResetting(db, f.kit.id, f.app.id, leaseEnd)).toBe(false);
    expect(await code(stopped(s))).toBe('STALE_EPOCH');
  });

  it('a host marking Kit down replaces the resetting mark and ends the reset HOST_LOST', async () => {
    const s = await claimed();
    await M.setHostWorkerAvailability({}, { input: { appRef: f.app.id, worker: f.kit.id, state: 'UNAVAILABLE', reason: 'HOST_DOWN' } }, f.keyCtx());
    expect(await reset(s.resetId)).toMatchObject({ phase: 'failed', reason: 'HOST_LOST' });
    expect(await mark()).toMatchObject({ state: 'unavailable', reason: 'host-down', setBy: 'host' });
  });

  it('a host may not mark Kit out-of-tokens over the resetting mark', async () => {
    await claimed();
    expect(await code(M.setHostWorkerAvailability({}, { input: { appRef: f.app.id, worker: f.kit.id, state: 'UNAVAILABLE', reason: 'OUT_OF_TOKENS' } }, f.keyCtx())))
      .toBe('AVAILABILITY_NOT_PERMITTED');
  });
});

describe('the 070:02 report', () => {
  it('SUCCEEDED before the agent is relaunched is refused HOST_OPERATION_NOT_DONE and changes nothing', async () => {
    const s = await agentStopped();
    expect(await code(report(s, { outcome: 'SUCCEEDED' }))).toBe('HOST_OPERATION_NOT_DONE');
    expect((await reset(s.resetId)).phase).toBe('agent-stopped');
    expect((await db.hostOperation.findUniqueOrThrow({ where: { id: s.operationId } })).status).toBe('collected');
  });

  it('FAILED names its closed reason first; a free-text-only reason is refused', async () => {
    const s = await claimed();
    expect(await code(report(s, { outcome: 'FAILED', failureReason: 'tree was dirty' }))).toBe('BAD_CONTEXT_RESET_INPUT');
    expect(await report(s, { outcome: 'FAILED', failureReason: 'DIRTY_TREE: 3 files' })).toMatchObject({ status: 'failed' });
    expect(await reset(s.resetId)).toMatchObject({ phase: 'refused', reason: 'DIRTY_TREE' });
    expect(await resetting()).toBe(false);
  });

  it('a reset already ended by a step keeps its outcome when the operation is reported', async () => {
    const s = await claimed();
    await f.step('reportContextResetRelaunchFailed', { resetId: s.resetId, epoch: 1, reason: 'STAGING_FAILED' });
    expect(await report(s, { outcome: 'FAILED', failureReason: 'whatever' })).toMatchObject({ status: 'failed' });
    expect(await reset(s.resetId)).toMatchObject({ reason: 'STAGING_FAILED' });
  });

  it('relaunchFailed takes only its closed reasons', async () => {
    const s = await claimed();
    expect(await code(f.step('reportContextResetRelaunchFailed', { resetId: s.resetId, epoch: 1, reason: 'NOT_IDLE' }))).toBe('BAD_CONTEXT_RESET_INPUT');
  });
});

describe('the sweep (from the stall tick)', () => {
  it('CLAIM_LAPSED after the claim lease, and the mark is released', async () => {
    const s = await claimed();
    const at = new Date(Date.now() + CLAIM_LEASE_MS + 1_000);
    expect((await taskStallTick(db, at)).contextResetsEnded).toBe(1);
    expect(await reset(s.resetId)).toMatchObject({ phase: 'failed', reason: 'CLAIM_LAPSED' });
    expect(await isWorkerResetting(db, f.kit.id, f.app.id, at)).toBe(false);
  });

  it('SESSION_ENDED when the session ends under a live reset', async () => {
    const s = await claimed();
    await db.session.update({ where: { id: f.session.id }, data: { endedAt: new Date() } });
    expect(await sweepContextResets(db, new Date())).toBe(1);
    expect(await reset(s.resetId)).toMatchObject({ reason: 'SESSION_ENDED' });
  });

  it('WORKER_GONE when the worker is retired', async () => {
    const s = await claimed();
    await db.worker.update({ where: { id: f.kit.id }, data: { retiredAt: new Date() } });
    expect(await sweepContextResets(db, new Date())).toBe(1);
    expect(await reset(s.resetId)).toMatchObject({ reason: 'WORKER_GONE' });
  });

  /** The tick at which the 070:02 settle times a collected operation out (and the reset sweep runs after it). */
  const pastReportTimeout = async (s: Stage) => {
    const op = await db.hostOperation.findUniqueOrThrow({ where: { id: s.operationId } });
    return new Date(op.collectedAt!.getTime() + (HOST_REPORT_TIMEOUT_DEFAULT_MINUTES + 1) * MIN);
  };

  it('a collected operation never reported, before any stop: REPORT_TIMEOUT, in the same tick as the settle', async () => {
    const s = await checkpointed();
    const tick = await taskStallTick(db, await pastReportTimeout(s));
    expect(tick).toMatchObject({ hostOperationsSettled: 1, contextResetsEnded: 1 });
    expect(await reset(s.resetId)).toMatchObject({ phase: 'failed', reason: 'REPORT_TIMEOUT' });
  });

  it('never reported after a granted stop: RELAUNCH_UNVERIFIED', async () => {
    const s = await agentStopped();
    expect((await taskStallTick(db, await pastReportTimeout(s))).contextResetsEnded).toBe(1);
    expect(await reset(s.resetId)).toMatchObject({ reason: 'RELAUNCH_UNVERIFIED' });
  });

  it('a requested reset whose host was lost before collecting: HOST_LOST', async () => {
    const t = await f.startedTask();
    await f.finish(t.id);
    const r = await db.contextReset.findUniqueOrThrow({ where: { taskId: t.id } });
    await db.hostRegistration.updateMany({ data: { lostAt: new Date() } });
    expect(await taskStallTick(db, new Date())).toMatchObject({ hostOperationsSettled: 1, contextResetsEnded: 1 });
    expect(await reset(r.id)).toMatchObject({ phase: 'failed', reason: 'HOST_LOST' });
  });

  it('a second sweep changes nothing', async () => {
    await claimed();
    const at = new Date(Date.now() + CLAIM_LEASE_MS + 1_000);
    expect(await sweepContextResets(db, at)).toBe(1);
    expect(await sweepContextResets(db, at)).toBe(0);
  });

  it('the relaunched agent\'s activity after a stop ends the mark even before the report (R6)', async () => {
    const s = await agentStopped();
    await relaunched(s);
    const later = new Date(Date.now() + 2_000);
    await db.session.update({ where: { id: f.session.id }, data: { updatedAt: later } });
    await sweepContextResets(db, new Date(later.getTime() + 1_000));
    expect(await mark()).toMatchObject({ state: 'available' });
    expect((await reset(s.resetId)).phase).toBe('relaunched');
  });

  it('a claim mark lapses with its until even before any sweep', async () => {
    await claimed();
    expect(await isWorkerResetting(db, f.kit.id, f.app.id, new Date(Date.now() + CLAIM_LEASE_MS + MIN))).toBe(false);
  });
});
