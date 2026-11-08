/** #3309 / cor:agt:050:27 part 11: HOST_UNSUPPORTED belongs only before the claim. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Prisma } from '../../generated/prisma/index.js';
import { db } from '../../integrations/db/client.js';
import { waitForLockWaitersOfType } from '../../test/lockWait.js';
import { M, PROC, NEW_PROC, setUpResetFixture, type ResetFixture } from '../../test/contextResetFixture.js';
import {
  claimContextReset, CONTEXT_RESET_FAILED_EVENT, isWorkerResetting, onContextResetReported, sweepContextResets,
} from './contextReset.js';
import { CLAIMED_PHASES, HOST_REPORTED_REASONS, RELAUNCH_FAILED_REASONS } from './types.js';

vi.mock('../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));

let f: ResetFixture;
beforeEach(async () => { f = await setUpResetFixture(); });
type Stage = Awaited<ReturnType<ResetFixture['collectedReset']>>;
const host = () => ({ appId: f.app.id, hostId: 'orca1' });
const reset = (s: Stage) => db.contextReset.findUniqueOrThrow({ where: { id: s.resetId } });
const mark = () => db.workerAvailability.findUnique({ where: { workerId: f.kit.id } });
const report = (s: Stage, reason = 'HOST_UNSUPPORTED: missing arg x') =>
  M.reportHostOperation({}, { input: { appRef: f.app.id, id: s.operationId, outcome: 'FAILED', failureReason: reason } }, f.keyCtx());

async function atPhase(phase: string): Promise<Stage> {
  const s = await f.collectedReset();
  if (phase === 'requested') return s;
  expect((await f.step('claimContextReset', { resetId: s.resetId, epoch: 0, process: PROC })).refused).toBeNull();
  if (phase === 'claimed') return s;
  expect((await f.step('registerContextResetRecovery', {
    resetId: s.resetId, epoch: 1, checkpointNode: (await f.checkpoint()).id, sessionId: f.session.id, taskId: s.taskId,
  })).refused).toBeNull();
  if (phase === 'checkpointed') return s;
  expect((await f.step('authorizeContextResetStop', { resetId: s.resetId, epoch: 1, process: PROC })).refused).toBeNull();
  if (phase === 'stop-granted') return s;
  expect((await f.step('reportContextResetAgentStopped', { resetId: s.resetId, epoch: 1 })).refused).toBeNull();
  if (phase === 'agent-stopped') return s;
  expect((await f.step('reportContextResetRelaunched', { resetId: s.resetId, epoch: 1, process: NEW_PROC })).refused).toBeNull();
  return s;
}

function refusalText(phase: string, reasons: readonly string[]): string {
  return `A reset's failure in phase ${phase} starts with its reason: one of ${reasons.join(', ')}, then ": " and any detail.`;
}

describe('HOST_UNSUPPORTED before the claim', () => {
  it.each(['HOST_UNSUPPORTED', 'HOST_UNSUPPORTED: missing arg x'])('settles requested once: %s', async (reason) => {
    const s = await atPhase('requested');
    const task = await db.agentTask.findUniqueOrThrow({ where: { id: s.taskId } });
    expect(await report(s, reason)).toMatchObject({ status: 'failed', failureReason: reason });
    expect(await reset(s)).toMatchObject({ phase: 'failed', reason: 'HOST_UNSUPPORTED', epoch: 1 });
    expect((await reset(s)).endedAt).not.toBeNull();
    expect(await db.agentTask.findUniqueOrThrow({ where: { id: s.taskId } })).toEqual(task);
    expect(await isWorkerResetting(db, f.kit.id, f.app.id, new Date())).toBe(false);
    const events = await db.agentTeamEvent.findMany({ where: { taskId: s.taskId, type: CONTEXT_RESET_FAILED_EVENT } });
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({ reason: 'HOST_UNSUPPORTED', fromPhase: 'requested' });
    const ended = await reset(s);
    expect(await report(s, reason)).toMatchObject({ status: 'failed' });
    expect(await reset(s)).toEqual(ended);
    expect(await db.agentTeamEvent.count({ where: { taskId: s.taskId, type: CONTEXT_RESET_FAILED_EVENT } })).toBe(1);
  });

  it('requested refusal text offers HOST_UNSUPPORTED as well as every existing reason', async () => {
    const s = await atPhase('requested');
    await expect(report(s, 'unknown')).rejects.toMatchObject({
      extensions: { code: 'BAD_CONTEXT_RESET_INPUT' },
      message: refusalText('requested', ['HOST_UNSUPPORTED', ...HOST_REPORTED_REASONS]),
    });
    expect((await reset(s)).phase).toBe('requested');
  });

  it.each(CLAIMED_PHASES)('refuses after claim in %s without changing reset, operation, mark or task', async (phase) => {
    const s = await atPhase(phase);
    const before = await reset(s);
    const op = await db.hostOperation.findUniqueOrThrow({ where: { id: s.operationId } });
    const availability = await mark();
    const task = await db.agentTask.findUniqueOrThrow({ where: { id: s.taskId } });
    await expect(report(s)).rejects.toMatchObject({
      extensions: { code: 'BAD_CONTEXT_RESET_INPUT' }, message: refusalText(phase, HOST_REPORTED_REASONS),
    });
    expect(await reset(s)).toEqual(before);
    expect(await mark()).toEqual(availability);
    expect(await db.hostOperation.findUniqueOrThrow({ where: { id: s.operationId } })).toEqual(op);
    expect(await db.agentTask.findUniqueOrThrow({ where: { id: s.taskId } })).toEqual(task);
    expect(await db.agentTeamEvent.count({ where: { taskId: s.taskId, type: CONTEXT_RESET_FAILED_EVENT } })).toBe(0);
  });

  it('an already-ended reset keeps its step outcome, even for an otherwise disallowed reason', async () => {
    const s = await atPhase('claimed');
    await f.step('reportContextResetRelaunchFailed', { resetId: s.resetId, epoch: 1, reason: 'STAGING_FAILED' });
    const before = await reset(s);
    const availability = await mark();
    expect(await report(s)).toMatchObject({ status: 'failed' });
    expect(await reset(s)).toEqual(before);
    expect(await mark()).toEqual(availability);
    expect(await db.agentTeamEvent.count({ where: { taskId: s.taskId, type: CONTEXT_RESET_FAILED_EVENT } })).toBe(1);
    expect(RELAUNCH_FAILED_REASONS).not.toContain('HOST_UNSUPPORTED');
  });

  it.each(HOST_REPORTED_REASONS)('keeps existing host report %s accepted', async (reason) => {
    const s = await atPhase('claimed');
    expect(await report(s, `${reason}: observed`)).toMatchObject({ status: 'failed' });
    expect((await reset(s)).reason).toBe(reason);
  });
});

describe('settled operation sweep uses the same phase boundary', () => {
  it.each(['requested', ...CLAIMED_PHASES])('sweeps HOST_UNSUPPORTED in %s', async (phase) => {
    const s = await atPhase(phase);
    // The sweep consumes a settled operation (e.g. a legacy/external writer), not a second report mutation.
    await db.hostOperation.update({ where: { id: s.operationId }, data: {
      status: 'failed', finishedAt: new Date(), failureReason: 'HOST_UNSUPPORTED: unsupported wrapper',
    } });
    expect(await sweepContextResets(db)).toBe(1);
    const expected = phase === 'requested' ? 'HOST_UNSUPPORTED'
      : phase === 'stop-granted' || phase === 'agent-stopped' ? 'RELAUNCH_UNVERIFIED' : 'REPORT_TIMEOUT';
    expect(await reset(s)).toMatchObject({ phase: 'failed', reason: expected });
    expect(await db.agentTeamEvent.count({ where: { taskId: s.taskId, type: CONTEXT_RESET_FAILED_EVENT } })).toBe(1);
  });
});

/** Hold a real protocol transaction open, and prove its competitor is blocked before committing it. */
async function race<T>(first: (tx: Prisma.TransactionClient) => Promise<void>, next: () => Promise<T>): Promise<T | unknown> {
  let release!: () => void;
  let ready!: () => void;
  let rejectReady!: (e: unknown) => void;
  const held = new Promise<void>((r) => { release = r; });
  const locked = new Promise<void>((r, reject) => { ready = r; rejectReady = reject; });
  const leading = db.$transaction(async (tx) => {
    try { await first(tx); ready(); await held; } catch (e) { rejectReady(e); throw e; }
  }, { timeout: 30_000 });
  try { await locked; } catch (e) { release(); await leading.catch(() => undefined); throw e; }
  let settled = false;
  const following = next().then((v) => v, (e: unknown) => e).finally(() => { settled = true; });
  try {
    await waitForLockWaitersOfType(db, 'advisory');
    expect(settled).toBe(false);
  } finally { release(); await leading; }
  return following;
}

