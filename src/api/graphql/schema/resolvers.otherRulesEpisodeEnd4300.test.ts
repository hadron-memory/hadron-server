/**
 * #4300 (cor:agt:050:13, cor:agt:050:15, cor:agt:050:17, cor:agt:050:20) — the move that opened an episode never ends it,
 * for the no-progress rule too (#4298/#4299 built it for the not-started rule only).
 *
 * The opening move is written twice: as the row stamp that is the episode's start and as an event a few milliseconds
 * later. Counted from the start alone, that event reads as the first ending move, so the recorded end
 * (`escalationEndedAt`) is the move that opened the episode and precedes the alarm.
 *
 * Case (b), a no-progress episode opened by reassigning a started task, is that defect: the reassignment stamps
 * `assignedAt` from the application clock and appends its `task.reassigned` event after it (pinned red on main, and
 * through the real mutation). Case (a), an episode opened by a RELEASE, is not (the issue's green-on-main rule): the
 * release trigger writes `released_at` and its `task.released` event at one instant, so the event is never after the
 * episode's start, and a started task cannot be blocked (chk_started_not_blocked), so a release never opens a no-progress
 * episode. Its pins, through the real release path, stay as guards.
 *
 * Same cast and controllable clock as resolvers.notStartedEpisodeEnd4298.test.ts.
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
/** The gap #4298 observed between a row stamp and its event. */
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
  const org = await db.organization.create({ data: { name: 'OtherRules', urn: `other-rules-${n}.example` } });
  admin = await db.user.create({ data: { githubId: 700_000 + n, githubUsername: `or-admin-${n}`, roles: ['READER'] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  const agent = await M.createAgent({}, { orgId: org.id, name: 'Team Agent' }, ctx(admin.id));
  app = await db.app.create({ data: { organizationId: org.id, name: 'Team', urn: `other-rules-${n}.example:team` }, select: { id: true } });
  const worker = (name: string) =>
    db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: app.id, agentId: agent.id, name, slug: name.toLowerCase() }, select: { id: true } });
  ada = await worker('Ada');
  anne = await worker('Anne');
  rook = await worker('Rook');
});

