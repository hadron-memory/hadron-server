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
import { recordEndedEscalations } from '../../../lib/agentTasks/stall.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
import { appendTaskEvent } from '../../../lib/agentTasks/events.js';
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
/** The evaluator pass that records an ended alarm's escalation end (once). */
const record = (hhmm: string) => recordEndedEscalations(db, at(hhmm));
/** Reads; unless `recordAt` is null, the pass has run first (at 12:30 by default), as it does every minute in production. */
async function events(args = '', recordAt: string | null = '12:30'): Promise<Ev[]> {
  if (recordAt) await record(recordAt);
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

  it('acknowledged after the episode ended but before the pass recorded it: the acknowledgement freezes the episode end', async () => {
    const { t, alarm } = await notStartedAlarm();
    await db.agentTask.update({ where: { id: t.id }, data: { status: 'started', startedAt: at('10:20') } });
    expect(await db.alarmEscalationEnd.count({ where: { eventId: alarm.id } })).toBe(0); // the pass has not run
    await M.acknowledgeAlarm({}, { eventId: alarm.id }, ctx(admin.id));
    const rec = await db.alarmEscalationEnd.findUniqueOrThrow({ where: { eventId: alarm.id } });
    expect(rec.endedAt).toEqual(at('10:20'));
    const [e] = await events('', null);
    expect(e).toMatchObject({ id: alarm.id, escalationEndedAt: iso('10:20') });
    expect(e.acknowledgedAt).not.toBeNull();
  });

  it('acknowledged while the episode still runs: nothing is recorded; the acknowledgement is the end', async () => {
    const { alarm } = await notStartedAlarm();
    await M.acknowledgeAlarm({}, { eventId: alarm.id }, ctx(admin.id));
    expect(await db.alarmEscalationEnd.count({ where: { eventId: alarm.id } })).toBe(0);
    const [e] = await events('', null);
    expect(e.escalationEndedAt).toBe(e.acknowledgedAt);
    expect(await events('alarmsInEffect: true', null)).toEqual([]); // acknowledged while running: out of effect at once, no pass needed
  });

  it('acknowledged after the pass recorded the end: the earlier instant, the recorded end', async () => {
    const { t, alarm } = await notStartedAlarm();
    await db.agentTask.update({ where: { id: t.id }, data: { status: 'started', startedAt: at('10:20') } });
    await record('10:25');
    // Through the real mutation: the freeze finds the end already recorded and must leave it be (no duplicate insert).
    await M.acknowledgeAlarm({}, { eventId: alarm.id }, ctx(admin.id));
    expect(await db.alarmEscalationEnd.count({ where: { eventId: alarm.id } })).toBe(1);
    expect(await events('', null)).toMatchObject([{ id: alarm.id, escalationEndedAt: iso('10:20') }]);
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
    // Written by the real event writer, so the payload shape is the production one (`fields`).
    await appendTaskEvent(db, { appId: app.id, taskId: t.id, actor: { userId: admin.id, workerId: null, agentId: null }, event: { type: 'task.edited', fields: ['finishBy'] }, createdAt: at('10:30') });
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

  it('another task\'s notes never set this alarm\'s end: only its own task\'s record counts', async () => {
    const t = await task({ ownerWorkerId: ada.id, assigneeWorkerId: anne.id, assignedAt: at('09:30'), status: 'started', startedAt: at('10:00') });
    const other = await task({ ownerWorkerId: ada.id, assigneeWorkerId: rook.id, assignedAt: at('09:30'), status: 'started', startedAt: at('10:00') });
    await db.session.create({ data: { id: generateId(), appId: app.id, workerId: anne.id, agentId, startedAt: at('10:00'), updatedAt: at('10:00') } });
    await tick('11:00');
    const alarm = (await alarms('stall.no-progress')).find((a) => a.taskId === t.id)!;
    await db.agentTeamEvent.create({ data: { appId: app.id, taskId: other.id, type: 'task.progress', actorWorkerId: rook.id, createdAt: at('11:30') } });
    await db.agentTask.update({ where: { id: t.id }, data: { status: 'finished', finishedAt: at('12:00'), resultOutcome: 'succeeded' } });
    expect((await events()).find((e) => e.id === alarm.id)).toMatchObject({ escalationEndedAt: iso('12:00') });
  });

  it('a not-started alarm ends at the FIRST reassignment, not the latest one the row now shows', async () => {
    const { t, alarm } = await notStartedAlarm();
    const party = (w: { id: string }) => ({ workerId: w.id });
    const by = { userId: admin.id, workerId: null, agentId: null };
    await appendTaskEvent(db, { appId: app.id, taskId: t.id, actor: by, event: { type: 'task.reassigned', from: party(anne), to: party(rook), closeSessionWhenDone: false }, createdAt: at('10:20') });
    await appendTaskEvent(db, { appId: app.id, taskId: t.id, actor: by, event: { type: 'task.reassigned', from: party(rook), to: party(anne), closeSessionWhenDone: false }, createdAt: at('10:35') });
    await db.agentTask.update({ where: { id: t.id }, data: { assigneeWorkerId: anne.id, assignedAt: at('10:35') } });
    expect((await events()).find((e) => e.id === alarm.id)).toMatchObject({ escalationEndedAt: iso('10:20') });
  });

  it('before the pass has run an ended alarm still reads as in effect, with no end; after it, ended', async () => {
    const { t, alarm } = await notStartedAlarm();
    await db.agentTask.update({ where: { id: t.id }, data: { status: 'started', startedAt: at('10:20') } });
    expect(await events('', null)).toMatchObject([{ id: alarm.id, escalationEndedAt: null }]);
    expect((await events('alarmsInEffect: true', null)).map((e) => e.id)).toEqual([alarm.id]);
    await record('10:21');
    expect(await events('', null)).toMatchObject([{ id: alarm.id, escalationEndedAt: iso('10:20') }]);
    expect(await events('alarmsInEffect: true', null)).toEqual([]);
  });

  it('the recorded end is written once: a second heartbeat and a later finish do not move it, and the database refuses an update', async () => {
    const t = await task({ ownerWorkerId: ada.id, assigneeWorkerId: anne.id, assignedAt: at('09:30'), status: 'started', startedAt: at('10:00') });
    const session = await db.session.create({ data: { id: generateId(), appId: app.id, workerId: anne.id, agentId, startedAt: at('10:00'), updatedAt: at('10:00') } });
    await tick('11:00');
    const alarm = (await alarms('stall.no-progress')).find((a) => a.taskId === t.id)!;
    await db.session.update({ where: { id: session.id }, data: { updatedAt: at('11:10') } }); // the assignee acts: the episode ends
    await record('11:10');
    expect((await events('', null)).find((e) => e.id === alarm.id)).toMatchObject({ escalationEndedAt: iso('11:10') });
    await db.session.update({ where: { id: session.id }, data: { updatedAt: at('11:20') } }); // a second heartbeat
    await record('11:21');
    expect((await events('', null)).find((e) => e.id === alarm.id)).toMatchObject({ escalationEndedAt: iso('11:10') });
    await db.agentTask.update({ where: { id: t.id }, data: { status: 'finished', finishedAt: at('12:00'), resultOutcome: 'succeeded' } });
    await record('12:01');
    expect((await events('', null)).find((e) => e.id === alarm.id)).toMatchObject({ escalationEndedAt: iso('11:10') });
    await expect(db.alarmEscalationEnd.update({ where: { eventId: alarm.id }, data: { endedAt: at('12:00') } })).rejects.toThrow();
  });

  it('the old assignee acted at 11:10 and the task was reassigned at 11:20: the recorded end is the activity, 11:10', async () => {
    const t = await task({ ownerWorkerId: ada.id, assigneeWorkerId: anne.id, assignedAt: at('09:30'), status: 'started', startedAt: at('10:00') });
    const session = await db.session.create({ data: { id: generateId(), appId: app.id, workerId: anne.id, agentId, startedAt: at('10:00'), updatedAt: at('10:00') } });
    await tick('11:00');
    const alarm = (await alarms('stall.no-progress')).find((a) => a.taskId === t.id)!;
    await db.session.update({ where: { id: session.id }, data: { updatedAt: at('11:10') } });
    const by = { userId: admin.id, workerId: null, agentId: null };
    await appendTaskEvent(db, { appId: app.id, taskId: t.id, actor: by, event: { type: 'task.reassigned', from: { workerId: anne.id }, to: { workerId: rook.id }, closeSessionWhenDone: false }, createdAt: at('11:20') });
    await db.agentTask.update({ where: { id: t.id }, data: { assigneeWorkerId: rook.id, assignedAt: at('11:20') } });
    await record('11:30');
    expect((await events('', null)).find((e) => e.id === alarm.id)).toMatchObject({ escalationEndedAt: iso('11:10') });
  });

  it('two children end after the alarm began: the recorded end is the FIRST child end, 11:10, not the latest', async () => {
    const parent = await task({ ownerWorkerId: ada.id, assigneeWorkerId: anne.id, assignedAt: at('09:30'), status: 'started', startedAt: at('10:00') });
    await db.session.create({ data: { id: generateId(), appId: app.id, workerId: anne.id, agentId, startedAt: at('10:00'), updatedAt: at('10:00') } });
    await tick('11:00');
    const alarm = (await alarms('stall.no-progress')).find((a) => a.taskId === parent.id)!;
    const child = (finishedAt: string) => task({
      parentTaskId: parent.id, ownerWorkerId: anne.id, assigneeWorkerId: rook.id, assignedAt: at('09:40'),
      status: 'finished', startedAt: at('09:50'), finishedAt: at(finishedAt), resultOutcome: 'succeeded',
    });
    await child('11:10');
    await child('11:20');
    await record('11:30');
    expect((await events('', null)).find((e) => e.id === alarm.id)).toMatchObject({ escalationEndedAt: iso('11:10') });
  });

  it('the pass does not even select alarms that can never be recorded: a post-limit alarm and an uninstalled App\'s alarm', async () => {
    const done = await task({ ownerWorkerId: ada.id, assigneeWorkerId: anne.id, assignedAt: at('09:00'), status: 'finished', startedAt: at('09:10'), finishedAt: at('09:20'), resultOutcome: 'succeeded' });
    const stale = (appId: string, taskId: string | null, type: string, start: string) =>
      db.agentTeamEvent.create({ data: { appId, taskId, type, severity: 'alarm', chain: [], payload: {}, episodeStart: at(start), createdAt: at('09:30') } });
    const postLimit = await stale(app.id, done.id, 'alarm.post-limit', '09:05');
    const live = await stale(app.id, done.id, 'stall.not-started', '09:06');
    // The rows the pass reads from the event stream, counted: the selection is the cost bound.
    let selected = 0;
    const counting = new Proxy(db, {
      get(t, k, r) {
        const v = Reflect.get(t, k, r);
        if (k !== 'agentTeamEvent') return typeof v === 'function' ? v.bind(t) : v;
        return new Proxy(v as object, {
          get(m, f, rr) {
            const x = Reflect.get(m, f, rr);
            if (f !== 'findMany') return typeof x === 'function' ? x.bind(m) : x;
            return async (...a: unknown[]) => { const rows = (await (x as (...b: unknown[]) => Promise<unknown[]>).apply(m, a)) as unknown[]; selected += rows.length; return rows; };
          },
        });
      },
    }) as typeof db;
    expect(await recordEndedEscalations(counting, at('12:00'))).toBe(1);
    expect(selected).toBe(1); // only the stall alarm; the post-limit alarm was never selected
    expect(await db.alarmEscalationEnd.count({ where: { eventId: postLimit.id } })).toBe(0);
    expect(await db.alarmEscalationEnd.count({ where: { eventId: live.id } })).toBe(1);
    await db.app.update({ where: { id: app.id }, data: { uninstalledAt: at('12:30') } });
    const after = await stale(app.id, done.id, 'stall.not-started', '09:07');
    selected = 0;
    expect(await recordEndedEscalations(counting, at('13:00'))).toBe(0);
    expect(selected).toBe(0); // an uninstalled App's alarms are not selected either
    expect(await db.alarmEscalationEnd.count({ where: { eventId: after.id } })).toBe(0);
  });

  it('activity BEFORE the episode began never counts: it started the episode, and the recorded end is the later note', async () => {
    const t = await task({ ownerWorkerId: ada.id, assigneeWorkerId: anne.id, assignedAt: at('09:30'), status: 'started', startedAt: at('10:00') });
    await db.session.create({ data: { id: generateId(), appId: app.id, workerId: anne.id, agentId, startedAt: at('10:00'), updatedAt: at('10:30') } });
    await tick('11:35'); // the episode began at the 10:30 activity; its window (60 min) has passed
    const alarm = (await alarms('stall.no-progress')).find((a) => a.taskId === t.id)!;
    expect(alarm.episodeStart).toEqual(at('10:30'));
    await db.agentTeamEvent.create({ data: { appId: app.id, taskId: t.id, type: 'task.progress', actorWorkerId: anne.id, createdAt: at('11:40') } });
    await record('11:45');
    expect((await events('', null)).find((e) => e.id === alarm.id)).toMatchObject({ escalationEndedAt: iso('11:40') });
  });

  /** Anne's started task raises no-progress at 11:00; Rook has a session from 11:10 while the task is still Anne's; then Anne to Rook at 11:20 and Rook back to Anne at 11:40. */
  async function interimAssignee() {
    const t = await task({ ownerWorkerId: ada.id, assigneeWorkerId: anne.id, assignedAt: at('09:30'), status: 'started', startedAt: at('10:00') });
    await db.session.create({ data: { id: generateId(), appId: app.id, workerId: anne.id, agentId, startedAt: at('10:00'), updatedAt: at('10:00') } });
    await tick('11:00');
    const alarm = (await alarms('stall.no-progress')).find((a) => a.taskId === t.id)!;
    await db.session.create({ data: { id: generateId(), appId: app.id, workerId: rook.id, agentId, startedAt: at('11:10'), updatedAt: at('11:10') } });
    const by = { userId: admin.id, workerId: null, agentId: null };
    await appendTaskEvent(db, { appId: app.id, taskId: t.id, actor: by, event: { type: 'task.reassigned', from: { workerId: anne.id }, to: { workerId: rook.id }, closeSessionWhenDone: false }, createdAt: at('11:20') });
    await appendTaskEvent(db, { appId: app.id, taskId: t.id, actor: by, event: { type: 'task.reassigned', from: { workerId: rook.id }, to: { workerId: anne.id }, closeSessionWhenDone: false }, createdAt: at('11:40') });
    await db.agentTask.update({ where: { id: t.id }, data: { assigneeWorkerId: anne.id, assignedAt: at('11:40') } });
    return alarm;
  }

  it('an intermediate assignee\'s activity BEFORE they held the task never counts: the pass records the first reassignment, 11:20, not 11:10', async () => {
    const alarm = await interimAssignee();
    await record('11:50');
    expect((await events('', null)).find((e) => e.id === alarm.id)).toMatchObject({ escalationEndedAt: iso('11:20') });
  });

  it('the same through the acknowledgement\'s freeze: it records 11:20 too', async () => {
    const alarm = await interimAssignee();
    await M.acknowledgeAlarm({}, { eventId: alarm.id }, ctx(admin.id));
    expect((await db.alarmEscalationEnd.findUniqueOrThrow({ where: { eventId: alarm.id } })).endedAt).toEqual(at('11:20'));
  });

  /**
   * A started task of Anne's with a no-progress alarm, and one "noise" row that must NOT count as her activity (a session
   * ended before its last write, an auto-expiry's maintenance write, a deleted session, a usage event that is not
   * activity, a child that ended before the episode): a note at 12:00 then ends it, so the recorded end is 12:00 unless
   * the guard under test lets the noise in and records it as an earlier end.
   */
  async function noProgressWithNoise(noise: (taskId: string) => Promise<void>) {
    const t = await task({ ownerWorkerId: ada.id, assigneeWorkerId: anne.id, assignedAt: at('09:30'), status: 'started', startedAt: at('10:00') });
    await db.session.create({ data: { id: generateId(), appId: app.id, workerId: anne.id, agentId, startedAt: at('10:00'), updatedAt: at('10:00') } });
    await noise(t.id);
    await tick('11:05');
    const alarm = (await alarms('stall.no-progress')).find((a) => a.taskId === t.id)!;
    await db.agentTeamEvent.create({ data: { appId: app.id, taskId: t.id, type: 'task.progress', actorWorkerId: anne.id, createdAt: at('12:00') } });
    await record('12:05');
    return (await events('', null)).find((e) => e.id === alarm.id);
  }

  it('activity cannot postdate the end of its session: a heartbeat written after the session ended is not an end', async () => {
    const e = await noProgressWithNoise(async () => {
      await db.session.create({ data: { id: generateId(), appId: app.id, workerId: anne.id, agentId, startedAt: at('10:00'), updatedAt: at('11:10'), endedAt: at('10:00') } });
    });
    expect(e).toMatchObject({ escalationEndedAt: iso('12:00') });
  });

  it('an auto-expiry\'s maintenance write is not activity', async () => {
    const e = await noProgressWithNoise(async () => {
      await db.session.create({ data: { id: generateId(), appId: app.id, workerId: anne.id, agentId, startedAt: at('10:00'), updatedAt: at('11:10'), autoExpiredAt: at('11:10') } });
    });
    expect(e).toMatchObject({ escalationEndedAt: iso('12:00') });
  });

  it('a deleted session is not activity', async () => {
    const e = await noProgressWithNoise(async () => {
      await db.session.create({ data: { id: generateId(), appId: app.id, workerId: anne.id, agentId, startedAt: at('10:00'), updatedAt: at('11:10'), deletedAt: at('11:11') } });
    });
    expect(e).toMatchObject({ escalationEndedAt: iso('12:00') });
  });

  it('a usage event that does not count as activity is not activity', async () => {
    const e = await noProgressWithNoise(async () => {
      const sid = generateId();
      await db.session.create({ data: { id: sid, appId: app.id, workerId: anne.id, agentId, startedAt: at('10:00'), updatedAt: at('10:00') } });
      await db.usageEvent.create({ data: { type: 'test', sessionId: sid, appId: app.id, countsAsActivity: false, createdAt: at('11:10') } });
    });
    expect(e).toMatchObject({ escalationEndedAt: iso('12:00') });
  });

  it('a child that ended BEFORE the episode began is not the end of this episode', async () => {
    const e = await noProgressWithNoise(async (parentId) => {
      await task({ parentTaskId: parentId, ownerWorkerId: anne.id, assigneeWorkerId: rook.id, assignedAt: at('09:35'), status: 'finished', startedAt: at('09:40'), finishedAt: at('09:50'), resultOutcome: 'succeeded' });
    });
    expect(e).toMatchObject({ escalationEndedAt: iso('12:00') });
  });

  it('the real reassignment mutation\'s event is what the stints are read from: the previous assignee\'s activity is found through its payload', async () => {
    const t = await task({ ownerWorkerId: ada.id, assigneeWorkerId: anne.id, assignedAt: at('09:30'), status: 'started', startedAt: at('10:00') });
    const session = await db.session.create({ data: { id: generateId(), appId: app.id, workerId: anne.id, agentId, startedAt: at('10:00'), updatedAt: at('10:00') } });
    await tick('11:00');
    const alarm = (await alarms('stall.no-progress')).find((a) => a.taskId === t.id)!;
    await db.session.update({ where: { id: session.id }, data: { updatedAt: at('11:10') } });
    await M.reassignAgentTask({}, { taskId: t.id, assignee: { worker: rook.id } }, ctx(admin.id)); // production payload, the clock's real now
    const ev = await db.agentTeamEvent.findFirstOrThrow({ where: { taskId: t.id, type: 'task.reassigned' } });
    expect(ev.payload).toMatchObject({ from: { workerId: anne.id }, to: { workerId: rook.id } });
    await record('12:30');
    // Anne acted at 11:10 while she held it; the reassignment (real now) is later, so the end is her activity.
    expect((await events('', null)).find((e) => e.id === alarm.id)).toMatchObject({ escalationEndedAt: iso('11:10') });
  });

  it('a repeated open for the worker who already holds the task keeps the earlier stint start: the activity between still counts', async () => {
    const t = await task({ ownerWorkerId: ada.id, assigneeWorkerId: rook.id, assignedAt: at('09:30'), status: 'started', startedAt: at('10:00') });
    const by = { userId: admin.id, workerId: null, agentId: null };
    // The real writers, so the payload shapes the reader depends on are the production ones.
    await appendTaskEvent(db, { appId: app.id, taskId: t.id, actor: by, event: { type: 'task.assigned', assignee: { workerId: rook.id }, closeSessionWhenDone: false }, createdAt: at('09:30') });
    const session = await db.session.create({ data: { id: generateId(), appId: app.id, workerId: rook.id, agentId, startedAt: at('10:00'), updatedAt: at('10:00') } });
    await tick('11:05');
    const alarm = (await alarms('stall.no-progress')).find((a) => a.taskId === t.id)!;
    await db.session.update({ where: { id: session.id }, data: { updatedAt: at('11:10') } }); // legitimate activity while he holds it
    await appendTaskEvent(db, { appId: app.id, taskId: t.id, actor: by, event: { type: 'assignment.matched', assignee: { workerId: rook.id }, family: 'claude', closeSessionWhenDone: false }, createdAt: at('11:15') });
    const stored = await db.agentTeamEvent.findMany({ where: { taskId: t.id, type: { in: ['task.assigned', 'assignment.matched'] } }, orderBy: { createdAt: 'asc' } });
    expect(stored.map((e) => (e.payload as { assignee?: { workerId?: string } }).assignee?.workerId)).toEqual([rook.id, rook.id]);
    await record('11:30');
    expect((await events('', null)).find((e) => e.id === alarm.id)).toMatchObject({ escalationEndedAt: iso('11:10') });
  });

  it('the CURRENT holder\'s activity before they held the task never counts either (Anne to Rook at 11:20, Rook stays)', async () => {
    const t = await task({ ownerWorkerId: ada.id, assigneeWorkerId: anne.id, assignedAt: at('09:30'), status: 'started', startedAt: at('10:00') });
    await db.session.create({ data: { id: generateId(), appId: app.id, workerId: anne.id, agentId, startedAt: at('10:00'), updatedAt: at('10:00') } });
    await tick('11:00');
    const alarm = (await alarms('stall.no-progress')).find((a) => a.taskId === t.id)!;
    await db.session.create({ data: { id: generateId(), appId: app.id, workerId: rook.id, agentId, startedAt: at('11:05'), updatedAt: at('11:05') } });
    await appendTaskEvent(db, { appId: app.id, taskId: t.id, actor: { userId: admin.id, workerId: null, agentId: null }, event: { type: 'task.reassigned', from: { workerId: anne.id }, to: { workerId: rook.id }, closeSessionWhenDone: false }, createdAt: at('11:20') });
    await db.agentTask.update({ where: { id: t.id }, data: { assigneeWorkerId: rook.id, assignedAt: at('11:20') } });
    await record('11:30');
    expect((await events('', null)).find((e) => e.id === alarm.id)).toMatchObject({ escalationEndedAt: iso('11:20') });
  });

  it('one child ended before the episode and one after: the recorded end is the one after, 11:10', async () => {
    const parent = await task({ ownerWorkerId: ada.id, assigneeWorkerId: anne.id, assignedAt: at('09:30'), status: 'started', startedAt: at('10:00') });
    await db.session.create({ data: { id: generateId(), appId: app.id, workerId: anne.id, agentId, startedAt: at('10:00'), updatedAt: at('10:00') } });
    await tick('11:00');
    const alarm = (await alarms('stall.no-progress')).find((a) => a.taskId === parent.id)!;
    const child = (finishedAt: string) => task({
      parentTaskId: parent.id, ownerWorkerId: anne.id, assigneeWorkerId: rook.id, assignedAt: at('09:35'),
      status: 'finished', startedAt: at('09:40'), finishedAt: at(finishedAt), resultOutcome: 'succeeded',
    });
    await child('09:50');
    await child('11:10');
    await record('11:30');
    expect((await events('', null)).find((e) => e.id === alarm.id)).toMatchObject({ escalationEndedAt: iso('11:10') });
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

  it('without alarmsOnly the filter still lists only alarms (it implies alarmsOnly)', async () => {
    const { alarm } = await notStartedAlarm();
    await task({ ownerWorkerId: ada.id, createdAt: at('10:00') }); // ordinary task.* events exist beside the alarm? none seeded: add one
    await db.agentTeamEvent.create({ data: { appId: app.id, type: 'task.created', createdAt: at('10:01') } });
    const r = await server.executeOperation(
      { query: `{ agentTeamEvents(appRef: "${app.id}", alarmsInEffect: true) { id type } }` },
      { contextValue: ctx(admin.id) },
    );
    if (r.body.kind !== 'single' || r.body.singleResult.errors) throw new Error('read failed');
    expect((r.body.singleResult.data as any).agentTeamEvents.map((e: { id: string }) => e.id)).toEqual([alarm.id]);
  });

  it('the scan is scoped to the App asked for: another App\'s in-effect alarm is never returned', async () => {
    const { alarm } = await notStartedAlarm();
    const other = await db.app.create({ data: { organizationId: (await db.app.findUniqueOrThrow({ where: { id: app.id } })).organizationId, name: 'Other', urn: `other-${generateId()}.example:team` }, select: { id: true } });
    const w = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: other.id, agentId, name: 'Zed', slug: 'zed' }, select: { id: true } });
    await db.agentTask.create({ data: { appId: other.id, title: 'Other', ownerWorkerId: w.id, assigneeWorkerId: w.id, assignedAt: at('10:00'), createdAt: at('10:00') } });
    await tick('10:16');
    // A task-less alarm needs no open task of this App to pass the cost cut, so only the App scope itself keeps it out.
    await db.agentTeamEvent.create({ data: { appId: other.id, type: 'alarm.post-limit', severity: 'alarm', chain: [], payload: {}, createdAt: at('10:17') } });
    const foreign = await db.agentTeamEvent.findMany({ where: { appId: other.id, severity: 'alarm' } });
    expect(foreign.length).toBeGreaterThan(0);
    const got = (await events('alarmsInEffect: true')).map((e) => e.id);
    expect(got).toEqual([alarm.id]);
    for (const f of foreign) expect(got).not.toContain(f.id);
  });

  it('a read works nothing out: with a history of ended alarms recorded, an in-effect read reads no task and costs one page', async () => {
    const done = await task({ ownerWorkerId: ada.id, assigneeWorkerId: anne.id, assignedAt: at('09:00'), status: 'finished', startedAt: at('09:10'), finishedAt: at('09:20'), resultOutcome: 'succeeded' });
    await db.agentTeamEvent.createMany({
      data: Array.from({ length: 450 }, (_, i) => ({
        id: generateId(), appId: app.id, taskId: done.id, type: 'stall.not-started', severity: 'alarm', chain: [], payload: {},
        episodeStart: new Date(at('09:00').getTime() + (i + 1) * 1000), createdAt: new Date(at('09:30').getTime() + i * 1000),
      })),
    });
    const live = await db.agentTeamEvent.create({ data: { appId: app.id, type: 'alarm.post-limit', severity: 'alarm', chain: [], payload: {}, createdAt: at('11:00') } });
    expect(await record('12:00')).toBe(450); // the pass pages through all of them (more than one batch) and records each once
    expect(await record('12:01')).toBe(0); // and a second pass writes nothing: write-once
    let taskReads = 0;
    const counting = new Proxy(db, {
      get(t, k, r) {
        const v = Reflect.get(t, k, r);
        if (k !== 'agentTask') return typeof v === 'function' ? v.bind(t) : v;
        return new Proxy(v as object, { get(m, f, rr) { const x = Reflect.get(m, f, rr); if (f === 'findMany') taskReads++; return typeof x === 'function' ? x.bind(m) : x; } });
      },
    }) as typeof db;
    const r = await server.executeOperation(
      { query: `{ agentTeamEvents(appRef: "${app.id}", alarmsInEffect: true, limit: 1) { id escalationEndedAt } }` },
      { contextValue: { db: counting, userId: admin.id, roles: ['READER'] } as Context },
    );
    if (r.body.kind !== 'single' || r.body.singleResult.errors) throw new Error(JSON.stringify(r.body));
    expect((r.body.singleResult.data as any).agentTeamEvents).toEqual([{ id: live.id, escalationEndedAt: null }]);
    expect(taskReads).toBe(0);
  });

  it('newestFirst and the Page sibling take the filter too: newest in-effect alarms first, hasMore and a cursor that continues', async () => {
    const made = [];
    for (let i = 0; i < 4; i++) made.push(await db.agentTeamEvent.create({ data: { appId: app.id, type: 'alarm.post-limit', severity: 'alarm', chain: [], payload: {}, createdAt: new Date(at('10:00').getTime() + i * 60_000) } }));
    await db.agentTeamEvent.update({ where: { id: made[2].id }, data: { acknowledgedAt: at('11:00'), acknowledgedByWorkerId: ada.id } });
    const read = async (args: string) => {
      const r = await server.executeOperation(
        { query: `{ agentTeamEventsPage(appRef: "${app.id}", alarmsInEffect: true, newestFirst: true, ${args}) { hasMore nextCursor events { id } } }` },
        { contextValue: ctx(admin.id) },
      );
      if (r.body.kind !== 'single' || r.body.singleResult.errors) throw new Error(JSON.stringify(r.body));
      return (r.body.singleResult.data as any).agentTeamEventsPage as { hasMore: boolean; nextCursor: string | null; events: { id: string }[] };
    };
    const first = await read('limit: 2');
    expect(first.events.map((e) => e.id)).toEqual([made[3].id, made[1].id]); // made[2] is acknowledged
    expect(first.hasMore).toBe(true);
    const second = await read(`limit: 2, before: "${first.nextCursor}"`);
    expect(second.events.map((e) => e.id)).toEqual([made[0].id]);
    expect(second.hasMore).toBe(false);
  });
});
