/**
 * #2763 — the coordinator-cadence alarm (cor:agt:050:31, Proposed): one task-less alarm per coordinator per episode when it
 * made no counted assignment for 60 minutes while a worker in its lane was free. Every timestamp is relative to a fixed `now`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../id.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../workerSignature.js';
import { ensureChannelWithRoot } from '../channels.js';
import { evaluateCoordinatorCadence } from './coordinatorCadence.js';
import { matchingTeamPool } from './matcher.js';
import * as stopState from '../stopSignals/state.js';
import { Prisma } from '../../generated/prisma/index.js';
import { eventPayloadFor } from './darkWorker.js';
import { taskStallTick } from '../../jobs/taskStallEvaluator.js';

vi.mock('../../lib/bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));

const MIN = 60_000;
const NOW = new Date('2026-11-03T12:00:00.000Z');
const at = (minutesAgo: number) => new Date(NOW.getTime() - minutesAgo * MIN);
const TYPE = 'alarm.coordinator-cadence';

let org: { id: string; urn: string };
let app: { id: string };
let user: { id: string };
let agent: { id: string };
const w: Record<string, { id: string }> = {};

beforeEach(async () => {
  await cleanDb(db);
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
  org = await db.organization.create({ data: { id: generateId(), name: 'cad-org', urn: `cad-${suffix}.com` } });
  user = await db.user.create({ data: { id: generateId(), githubId: 98_200 + Math.floor(Math.random() * 1000), githubUsername: `cad-${suffix}`, roles: ['READER'] } });
  agent = await db.agent.create({ data: { id: generateId(), organizationId: org.id, name: 'Engineer', urn: `${org.urn}:engineer`, visibility: 'ORGANIZATION' } });
  app = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Team', urn: `${org.urn}:team` } });
  await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: user.id, role: 'ADMIN' } });
  const memory = await db.memory.create({
    data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:team-shared`, name: 'shared', class: 'app', appId: app.id, sharedMemoryOfAgentId: agent.id },
  });
  await ensureChannelWithRoot(db, { memoryId: memory.id, loc: 'chats:team', name: 'team', createdBy: user.id, asDefaultOfAppId: app.id });
  // Ada coordinates; Liam reports to Ada; Tove reports to nobody.
  w.Ada = await mk('Ada', null, 'coordinator');
  w.Liam = await mk('Liam', w.Ada.id);
  w.Tove = await mk('Tove', null);
});

const mk = (name: string, reportsTo: string | null, role = 'engineer') =>
  db.worker.create({
    data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId: app.id, agentId: agent.id, name, slug: name.toLowerCase(), role, heldByUserId: user.id, reportsToWorkerId: reportsTo },
    select: { id: true },
  });
/** A live, bound session started `minutesAgo` minutes before NOW (family claude, so the worker is free for work when idle). */
const bind = (name: string, minutesAgo = 300) =>
  db.session.create({
    data: { id: generateId(), appId: app.id, userId: user.id, workerId: w[name].id, agentId: agent.id, type: 'DEVELOPER', startedAt: at(minutesAgo), updatedAt: NOW, family: 'claude' },
  });
const event = async (type: string, actor: string, minutesAgo: number, subject = 'Liam') => {
  // A task event names its task (`chk_agent_team_events_shape`); the task is unassigned so it never makes anyone busy.
  const task = await db.agentTask.create({ data: { appId: app.id, title: 'T', ownerUserId: user.id } });
  return db.agentTeamEvent.create({ data: { appId: app.id, type, taskId: task.id, actorWorkerId: w[actor].id, subjectWorkerId: w[subject].id, payload: {}, createdAt: at(minutesAgo) } });
};
const alarms = (name = 'Ada') => db.agentTeamEvent.findMany({ where: { subjectWorkerId: w[name].id, type: TYPE }, orderBy: { createdAt: 'asc' } });
const later = (m: number) => new Date(NOW.getTime() + m * MIN);

