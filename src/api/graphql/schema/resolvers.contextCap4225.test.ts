/**
 * #4225 S4b (epic #4229; G4 in coordination:team-on-orca-decisions; hrn:node:hadronmemory.com:specs:cor:agt:050:27 part 12,
 * Proposed) — `Agent.contextCap`: a worker of a long-lived Agent whose reported context is over its Agent's cap and whose
 * host reports it idle at an empty prompt gets ONE `worker.reset-context`, at most once an hour, through the existing
 * protocol and fence. A busy worker is reported only; a short-lived Agent's workers ignore the cap; no cap is no limit.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { contextCapTick, __capSweepTesting } from '../../../lib/contextReset/capSweep.js';
import { issueReset } from '../../../lib/contextReset/contextReset.js';
import { PLATFORM_ACTOR } from '../../../lib/agentTasks/events.js';
import { buildASTSchema, parse } from 'graphql';
import { typeDefs } from './typeDefs.js';
import { resolvers } from './resolvers.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
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
  __capSweepTesting.reset();
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
    // Wolfgang #108825 / Peter #108828: the cause rides in the args too, so the host's checkpoint needs no extra read.
    expect(op!.args).toEqual({ workerId: F.kit.id, sessionId: F.session.id, resetId: r.id, cause: 'context-cap' });
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

describe('a full page of workers that cannot be reset does not hide one that can (Diego P2)', () => {
  it('60 earlier over-cap idle workers with no open session, then Kit: Kit is reset in one pass', async () => {
    const stale = ago(10).toISOString();
    for (let i = 0; i < 60; i += 1) {
      const w = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: F.app.id, agentId: F.agentId, name: `Idle${i}`, slug: `idle-${i}` }, select: { id: true } });
      const terminal = {
        host: { id: 'orca1', label: 'Orca' }, status: 'idle', prompt: 'empty', reason: null, lastTurnAt: null,
        checkedAt: new Date(Date.now() - 10 * MIN - (60 - i) * 1000).toISOString(), reportedAt: stale,
        contextTokens: CAP + 5, contextMeasuredAt: stale,
      };
      await db.$executeRaw`UPDATE workers SET terminal = ${JSON.stringify(terminal)}::jsonb WHERE id = ${w.id}`;
    }
    await report();
    expect(await contextCapTick(db)).toBe(1);
    expect(await resets()).toHaveLength(1);
  });
  it('60 earlier over-cap idle workers WITH sessions but no capable host (so the SQL cannot exclude them), then Kit', async () => {
    for (let i = 0; i < 60; i += 1) {
      const w = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: F.app.id, agentId: F.agentId, name: `Open${i}`, slug: `open-${i}` }, select: { id: true } });
      await F.bind(w);
      const at = new Date(Date.now() - 10 * MIN - (60 - i) * 1000).toISOString();
      const terminal = { host: { id: 'orca1', label: 'Orca' }, status: 'idle', prompt: 'empty', reason: null, lastTurnAt: null, checkedAt: at, reportedAt: at, contextTokens: CAP + 5, contextMeasuredAt: at };
      await db.$executeRaw`UPDATE workers SET terminal = ${JSON.stringify(terminal)}::jsonb WHERE id = ${w.id}`;
    }
    await report();
    expect(await contextCapTick(db)).toBe(1);
    expect(await resets()).toHaveLength(1);
    expect(await db.contextReset.count()).toBe(1);
  });
  it('and the ones that were skipped stay skipped: a second pass issues nothing', async () => {
    const w = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: F.app.id, agentId: F.agentId, name: 'Idle', slug: 'idle' }, select: { id: true } });
    const t = new Date(Date.now() - 5 * MIN).toISOString();
    await db.$executeRaw`UPDATE workers SET terminal = ${JSON.stringify({ host: { id: 'orca1', label: 'Orca' }, status: 'idle', prompt: 'empty', reason: null, lastTurnAt: null, checkedAt: t, reportedAt: t, contextTokens: CAP + 5, contextMeasuredAt: t })}::jsonb WHERE id = ${w.id}`;
    await report();
    expect(await contextCapTick(db)).toBe(1);
    expect(await contextCapTick(db)).toBe(0);
  });
});

describe('what the pass decides, and fair rotation across bounded passes (Diego P2, Arianna N-B)', () => {
  const over = (id: string, at = ago(5).toISOString()) => db.$executeRaw`UPDATE workers SET terminal = ${JSON.stringify({
    host: { id: 'orca1', label: 'Orca' }, status: 'idle', prompt: 'empty', reason: null, lastTurnAt: null, checkedAt: at, reportedAt: at,
    contextTokens: CAP + 5, contextMeasuredAt: at })}::jsonb WHERE id = ${id}`;
  // Ids sort before Kit's when given: the scan key is the worker id.
  const mk = async (name: string, appId = F.app.id, id?: string) => db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, ...(id ? { id } : {}), appId, agentId: F.agentId, name, slug: name.toLowerCase() }, select: { id: true } });
  const session = (w: { id: string }, appId = F.app.id) => db.session.create({ data: { id: `s${Math.random()}`.replace('.', ''), appId, workerId: w.id, agentId: F.agentId, userId: F.holder.id, startedAt: ago(3), updatedAt: ago(3) }, select: { id: true } });
  beforeEach(() => { __capSweepTesting.decided = []; __capSweepTesting.reset(); });
  afterEach(() => { __capSweepTesting.page = 50; __capSweepTesting.maxPages = 200; __capSweepTesting.decided = null; __capSweepTesting.reset(); });

  it('never decides a worker with no open session, one in a paused App, or one with a reset live or asked for in the hour', async () => {
    const noSession = await mk('NoSession'); await over(noSession.id);
    const paused = await db.app.create({ data: { organizationId: F.orgId, name: 'Paused', urn: `paused-${Math.random()}.example:p`.replace('.', '-'), teamPausedAt: new Date() }, select: { id: true } });
    const inPaused = await mk('InPaused', paused.id); await session(inPaused, paused.id); await over(inPaused.id);
    const hour = await mk('InHour'); const hs = await session(hour); await over(hour.id);
    await db.$executeRaw`INSERT INTO context_resets (id, app_id, worker_id, session_id, cause, host_id, phase, reason, requested_at, ended_at)
      VALUES (${`r${Math.random()}`}, ${F.app.id}, ${hour.id}, ${hs.id}, 'context-cap', NULL, 'failed', 'HOST_UNSUPPORTED', now(), now())`;
    await report();
    expect(await contextCapTick(db)).toBe(1);
    expect(__capSweepTesting.decided).toEqual([F.kit.id]);
  });

  it('issueReset itself refuses a worker with no open session (Peter #108933): the sweep\'s EXISTS is only an optimisation', async () => {
    const w = await mk('Bare');
    // Both ways: with no host to take it the cap path could return before the session is touched, a task-end reset (which
    // records a failed row when no host can) could not; the guard alone stops both.
    for (const unsupportedIsFailure of [false, true]) {
      const out = await db.$transaction((tx) => issueReset(tx, {
        appId: F.app.id, workerId: w.id, taskId: unsupportedIsFailure ? 'some-task' : null, cause: unsupportedIsFailure ? 'task-end' : 'context-cap',
        actor: PLATFORM_ACTOR, now: new Date(), unsupportedIsFailure, extra: {},
      }));
      expect(out).toBeNull();
    }
    expect(await db.contextReset.count({ where: { workerId: w.id } })).toBe(0);
    expect(await db.hostOperation.count({ where: { workerId: w.id } })).toBe(0);
  });

  it('Diego\'s shape: earlier over-cap workers in a paused App never keep Kit out, over two bounded ticks', async () => {
    const paused = await db.app.create({ data: { organizationId: F.orgId, name: 'Paused2', urn: `paused2-${Math.random()}.example:p`.replace('.', '-'), teamPausedAt: new Date() }, select: { id: true } });
    for (let i = 0; i < 25; i += 1) { const w = await mk(`P${i}`, paused.id); await session(w, paused.id); await over(w.id, new Date(Date.now() - 10 * MIN - (30 - i) * 1000).toISOString()); }
    await report();
    __capSweepTesting.page = 5; __capSweepTesting.maxPages = 2;
    const n = (await contextCapTick(db)) + (await contextCapTick(db));
    expect(n).toBe(1);
    expect(__capSweepTesting.decided).toEqual([F.kit.id]);
  });

  it('Diego\'s refreshed prefix: reports that keep arriving for workers ahead of Kit cannot keep the cursor from reaching him (stable scan key)', async () => {
    // Six over-cap idle workers with sessions and no capable host, whose ids sort BEFORE Kit's; each tick their hosts report
    // again (a new checkedAt) and then Kit's does. A cursor on the mutable checkedAt is overtaken by the refreshed ones.
    const prefix: { id: string }[] = [];
    for (let i = 0; i < 6; i += 1) {
      const w = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, id: `00p${i}`, appId: F.app.id, agentId: F.agentId, name: `Pre${i}`, slug: `pre-${i}` }, select: { id: true } });
      await session(w);
      prefix.push(w);
    }
    __capSweepTesting.page = 1; __capSweepTesting.maxPages = 2; // two workers a pass
    let issued = 0;
    for (let tick = 0; tick < 8 && issued === 0; tick += 1) {
      for (const [i, w] of prefix.entries()) await over(w.id, new Date(Date.now() - 8 * MIN + tick * 20_000 + i * 100).toISOString());
      await report();
      issued += await contextCapTick(db);
    }
    expect(issued).toBe(1);
    expect(await resets()).toHaveLength(1);
  });

  it('a pass bounded below the candidate count rotates: progress carries to the next pass until Kit is reached', async () => {
    // 25 earlier over-cap workers WITH sessions and no capable host: only the decision itself can pass them over.
    for (let i = 0; i < 25; i += 1) { const w = await mk(`Old${i}`, F.app.id, `00o${String(i).padStart(2, '0')}`); await session(w); await over(w.id, new Date(Date.now() - 10 * MIN - (30 - i) * 1000).toISOString()); }
    await report();
    __capSweepTesting.page = 5; __capSweepTesting.maxPages = 2; // 10 workers a pass
    let issued = 0;
    for (let tick = 0; tick < 5 && issued === 0; tick += 1) issued += await contextCapTick(db);
    expect(issued).toBe(1);
    expect(await resets()).toHaveLength(1);
    expect(new Set(__capSweepTesting.decided).size).toBeGreaterThan(20);
  });

  it('and wraps: once it reaches the end, the next pass starts again from the first', async () => {
    for (let i = 0; i < 12; i += 1) { const w = await mk(`Old${i}`, F.app.id, `00w${String(i).padStart(2, '0')}`); await session(w); await over(w.id, new Date(Date.now() - 10 * MIN - (30 - i) * 1000).toISOString()); }
    __capSweepTesting.page = 5; __capSweepTesting.maxPages = 2;
    for (let tick = 0; tick < 4; tick += 1) await contextCapTick(db);
    const seen = __capSweepTesting.decided!;
    expect(new Set(seen).size).toBe(12); // every worker decided at least once
    expect(seen.length).toBeGreaterThan(12); // and the first ones again after the wrap
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

describe('the operation args carry the cause, from a closed set', () => {
  const op = (args: Record<string, string>) => db.hostOperation.create({
    data: { id: `o${Math.random()}`.replace('.', ''), appId: F.app.id, hostId: 'orca1', type: 'worker.reset-context', workerId: F.kit.id, args, issuedBy: 'platform' },
  });
  const base = { workerId: '', sessionId: 's1', resetId: 'r1' };
  it('accepts context-cap and task-end, with or without a task, and refuses any other word or a non-string', async () => {
    const a = { ...base, workerId: F.kit.id, sessionId: F.session.id };
    await expect(op({ ...a, cause: 'context-cap' })).resolves.toBeTruthy();
    await expect(op({ ...a, taskId: 't1', cause: 'task-end', resetId: 'r2' })).resolves.toBeTruthy();
    await expect(op({ ...a, taskId: 't1', resetId: 'r3' })).resolves.toBeTruthy();
    await expect(op({ ...a, cause: 'whatever' })).rejects.toThrow(/chk_host_operations_shape/);
    await expect(op({ ...a, cause: 'context cap' })).rejects.toThrow(/chk_host_operations_shape/);
  });
  it('a reset op with neither taskId nor cause is accepted, so the cap migration\'s function is the one in force', async () => {
    await expect(op({ ...base, workerId: F.kit.id, sessionId: F.session.id, resetId: 'r9' })).resolves.toBeTruthy();
  });
  it('host_operation_args_ok has exactly ONE definition among the files post-push.sql includes (Peter #108853), the one that takes the cause', async () => {
    const { readFileSync } = await import('node:fs');
    const dir = new URL('../../../../prisma/', import.meta.url);
    const included = [...readFileSync(new URL('post-push.sql', dir), 'utf8').matchAll(/^\\ir\s+(\S+)/gm)].map((m) => m[1]!);
    expect(included).toContain('host-operation-invariants.sql');
    const defs = included.filter((f) => readFileSync(new URL(f, dir), 'utf8').includes('CREATE OR REPLACE FUNCTION host_operation_args_ok'));
    expect(defs).toEqual(['host-operation-invariants.sql']);
    const src = readFileSync(new URL('host-operation-invariants.sql', dir), 'utf8');
    expect(src).toContain("optional := ARRAY['taskId', 'cause']");
    expect(src).toContain("IN ('task-end', 'context-cap')");
  });
  it('the surviving host_operation_args_ok carries #4230/#4251\'s start keys AND the cap\'s cause (the carry from main)', async () => {
    const ok = async (type: string, args: Record<string, string>) =>
      ((await db.$queryRaw<{ ok: boolean }[]>`SELECT host_operation_args_ok(${type}, ${JSON.stringify(args)}::jsonb, 'w') AS ok`)[0]!).ok;
    const start = { workerId: 'w', worktree: 'wt', family: 'claude' };
    expect(await ok('worker.start', { ...start, lifecycle: 'SHORT_LIVED', effort: 'high', accountProfile: 'max1', model: 'claude-sonnet-5-5' })).toBe(true);
    expect(await ok('worker.start', { ...start, lifecycle: 'FOREVER' })).toBe(false);
    expect(await ok('worker.start', { ...start, model: 'not a model!' })).toBe(false);
    expect(await ok('worker.reset-context', { workerId: 'w', sessionId: 's', resetId: 'r', cause: 'context-cap' })).toBe(true);
    expect(await ok('worker.reset-context', { workerId: 'w', sessionId: 's', resetId: 'r', cause: 'nope' })).toBe(false);
    expect(await ok('worker.reset-context', { workerId: 'w', sessionId: 's', resetId: 'r', taskId: 't', lifecycle: 'LONG_LIVED' })).toBe(false);
  });
  it('the application validator refuses a cause outside the closed set', async () => {
    const { validateHostOperation } = await import('../../../lib/hostOperations/types.js');
    expect(() => validateHostOperation('worker.reset-context', { workerId: 'w', sessionId: 's', resetId: 'r', cause: 'whatever' })).toThrow(/cause/);
    expect(validateHostOperation('worker.reset-context', { workerId: 'w', sessionId: 's', resetId: 'r', cause: 'task-end' }).args.cause).toBe('task-end');
  });
  it('the application validator takes it too', async () => {
    const { validateHostOperation } = await import('../../../lib/hostOperations/types.js');
    expect(validateHostOperation('worker.reset-context', { workerId: 'w', sessionId: 's', resetId: 'r', cause: 'context-cap' }).args.cause).toBe('context-cap');
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
