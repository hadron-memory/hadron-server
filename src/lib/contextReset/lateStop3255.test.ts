/** #3255 (cor:agt:050:27 part 10): a late stop is recorded once, never a new reset transition or alarm. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { code, ctx, M, NEW_PROC, PROC, setUpResetFixture, type ResetFixture } from '../../test/contextResetFixture.js';
import { resolvers } from '../../api/graphql/schema/resolvers.js';
import { typeDefs } from '../../api/graphql/schema/typeDefs.js';
import { reportContextResetAgentStopped } from './contextReset.js';

vi.mock('../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));

const EVENT = 'task.context-reset-late-stop';
let f: ResetFixture;
beforeEach(async () => { f = await setUpResetFixture(); });
const events = () => db.agentTeamEvent.findMany({ where: { appId: f.app.id, type: EVENT } });
const reset = (id: string) => db.contextReset.findUniqueOrThrow({ where: { id } });
const mark = () => db.workerAvailability.findUniqueOrThrow({ where: { workerId: f.kit.id } });
async function granted() {
  const s = await f.collectedReset();
  await f.step('claimContextReset', { resetId: s.resetId, epoch: 0, process: PROC });
  await f.step('registerContextResetRecovery', {
    resetId: s.resetId, epoch: 1, checkpointNode: (await f.checkpoint()).id, sessionId: f.session.id, taskId: s.taskId,
  });
  await f.step('authorizeContextResetStop', { resetId: s.resetId, epoch: 1, process: PROC });
  return s;
}
const stopped = (s: { resetId: string }, extra: Record<string, unknown> = {}) =>
  f.step('reportContextResetAgentStopped', { resetId: s.resetId, epoch: 1, ...extra });

describe('#3255 late-stop report', () => {
  it('keeps the existing GraphQL input and adds only an optional lateStopMs Int', () => {
    expect(typeDefs).toContain('reportContextResetAgentStopped(input: ContextResetStepInput!)');
    const input = typeDefs.match(/input ContextResetStepInput \{([^}]+)\}/)![1]!;
    expect(input).toMatch(/lateStopMs: Int\s/);
    expect(input).not.toContain('lateStopMs: Int!');
  });

  it('records lateness for the coordinator in the report transaction without changing the task or outcome', async () => {
    const s = await granted();
    const taskBefore = await db.agentTask.findUniqueOrThrow({ where: { id: s.taskId } });
    const result = await stopped(s, { lateStopMs: 30_000 });
    expect(result).toMatchObject({ refused: null, replayed: false, reset: { phase: 'agent-stopped', epoch: 1 } });
    const rows = await events();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ taskId: s.taskId, subjectWorkerId: f.kit.id, severity: null, payload: { resetId: s.resetId, lateStopMs: 30_000 } });
    expect(await db.agentTask.findUniqueOrThrow({ where: { id: s.taskId } })).toEqual(taskBefore);
    const Q = resolvers.Query as any;
    const visible = await f.asWorker<Array<{ id: string }>>(f.ada, () => Q.agentTeamEvents({}, { appRef: f.app.id, types: [EVENT] }, ctx(f.holder.id)));
    expect(visible.map((e: { id: string }) => e.id)).toEqual([rows[0]!.id]);
    expect(await db.agentTeamEvent.count({ where: { appId: f.app.id, severity: 'alarm' } })).toBe(0);
  });

  it('concurrent re-reports record exactly one late event and preserve the first stopped timestamp and mark', async () => {
    const s = await granted();
    await Promise.all([stopped(s, { lateStopMs: 12 }), stopped(s, { lateStopMs: 12 })]);
    const before = await reset(s.resetId);
    const markBefore = await mark();
    expect((await stopped(s, { lateStopMs: 13 })).replayed).toBe(true);
    expect(await events()).toHaveLength(1);
    expect((await reset(s.resetId)).agentStoppedAt).toEqual(before.agentStoppedAt);
    expect(await mark()).toEqual(markBefore);
  });

  it('can attach the first late annotation to a repeated stopped report without changing its state', async () => {
    const s = await granted();
    await stopped(s);
    const before = await reset(s.resetId);
    const markBefore = await mark();
    expect((await stopped(s, { lateStopMs: 15 })).replayed).toBe(true);
    expect(await events()).toHaveLength(1);
    expect(await reset(s.resetId)).toEqual(before);
    expect(await mark()).toEqual(markBefore);
  });

  it.each([undefined, null, 0])('an omitted, null or zero lateness records none (%s)', async value => {
    const s = await granted();
    await stopped(s, value === undefined ? {} : { lateStopMs: value });
    expect(await events()).toEqual([]);
    expect((await reset(s.resetId)).phase).toBe('agent-stopped');
  });

  it.each([-1, 86_400_001, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('rejects invalid lateness as BAD_USER_INPUT without a transition (%s)', async value => {
    const s = await granted();
    const before = await reset(s.resetId);
    const markBefore = await mark();
    expect(await code(stopped(s, { lateStopMs: value }))).toBe('BAD_USER_INPUT');
    expect(await reset(s.resetId)).toEqual(before);
    expect(await mark()).toEqual(markBefore);
    expect(await events()).toEqual([]);
  });

  it('accepts the inclusive upper bound', async () => {
    const s = await granted();
    await stopped(s, { lateStopMs: 86_400_000 });
    expect((await events())[0]?.payload).toMatchObject({ lateStopMs: 86_400_000 });
  });

  it('rolls the late event and the stopped transition back together on a transaction fault', async () => {
    const s = await granted();
    const before = await reset(s.resetId);
    const markBefore = await mark();
    await expect(db.$transaction(async tx => {
      await reportContextResetAgentStopped(tx, { appId: f.app.id, hostId: 'orca1' }, s.resetId, 1, new Date(), 17);
      expect(await tx.agentTeamEvent.count({ where: { appId: f.app.id, type: EVENT } })).toBe(1);
      throw new Error('forced transaction rollback');
    })).rejects.toThrow('forced transaction rollback');
    expect(await reset(s.resetId)).toEqual(before);
    expect(await mark()).toEqual(markBefore);
    expect(await events()).toEqual([]);
  });

  it('preserves the uncollected-host refusal and adds no late event', async () => {
    const task = await f.startedTask();
    await f.finish(task.id);
    const r = await db.contextReset.findUniqueOrThrow({ where: { taskId: task.id } });
    expect(await code(stopped({ resetId: r.id }, { lateStopMs: 3 }))).toBe('HOST_OPERATION_NOT_COLLECTED');
    expect(await events()).toEqual([]);
  });

  it('another host is refused byte-identically to an on-time report', async () => {
    const s = await granted();
    const other = await f.hostKey('orca2');
    await f.register(other);
    const error = async (extra: Record<string, unknown>) => {
      try { await f.step('reportContextResetAgentStopped', { resetId: s.resetId, epoch: 1, ...extra }, other); }
      catch (e) { const v = e as { message: string; extensions: unknown }; return { message: v.message, extensions: v.extensions }; }
      throw new Error('Expected refusal');
    };
    expect(await error({ lateStopMs: 3 })).toEqual(await error({}));
    expect(await events()).toEqual([]);
  });

  it('a wrong epoch does not record lateness', async () => {
    const s = await granted();
    expect(await code(stopped(s, { epoch: 99, lateStopMs: 3 }))).toBe('STALE_EPOCH');
    expect(await events()).toEqual([]);
  });

  it('a stop was never granted: no late event and no changed protocol refusal', async () => {
    const s = await f.collectedReset();
    await f.step('claimContextReset', { resetId: s.resetId, epoch: 0, process: PROC });
    expect(await code(stopped(s, { lateStopMs: 3 }))).toBe('CONTEXT_RESET_WRONG_PHASE');
    expect(await events()).toEqual([]);
  });

  it('S8: an old granted epoch reports once after termination and leaves a newer reset and its mark untouched', async () => {
    const old = await granted();
    await M.setWorkerAvailability({}, { input: { worker: f.kit.id, appRef: f.app.id, state: 'AVAILABLE' } }, ctx(f.manager.id));
    // The old stop window has passed and a later reset now owns the availability mark (#2255).
    await db.contextReset.update({ where: { id: old.resetId }, data: { stopGrantedAt: new Date(Date.now() - 60_000) } });
    await db.workerAvailability.update({ where: { workerId: f.kit.id }, data: { until: new Date(Date.now() - 1_000) } });
    const next = await f.collectedReset();
    await f.step('claimContextReset', { resetId: next.resetId, epoch: 0, process: PROC });
    const before = { old: await reset(old.resetId), next: await reset(next.resetId), mark: await mark(), tasks: await db.agentTask.findMany({ where: { appId: f.app.id }, orderBy: { id: 'asc' } }) };
    expect(before.old).toMatchObject({ phase: 'failed', epoch: 2 });
    expect(before.mark.contextResetId).toBe(next.resetId);
    await Promise.all([stopped(old, { lateStopMs: 30_000 }), stopped(old, { lateStopMs: 30_000 })]);
    expect(await events()).toHaveLength(1);
    expect((await events())[0]?.payload).toMatchObject({ resetId: old.resetId, lateStopMs: 30_000 });
    expect(await reset(old.resetId)).toEqual(before.old);
    expect(await reset(next.resetId)).toEqual(before.next);
    expect(await mark()).toEqual(before.mark);
    expect(await db.agentTask.findMany({ where: { appId: f.app.id }, orderBy: { id: 'asc' } })).toEqual(before.tasks);
  });

  it('an ended reset without a granted stop cannot record late telemetry', async () => {
    const s = await f.collectedReset();
    await f.step('claimContextReset', { resetId: s.resetId, epoch: 0, process: PROC });
    await M.setWorkerAvailability({}, { input: { worker: f.kit.id, appRef: f.app.id, state: 'AVAILABLE' } }, ctx(f.manager.id));
    expect(await code(stopped(s, { lateStopMs: 5 }))).toBeDefined();
    expect(await events()).toEqual([]);
  });

  it('an ended reset accepts only its granted epoch; other protocol steps and on-time old reports remain stale', async () => {
    const s = await granted();
    await M.setWorkerAvailability({}, { input: { worker: f.kit.id, appRef: f.app.id, state: 'AVAILABLE' } }, ctx(f.manager.id));
    for (const epoch of [0, 2, 99]) expect(await code(stopped(s, { epoch, lateStopMs: 5 }))).toBe('STALE_EPOCH');
    expect(await code(stopped(s))).toBe('STALE_EPOCH');
    expect(await code(f.step('authorizeContextResetStop', { resetId: s.resetId, epoch: 1, process: PROC }))).toBe('STALE_EPOCH');
    expect(await code(f.step('reportContextResetRelaunched', { resetId: s.resetId, epoch: 1, process: PROC }))).toBe('STALE_EPOCH');
    expect(await events()).toEqual([]);
    expect((await stopped(s, { lateStopMs: 5 })).reset.phase).toBe('failed');
    expect(await events()).toHaveLength(1);
  });

  it('another host cannot annotate an ended grant', async () => {
    const s = await granted();
    await M.setWorkerAvailability({}, { input: { worker: f.kit.id, appRef: f.app.id, state: 'AVAILABLE' } }, ctx(f.manager.id));
    const other = await f.hostKey('orca2');
    await f.register(other);
    expect(await code(f.step('reportContextResetAgentStopped', { resetId: s.resetId, epoch: 1, lateStopMs: 5 }, other))).toBe('CONTEXT_RESET_NOT_FOUND');
    expect(await events()).toEqual([]);
  });

  it('a successful end retains its grant epoch and can receive only late telemetry afterward', async () => {
    const s = await granted();
    await stopped(s);
    await f.step('reportContextResetRelaunched', { resetId: s.resetId, epoch: 1, process: NEW_PROC });
    await M.reportHostOperation({}, { input: { appRef: f.app.id, id: s.operationId, outcome: 'SUCCEEDED' } }, f.keyCtx());
    const before = await reset(s.resetId);
    const markBefore = await mark();
    const operationBefore = await db.hostOperation.findUniqueOrThrow({ where: { id: s.operationId } });
    expect(before).toMatchObject({ phase: 'done', epoch: 1 });
    await stopped(s, { lateStopMs: 7 });
    expect(await events()).toHaveLength(1);
    expect(await reset(s.resetId)).toEqual(before);
    expect(await mark()).toEqual(markBefore);
    expect(await db.hostOperation.findUniqueOrThrow({ where: { id: s.operationId } })).toEqual(operationBefore);
  });

  it('a refused end also retains the epoch of the earlier granted stop for telemetry', async () => {
    const s = await granted();
    await M.reportHostOperation({}, { input: { appRef: f.app.id, id: s.operationId, outcome: 'FAILED', failureReason: 'DIRTY_TREE: host refused' } }, f.keyCtx());
    const before = await reset(s.resetId);
    expect(before).toMatchObject({ phase: 'refused', epoch: 2 });
    await stopped(s, { lateStopMs: 8 });
    expect(await events()).toHaveLength(1);
    expect(await reset(s.resetId)).toEqual(before);
  });
});