/** Ada bound 300 min ago, last assigned 90 min ago; Liam bound and idle. Observed first at NOW-70 so the clock has run out. */
async function lateAda() {
  await bind('Ada');
  await bind('Liam');
  await event('task.assigned', 'Ada', 90);
  await evaluateCoordinatorCadence(db, at(70)); // first observation (no alarm: clock = max(assign 90, session 300, observed 70) = 70 min ago... see below)
}

describe('#2763 the rule', () => {
  it('raises exactly one alarm, with the payload and chain, once the clock passes 60 minutes with a free lane worker', async () => {
    await lateAda();
    expect(await alarms()).toHaveLength(0); // observed at NOW-70, so 70 minutes later is NOW
    const raised = await evaluateCoordinatorCadence(db, NOW);
    expect(raised).toHaveLength(1);
    const [a] = await alarms();
    expect(a).toMatchObject({ taskId: null, severity: 'alarm', appId: app.id, subjectWorkerId: w.Ada.id });
    expect(a.payload).toEqual({ reason: 'coordinator-cadence', windowMinutes: 60, lastAssignedAt: at(90).toISOString(), freeWorkerCount: 1 });
    expect(JSON.stringify(a.payload)).not.toMatch(/title|text/i);
    expect(await db.coordinatorCadenceEpisode.count({ where: { workerId: w.Ada.id, endedAt: null } })).toBe(1);
  });

  it('a second pass and two raced passes add nothing', async () => {
    await lateAda();
    const results = await Promise.all([evaluateCoordinatorCadence(db, NOW), evaluateCoordinatorCadence(db, NOW)]);
    expect(results.flat()).toHaveLength(1);
    expect(await evaluateCoordinatorCadence(db, later(5))).toEqual([]);
    expect(await alarms()).toHaveLength(1);
  });

  it('its next task.assigned closes the episode and a later lateness raises a new one', async () => {
    await lateAda();
    await evaluateCoordinatorCadence(db, NOW);
    await event('task.reassigned', 'Ada', -1); // 1 minute after NOW
    expect(await evaluateCoordinatorCadence(db, later(2))).toEqual([]);
    expect(await db.coordinatorCadenceEpisode.count({ where: { workerId: w.Ada.id, endedAt: null } })).toBe(0);
    expect(await evaluateCoordinatorCadence(db, later(60))).toEqual([]); // 59 minutes after the assignment at +1
    expect(await evaluateCoordinatorCadence(db, later(61))).toHaveLength(1);
    expect(await alarms()).toHaveLength(2);
  });

  it('assignment.matched alone does not reset the clock, and neither does another worker\'s assignment', async () => {
    await lateAda();
    await event('assignment.matched', 'Tove', 10);
    await event('task.assigned', 'Tove', 5);
    await event('assignment.matched', 'Ada', 5);
    expect(await evaluateCoordinatorCadence(db, NOW)).toHaveLength(1);
  });

  it('raises nothing when no lane worker is free, and an open episode survives such a pass without a second alarm', async () => {
    await lateAda();
    await db.agentTask.create({ data: { appId: app.id, title: 'T', ownerUserId: user.id, assigneeWorkerId: w.Liam.id, assignedAt: at(10) } });
    expect(await evaluateCoordinatorCadence(db, NOW)).toEqual([]);
    await db.agentTask.deleteMany({ where: { appId: app.id, assigneeWorkerId: { not: null } } });
    expect(await evaluateCoordinatorCadence(db, later(1))).toHaveLength(1);
    await db.agentTask.create({ data: { appId: app.id, title: 'T', ownerUserId: user.id, assigneeWorkerId: w.Liam.id, assignedAt: at(10) } });
    expect(await evaluateCoordinatorCadence(db, later(2))).toEqual([]);
    expect(await db.coordinatorCadenceEpisode.count({ where: { workerId: w.Ada.id, endedAt: null } })).toBe(1);
    await db.agentTask.deleteMany({ where: { appId: app.id, assigneeWorkerId: { not: null } } });
    expect(await evaluateCoordinatorCadence(db, later(3))).toEqual([]);
    expect(await alarms()).toHaveLength(1);
  });

  it('a never-assigned coordinator is not late before 60 minutes from its observed row, and an existing one is not late at first pass', async () => {
    await bind('Ada', 500);
    await bind('Liam');
    expect(await evaluateCoordinatorCadence(db, NOW)).toEqual([]);
    expect(await evaluateCoordinatorCadence(db, later(59))).toEqual([]);
    expect(await evaluateCoordinatorCadence(db, later(60))).toHaveLength(1);
    expect((await alarms())[0].payload).toMatchObject({ lastAssignedAt: null });
  });

  it('a coordinator whose first session is recent is not late even when first observed long ago', async () => {
    await bind('Liam');
    await db.coordinatorCadenceClock.create({ data: { workerId: w.Ada.id, appId: app.id, observedAt: at(500) } });
    await bind('Ada', 10);
    expect(await evaluateCoordinatorCadence(db, NOW)).toEqual([]);
  });

  it('an App without a coordinator raises nothing, and a retired coordinator is not evaluated', async () => {
    await bind('Liam');
    await db.worker.update({ where: { id: w.Ada.id }, data: { retiredAt: at(1) } });
    await evaluateCoordinatorCadence(db, at(70));
    expect(await evaluateCoordinatorCadence(db, NOW)).toEqual([]);
    expect(await db.coordinatorCadenceClock.count()).toBe(0);
  });
});

