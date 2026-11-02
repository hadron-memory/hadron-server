/** #3255 (cor:agt:050:27 part 10): a late stop is recorded once, never a new reset transition or alarm. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { code, ctx, M, PROC, setUpResetFixture, type ResetFixture } from '../../test/contextResetFixture.js';
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
    expect(rows[0]).toMatchObject({ taskId: s.taskId, subjectWorkerId: f.kit.id, severity: 'info', payload: { resetId: s.resetId, lateStopMs: 30_000 } });
    expect(await db.agentTask.findUniqueOrThrow({ where: { id: s.taskId } })).toEqual(taskBefore);
    const Q = resolvers.Query as any;
    const visible = await f.asWorker(f.ada, () => Q.agentTeamEvents({}, { appRef: f.app.id, types: [EVENT] }, ctx(f.holder.id)));
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
});
