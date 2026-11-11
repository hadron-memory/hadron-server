/**
 * #3934 (cor:agt:050:20, V77 "an alarm in effect") — `AgentTeamEvent.escalationEndedAt` and the `agentTeamEvents`
 * `alarmsInEffect` filter.
 *
 * An alarm is in effect while it is unacknowledged and its escalation has not stopped; its escalation ended at the
 * earlier of the acknowledgement and the end of its episode. Both reads must come from the answer the wake schedule
 * uses (`wakeDueOwners` closes exactly the alarms these reads call ended), for every kind of alarm. Reading changes
 * nothing, and a read without the filter is today's list.
 *
 * Executed over the real SDL (ApolloServer), because the surface under test is a schema field and an argument.
 * Same cast and controllable clock as endedAlarmEpisodes2200.test.ts.
 */
import { ApolloServer } from '@apollo/server';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { taskStallTick } from '../../../jobs/taskStallEvaluator.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
import { resolvers, type Context } from './resolvers.js';
import { typeDefs } from './typeDefs.js';

const M = resolvers.Mutation as any;
const DAY = '2026-10-09';
const at = (hhmm: string): Date => new Date(`${DAY}T${hhmm}:00Z`);
const iso = (hhmm: string): string => at(hhmm).toISOString();
const ctx = (userId?: string): Context => ({ db, userId, roles: ['READER'] });
const server = new ApolloServer<Context>({ typeDefs, resolvers });

let app: { id: string };
let agentId: string;
let admin: { id: string };
let ada: { id: string };
let anne: { id: string };
let rook: { id: string };

beforeEach(async () => {
  await cleanDb(db);
  const n = Math.floor(Math.random() * 1_000_000);
  const org = await db.organization.create({ data: { name: 'InEffect', urn: `ineffect-${n}.example` } });
  admin = await db.user.create({ data: { githubId: 500_000 + n, githubUsername: `ie-admin-${n}`, roles: ['READER'] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  const agent = await M.createAgent({}, { orgId: org.id, name: 'Team Agent' }, ctx(admin.id));
  agentId = agent.id;
  app = await db.app.create({ data: { organizationId: org.id, name: 'Team', urn: `ineffect-${n}.example:team` }, select: { id: true } });
  const worker = (name: string) =>
    db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: app.id, agentId, name, slug: name.toLowerCase() }, select: { id: true } });
  ada = await worker('Ada');
  anne = await worker('Anne');
  rook = await worker('Rook');
});

type Ev = { id: string; type: string; acknowledgedAt: string | null; escalationEndedAt: string | null };
async function events(args = ''): Promise<Ev[]> {
  const r = await server.executeOperation(
    { query: `{ agentTeamEvents(appRef: "${app.id}", alarmsOnly: true ${args}) { id type acknowledgedAt escalationEndedAt } }` },
    { contextValue: ctx(admin.id) },
  );
  if (r.body.kind !== 'single') throw new Error('single response required');
  const s = r.body.singleResult;
  if (s.errors) throw new Error(JSON.stringify(s.errors));
  return (s.data as any).agentTeamEvents;
}

const task = (data: Record<string, unknown>) =>
  db.agentTask.create({ data: { appId: app.id, title: 'T', createdAt: at('09:00'), ...data }, select: { id: true } });
const assignedToAnne = (assignedAt: string) =>
  task({ ownerWorkerId: ada.id, assigneeWorkerId: anne.id, assignedAt: at(assignedAt), createdAt: at(assignedAt) });