describe('#2763 the lane', () => {
  it('a lone idle coordinator raises nothing (self-exclusion)', async () => {
    await db.worker.updateMany({ where: { id: { in: [w.Liam.id, w.Tove.id] } }, data: { retiredAt: at(1) } });
    await bind('Ada');
    await evaluateCoordinatorCadence(db, at(70));
    expect(await evaluateCoordinatorCadence(db, NOW)).toEqual([]);
  });

  it('a free second coordinator with no reporting line does not make the first late', async () => {
    w.Beth = await mk('Beth', null, 'coordinator');
    await db.worker.updateMany({ where: { id: { in: [w.Liam.id, w.Tove.id] } }, data: { retiredAt: at(1) } });
    await bind('Ada');
    await bind('Beth');
    await evaluateCoordinatorCadence(db, at(70));
    expect(await evaluateCoordinatorCadence(db, NOW)).toEqual([]);
  });

  it('a free worker reporting to another coordinator does not count', async () => {
    w.Beth = await mk('Beth', null, 'coordinator');
    w.Sam = await mk('Sam', w.Beth.id);
    await db.worker.updateMany({ where: { id: { in: [w.Liam.id, w.Tove.id] } }, data: { retiredAt: at(1) } });
    await bind('Ada');
    await bind('Beth');
    await bind('Sam');
    await evaluateCoordinatorCadence(db, at(70));
    expect(await alarms('Ada')).toHaveLength(0);
    expect(await evaluateCoordinatorCadence(db, NOW)).toHaveLength(1); // Beth is late (Sam is hers); Ada is not
    expect(await alarms('Beth')).toHaveLength(1);
    expect(await alarms('Ada')).toHaveLength(0);
  });

  it('a free worker with no reporting line counts for every coordinator: one episode each', async () => {
    w.Beth = await mk('Beth', null, 'coordinator');
    await db.worker.update({ where: { id: w.Liam.id }, data: { retiredAt: at(1) } });
    await bind('Ada');
    await bind('Beth');
    await bind('Tove');
    await evaluateCoordinatorCadence(db, at(70));
    expect(await evaluateCoordinatorCadence(db, NOW)).toHaveLength(2);
    expect(await alarms('Ada')).toHaveLength(1);
    expect(await alarms('Beth')).toHaveLength(1);
    expect(await evaluateCoordinatorCadence(db, later(1))).toEqual([]);
  });
});

