/**
 * #4225 S4b (epic #4229; G4 in coordination:team-on-orca-decisions; hrn:node:hadronmemory.com:specs:cor:agt:050:27 part 12,
 * Proposed) — `Agent.contextCap`: a worker of a long-lived Agent whose reported context is over its Agent's cap and whose
 * host reports it idle at an empty prompt gets ONE `worker.reset-context`, at most once an hour, through the existing
 * protocol and fence. A busy worker is reported only; a short-lived Agent's workers ignore the cap; no cap is no limit.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { contextCapTick } from '../../../lib/contextReset/capSweep.js';
import { buildASTSchema, parse } from 'graphql';
import { typeDefs } from './typeDefs.js';
import { resolvers } from './resolvers.js';
import { M, MIN, PROC, NEW_PROC, ctx, code, setUpResetFixture, type ResetFixture } from '../../../test/contextResetFixture.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../lib/bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));

let F: ResetFixture;
const CAP = 100_000;
const ago = (min: number) => new Date(Date.now() - min * MIN);

const setCap = (cap: number | null) => M.updateAgent({}, { ref: F.agentId, contextCap: cap }, ctx(F.manager.id));
/** A terminal report for Kit, as the host sends it. */
const report = (extra: Record<string, unknown> = {}) =>
  M.setHostWorkerTerminals({}, {
    input: {
      appRef: F.app.id,
      reports: [{
        worker: F.kit.id, status: 'idle', prompt: 'empty', checkedAt: new Date(), lastTurnAt: ago(1),
        contextTokens: CAP + 1, contextMeasuredAt: ago(1), ...extra,
      }],
    },
  }, F.keyCtx());
const resets = () => db.contextReset.findMany({ where: { workerId: F.kit.id }, orderBy: { requestedAt: 'asc' } }) as Promise<any[]>;
const ops = () => db.hostOperation.findMany({ where: { workerId: F.kit.id, type: 'worker.reset-context' } });

beforeEach(async () => {
  F = await setUpResetFixture();
  // The cap must not lean on the task-end setting: switch that off.
  await M.updateAgent({}, { ref: F.agentId, resetContextAfterTask: false }, ctx(F.manager.id));
  await setCap(CAP);
});

describe('Agent.contextCap', () => {
  it('is set and cleared by whoever manages the Agent, and read on the Agent', async () => {
    const read = async () => (await db.agent.findUniqueOrThrow({ where: { id: F.agentId } })) as any;
    expect((await read()).contextCap).toBe(CAP);
    await setCap(250_000);
    expect((await read()).contextCap).toBe(250_000);
    await setCap(null);
    expect((await read()).contextCap).toBeNull();
    expect(await (resolvers as any).Agent.contextCap?.(await read())).toBeUndefined(); // a plain column: no custom resolver needed
  });
  it('is unset by default, and createAgent accepts one', async () => {
    const a = await M.createAgent({}, { orgId: F.orgId, name: 'Other' }, ctx(F.manager.id));
    expect((await db.agent.findUniqueOrThrow({ where: { id: a.id } }) as any).contextCap).toBeNull();
    const b = await M.createAgent({}, { orgId: F.orgId, name: 'Capped', contextCap: 50_000 }, ctx(F.manager.id));
    expect((await db.agent.findUniqueOrThrow({ where: { id: b.id } }) as any).contextCap).toBe(50_000);
  });
  for (const bad of [0, -1, 1.5, 2_147_483_648]) {
    it(`refuses ${bad}`, async () => {
      expect(await code(setCap(bad))).toBe('BAD_USER_INPUT');
      expect((await db.agent.findUniqueOrThrow({ where: { id: F.agentId } }) as any).contextCap).toBe(CAP);
    });
  }
  it('a person who does not manage the Agent cannot set it', async () => {
    await expect(M.updateAgent({}, { ref: F.agentId, contextCap: 5 }, ctx(F.holder.id))).rejects.toThrow();
    expect((await db.agent.findUniqueOrThrow({ where: { id: F.agentId } }) as any).contextCap).toBe(CAP);
  });
  it('the database refuses 0 and a negative cap on a raw write', async () => {
    await expect(db.$executeRaw`UPDATE agents SET context_cap = 0 WHERE id = ${F.agentId}`).rejects.toThrow(/context_cap/);
    await expect(db.$executeRaw`UPDATE agents SET context_cap = -5 WHERE id = ${F.agentId}`).rejects.toThrow(/context_cap/);
    await expect(db.$executeRaw`UPDATE agents SET context_cap = 7 WHERE id = ${F.agentId}`).resolves.toBe(1);
  });
});

