/**
 * #4298 (cor:agt:050:13, cor:agt:050:14, cor:agt:050:20) — the recorded end of an alarm's episode never precedes the alarm.
 *
 * The move that OPENS an episode is written twice: as a stamp on the task row (`assignedAt`, `releasedAt`), which is the
 * episode's start, and as an event (`task.assigned`, `task.released`) a few milliseconds later in the same transaction.
 * The episode's end is the first ending move AFTER it began, so the opening event, later than the start by those
 * milliseconds, was read as the move that ended the episode: `escalationEndedAt` on a not-started alarm was its own
 * task's assignment (Cedar's reproduction on hadron-cli#2203 QA: 16m 59.991s before the start).
 *
 * Same cast and controllable clock as resolvers.alarmInEffect3934.test.ts.
 */
import { ApolloServer } from '@apollo/server';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { taskStallTick } from '../../../jobs/taskStallEvaluator.js';
import { recordEndedEscalations } from '../../../lib/agentTasks/stall.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
import { appendTaskEvent, type TaskEventPayload } from '../../../lib/agentTasks/events.js';
import { resolvers, type Context } from './resolvers.js';
import { typeDefs } from './typeDefs.js';

const M = resolvers.Mutation as any;
const DAY = '2026-10-09';
const at = (hhmm: string, ms = 0): Date => new Date(new Date(`${DAY}T${hhmm}:00Z`).getTime() + ms);
const iso = (hhmm: string): string => at(hhmm).toISOString();
/** The gap Cedar observed between the row's `assignedAt` and its `task.assigned` event. */
const GAP_MS = 9;
const ctx = (userId?: string): Context => ({ db, userId, roles: ['READER'] });
const server = new ApolloServer<Context>({ typeDefs, resolvers });

let app: { id: string };
let admin: { id: string };
let ada: { id: string };
let anne: { id: string };
let rook: { id: string };

beforeEach(async () => {
  await cleanDb(db);
  const n = Math.floor(Math.random() * 1_000_000);
  const org = await db.organization.create({ data: { name: 'EpisodeEnd', urn: `episode-end-${n}.example` } });
  admin = await db.user.create({ data: { githubId: 600_000 + n, githubUsername: `ee-admin-${n}`, roles: ['READER'] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  const agent = await M.createAgent({}, { orgId: org.id, name: 'Team Agent' }, ctx(admin.id));
  app = await db.app.create({ data: { organizationId: org.id, name: 'Team', urn: `episode-end-${n}.example:team` }, select: { id: true } });
  const worker = (name: string) =>
    db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: app.id, agentId: agent.id, name, slug: name.toLowerCase() }, select: { id: true } });
  ada = await worker('Ada');
  anne = await worker('Anne');
  rook = await worker('Rook');
});

type Ev = { id: string; acknowledgedAt: string | null; escalationEndedAt: string | null };
async function events(args = ''): Promise<Ev[]> {
  const r = await server.executeOperation(
    { query: `{ agentTeamEvents(appRef: "${app.id}", alarmsOnly: true ${args}) { id acknowledgedAt escalationEndedAt } }` },
    { contextValue: ctx(admin.id) },
  );
  if (r.body.kind !== 'single') throw new Error('single response required');
  const s = r.body.singleResult;
  if (s.errors) throw new Error(JSON.stringify(s.errors));
  return (s.data as any).agentTeamEvents;
}
const inEffect = async () => (await events('alarmsInEffect: true')).map((e) => e.id);
const record = (hhmm: string) => recordEndedEscalations(db, at(hhmm));
const tick = (hhmm: string) => taskStallTick(db, at(hhmm));
const by = () => ({ userId: admin.id, workerId: null, agentId: null });
const event = (taskId: string, e: TaskEventPayload, createdAt: Date) => appendTaskEvent(db, { appId: app.id, taskId, actor: by(), event: e, createdAt });
const party = (w: { id: string }) => ({ workerId: w.id });

/**
 * Anne's task as the write path leaves it: the row's `assignedAt` at 10:00, its `task.assigned` event 9 ms later. The
 * pass at 10:15 raises the not-started alarm (episode start 10:00:00.000).
 */