const tick = (t: string) => taskStallTick(db, at(t));
const alarms = (type?: string) =>
  db.agentTeamEvent.findMany({ where: { severity: 'alarm', ...(type ? { type } : {}) }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
const rows = (eventId: string) => db.agentTeamAlarmSchedule.findMany({ where: { eventId }, orderBy: { chainIndex: 'asc' } });

/** A not-started alarm on Anne's task (assigned 10:00): chain [Ada, manager]. */
async function notStartedAlarm() {
  const t = await assignedToAnne('10:00');
  await tick('10:15');
  const [alarm] = await alarms('stall.not-started');
  return { t, alarm };
}

describe('#3934 — escalationEndedAt and alarmsInEffect on a task alarm', () => {
  it('an alarm whose episode still runs is in effect: no end, and the filter lists it', async () => {
    const { alarm } = await notStartedAlarm();
    const [e] = await events();
    expect(e).toMatchObject({ id: alarm.id, escalationEndedAt: null });
    expect((await events('alarmsInEffect: true')).map((x) => x.id)).toEqual([alarm.id]);
  });

  it('started: the episode ended at the start; out of the filter, still listed without it, still unacknowledged', async () => {
    const { t, alarm } = await notStartedAlarm();
    await db.agentTask.update({ where: { id: t.id }, data: { status: 'started', startedAt: at('10:20') } });
    const [e] = await events();
    expect(e).toMatchObject({ id: alarm.id, acknowledgedAt: null, escalationEndedAt: iso('10:20') });
    expect(await events('alarmsInEffect: true')).toEqual([]);
  });

  // A not-started alarm ends at the FIRST transition that ends it: a task finished after being started ended at its start.
  it.each([['finished', 'finishedAt', '10:16'], ['cancelled', 'cancelledAt', '10:25']] as const)('%s: ended at the first ending move', async (status, col, ended) => {
    const { t, alarm } = await notStartedAlarm();
    await db.agentTask.update({ where: { id: t.id }, data: { status, [col]: at('10:25'), ...(status === 'finished' ? { startedAt: at('10:16'), resultOutcome: 'succeeded' } : {}) } });
    expect(await events()).toMatchObject([{ id: alarm.id, escalationEndedAt: iso(ended) }]);
    expect(await events('alarmsInEffect: true')).toEqual([]);
  });

  it('acknowledged while the episode runs: ended at the acknowledgement', async () => {
    const { alarm } = await notStartedAlarm();
    await db.agentTeamEvent.update({ where: { id: alarm.id }, data: { acknowledgedAt: at('10:18'), acknowledgedByWorkerId: ada.id } });
    expect(await events()).toMatchObject([{ id: alarm.id, escalationEndedAt: iso('10:18') }]);
    expect(await events('alarmsInEffect: true')).toEqual([]);
  });

  it('acknowledged after the episode ended: the earlier instant, the end of the episode', async () => {
    const { t, alarm } = await notStartedAlarm();
    await db.agentTask.update({ where: { id: t.id }, data: { status: 'started', startedAt: at('10:20') } });
    await db.agentTeamEvent.update({ where: { id: alarm.id }, data: { acknowledgedAt: at('10:40'), acknowledgedByWorkerId: ada.id } });
    expect(await events()).toMatchObject([{ id: alarm.id, escalationEndedAt: iso('10:20') }]);
  });

  it('acknowledged before the episode ended: the earlier instant, the acknowledgement', async () => {
    const { t, alarm } = await notStartedAlarm();
    await db.agentTeamEvent.update({ where: { id: alarm.id }, data: { acknowledgedAt: at('10:18'), acknowledgedByWorkerId: ada.id } });
    await db.agentTask.update({ where: { id: t.id }, data: { status: 'started', startedAt: at('10:20') } });
    expect(await events()).toMatchObject([{ id: alarm.id, escalationEndedAt: iso('10:18') }]);
  });

  it('a later move does not move an end already reached: started 10:20, then finished 10:40, still ended at 10:20', async () => {
    const { t, alarm } = await notStartedAlarm();
    await db.agentTask.update({ where: { id: t.id }, data: { status: 'started', startedAt: at('10:20') } });
    expect(await events()).toMatchObject([{ id: alarm.id, escalationEndedAt: iso('10:20') }]);
    await db.agentTask.update({ where: { id: t.id }, data: { status: 'finished', finishedAt: at('10:40'), resultOutcome: 'succeeded' } });
    expect(await events()).toMatchObject([{ id: alarm.id, escalationEndedAt: iso('10:20') }]);
  });

  it('a finish-by alarm is not ended by a reassignment, only by its deadline edit: the end is the edit, not the assignment', async () => {
    const t = await task({ ownerWorkerId: ada.id, assigneeWorkerId: anne.id, assignedAt: at('09:30'), finishBy: at('10:00') });
    await tick('10:15');
    const [alarm] = await alarms('stall.finish-by');
    await db.agentTask.update({ where: { id: t.id }, data: { assigneeWorkerId: rook.id, assignedAt: at('10:05') } });
    expect(await events()).toMatchObject([{ id: alarm.id, escalationEndedAt: null }]);
    await db.agentTask.update({ where: { id: t.id }, data: { finishBy: at('18:00') } });
    await db.agentTeamEvent.create({ data: { appId: app.id, taskId: t.id, type: 'task.edited', payload: { fields: ['finishBy'] }, createdAt: at('10:30') } });
    expect(await events()).toMatchObject([{ id: alarm.id, escalationEndedAt: iso('10:30') }]);
  });

  it('a no-progress alarm ends at the FIRST note after it began; a later finish does not move it', async () => {
    const t = await task({ ownerWorkerId: ada.id, assigneeWorkerId: anne.id, assignedAt: at('09:30'), status: 'started', startedAt: at('10:00') });
    await db.session.create({ data: { id: generateId(), appId: app.id, workerId: anne.id, agentId, startedAt: at('10:00'), updatedAt: at('10:00') } });
    await tick('11:00');
    const [alarm] = await alarms('stall.no-progress');
    await db.agentTeamEvent.create({ data: { appId: app.id, taskId: t.id, type: 'task.progress', actorWorkerId: anne.id, createdAt: at('11:30') } });
    await db.agentTeamEvent.create({ data: { appId: app.id, taskId: t.id, type: 'task.progress', actorWorkerId: anne.id, createdAt: at('11:45') } });
    await db.agentTask.update({ where: { id: t.id }, data: { status: 'finished', finishedAt: at('12:00'), resultOutcome: 'succeeded' } });
    expect((await events()).find((e) => e.id === alarm.id)).toMatchObject({ escalationEndedAt: iso('11:30') });
  });

  it('the same answer as the wake schedule: the wake pass closes exactly the alarms the read calls ended', async () => {
    const { t: ended } = await notStartedAlarm();
    const running = await assignedToAnne('10:05'); // its own alarm at 10:20, still running
    await tick('10:20');
    await db.agentTask.update({ where: { id: ended.id }, data: { status: 'started', startedAt: at('10:22') } });
    const before = await events();
    expect(before).toHaveLength(2);
    const endedIds = before.filter((e) => e.escalationEndedAt).map((e) => e.id);
    expect(endedIds).toHaveLength(1);
    await tick('10:50'); // every second row is due; the wake pass judges both
    for (const a of await alarms()) {
      const [, second] = await rows(a.id);
      expect(second.endedAt !== null).toBe(endedIds.includes(a.id));
      expect(second.wokenAt !== null).toBe(!endedIds.includes(a.id));
    }
    void running;
  });
});

describe('#3934 — the kinds with no task: judged by their own episode', () => {
  const taskless = (type: string) =>
    db.agentTeamEvent.create({ data: { appId: app.id, type, severity: 'alarm', chain: [], payload: {}, subjectWorkerId: rook.id, createdAt: at('10:00') } });

  it('a dark-worker alarm: ended when its episode row says so, and not before', async () => {
    const e = await taskless('alarm.dark-worker');
    const ep = await db.darkWorkerEpisode.create({ data: { appId: app.id, workerId: rook.id, eventId: e.id, reason: 'overdue', openedAt: at('10:00') } });
    expect(await events('alarmsInEffect: true')).toMatchObject([{ id: e.id, escalationEndedAt: null }]);
    await db.darkWorkerEpisode.update({ where: { id: ep.id }, data: { endedAt: at('10:30') } });
    expect(await events()).toMatchObject([{ id: e.id, escalationEndedAt: iso('10:30') }]);
    expect(await events('alarmsInEffect: true')).toEqual([]);
  });

  it('a coordinator-cadence alarm: the same', async () => {
    const e = await taskless('alarm.coordinator-cadence');
    const ep = await db.coordinatorCadenceEpisode.create({ data: { appId: app.id, workerId: rook.id, eventId: e.id, openedAt: at('10:00') } });
    expect(await events('alarmsInEffect: true')).toMatchObject([{ id: e.id, escalationEndedAt: null }]);
    await db.coordinatorCadenceEpisode.update({ where: { id: ep.id }, data: { endedAt: at('10:45') } });
    expect(await events()).toMatchObject([{ id: e.id, escalationEndedAt: iso('10:45') }]);
    expect(await events('alarmsInEffect: true')).toEqual([]);
  });

  it('a task-less alarm with no episode rule keeps escalating until acknowledged', async () => {
    const e = await taskless('alarm.post-limit');
    expect(await events('alarmsInEffect: true')).toMatchObject([{ id: e.id, escalationEndedAt: null }]);
    await db.agentTeamEvent.update({ where: { id: e.id }, data: { acknowledgedAt: at('11:00'), acknowledgedByWorkerId: ada.id } });
    expect(await events()).toMatchObject([{ id: e.id, escalationEndedAt: iso('11:00') }]);
  });
});

describe('#3934 — the surface changes nothing and pages whole', () => {
  it('reading with and without the filter writes nothing', async () => {
    const { t } = await notStartedAlarm();
    await db.agentTask.update({ where: { id: t.id }, data: { status: 'started', startedAt: at('10:20') } });
    const snap = async () => JSON.stringify([await db.agentTeamEvent.findMany({ orderBy: { id: 'asc' } }), await db.agentTeamAlarmSchedule.findMany({ orderBy: [{ eventId: 'asc' }, { chainIndex: 'asc' }] })]);
    const before = await snap();
    await events();
    await events('alarmsInEffect: true');
    expect(await snap()).toBe(before);
  });

  it('without the filter the list is today\'s list: ended alarms stay', async () => {
    const { t } = await notStartedAlarm();
    await db.agentTask.update({ where: { id: t.id }, data: { status: 'started', startedAt: at('10:20') } });
    expect(await events()).toHaveLength(1);
    expect(await events('alarmsInEffect: false')).toHaveLength(1);
  });

  it('a page is full of in-effect alarms: ended ones in between are skipped, and `after` continues', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const t = await assignedToAnne('10:00');
      await tick(`10:${15 + i}`);
      ids.push(t.id);
    }
    const all = await alarms('stall.not-started');
    expect(all).toHaveLength(5);
    // end the 1st, 2nd and 4th
    for (const i of [0, 1, 3]) await db.agentTask.update({ where: { id: all[i].taskId! }, data: { status: 'started', startedAt: at('10:30') } });
    const first = await events('alarmsInEffect: true limit: 1');
    expect(first.map((e) => e.id)).toEqual([all[2].id]);
    const second = await events(`alarmsInEffect: true limit: 1 after: "${first[0].id}"`);
    expect(second.map((e) => e.id)).toEqual([all[4].id]);
    expect(await events(`alarmsInEffect: true limit: 1 after: "${second[0].id}"`)).toEqual([]);
    void ids;
  });

  it('more ended alarms than one scan batch precede the first in-effect alarm: it is still found', async () => {
    const ended = Array.from({ length: 205 }, (_, i) => ({
      id: generateId(), appId: app.id, type: 'alarm.dark-worker', severity: 'alarm', chain: [], payload: {}, subjectWorkerId: rook.id,
      createdAt: new Date(at('08:00').getTime() + i * 1000),
    }));
    await db.agentTeamEvent.createMany({ data: ended });
    await db.darkWorkerEpisode.createMany({
      data: ended.map((e, i) => ({ appId: app.id, workerId: rook.id, eventId: e.id, reason: 'overdue', openedAt: e.createdAt, endedAt: at('09:00'), id: `ep-${i}-${generateId()}` })),
    });
    const live = await db.agentTeamEvent.create({
      data: { appId: app.id, type: 'alarm.post-limit', severity: 'alarm', chain: [], payload: {}, createdAt: at('09:30') },
    });
    expect((await events('alarmsInEffect: true limit: 1')).map((e) => e.id)).toEqual([live.id]);
  });
});