describe('over the cap and proven idle: one reset', () => {
  it('issues one worker.reset-context through the existing protocol, with a cause and no task', async () => {
    await report();
    expect(await contextCapTick(db)).toBe(1);
    const [r, ...rest] = await resets();
    expect(rest).toEqual([]);
    expect(r).toMatchObject({ cause: 'context-cap', taskId: null, phase: 'requested', hostId: 'orca1', sessionId: F.session.id });
    const [op, ...more] = await ops();
    expect(more).toEqual([]);
    expect(op!.id).toBe(r.hostOperationId);
    expect(op!.args).toEqual({ workerId: F.kit.id, sessionId: F.session.id, resetId: r.id });
    expect((op!.args as any).taskId).toBeUndefined();
    const ev = await db.agentTeamEvent.findMany({ where: { type: 'task.context-reset-requested', subjectWorkerId: F.kit.id } });
    expect(ev).toHaveLength(1);
    expect(ev[0]!.taskId).toBeNull();
    expect(ev[0]!.payload).toMatchObject({ resetId: r.id, cause: 'context-cap', contextTokens: CAP + 1, contextCap: CAP });
  });

  it('a second tick within the hour issues none, and neither does one after the first reset ended', async () => {
    await report();
    expect(await contextCapTick(db)).toBe(1);
    expect(await contextCapTick(db)).toBe(0);
    await db.contextReset.updateMany({ where: { workerId: F.kit.id }, data: { phase: 'failed', reason: 'HOST_LOST', endedAt: new Date() } });
    // A NEW measurement after the request, so only the hour (not the stale measurement) holds the second one back.
    await F.register(F.orca1, { pollIntervalSeconds: 7200 });
    await report({ contextMeasuredAt: new Date(Date.now() + 60_000) });
    expect(await contextCapTick(db, new Date(Date.now() + 10 * MIN))).toBe(0);
    expect(await resets()).toHaveLength(1);
  });

  it('after the hour, a NEW measurement over the cap issues another; the old one does not', async () => {
    await report();
    await contextCapTick(db);
    await db.contextReset.updateMany({ where: { workerId: F.kit.id }, data: { phase: 'failed', reason: 'HOST_LOST', endedAt: new Date() } });
    const later = new Date(Date.now() + 61 * MIN);
    await F.register(F.orca1, { pollIntervalSeconds: 7200 }); // the host stays live at `later`
    // The same report, only aged: its measurement predates the last request, so it proves nothing new.
    await db.$executeRaw`UPDATE workers SET terminal = jsonb_set(terminal, '{checkedAt}', to_jsonb(${new Date(later.getTime() - MIN).toISOString()}::text)) WHERE id = ${F.kit.id}`;
    expect(await contextCapTick(db, later)).toBe(0);
    await db.$executeRaw`UPDATE workers SET terminal = jsonb_set(jsonb_set(terminal, '{checkedAt}', to_jsonb(${new Date(later.getTime() - MIN).toISOString()}::text)), '{contextMeasuredAt}', to_jsonb(${new Date(later.getTime() - 2 * MIN).toISOString()}::text)) WHERE id = ${F.kit.id}`;
    expect(await contextCapTick(db, later)).toBe(1);
    expect(await resets()).toHaveLength(2);
  });

  it('two ticks racing issue one', async () => {
    await report();
    const n = await Promise.all([contextCapTick(db), contextCapTick(db)]);
    expect(n.reduce((a, b) => a + b, 0)).toBe(1);
    expect(await resets()).toHaveLength(1);
  });

  it('a worker holding started tasks (a coordinator) is still reset, and the host claim does not refuse OTHER_WORK or SETTING_OFF', async () => {
    await F.startedTask();
    await report();
    expect(await contextCapTick(db)).toBe(1);
    const r = (await resets())[0];
    await M.collectHostOperations({}, { appRef: F.app.id }, F.keyCtx());
    const claimed = await F.step('claimContextReset', { resetId: r.id, epoch: 0, process: PROC });
    expect(claimed.refused).toBeNull();
    expect(claimed.reset.phase).toBe('claimed');
    expect(claimed.reset.cause).toBe('context-cap');
    expect(claimed.reset.taskId).toBeNull();
  });
});