describe('#2763 the exemptions come from the dark-worker set', () => {
  it.each([
    ['PAUSED', async () => db.workerWakeSettings.create({ data: { workerId: w.Ada.id, pausedUntil: later(60) } })],
    ['TEAM_PAUSED', async () => db.app.update({ where: { id: app.id }, data: { teamPausedAt: at(100) } })],
  ])('%s raises nothing', async (_name, apply) => {
    await bind('Ada');
    await bind('Liam');
    await evaluateCoordinatorCadence(db, at(70));
    await apply();
    expect(await evaluateCoordinatorCadence(db, NOW)).toEqual([]);
  });

  it('a coordinator with no live session is NOT exempt (cor:agt:050:31 r3), but a paused one without a session still is', async () => {
    await bind('Liam');
    await evaluateCoordinatorCadence(db, at(70));
    await db.workerWakeSettings.create({ data: { workerId: w.Ada.id, pausedUntil: later(60) } });
    expect(await evaluateCoordinatorCadence(db, NOW)).toEqual([]);
    await db.workerWakeSettings.delete({ where: { workerId: w.Ada.id } });
    expect(await evaluateCoordinatorCadence(db, later(1))).toHaveLength(1);
  });
});

describe('#2763 the database and the surfaces', () => {
  it('admits one OPEN episode per coordinator, and the stall tick runs the pass', async () => {
    await lateAda();
    const tick = await taskStallTick(db, NOW);
    expect(tick.cadenceRaised).toBe(1);
    const second = await db.agentTeamEvent.create({ data: { appId: app.id, type: TYPE, subjectWorkerId: w.Ada.id, severity: 'alarm', chain: [], payload: {} } });
    await expect(db.coordinatorCadenceEpisode.create({ data: { appId: app.id, workerId: w.Ada.id, eventId: second.id, openedAt: NOW } })).rejects.toThrow();
  });

  it('redacts the evidence for a reader without access to worker internals, keeps the reason and window', async () => {
    const payload = { reason: 'coordinator-cadence', windowMinutes: 60, lastAssignedAt: NOW.toISOString(), freeWorkerCount: 2 };
    const out = await eventPayloadFor({ type: TYPE, appId: app.id, payload }, { db, user: { id: generateId() }, roles: [] } as never);
    expect(out).toEqual({ reason: 'coordinator-cadence', windowMinutes: 60 });
  });

  it('wakes the nearest owner of the chain through the episode-bound delivery, and stops when the episode ends', async () => {
    w.Cass = await mk('Cass', null, 'lead');
    await db.worker.update({ where: { id: w.Ada.id }, data: { reportsToWorkerId: w.Cass.id } });
    await lateAda();
    await evaluateCoordinatorCadence(db, NOW);
    const [a] = await alarms();
    expect((a.chain as { workerId?: string }[])[0]).toEqual({ workerId: w.Cass.id });
    const { pendingTaskWakes } = await import('./taskWakes.js');
    const pending = (await pendingTaskWakes(db, [w.Cass.id], NOW)).get(w.Cass.id) ?? [];
    expect(pending.filter((p) => p.eventId === a.id)).toHaveLength(1);
    expect(pending.find((p) => p.eventId === a.id)?.title).toBe('Ada has stopped assigning work');
    await db.coordinatorCadenceEpisode.updateMany({ where: { eventId: a.id }, data: { endedAt: later(1) } });
    expect(((await pendingTaskWakes(db, [w.Cass.id], later(1))).get(w.Cass.id) ?? []).some((p) => p.eventId === a.id)).toBe(false);
  });
});