type Ev = { id: string; escalationEndedAt: string | null };
async function events(args = ''): Promise<Ev[]> {
  const r = await server.executeOperation(
    { query: `{ agentTeamEvents(appRef: "${app.id}", alarmsOnly: true ${args}) { id escalationEndedAt } }` },
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
const alarmOf = (taskId: string, type: string) => db.agentTeamEvent.findFirstOrThrow({ where: { taskId, type } });
/** The recorded end is the expected move, and it does not precede the alarm's raise. */
async function endsAt(alarm: { id: string; createdAt: Date }, expected: Date) {
  const [e] = await events();
  expect(e).toMatchObject({ id: alarm.id, escalationEndedAt: expected.toISOString() });
  expect(new Date(e.escalationEndedAt!).getTime()).toBeGreaterThanOrEqual(alarm.createdAt.getTime());
  expect(await inEffect()).toEqual([]);
}

const note = (taskId: string, hhmm: string) => event(taskId, { type: 'task.progress' }, at(hhmm));
const MIN = 60_000;
const plus = (d: Date, minutes: number) => new Date(d.getTime() + minutes * MIN);

/**
 * The REAL release path: `t` blocked by a fresh blocker (the blocker trigger sets `blocked`), then the blocker finished,
 * which releases `t` (task-blocker-invariants.sql: `released_at` and `task.released` at one stamp). Returns the stamp.
 */
async function blockThenRelease(taskId: string): Promise<Date> {
  const blocker = await db.agentTask.create({ data: { appId: app.id, title: 'B', ownerWorkerId: ada.id }, select: { id: true } });
  await db.agentTaskBlocker.create({ data: { taskId, blockerTaskId: blocker.id } });
  expect((await db.agentTask.findUniqueOrThrow({ where: { id: taskId } })).blocked).toBe(true);
  await db.agentTask.update({ where: { id: blocker.id }, data: { status: 'cancelled', cancelledAt: new Date() } });
  const row = await db.agentTask.findUniqueOrThrow({ where: { id: taskId } });
  expect(row.blocked).toBe(false);
  const released = await db.agentTeamEvent.findFirstOrThrow({ where: { taskId, type: 'task.released' } });
  expect(released.createdAt).toEqual(row.releasedAt); // one instant: the event is never after the episode's start
  return row.releasedAt!;
}

describe('#4300 (a) — an episode opened by a release: not a defect on the real release path (guards)', () => {
  it('couldn\'t-be-assigned: a queued task released by its blocker\'s end; the end is the first assignment after the alarm', async () => {
    const t = await db.agentTask.create({ data: { appId: app.id, title: 'Q', ownerWorkerId: ada.id }, select: { id: true } });
    const releasedAt = await blockThenRelease(t.id);
    await taskStallTick(db, plus(releasedAt, 31));
    const alarm = await alarmOf(t.id, 'assignment.unassignable');
    expect(alarm.episodeStart).toEqual(releasedAt); // the inferred start: the row's releasedAt
    await recordEndedEscalations(db, plus(releasedAt, 32));
    expect(await inEffect()).toEqual([alarm.id]);
    const assignedAt = plus(releasedAt, 40);
    await db.agentTask.update({ where: { id: t.id }, data: { assigneeWorkerId: anne.id, assignedAt } });
    await event(t.id, { type: 'task.assigned', assignee: party(anne), closeSessionWhenDone: false }, new Date(assignedAt.getTime() + GAP_MS));
    await recordEndedEscalations(db, plus(releasedAt, 41));
    await endsAt(alarm, new Date(assignedAt.getTime() + GAP_MS));
  });

  it('no-progress: a release never opens the episode; a task released, then started, counts from its start', async () => {
    const t = await db.agentTask.create({
      data: { appId: app.id, title: 'T', ownerWorkerId: ada.id, assigneeWorkerId: anne.id, assignedAt: new Date() },
      select: { id: true },
    });
    const releasedAt = await blockThenRelease(t.id);
    // A started task cannot be blocked, so it is started only after the release.
    await expect(db.$executeRaw`UPDATE agent_tasks SET status = 'started', started_at = now(), blocked = true WHERE id = ${t.id}`).rejects.toThrow(/chk_started_not_blocked/);
    const startedAt = plus(releasedAt, 1);
    await db.agentTask.update({ where: { id: t.id }, data: { status: 'started', startedAt } });
    await event(t.id, { type: 'task.started' }, startedAt);
    await taskStallTick(db, plus(startedAt, 61));
    const alarm = await alarmOf(t.id, 'stall.no-progress');
    expect(alarm.episodeStart).toEqual(startedAt); // not the release
    await event(t.id, { type: 'task.progress' }, plus(startedAt, 65));
    await recordEndedEscalations(db, plus(startedAt, 66));
    await endsAt(alarm, plus(startedAt, 65));
  });
});

/** Rook's task, started at 09:00, reassigned to Anne at 10:00 (row stamp 10:00, its event 9 ms later), alarmed at 11:01. */
async function startedReassignedThenAlarmed(eventMs = GAP_MS) {
  const t = await db.agentTask.create({
    data: {
      appId: app.id, title: 'T', createdAt: at('09:00'), ownerWorkerId: ada.id, assigneeWorkerId: anne.id,
      assignedAt: at('10:00'), status: 'started', startedAt: at('09:00'),
    },
    select: { id: true },
  });
  await event(t.id, { type: 'task.assigned', assignee: party(rook), closeSessionWhenDone: false }, at('09:00', GAP_MS));
  await event(t.id, { type: 'task.started' }, at('09:00', GAP_MS));
  await event(t.id, { type: 'task.reassigned', from: party(rook), to: party(anne), closeSessionWhenDone: false }, at('10:00', eventMs));
  return t;
}

describe('#4300 (b) — a no-progress episode opened by reassigning a started task is not ended by its own task.reassigned', () => {
  it('the end is the first progress note after the alarm, not the reassignment that opened the episode', async () => {
    const t = await startedReassignedThenAlarmed();
    await tick('11:01');
    const alarm = await alarmOf(t.id, 'stall.no-progress');
    expect(alarm.episodeStart).toEqual(at('10:00')); // the inferred start: the reassignment's assignedAt
    await record('11:02');
    expect(await inEffect()).toEqual([alarm.id]);
    await note(t.id, '11:05');
    await record('11:06');
    await endsAt(alarm, at('11:05'));
  });

  it('the real reassignment path: reassignAgentTask on a started task, alarmed, then a note: the end is the note', async () => {
    const t = await db.agentTask.create({
      data: { appId: app.id, title: 'Real', ownerWorkerId: ada.id, assigneeWorkerId: rook.id, assignedAt: new Date(Date.now() - 120 * MIN), status: 'started', startedAt: new Date(Date.now() - 120 * MIN) },
      select: { id: true },
    });
    await M.reassignAgentTask({}, { taskId: t.id, assignee: { worker: anne.id } }, ctx(admin.id));
    const row = await db.agentTask.findUniqueOrThrow({ where: { id: t.id } });
    const reassigned = await db.agentTeamEvent.findFirstOrThrow({ where: { taskId: t.id, type: 'task.reassigned' } });
    expect(reassigned.createdAt.getTime()).toBeGreaterThanOrEqual(row.assignedAt!.getTime()); // the event is never before the stamp
    await taskStallTick(db, plus(row.assignedAt!, 61));
    const alarm = await alarmOf(t.id, 'stall.no-progress');
    expect(alarm.episodeStart).toEqual(row.assignedAt); // the inferred start: the reassignment's assignedAt
    await event(t.id, { type: 'task.progress' }, plus(row.assignedAt!, 65));
    await recordEndedEscalations(db, plus(row.assignedAt!, 66));
    expect((await db.alarmEscalationEnd.findUniqueOrThrow({ where: { eventId: alarm.id } })).endedAt).toEqual(plus(row.assignedAt!, 65));
  });
});

// LOCAL delta F1 on #4299 (P3, deferred here): no pin guarded the fallback of the "after" bound, where the alarm's raise
// is not later than its episode's start and the bound is the start itself, EXCLUSIVE. Each alarm row is inserted with its
// raise equal to its start, and the opening event is stamped at that same instant: widening the fallback to start - 1 ms
// would read that event as the end. A test gap, not a defect case: expected green on main for not-started.
describe('#4300 — a raise not later than the episode\'s start: the bound is the start, exclusive', () => {
  const insertAlarm = (taskId: string, type: string, start: Date) =>
    db.agentTeamEvent.create({ data: { appId: app.id, taskId, type, severity: 'alarm', episodeStart: start, createdAt: start, chain: [{ workerId: ada.id }] } });

  it('not-started: an assignment event at the very start is not the end; the start is', async () => {
    const t = await db.agentTask.create({
      data: { appId: app.id, title: 'T', createdAt: at('10:00'), ownerWorkerId: ada.id, assigneeWorkerId: anne.id, assignedAt: at('10:00') },
      select: { id: true },
    });
    await event(t.id, { type: 'task.assigned', assignee: party(anne), closeSessionWhenDone: false }, at('10:00'));
    const alarm = await insertAlarm(t.id, 'stall.not-started', at('10:00'));
    await db.agentTask.update({ where: { id: t.id }, data: { status: 'started', startedAt: at('10:17') } });
    await event(t.id, { type: 'task.started' }, at('10:17'));
    await record('10:18');
    expect(await events()).toMatchObject([{ id: alarm.id, escalationEndedAt: iso('10:17') }]);
  });

  it('no-progress: a reassignment event at the very start is not the end; the first note is', async () => {
    const t = await startedReassignedThenAlarmed(0);
    const alarm = await insertAlarm(t.id, 'stall.no-progress', at('10:00'));
    await note(t.id, '11:05');
    await record('11:06');
    expect(await events()).toMatchObject([{ id: alarm.id, escalationEndedAt: iso('11:05') }]);
  });
});