describe('the existing protocol carries it to done', () => {
  it('claim, recovery registration with no task, stop, stopped, relaunched, done', async () => {
    await report();
    await contextCapTick(db);
    const r = (await resets())[0];
    await M.collectHostOperations({}, { appRef: F.app.id }, F.keyCtx());
    const cp = await F.checkpoint();
    await F.step('claimContextReset', { resetId: r.id, epoch: 0, process: PROC });
    const reg = await F.step('registerContextResetRecovery', { resetId: r.id, epoch: 1, sessionId: F.session.id, checkpointNode: cp.id });
    expect(reg.refused).toBeNull();
    const stop = await F.step('authorizeContextResetStop', { resetId: r.id, epoch: 1, process: PROC });
    expect(stop.refused).toBeNull();
    const stopped = await F.step('reportContextResetAgentStopped', { resetId: r.id, epoch: 1 });
    expect(stopped.reset.phase).toBe('agent-stopped');
    const re = await F.step('reportContextResetRelaunched', { resetId: r.id, epoch: 1, process: NEW_PROC });
    expect(re.reset.phase).toBe('relaunched');
    // The worker carries the `resetting` mark meanwhile, on every assignment path.
    const mark = await db.workerAvailability.findUniqueOrThrow({ where: { workerId: F.kit.id } });
    expect(mark).toMatchObject({ state: 'unavailable', reason: 'resetting' });
  });
  it('a recovery reference naming a task is refused for a reset that has none', async () => {
    await report();
    await contextCapTick(db);
    const r = (await resets())[0];
    await M.collectHostOperations({}, { appRef: F.app.id }, F.keyCtx());
    const cp = await F.checkpoint();
    await F.step('claimContextReset', { resetId: r.id, epoch: 0, process: PROC });
    expect(await code(F.step('registerContextResetRecovery', { resetId: r.id, epoch: 1, sessionId: F.session.id, taskId: 'some-task', checkpointNode: cp.id }))).toBe('RECOVERY_REF_INVALID');
  });
  it('the claim refuses SETTING_OFF when the cap was cleared meanwhile, and PAUSED under a team pause', async () => {
    await report();
    await contextCapTick(db);
    const r = (await resets())[0];
    await M.collectHostOperations({}, { appRef: F.app.id }, F.keyCtx());
    await setCap(null);
    const claimed = await F.step('claimContextReset', { resetId: r.id, epoch: 0, process: PROC });
    expect(claimed.refused).toBe('SETTING_OFF');
  });
  it('the claim refuses SETTING_OFF when the Agent became short-lived meanwhile', async () => {
    await report();
    await contextCapTick(db);
    const r = (await resets())[0];
    await M.collectHostOperations({}, { appRef: F.app.id }, F.keyCtx());
    await M.updateAgent({}, { ref: F.agentId, lifecycle: 'SHORT_LIVED' }, ctx(F.manager.id));
    expect((await F.step('claimContextReset', { resetId: r.id, epoch: 0, process: PROC })).refused).toBe('SETTING_OFF');
  });
  it('the host reads the reset with its cause and a null task', async () => {
    await report();
    await contextCapTick(db);
    const r = (await resets())[0];
    await M.collectHostOperations({}, { appRef: F.app.id }, F.keyCtx());
    const read = await (resolvers.Query as any).contextReset({}, { appRef: F.app.id, resetId: r.id }, F.keyCtx());
    expect(read).toMatchObject({ id: r.id, cause: 'context-cap', taskId: null, phase: 'requested' });
  });
});