describe('#2763 fix head: the decision is re-derived inside the raise transaction; the chain follows cor:agt:050:18', () => {
  it('an assignment that commits between the pass\'s reads and the raise transaction publishes nothing', async () => {
    await lateAda();
    const real = db.$transaction.bind(db) as (...a: unknown[]) => Promise<unknown>;
    const spy = vi.spyOn(db, '$transaction').mockImplementationOnce((async (...a: unknown[]) => {
      await event('task.assigned', 'Ada', 0); // commits in the window between the outer read and the transaction
      return real(...a);
    }) as never);
    expect(await evaluateCoordinatorCadence(db, NOW)).toEqual([]);
    spy.mockRestore();
    expect(await alarms()).toHaveLength(0);
    expect(await db.coordinatorCadenceEpisode.count()).toBe(0);
    expect(await db.agentTeamAlarmSchedule.count()).toBe(0);
  });

  it('a pause that commits in that window publishes nothing', async () => {
    await lateAda();
    const real = db.$transaction.bind(db) as (...a: unknown[]) => Promise<unknown>;
    const spy = vi.spyOn(db, '$transaction').mockImplementationOnce((async (...a: unknown[]) => {
      await db.workerWakeSettings.create({ data: { workerId: w.Ada.id, pausedUntil: later(60) } });
      return real(...a);
    }) as never);
    expect(await evaluateCoordinatorCadence(db, NOW)).toEqual([]);
    spy.mockRestore();
    expect(await alarms()).toHaveLength(0);
  });

  it('the chain is the reporting line only when there is one', async () => {
    w.Cass = await mk('Cass', null, 'lead');
    await db.worker.update({ where: { id: w.Ada.id }, data: { reportsToWorkerId: w.Cass.id } });
    await lateAda();
    await evaluateCoordinatorCadence(db, NOW);
    expect((await alarms())[0].chain).toEqual([{ workerId: w.Cass.id }]);
  });

  it('the App managers are the chain only when there is no reporting line', async () => {
    await lateAda();
    await evaluateCoordinatorCadence(db, NOW);
    const chain = (await alarms())[0].chain as { workerId?: string; userId?: string; via?: string }[];
    expect(chain.length).toBeGreaterThan(0);
    expect(chain.every((p) => !p.workerId && p.userId && p.via === 'manager')).toBe(true);
  });

  it('a real task.assigned ends the episode and the delivered escalation stops', async () => {
    w.Cass = await mk('Cass', null, 'lead');
    await db.worker.update({ where: { id: w.Ada.id }, data: { reportsToWorkerId: w.Cass.id } });
    await lateAda();
    await evaluateCoordinatorCadence(db, NOW);
    const [a] = await alarms();
    const { pendingTaskWakes } = await import('./taskWakes.js');
    expect(((await pendingTaskWakes(db, [w.Cass.id], NOW)).get(w.Cass.id) ?? []).some((p) => p.eventId === a.id)).toBe(true);
    await event('task.assigned', 'Ada', -1);
    await evaluateCoordinatorCadence(db, later(2));
    expect(((await pendingTaskWakes(db, [w.Cass.id], later(2))).get(w.Cass.id) ?? []).some((p) => p.eventId === a.id)).toBe(false);
  });

  it('escalation up the chain ends with the episode: the unwoken owner is closed, not woken (stall.ts)', async () => {
    w.Dee = await mk('Dee', null, 'lead');
    w.Cass = await mk('Cass', w.Dee.id, 'lead');
    await db.worker.update({ where: { id: w.Ada.id }, data: { reportsToWorkerId: w.Cass.id } });
    await lateAda();
    await evaluateCoordinatorCadence(db, NOW);
    const [a] = await alarms();
    expect(a.chain).toEqual([{ workerId: w.Cass.id }, { workerId: w.Dee.id }]);
    await event('task.assigned', 'Ada', -1);
    await evaluateCoordinatorCadence(db, later(2)); // the episode ends
    const { wakeDueOwners } = await import('./stall.js');
    expect(await wakeDueOwners(db, later(70))).toBe(0);
    const rows = await db.agentTeamAlarmSchedule.findMany({ where: { eventId: a.id }, orderBy: { chainIndex: 'asc' } });
    expect(rows[1].wokenAt).toBeNull();
    expect(rows[1].endedAt).not.toBeNull();
  });
});