async function assignedThenAlarmed() {
  const t = await db.agentTask.create({
    data: { appId: app.id, title: 'T', createdAt: at('10:00'), ownerWorkerId: ada.id, assigneeWorkerId: anne.id, assignedAt: at('10:00') },
    select: { id: true },
  });
  await event(t.id, { type: 'task.assigned', assignee: party(anne), closeSessionWhenDone: false }, at('10:00', GAP_MS));
  await tick('10:15');
  const alarm = await db.agentTeamEvent.findFirstOrThrow({ where: { taskId: t.id, type: 'stall.not-started' } });
  expect(alarm.episodeStart).toEqual(at('10:00'));
  return { t, alarm };
}
const start = async (taskId: string, hhmm: string) => {
  await db.agentTask.update({ where: { id: taskId }, data: { status: 'started', startedAt: at(hhmm) } });
  await event(taskId, { type: 'task.started' }, at(hhmm));
};

describe('#4298 — a not-started episode ends at the start, not at the assignment that opened it', () => {
  it('Cedar\'s reproduction: assign, pass past the window, start, pass again: the end is the start', async () => {
    const { t, alarm } = await assignedThenAlarmed();
    // Still pending: in effect, however many passes run.
    await record('10:16');
    expect(await events()).toMatchObject([{ id: alarm.id, escalationEndedAt: null }]);
    expect(await inEffect()).toEqual([alarm.id]);

    await start(t.id, '10:17');
    await tick('10:18');
    const [e] = await events();
    expect(e).toMatchObject({ id: alarm.id, acknowledgedAt: null, escalationEndedAt: iso('10:17') });
    expect(new Date(e.escalationEndedAt!).getTime()).toBeGreaterThanOrEqual(alarm.createdAt.getTime());
    expect(await inEffect()).toEqual([]);
  });

  it('the acknowledgement\'s freeze records the start too, not the opening assignment', async () => {
    const { t, alarm } = await assignedThenAlarmed();
    await start(t.id, '10:17');
    await M.acknowledgeAlarm({}, { eventId: alarm.id }, ctx(admin.id));
    expect((await db.alarmEscalationEnd.findUniqueOrThrow({ where: { eventId: alarm.id } })).endedAt).toEqual(at('10:17'));
  });

  it('a reassignment ends it at the reassignment, not at the opening assignment before it', async () => {
    const { t, alarm } = await assignedThenAlarmed();
    await db.agentTask.update({ where: { id: t.id }, data: { assigneeWorkerId: rook.id, assignedAt: at('10:20') } });
    await event(t.id, { type: 'task.reassigned', from: party(anne), to: party(rook), closeSessionWhenDone: false }, at('10:20', GAP_MS));
    await record('10:21');
    expect(await events()).toMatchObject([{ id: alarm.id, escalationEndedAt: at('10:20', GAP_MS).toISOString() }]);
  });

  it('an episode opened by a REASSIGNMENT is not ended by its own task.reassigned event: it ends at the start', async () => {
    // Rook held it first; at 10:00 it is reassigned to Anne (row stamp 10:00, its event 9 ms later).
    const t = await db.agentTask.create({
      data: { appId: app.id, title: 'T', createdAt: at('09:00'), ownerWorkerId: ada.id, assigneeWorkerId: anne.id, assignedAt: at('10:00') },
      select: { id: true },
    });
    await event(t.id, { type: 'task.assigned', assignee: party(rook), closeSessionWhenDone: false }, at('09:55', GAP_MS));
    await event(t.id, { type: 'task.reassigned', from: party(rook), to: party(anne), closeSessionWhenDone: false }, at('10:00', GAP_MS));
    await tick('10:15');
    const alarm = await db.agentTeamEvent.findFirstOrThrow({ where: { taskId: t.id, type: 'stall.not-started' } });
    expect(alarm.episodeStart).toEqual(at('10:00'));
    await record('10:16');
    expect(await inEffect()).toEqual([alarm.id]);
    await start(t.id, '10:17');
    await record('10:18');
    expect(await events()).toMatchObject([{ id: alarm.id, escalationEndedAt: iso('10:17') }]);
    expect(await inEffect()).toEqual([]);
  });

  it('cancelled with no start: the cancellation, not the opening assignment', async () => {
    const { t, alarm } = await assignedThenAlarmed();
    await db.agentTask.update({ where: { id: t.id }, data: { status: 'cancelled', cancelledAt: at('10:25') } });
    await record('10:26');
    expect(await events()).toMatchObject([{ id: alarm.id, escalationEndedAt: iso('10:25') }]);
  });

  it('started then finished: the start (the first ending move), not the opening assignment and not the finish', async () => {
    const { t, alarm } = await assignedThenAlarmed();
    await start(t.id, '10:20');
    await db.agentTask.update({ where: { id: t.id }, data: { status: 'finished', finishedAt: at('10:25'), resultOutcome: 'succeeded' } });
    await record('10:26');
    expect(await events()).toMatchObject([{ id: alarm.id, escalationEndedAt: iso('10:20') }]);
  });

  it('a released task: the episode opened by the release ends at the start, not at the release\'s own event', async () => {
    // Assigned at 09:30 while blocked, released at 10:00 (the row stamp; its event 9 ms later): the clock counts from 10:00.
    const t = await db.agentTask.create({
      data: { appId: app.id, title: 'T', createdAt: at('09:30'), ownerWorkerId: ada.id, assigneeWorkerId: anne.id, assignedAt: at('09:30'), releasedAt: at('10:00') },
      select: { id: true },
    });
    await event(t.id, { type: 'task.assigned', assignee: party(anne), closeSessionWhenDone: false }, at('09:30', GAP_MS));
    await event(t.id, { type: 'task.released' }, at('10:00', GAP_MS));
    await tick('10:15');
    const alarm = await db.agentTeamEvent.findFirstOrThrow({ where: { taskId: t.id, type: 'stall.not-started' } });
    expect(alarm.episodeStart).toEqual(at('10:00'));
    await start(t.id, '10:17');
    await record('10:18');
    expect(await events()).toMatchObject([{ id: alarm.id, escalationEndedAt: iso('10:17') }]);
  });

  // Scope (the gate on #4298: the not-started rule only). Every other rule still counts from its episode's start. Not
  // red on main: it holds the change to the one rule.
  it('another rule is unchanged: a couldn\'t-be-assigned episode still ends at the first assignment after its start', async () => {
    const t = await db.agentTask.create({ data: { appId: app.id, title: 'Q', createdAt: at('10:00'), ownerWorkerId: ada.id }, select: { id: true } });
    await tick('10:35');
    const alarm = await db.agentTeamEvent.findFirstOrThrow({ where: { taskId: t.id, type: 'assignment.unassignable' } });
    // An assignment recorded before the pass that raised the alarm (a late pass): still the end, as on main.
    await db.agentTask.update({ where: { id: t.id }, data: { assigneeWorkerId: anne.id, assignedAt: at('10:32') } });
    await event(t.id, { type: 'task.assigned', assignee: party(anne), closeSessionWhenDone: false }, at('10:32'));
    await record('10:36');
    expect(await events()).toMatchObject([{ id: alarm.id, escalationEndedAt: iso('10:32') }]);
  });

  it('the real write path: a task created with an assignee, alarmed and started, never ends before its alarm', async () => {
    const made = await M.createAgentTask({}, { input: { appRef: app.id, title: 'Real', assignee: { worker: anne.id } } }, ctx(admin.id));
    const row = await db.agentTask.findUniqueOrThrow({ where: { id: made.id } });
    const assigned = await db.agentTeamEvent.findFirstOrThrow({ where: { taskId: made.id, type: 'task.assigned' } });
    expect(assigned.createdAt.getTime()).toBeGreaterThanOrEqual(row.assignedAt!.getTime()); // the event is never before the stamp
    const raisedAt = new Date(row.assignedAt!.getTime() + 16 * 60_000);
    await taskStallTick(db, raisedAt);
    const alarm = await db.agentTeamEvent.findFirstOrThrow({ where: { taskId: made.id, type: 'stall.not-started' } });
    const startedAt = new Date(row.assignedAt!.getTime() + 17 * 60_000);
    await db.agentTask.update({ where: { id: made.id }, data: { status: 'started', startedAt } });
    await appendTaskEvent(db, { appId: app.id, taskId: made.id, actor: by(), event: { type: 'task.started' }, createdAt: startedAt });
    await recordEndedEscalations(db, new Date(startedAt.getTime() + 60_000));
    expect((await db.alarmEscalationEnd.findUniqueOrThrow({ where: { eventId: alarm.id } })).endedAt).toEqual(startedAt);
  });
});