describe('not over the cap, not proven idle, or not capped: nothing', () => {
  const none = async () => {
    expect(await contextCapTick(db)).toBe(0);
    expect(await resets()).toHaveLength(0);
    expect(await ops()).toHaveLength(0);
  };
  it('busy and over the cap is reported only: the reading stays on the roster, nothing is touched', async () => {
    await report({ status: 'busy', prompt: 'not_empty' });
    await none();
    const t = (await db.worker.findUniqueOrThrow({ where: { id: F.kit.id } })).terminal as any;
    expect(t.contextTokens).toBe(CAP + 1);
  });
  for (const [name, extra] of [
    ['idle with a draft in the composer', { prompt: 'not_empty' }],
    ['idle at a menu', { prompt: 'menu' }],
    ['idle with an unknown prompt', { prompt: 'unknown' }],
    ['locked', { status: 'locked', reason: 'rate_limited' }],
    ['dark', { status: 'dark', reason: 'bare_shell' }],
    ['exactly at the cap', { contextTokens: CAP }],
    ['under the cap', { contextTokens: 10 }],
    ['unmeasured', { contextTokens: null, contextMeasuredAt: null }],
  ] as [string, Record<string, unknown>][]) {
    it(name, async () => { await report(extra); await none(); });
  }
  it('no cap set', async () => { await setCap(null); await report(); await none(); });
  it('a short-lived Agent ignores the cap', async () => {
    await M.updateAgent({}, { ref: F.agentId, lifecycle: 'SHORT_LIVED' }, ctx(F.manager.id));
    await report();
    await none();
  });
  it('a stale report is not proof', async () => {
    await report({ checkedAt: ago(45), lastTurnAt: ago(46), contextMeasuredAt: ago(46) });
    await none();
  });
  it('a team pause', async () => {
    await report();
    await db.app.update({ where: { id: F.app.id }, data: { teamPausedAt: new Date() } });
    await none();
  });
  it('no open session', async () => {
    await report();
    await db.session.update({ where: { id: F.session.id }, data: { endedAt: new Date() } });
    await none();
  });
  it('no live host that registers the worker with the capability: no reset, and no failed row either', async () => {
    await F.register(F.orca1, { capabilities: [] });
    await report();
    await none();
  });
  it('a retired worker', async () => {
    await report();
    await db.worker.update({ where: { id: F.kit.id }, data: { retiredAt: new Date() } });
    await none();
  });
  it('a reset already live for the worker', async () => {
    const t = await F.startedTask();
    await M.updateAgent({}, { ref: F.agentId, resetContextAfterTask: true }, ctx(F.manager.id));
    await F.finish(t.id);
    expect(await resets()).toHaveLength(1);
    // Measured after that request, so only the live reset holds this one back.
    await report({ contextMeasuredAt: new Date(Date.now() + 60_000) });
    expect(await contextCapTick(db)).toBe(0);
    expect(await resets()).toHaveLength(1);
  });
});

describe('the task-end reset is unchanged', () => {
  it('still records cause task-end with its task, once per finish', async () => {
    await M.updateAgent({}, { ref: F.agentId, resetContextAfterTask: true }, ctx(F.manager.id));
    const t = await F.startedTask();
    await F.finish(t.id);
    const [r] = await resets();
    expect(r).toMatchObject({ cause: 'task-end', taskId: t.id });
  });
});

describe('the database shape', () => {
  const insert = (cause: string, taskId: string | null) => db.$executeRaw`
    INSERT INTO context_resets (id, app_id, worker_id, session_id, task_id, cause, host_id, phase, reason, requested_at, ended_at)
    VALUES (${`r${Math.random()}`}, ${F.app.id}, ${F.kit.id}, ${F.session.id}, ${taskId}, ${cause}, NULL, 'failed', 'HOST_UNSUPPORTED', now(), now())`;
  it('a context-cap reset has no task and a task-end reset has one', async () => {
    await expect(insert('context-cap', null)).resolves.toBe(1);
    await expect(insert('context-cap', 'a-task')).rejects.toThrow(/context_resets/);
    await expect(insert('task-end', null)).rejects.toThrow(/context_resets/);
    await expect(insert('whatever', null)).rejects.toThrow(/context_resets/);
  });
});

describe('the SDL', () => {
  const schema = buildASTSchema(parse(typeDefs));
  it('Agent carries contextCap: Int, ContextReset carries cause and a nullable taskId, and the inputs take a cap', () => {
    expect(String((schema.getType('Agent') as any).getFields().contextCap?.type)).toBe('Int');
    const reset = (schema.getType('ContextReset') as any).getFields();
    expect(String(reset.cause?.type)).toBe('String!');
    expect(String(reset.taskId?.type)).toBe('ID');
    const mut = (schema.getMutationType() as any).getFields();
    expect(String(mut.createAgent.args.find((a: any) => a.name === 'contextCap')?.type)).toBe('Int');
    expect(String(mut.updateAgent.args.find((a: any) => a.name === 'contextCap')?.type)).toBe('Int');
  });
  it('the recovery registration input no longer requires a task', () => {
    const input = (schema.getType('RegisterContextResetRecoveryInput') as any)?.getFields();
    expect(String(input?.taskId?.type)).toBe('ID');
  });
});