describe('#3400 stop-covered lane workers (ruling 0123)', () => {
  const signal = (workerId: string, level = 'pause-dispatch', extra: Record<string, unknown> = {}) =>
    db.teamStopSignal.create({ data: {
      id: generateId(), appId: app.id, level, scope: 'worker', targetWorkerId: workerId,
      setAt: at(1), setByUserId: user.id, ...extra,
    } });

  it.each(['pause', 'halt', 'pause-dispatch'])('excludes the sole free lane worker under %s, with a live control', async (level) => {
    await lateAda();
    const stop = await signal(w.Liam.id, level);
    expect(await evaluateCoordinatorCadence(db, NOW)).toEqual([]);
    expect(await alarms()).toHaveLength(0);
    expect(await db.coordinatorCadenceEpisode.count()).toBe(0);
    await db.teamStopSignal.update({ where: { id: stop.id }, data: { endedAt: NOW, endKind: 'lifted', endedByUserId: user.id } });
    expect(await evaluateCoordinatorCadence(db, later(1))).toHaveLength(1);
    expect((await alarms())[0].payload).toMatchObject({ freeWorkerCount: 1 });
  });

  it.each(['pause', 'halt', 'pause-dispatch'])('counts only the uncovered free worker under %s', async (level) => {
    await lateAda();
    await bind('Tove');
    await signal(w.Liam.id, level);
    expect(await evaluateCoordinatorCadence(db, NOW)).toHaveLength(1);
    expect((await alarms())[0].payload).toMatchObject({ freeWorkerCount: 1 });
  });

  it.each(['pause', 'halt', 'pause-dispatch'])('uses team coverage at every level: %s', async (level) => {
    await lateAda();
    w.Head = await mk('Head', w.Ada.id);
    await db.worker.update({ where: { id: w.Liam.id }, data: { reportsToWorkerId: w.Head.id } });
    await signal(w.Head.id, level, { scope: 'team' });
    expect(await evaluateCoordinatorCadence(db, NOW)).toEqual([]);
    expect(await alarms()).toHaveLength(0);
  });

  it.each(['pause', 'halt', 'pause-dispatch'])('uses host registration coverage at every level: %s', async (level) => {
    await lateAda();
    const host = await db.hostRegistration.create({ data: {
      appId: app.id, hostId: 'cadence-test-host', label: 'Cadence test', pollIntervalSeconds: 600, refreshedAt: NOW,
    } });
    await db.hostRegistrationWorker.create({ data: { registrationId: host.id, workerId: w.Liam.id, family: 'claude' } });
    await signal(w.Liam.id, level, { scope: 'host', targetWorkerId: null, targetHostRegistrationId: host.id });
    expect(await evaluateCoordinatorCadence(db, NOW)).toEqual([]);
    expect(await alarms()).toHaveLength(0);
  });

  it('expires coverage at until, before the expiry sweep has recorded an end', async () => {
    await lateAda();
    await signal(w.Liam.id, 'pause-dispatch', { until: later(1) });
    expect(await evaluateCoordinatorCadence(db, NOW)).toEqual([]);
    expect(await evaluateCoordinatorCadence(db, later(1))).toHaveLength(1);
    expect((await alarms())[0].payload).toMatchObject({ freeWorkerCount: 1 });
  });

  it('ignores another App and another lane, while an uncovered local worker still counts', async () => {
    await lateAda();
    w.Beth = await mk('Beth', null, 'coordinator');
    w.Sam = await mk('Sam', w.Beth.id);
    await bind('Sam');
    const otherApp = await db.app.create({ data: { organizationId: org.id, name: 'Other', urn: `${org.urn}:other` } });
    const foreign = await db.worker.create({ data: {
      ...WORKER_SIGNATURE_DEFAULTS, appId: otherApp.id, agentId: agent.id, name: 'Other', slug: 'other', role: 'engineer',
    } });
    await signal(foreign.id, 'pause-dispatch', { appId: otherApp.id });
    await signal(w.Sam.id, 'pause-dispatch');
    expect(await evaluateCoordinatorCadence(db, NOW)).toHaveLength(1);
    expect((await alarms('Ada'))[0].payload).toMatchObject({ freeWorkerCount: 1 });
    expect(await alarms('Beth')).toHaveLength(0);
  });

  it('#3410 derives team coverage across reparenting within the same lane', async () => {
    await lateAda();
    w.Head = await mk('Head', w.Ada.id, 'coordinator');
    await db.worker.update({ where: { id: w.Liam.id }, data: { reportsToWorkerId: w.Head.id } });
    // Lane membership is positive on both sides; only stop coverage changes.
    expect((await matchingTeamPool(db, app.id, w.Ada.id)).has(w.Liam.id)).toBe(true);
    await signal(w.Head.id, 'pause-dispatch', { scope: 'team' });
    expect(await evaluateCoordinatorCadence(db, NOW)).toEqual([]);
    await db.worker.update({ where: { id: w.Liam.id }, data: { reportsToWorkerId: w.Ada.id } });
    expect((await matchingTeamPool(db, app.id, w.Ada.id)).has(w.Liam.id)).toBe(true);
    expect(await evaluateCoordinatorCadence(db, later(1))).toHaveLength(1);
    expect(await alarms('Ada')).toHaveLength(1);
    expect(await db.teamStopSignal.count({ where: { endedAt: null } })).toBe(1);
  });

  it('keeps an existing episode open while the free lane is stopped, until a counted assignment', async () => {
    await lateAda();
    expect(await evaluateCoordinatorCadence(db, NOW)).toHaveLength(1);
    const [episode] = await db.coordinatorCadenceEpisode.findMany();
    const stop = await signal(w.Liam.id);
    expect(await evaluateCoordinatorCadence(db, later(1))).toEqual([]);
    expect(await db.coordinatorCadenceEpisode.findUnique({ where: { id: episode.id } })).toMatchObject({ endedAt: null });
    await db.teamStopSignal.update({ where: { id: stop.id }, data: { endedAt: later(2), endKind: 'lifted', endedByUserId: user.id } });
    expect(await evaluateCoordinatorCadence(db, later(3))).toEqual([]);
    expect(await alarms()).toHaveLength(1);
    await event('task.assigned', 'Ada', -4);
    expect(await evaluateCoordinatorCadence(db, later(5))).toEqual([]);
    expect(await db.coordinatorCadenceEpisode.findUnique({ where: { id: episode.id } })).toMatchObject({ endedAt: later(4) });
  });

  it('#3410 identifies uncovered outer and covered raise-transaction decisions', async () => {
    await lateAda();
    const real = db.$transaction.bind(db) as (...a: unknown[]) => Promise<unknown>;
    const readCoverage = stopState.coveringSignals;
    const observations: { inRaise: boolean; client: unknown; covered: boolean }[] = [];
    let inRaise = false;
    let raiseClient: unknown;
    let raises = 0;
    const coverageSpy = vi.spyOn(stopState, 'coveringSignals').mockImplementation(async (...args) => {
      const coverage = await readCoverage(...args);
      if (args[1] === app.id && args[2]?.includes(w.Liam.id)) {
        observations.push({ inRaise, client: args[0], covered: coverage.has(w.Liam.id) });
      }
      return coverage; // Observe the real read; do not replace its answer.
    });
    const transactionSpy = vi.spyOn(db, '$transaction').mockImplementation((async (...a: unknown[]) => {
      const [callback, options] = a as [
        (tx: Prisma.TransactionClient) => Promise<unknown>,
        { isolationLevel?: Prisma.TransactionIsolationLevel } | undefined,
      ];
      if (options?.isolationLevel !== Prisma.TransactionIsolationLevel.Serializable) return real(...a);
      // An earlier transaction cannot silently consume the interleave: the outer lane read must already be uncovered.
      expect(observations.some((o) => !o.inRaise && o.client === db && !o.covered)).toBe(true);
      raises++;
      await signal(w.Liam.id); // Committed before the actual SERIALIZABLE raise callback begins.
      return real(async (tx: Prisma.TransactionClient) => {
        raiseClient = tx;
        inRaise = true;
        try { return await callback(tx); }
        finally { inRaise = false; }
      }, options);
    }) as never);
    try {
      expect(await evaluateCoordinatorCadence(db, NOW)).toEqual([]);
      expect(raises).toBe(1);
      expect(observations.some((o) => o.inRaise && o.client === raiseClient && o.covered)).toBe(true);
    } finally {
      transactionSpy.mockRestore();
      coverageSpy.mockRestore();
    }
    expect(await alarms()).toHaveLength(0);
    expect(await db.coordinatorCadenceEpisode.count()).toBe(0);
    expect(await db.agentTeamAlarmSchedule.count()).toBe(0);
  });

  it.each([false, true])('#3410 overlapping stops lift independently; existing episode: %s', async (openEpisode) => {
    await lateAda();
    if (openEpisode) expect(await evaluateCoordinatorCadence(db, NOW)).toHaveLength(1);
    const first = await signal(w.Liam.id, 'pause');
    const second = await signal(w.Liam.id, 'halt');
    expect(await evaluateCoordinatorCadence(db, later(1))).toEqual([]);
    expect((await stopState.coveringSignals(db, app.id, [w.Liam.id], later(1))).get(w.Liam.id)?.map((s) => s.id))
      .toEqual(expect.arrayContaining([first.id, second.id]));
    await db.teamStopSignal.update({ where: { id: first.id }, data: {
      endedAt: later(2), endKind: 'lifted', endedByUserId: user.id,
    } });
    expect((await stopState.coveringSignals(db, app.id, [w.Liam.id], later(3))).get(w.Liam.id)?.map((s) => s.id))
      .toEqual([second.id]);
    expect(await evaluateCoordinatorCadence(db, later(3))).toEqual([]);
    await db.teamStopSignal.update({ where: { id: second.id }, data: {
      endedAt: later(4), endKind: 'lifted', endedByUserId: user.id,
    } });
    expect((await stopState.coveringSignals(db, app.id, [w.Liam.id], later(5))).has(w.Liam.id)).toBe(false);
    const afterLastLift = await evaluateCoordinatorCadence(db, later(5));
    expect(afterLastLift).toHaveLength(openEpisode ? 0 : 1);
    expect(await alarms()).toHaveLength(1);
    expect((await alarms())[0].payload).toMatchObject({ freeWorkerCount: 1 });
    expect(await db.coordinatorCadenceEpisode.count({ where: { workerId: w.Ada.id, endedAt: null } })).toBe(1);
    // The assignment at NOW+6, not either lift, ends the episode. A later full window can raise again.
    await event('task.reassigned', 'Ada', -6);
    expect(await evaluateCoordinatorCadence(db, later(7))).toEqual([]);
    expect(await db.coordinatorCadenceEpisode.count({ where: { workerId: w.Ada.id, endedAt: null } })).toBe(0);
    expect(await evaluateCoordinatorCadence(db, later(66))).toHaveLength(1);
    expect(await alarms()).toHaveLength(2);
  });

  it('a coordinator team pause-dispatch leaves an unattached worker in its lane, without exempting the coordinator', async () => {
    await lateAda();
    await bind('Tove');
    await signal(w.Ada.id, 'pause-dispatch', { scope: 'team' });
    expect(await evaluateCoordinatorCadence(db, NOW)).toHaveLength(1);
    expect((await alarms())[0].payload).toMatchObject({ freeWorkerCount: 1 });
  });
});
