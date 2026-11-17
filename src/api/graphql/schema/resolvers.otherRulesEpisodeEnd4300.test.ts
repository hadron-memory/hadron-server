/**
 * #4300 (cor:agt:050:13, cor:agt:050:15, cor:agt:050:17, cor:agt:050:20) — the move that opened an episode never ends it,
 * for the no-progress and couldn't-be-assigned rules too (#4298/#4299 built it for the not-started rule only).
 *
 * The opening move is written twice: as the row stamp that is the episode's start (`releasedAt`, `assignedAt`) and as an
 * event (`task.released`, `task.reassigned`) a few milliseconds later. Counted from the start alone, that event reads as
 * the first ending move, so the recorded end (`escalationEndedAt`) is the move that opened the episode and precedes the
 * alarm. Each case asserts in the pin that the episode's start is the row stamp the issue infers.
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

/**
 * Anne's started task, assigned and started at 09:00 while blocked, released at 10:00 (the row stamp; its event 9 ms
 * later). The no-progress clock counts from the release; the pass at 11:01 raises the alarm.
 */
async function startedReleasedThenAlarmed(releaseEventMs = GAP_MS) {
  const t = await db.agentTask.create({
    data: {
      appId: app.id, title: 'T', createdAt: at('09:00'), ownerWorkerId: ada.id, assigneeWorkerId: anne.id,
      assignedAt: at('09:00'), status: 'started', startedAt: at('09:00'), releasedAt: at('10:00'),
    },
    select: { id: true },
  });
  await event(t.id, { type: 'task.assigned', assignee: party(anne), closeSessionWhenDone: false }, at('09:00', GAP_MS));
  await event(t.id, { type: 'task.started' }, at('09:00', GAP_MS));
  await event(t.id, { type: 'task.released' }, at('10:00', releaseEventMs));
  return t;
}
const note = (taskId: string, hhmm: string) => event(taskId, { type: 'task.progress' }, at(hhmm));

describe('#4300 (a) — an episode opened by a release is not ended by the release\'s own event', () => {
  it('no-progress: the end is the first progress note after the alarm, not the task.released event', async () => {
    const t = await startedReleasedThenAlarmed();
    await tick('11:01');
    const alarm = await alarmOf(t.id, 'stall.no-progress');
    expect(alarm.episodeStart).toEqual(at('10:00')); // the inferred start: the row's releasedAt
    await record('11:02');
    expect(await inEffect()).toEqual([alarm.id]);
    await note(t.id, '11:05');
    await record('11:06');
    await endsAt(alarm, at('11:05'));
  });

  it('couldn\'t-be-assigned: the end is the first assignment after the alarm, not the task.released event', async () => {
    // Queued at 09:30 while blocked, released at 10:00 (row stamp; its event 9 ms later): the clock counts from 10:00.
    const t = await db.agentTask.create({
      data: { appId: app.id, title: 'Q', createdAt: at('09:30'), ownerWorkerId: ada.id, releasedAt: at('10:00') },
      select: { id: true },
    });
    await event(t.id, { type: 'task.released' }, at('10:00', GAP_MS));
    await tick('10:31');
    const alarm = await alarmOf(t.id, 'assignment.unassignable');
    expect(alarm.episodeStart).toEqual(at('10:00')); // the inferred start: the row's releasedAt
    await record('10:32');
    expect(await inEffect()).toEqual([alarm.id]);
    await db.agentTask.update({ where: { id: t.id }, data: { assigneeWorkerId: anne.id, assignedAt: at('10:40') } });
    await event(t.id, { type: 'task.assigned', assignee: party(anne), closeSessionWhenDone: false }, at('10:40', GAP_MS));
    await record('10:41');
    await endsAt(alarm, at('10:40', GAP_MS));
  });
});

describe('#4300 (b) — a no-progress episode opened by reassigning a started task is not ended by its own task.reassigned', () => {
  it('the end is the first progress note after the alarm, not the reassignment that opened the episode', async () => {
    // Rook held and started it at 09:00; at 10:00 it is reassigned to Anne (row stamp 10:00, its event 9 ms later).
    const t = await db.agentTask.create({
      data: {
        appId: app.id, title: 'T', createdAt: at('09:00'), ownerWorkerId: ada.id, assigneeWorkerId: anne.id,
        assignedAt: at('10:00'), status: 'started', startedAt: at('09:00'),
      },
      select: { id: true },
    });
    await event(t.id, { type: 'task.assigned', assignee: party(rook), closeSessionWhenDone: false }, at('09:00', GAP_MS));
    await event(t.id, { type: 'task.started' }, at('09:00', GAP_MS));
    await event(t.id, { type: 'task.reassigned', from: party(rook), to: party(anne), closeSessionWhenDone: false }, at('10:00', GAP_MS));
    await tick('11:01');
    const alarm = await alarmOf(t.id, 'stall.no-progress');
    expect(alarm.episodeStart).toEqual(at('10:00')); // the inferred start: the reassignment's assignedAt
    await record('11:02');
    expect(await inEffect()).toEqual([alarm.id]);
    await note(t.id, '11:05');
    await record('11:06');
    await endsAt(alarm, at('11:05'));
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

  it('no-progress: a release event at the very start is not the end; the first note is', async () => {
    const t = await startedReleasedThenAlarmed(0);
    const alarm = await insertAlarm(t.id, 'stall.no-progress', at('10:00'));
    await note(t.id, '11:05');
    await record('11:06');
    expect(await events()).toMatchObject([{ id: alarm.id, escalationEndedAt: iso('11:05') }]);
  });
});