describe('claim/report serialization under the host protocol lock', () => {
  it('a report waiting behind a claim cannot end the claimed reset as HOST_UNSUPPORTED', async () => {
    const s = await atPhase('requested');
    const result = await race(async (tx) => {
      expect((await claimContextReset(tx, host(), s.resetId, 0, PROC, new Date())).refused).toBeNull();
    }, () => report(s));
    expect(result).toMatchObject({ extensions: { code: 'BAD_CONTEXT_RESET_INPUT' } });
    expect(await reset(s)).toMatchObject({ phase: 'claimed', reason: null, endedAt: null });
    expect((await mark())!.contextResetId).toBe(s.resetId);
    expect(await db.agentTeamEvent.count({ where: { taskId: s.taskId, type: CONTEXT_RESET_FAILED_EVENT } })).toBe(0);
  });

  it('a claim waiting behind the report cannot acquire a fence on the ended reset', async () => {
    const s = await atPhase('requested');
    const result = await race(async (tx) => {
      await onContextResetReported(tx, { id: s.operationId, ...host() }, 'failed', 'HOST_UNSUPPORTED: cannot run', new Date());
    }, () => f.step('claimContextReset', { resetId: s.resetId, epoch: 0, process: PROC }));
    expect(result).toMatchObject({ refused: 'HOST_UNSUPPORTED', reset: { phase: 'failed' } });
    expect(await isWorkerResetting(db, f.kit.id, f.app.id, new Date())).toBe(false);
    expect(await db.agentTeamEvent.count({ where: { taskId: s.taskId, type: CONTEXT_RESET_FAILED_EVENT } })).toBe(1);
  });
});
