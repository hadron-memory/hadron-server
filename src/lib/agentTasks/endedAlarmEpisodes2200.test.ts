import { WORKER_SIGNATURE_DEFAULTS } from '../workerSignature.js';
/**
 * #2200 (R196) — an alarm stops escalating when its OWN episode ends.
 *
 * The escalation (`wakeDueOwners`) used to stamp every due, unacknowledged row of an alarm whether or not the
 * condition that raised it still held. Now a row whose alarm's episode is over is CLOSED (`ended_at`), never woken,
 * and the roster stops showing it as "your move" at once. "Ended" needs positive proof (three-way: unknown / the
 * task row is terminal / the episode moved on); a #2022 stop never ends an alarm; history is never rewritten.
 *
 * Same cast and controllable clock as stall.test.ts: Ada owns the root task, Anne is its assignee and owns the
 * review child Rook holds; every chain is [owner, ...parents, App manager].
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../id.js';
import { resolvers, type Context } from '../../api/graphql/schema/resolvers.js';
import { taskStallTick } from '../../jobs/taskStallEvaluator.js';
import * as stall from './stall.js';
import { stallCandidates, STALL_WINDOW_DEFAULTS, wakeDueOwners, type StallInputs } from './stall.js';
import { loadTeamRoster } from './roster.js';

const M = resolvers.Mutation as any;
const DAY = '2026-10-09';
const at = (hhmm: string): Date => new Date(`${DAY}T${hhmm.length === 5 ? `${hhmm}:00` : hhmm}Z`);
const MINUTE = 60_000;

const ctx = (userId?: string): Context => ({ db, userId, roles: ['READER'] });
const endedAlarmEpisodes = (...a: unknown[]): Promise<Set<string>> => (stall as any).endedAlarmEpisodes(...a);

let app: { id: string };
let agentId: string;
let admin: { id: string };
let mia: { id: string };
let ada: { id: string };
let anne: { id: string };
let rook: { id: string };

beforeEach(async () => {
  await cleanDb(db);
  const n = Math.floor(Math.random() * 1_000_000);
  const org = await db.organization.create({ data: { name: 'Ended', urn: `ended-${n}.example` } });
  admin = await db.user.create({ data: { githubId: 300_000 + n, githubUsername: `en-admin-${n}`, roles: ['READER'] } });
  mia = await db.user.create({ data: { githubId: 400_000 + n, githubUsername: `en-mia-${n}`, roles: ['READER'] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  const agent = await M.createAgent({}, { orgId: org.id, name: 'Team Agent' }, ctx(admin.id));
  agentId = agent.id;
  app = await db.app.create({ data: { organizationId: org.id, name: 'Team', urn: `ended-${n}.example:team` }, select: { id: true } });
  await db.appMember.create({ data: { appId: app.id, userId: mia.id, role: 'member' } });
  const worker = (name: string) =>
    db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: app.id, agentId, name, slug: name.toLowerCase(), heldByUserId: mia.id }, select: { id: true } });
  ada = await worker('Ada');
  anne = await worker('Anne');
  rook = await worker('Rook');
});

// ── Fixtures ───────────────────────────────────────────────────────────────

type TaskData = Record<string, unknown>;
const task = (data: TaskData) =>
  db.agentTask.create({ data: { appId: app.id, title: 'T', createdAt: at('09:00'), ...data }, select: { id: true } });
const assignedToAnne = (assignedAt: string, extra: TaskData = {}) =>
  task({ ownerWorkerId: ada.id, assigneeWorkerId: anne.id, assignedAt: at(assignedAt), createdAt: at(assignedAt), ...extra });
const startedByAnne = (startedAt: string, extra: TaskData = {}) =>
  assignedToAnne('09:30', { status: 'started', startedAt: at(startedAt), ...extra });
const drive = (w: { id: string }, t: string) =>
  db.session.create({ data: { id: generateId(), appId: app.id, workerId: w.id, agentId, startedAt: at(t), updatedAt: at(t) } });
const note = (taskId: string, t: string) =>
  db.agentTeamEvent.create({ data: { appId: app.id, taskId, type: 'task.progress', actorWorkerId: anne.id, createdAt: at(t) } });
const queuedEvent = (taskId: string, t: string) =>
  db.agentTeamEvent.create({ data: { appId: app.id, taskId, type: 'assignment.queued', createdAt: at(t) } });
const finish = (id: string, t: string) =>
  db.agentTask.update({ where: { id }, data: { status: 'finished', finishedAt: at(t), resultOutcome: 'succeeded' } });
const cancel = (id: string, t: string) =>
  db.agentTask.update({ where: { id }, data: { status: 'cancelled', cancelledAt: at(t) } });

const tick = (t: string) => taskStallTick(db, at(t));
const alarms = (type?: string) =>
  db.agentTeamEvent.findMany({
    where: { severity: 'alarm', ...(type ? { type } : {}) },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
const rows = (eventId: string) => db.agentTeamAlarmSchedule.findMany({ where: { eventId }, orderBy: { chainIndex: 'asc' } });
const roster = async (t: string) => new Map((await loadTeamRoster(db, app.id, at(t))).map((r) => [r.name, r]));

/** A not-started alarm on Anne's root task (assigned 10:00): chain [Ada, manager], row 1 due 10:30. */
async function notStartedAlarm() {
  const t = await assignedToAnne('10:00');
  await tick('10:15');
  const [alarm] = await alarms('stall.not-started');
  expect(await rows(alarm.id)).toHaveLength(2);
  return { t, alarm };
}

// ── 1. Each rule: its own move ends the episode ────────────────────────────

describe('#2200 — the alarm\'s own episode ends, and its due rows are closed, not woken', () => {
  it('not-started → started: the second owner is never woken; the row is closed', async () => {
    const { t, alarm } = await notStartedAlarm();
    await db.agentTask.update({ where: { id: t.id }, data: { status: 'started', startedAt: at('10:20') } });
    await tick('10:30');
    const [r0, r1] = await rows(alarm.id);
    expect(r0.wokenAt).toEqual(at('10:15'));
    expect(r1).toMatchObject({ wokenAt: null, endedAt: at('10:30') });
  });

  it('every unwoken row of an ended alarm closes together, including one not yet due', async () => {
    const root = await assignedToAnne('09:00', { status: 'started', startedAt: at('09:05') });
    await drive(anne, '10:15');
    const review = await task({ parentTaskId: root.id, ownerWorkerId: anne.id, assigneeWorkerId: rook.id, assignedAt: at('10:00') });
    await tick('10:15');
    const [alarm] = await alarms('stall.not-started');
    expect(await rows(alarm.id)).toHaveLength(3); // Anne, Ada, the App manager
    await db.agentTask.update({ where: { id: review.id }, data: { status: 'started', startedAt: at('10:20') } });
    await tick('10:30'); // row 1 is due; row 2 (10:45) is not
    const [, r1, r2] = await rows(alarm.id);
    expect(r1).toMatchObject({ wokenAt: null, endedAt: at('10:30') });
    expect(r2).toMatchObject({ wokenAt: null, endedAt: at('10:30') });
  });

  it('not-started → reassigned: the old alarm closes; the new assignment gets its own alarm, and it still wakes', async () => {
    const { t, alarm } = await notStartedAlarm();
    await db.agentTask.update({ where: { id: t.id }, data: { assigneeWorkerId: rook.id, assignedAt: at('10:20') } });
    await tick('10:30');
    expect((await rows(alarm.id))[1]).toMatchObject({ wokenAt: null, endedAt: at('10:30') });
    await tick('10:35'); // 10:20 + 15
    const fresh = (await alarms('stall.not-started')).find((a) => a.id !== alarm.id);
    expect(fresh).toMatchObject({ episodeStart: at('10:20') });
    expect((await rows(fresh!.id))[0]).toMatchObject({ wokenAt: at('10:35'), endedAt: null });
    await tick('10:50'); // the new alarm's second row, still running
    expect((await rows(fresh!.id))[1]).toMatchObject({ wokenAt: at('10:50'), endedAt: null });
  });

  it('no-progress → a still-working note moves the start: the old alarm closes', async () => {
    const t = await startedByAnne('10:00');
    await drive(anne, '10:00');
    await tick('11:00');
    const [alarm] = await alarms('stall.no-progress');
    expect(await rows(alarm.id)).toHaveLength(2);
    await note(t.id, '11:30');
    await tick('12:00'); // row 1 due (window 60)
    expect((await rows(alarm.id))[1]).toMatchObject({ wokenAt: null, endedAt: at('12:00') });
  });

  it('no-progress with the condition still holding: stamped as before', async () => {
    await startedByAnne('10:00');
    await drive(anne, '10:00');
    await tick('11:00');
    const [alarm] = await alarms('stall.no-progress');
    await tick('12:00');
    expect((await rows(alarm.id))[1]).toMatchObject({ wokenAt: at('12:00'), endedAt: null });
  });

  it('unassignable → assigned: the queue alarm closes', async () => {
    const t = await task({ ownerWorkerId: ada.id, createdAt: at('10:00') });
    await queuedEvent(t.id, '10:00');
    await tick('10:30');
    const [alarm] = await alarms('assignment.unassignable');
    await db.agentTask.update({ where: { id: t.id }, data: { assigneeWorkerId: anne.id, assignedAt: at('10:40') } });
    await tick('11:00');
    expect((await rows(alarm.id))[1]).toMatchObject({ wokenAt: null, endedAt: at('11:00') });
  });

  it('unassignable → parked to backlog (a terminal row for this purpose): closed', async () => {
    const t = await task({ ownerWorkerId: ada.id, createdAt: at('10:00') });
    await queuedEvent(t.id, '10:00');
    await tick('10:30');
    const [alarm] = await alarms('assignment.unassignable');
    await db.agentTask.update({ where: { id: t.id }, data: { status: 'backlog' } });
    await tick('11:00');
    expect((await rows(alarm.id))[1]).toMatchObject({ wokenAt: null, endedAt: at('11:00') });
  });

  it.each([['finished'], ['cancelled']] as const)('any rule, then the task is %s: closed', async (how) => {
    const { t, alarm } = await notStartedAlarm();
    if (how === 'finished') {
      await db.agentTask.update({ where: { id: t.id }, data: { status: 'started', startedAt: at('10:16') } });
      await finish(t.id, '10:20');
    } else await cancel(t.id, '10:20');
    await tick('10:30');
    expect((await rows(alarm.id))[1]).toMatchObject({ wokenAt: null, endedAt: at('10:30') });
  });

  it('control: an open task whose episode is still running stamps exactly as before', async () => {
    const { alarm } = await notStartedAlarm();
    await tick('10:30');
    expect((await rows(alarm.id))[1]).toMatchObject({ wokenAt: at('10:30'), endedAt: null });
  });
});

// ── 2. cor:agt:050:16 — keyed on the child owner's activity, not the child's status ──

describe('#2200 — 050:16 stops on the child owner\'s activity (Vera\'s pin)', () => {
  async function unreactive() {
    const parent = await assignedToAnne('09:00', { status: 'started', startedAt: at('09:10') });
    const child = await task({
      parentTaskId: parent.id, ownerWorkerId: anne.id, assigneeWorkerId: rook.id, assignedAt: at('09:20'),
      status: 'finished', startedAt: at('09:30'), finishedAt: at('10:00'), resultOutcome: 'succeeded',
    });
    await drive(anne, '09:45');
    await tick('10:20');
    const [alarm] = await alarms('stall.owner-unreactive');
    expect(await rows(alarm.id)).toHaveLength(2);
    return { parent, child, alarm };
  }

  it('the child is long finished and its owner has not moved: the alarm keeps escalating', async () => {
    const { alarm } = await unreactive();
    await tick('10:40'); // row 1 due (window 20)
    expect((await rows(alarm.id))[1]).toMatchObject({ wokenAt: at('10:40'), endedAt: null });
  });

  it('the child\'s owner acts after it ended: the alarm closes', async () => {
    const { alarm } = await unreactive();
    await drive(anne, '10:25');
    await tick('10:40');
    expect((await rows(alarm.id))[1]).toMatchObject({ wokenAt: null, endedAt: at('10:40') });
  });

  it('the parent is cancelled: the alarm closes', async () => {
    const { parent, alarm } = await unreactive();
    await cancel(parent.id, '10:30');
    await tick('10:40');
    expect((await rows(alarm.id))[1]).toMatchObject({ wokenAt: null, endedAt: at('10:40') });
  });

  it('the parent loses its assignee (reassigned to nobody via a person-less pending queue): closes', async () => {
    const { parent, alarm } = await unreactive();
    await db.agentTask.update({
      where: { id: parent.id },
      data: { status: 'pending', startedAt: null, assigneeWorkerId: null, assignedAt: null },
    });
    await tick('10:40');
    expect((await rows(alarm.id))[1]).toMatchObject({ wokenAt: null, endedAt: at('10:40') });
  });
});

// ── 3. A #2022 stop never ends an alarm ────────────────────────────────────

describe('#2200 — a stop that spans an alarm does not end it', () => {
  it('raised, then a pause covers the assignee across the next due row: the episode has not ended, so the row is not closed', async () => {
    const { alarm } = await notStartedAlarm();
    const signal = await db.teamStopSignal.create({
      data: { id: generateId(), appId: app.id, level: 'pause', scope: 'worker', targetWorkerId: anne.id, setAt: at('10:20'), setByUserId: admin.id },
    });
    await db.teamStopCoverage.create({
      data: { id: generateId(), appId: app.id, signalId: signal.id, workerId: anne.id, enteredAt: at('10:20') },
    });
    await tick('10:30'); // during the stop: the evaluator's default rules hold the clock, but the episode has not ended
    expect((await rows(alarm.id))[1]).toMatchObject({ wokenAt: at('10:30'), endedAt: null }); // escalation goes on, as before
  });
});

// ── 4. History is never rewritten ──────────────────────────────────────────

describe('#2200 — closing a row writes nothing else', () => {
  it('the alarm event, its chain, acknowledged_at, existing woken_at and the row count are unchanged', async () => {
    const { t, alarm } = await notStartedAlarm();
    const before = {
      event: await db.agentTeamEvent.findUniqueOrThrow({ where: { id: alarm.id } }),
      events: await db.agentTeamEvent.count(),
      r0: (await rows(alarm.id))[0],
    };
    await db.agentTask.update({ where: { id: t.id }, data: { status: 'started', startedAt: at('10:20') } });
    await tick('10:30');
    expect(await db.agentTeamEvent.findUniqueOrThrow({ where: { id: alarm.id } })).toEqual(before.event);
    expect(await db.agentTeamEvent.count()).toBe(before.events);
    expect((await rows(alarm.id))[0]).toEqual(before.r0);
    expect(await rows(alarm.id)).toHaveLength(2);
  });
});

// ── 5. Scale, null task, uninstalled App ───────────────────────────────────

describe('#2200 — the escalation read', () => {
  it('500+ ended rows do not hide a live due row: they close, then the live row stamps', async () => {
    const live = await notStartedAlarm();
    // 520 alarms on finished tasks, each with a due, unwoken row 1 that sorts BEFORE the live one (due 09:00).
    const N = 520;
    const taskIds = Array.from({ length: N }, () => generateId());
    await db.agentTask.createMany({
      data: taskIds.map((id) => ({
        id, appId: app.id, title: 'old', ownerWorkerId: ada.id, createdAt: at('08:00'),
        status: 'cancelled', cancelledAt: at('08:30'),
      })),
    });
    const eventIds = taskIds.map(() => generateId());
    await db.agentTeamEvent.createMany({
      data: taskIds.map((taskId, i) => ({
        id: eventIds[i], appId: app.id, taskId, type: 'stall.not-started', severity: 'alarm',
        chain: [{ workerId: ada.id }, { workerId: anne.id }], episodeStart: at('08:10'), createdAt: at('08:15'),
      })),
    });
    await db.agentTeamAlarmSchedule.createMany({
      data: eventIds.flatMap((eventId) => [
        { eventId, chainIndex: 0, dueAt: at('08:15'), wokenAt: at('08:15') },
        { eventId, chainIndex: 1, dueAt: at('08:30') },
      ]),
    });
    expect(await wakeDueOwners(db, at('10:30'))).toBe(0); // 500 closed, none woken
    expect(await db.agentTeamAlarmSchedule.count({ where: { endedAt: { not: null } } })).toBe(500);
    expect(await wakeDueOwners(db, at('10:30'))).toBe(1); // the live row (the other 20 close in the same pass)
    expect(await db.agentTeamAlarmSchedule.count({ where: { endedAt: { not: null } } })).toBe(N);
    expect((await rows(live.alarm.id))[1]).toMatchObject({ wokenAt: at('10:30'), endedAt: null });
  });

  it('an alarm without a task is not classified: stamped as before, never closed', async () => {
    const e = await db.agentTeamEvent.create({
      data: { appId: app.id, type: 'stall.not-started', severity: 'alarm', chain: [{ workerId: ada.id }, { workerId: anne.id }], createdAt: at('10:00') },
    });
    await db.agentTeamAlarmSchedule.createMany({
      data: [{ eventId: e.id, chainIndex: 0, dueAt: at('10:00'), wokenAt: at('10:00') }, { eventId: e.id, chainIndex: 1, dueAt: at('10:15') }],
    });
    await wakeDueOwners(db, at('10:20'));
    expect((await rows(e.id))[1]).toMatchObject({ wokenAt: at('10:20'), endedAt: null });
  });

  it('an uninstalled App\'s alarm is untouched by the classification: stamped, not closed', async () => {
    const { t, alarm } = await notStartedAlarm();
    await db.agentTask.update({ where: { id: t.id }, data: { status: 'started', startedAt: at('10:20') } });
    await db.app.update({ where: { id: app.id }, data: { uninstalledAt: at('10:21') } });
    await tick('10:30');
    expect((await rows(alarm.id))[1]).toMatchObject({ wokenAt: at('10:30'), endedAt: null });
  });

  it('a cancel that commits while the pass waits on the task row is seen: closed, not stamped', async () => {
    const { t, alarm } = await notStartedAlarm();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let locked!: () => void;
    const held = new Promise<void>((r) => { locked = r; });
    const holder = db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM agent_tasks WHERE id = ${t.id} FOR UPDATE`;
      await tx.agentTask.update({ where: { id: t.id }, data: { status: 'cancelled', cancelledAt: at('10:29') } });
      locked();
      await gate;
    });
    await held;
    const pass = wakeDueOwners(db, at('10:30'));
    await new Promise((r) => setTimeout(r, 300)); // the pass is now blocked behind the task row
    release();
    await holder;
    await pass;
    expect((await rows(alarm.id))[1]).toMatchObject({ wokenAt: null, endedAt: at('10:30') });
  });
});

// ── 6. The roster clears at once ───────────────────────────────────────────

describe('#2200 — the roster\'s "your move" follows the alarm\'s live episode', () => {
  it('the owner\'s YOUR_MOVE clears the moment the episode ends, with no escalation pass in between', async () => {
    const { t } = await notStartedAlarm();
    expect((await roster('10:16')).get('Ada')?.state).toBe('YOUR_MOVE');
    await db.agentTask.update({ where: { id: t.id }, data: { status: 'started', startedAt: at('10:17') } });
    const ada = (await roster('10:18')).get('Ada');
    expect(ada?.state).not.toBe('YOUR_MOVE');
  });

  it('while the episode runs it stays YOUR_MOVE', async () => {
    await notStartedAlarm();
    expect((await roster('10:20')).get('Ada')?.state).toBe('YOUR_MOVE');
  });
});

// ── 7. endedAlarmEpisodes: three-way, positive proof only ──────────────────

describe('#2200 — endedAlarmEpisodes classifies on positive proof', () => {
  it('running ⇒ not ended; moved on ⇒ ended; row-terminal ⇒ ended; unknown task ⇒ not ended', async () => {
    const { t, alarm } = await notStartedAlarm();
    const a = { taskId: t.id, type: alarm.type, episodeStart: alarm.episodeStart };
    const key = stall.alarmEpisodeKey(a.taskId, a.type, a.episodeStart as Date);
    expect((await endedAlarmEpisodes(db, [a], at('10:20'))).has(key)).toBe(false);
    await db.agentTask.update({ where: { id: t.id }, data: { status: 'started', startedAt: at('10:21') } });
    expect((await endedAlarmEpisodes(db, [a], at('10:22'))).has(key)).toBe(true);
    await cancel(t.id, '10:23');
    expect((await endedAlarmEpisodes(db, [a], at('10:24'))).has(key)).toBe(true);
    const ghost = { taskId: generateId(), type: a.type, episodeStart: a.episodeStart };
    expect((await endedAlarmEpisodes(db, [ghost], at('10:24'))).size).toBe(0);
  });

  it('a task in an uninstalled App is unknown, never ended', async () => {
    const { t, alarm } = await notStartedAlarm();
    await cancel(t.id, '10:20');
    await db.app.update({ where: { id: app.id }, data: { uninstalledAt: at('10:21') } });
    const a = { taskId: t.id, type: alarm.type, episodeStart: alarm.episodeStart };
    expect((await endedAlarmEpisodes(db, [a], at('10:30'))).size).toBe(0);
  });
});

// ── 8. Differential / property: the flagged mode and the no-resurrection walk ──

describe('#2200 — stallCandidates({ episodesRunning }) is a superset of the default and never resurrects a key', () => {
  const windows = STALL_WINDOW_DEFAULTS;
  const flagged = (i: StallInputs, now: Date) => (stallCandidates as any)(i, windows, now, { episodesRunning: true }) as ReturnType<typeof stallCandidates>;
  const keyOf = (c: { rule: string; taskId: string; episodeStart: Date }) => `${c.taskId}|${c.rule}|${c.episodeStart.getTime()}`;

  /** A small deterministic generator (mulberry32). */
  const rng = (seed: number) => () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  type World = {
    status: 'pending' | 'started';
    assignee: string | null; assignedAt: Date | null; startedAt: Date | null;
    queuedAt: Date | null; progressAt: Date | null; activityAt: Date | null;
    openChildren: number; lastChildEndedAt: Date | null;
    ended: { id: string; endedAt: Date; ownerActivityAt: Date | null }[];
    stops: { start: Date; end: Date | null }[];
    t0: Date;
  };
  const inputsOf = (w: World): StallInputs => ({
    task: {
      id: 'T', appId: 'A', status: w.status, parentTaskId: null,
      ownerWorkerId: 'owner', ownerUserId: null, assigneeWorkerId: w.assignee, assigneeUserId: null,
      startBy: null, assignedAt: w.assignedAt, startedAt: w.startedAt, createdAt: w.t0,
    },
    openChildCount: w.openChildren,
    lastChildEndedAt: w.lastChildEndedAt,
    endedChildren: w.ended.map((c) => ({ ...c, ownerWorkerId: 'kid' })),
    lastProgressAt: w.progressAt,
    assigneeActivityAt: w.activityAt,
    queuedAt: w.queuedAt,
    stopIntervals: new Map(w.assignee ? [[w.assignee, w.stops]] : []),
    stopHolds: [],
  });

  it('(a)(b) over a matrix: default candidates ⊆ flagged, with the same episode start; flagged ignores stops and due time', () => {
    const now = at('12:00');
    const base: World = {
      status: 'pending', assignee: 'w1', assignedAt: at('11:50'), startedAt: null, queuedAt: null, progressAt: null,
      activityAt: null, openChildren: 0, lastChildEndedAt: null, ended: [], stops: [], t0: at('09:00'),
    };
    const worlds: World[] = [];
    for (const status of ['pending', 'started'] as const)
      for (const assignee of ['w1', null])
        for (const stop of [false, true])
          for (const age of [5, 30, 120])
            for (const kids of [0, 1])
              worlds.push({
                ...base, status, assignee,
                assignedAt: assignee ? new Date(now.getTime() - age * MINUTE) : null,
                startedAt: status === 'started' ? new Date(now.getTime() - age * MINUTE) : null,
                queuedAt: assignee ? null : new Date(now.getTime() - age * MINUTE),
                openChildren: kids,
                ended: kids ? [{ id: 'c1', endedAt: new Date(now.getTime() - age * MINUTE), ownerActivityAt: null }] : [],
                stops: stop ? [{ start: new Date(now.getTime() - 3 * MINUTE), end: null }] : [],
              });
    expect(worlds.length).toBeGreaterThan(40);
    let sawDefault = false;
    let sawFlaggedOnly = false;
    for (const w of worlds) {
      const i = inputsOf(w);
      const d = new Map(stallCandidates(i, windows, now).map((c) => [keyOf(c), c]));
      const f = new Map(flagged(i, now).map((c) => [keyOf(c), c]));
      for (const [k, c] of d) {
        sawDefault = true;
        expect(f.has(k), `default ${k} must be in flagged`).toBe(true);
        expect(f.get(k)!.episodeStart).toEqual(c.episodeStart);
      }
      for (const k of f.keys()) if (!d.has(k)) sawFlaggedOnly = true;
    }
    expect(sawDefault).toBe(true);
    expect(sawFlaggedOnly).toBe(true); // young episodes and stops are what the flag lifts
  });

  it('(c) a bounded random walk: once a key stops running it never runs again', () => {
    for (let seed = 1; seed <= 300; seed++) {
      const r = rng(seed);
      let clock = at('09:00').getTime();
      const tick = () => { clock += Math.floor(r() * 40) * MINUTE + MINUTE; return new Date(clock); };
      const w: World = {
        status: 'pending', assignee: null, assignedAt: null, startedAt: null, queuedAt: new Date(clock), progressAt: null,
        activityAt: null, openChildren: 0, lastChildEndedAt: null, ended: [], stops: [], t0: new Date(clock),
      };
      const running = new Set<string>();
      const dead = new Set<string>();
      let kid = 0;
      for (let step = 0; step < 40; step++) {
        const now = tick();
        const op = Math.floor(r() * 9);
        if (op === 0 && w.status === 'pending') { w.assignee = r() < 0.5 ? 'w1' : 'w2'; w.assignedAt = now; w.queuedAt = null; }
        else if (op === 1 && w.status === 'pending' && w.assignee) { w.status = 'started'; w.startedAt = now; }
        else if (op === 2 && w.status === 'started') w.progressAt = now;
        else if (op === 3 && w.assignee) w.activityAt = now;
        else if (op === 4 && w.status === 'started') { w.openChildren++; }
        else if (op === 5 && w.openChildren > 0) { w.openChildren--; w.lastChildEndedAt = now; w.ended.push({ id: `k${kid++}`, endedAt: now, ownerActivityAt: null }); }
        else if (op === 6) { for (const c of w.ended) c.ownerActivityAt = now; }
        else if (op === 7 && w.assignee) w.stops = [...w.stops, { start: now, end: r() < 0.5 ? null : new Date(now.getTime() + 5 * MINUTE) }];
        else if (op === 8 && w.assignee && w.status === 'started') { w.assignee = w.assignee === 'w1' ? 'w2' : 'w1'; w.assignedAt = now; }
        const now2 = new Date(now.getTime() + MINUTE);
        const keys = new Set(flagged(inputsOf(w), now2).map(keyOf));
        const defaults = stallCandidates(inputsOf(w), windows, now2).map(keyOf);
        for (const k of defaults) expect(keys.has(k), `seed ${seed} step ${step}: default ${k} ⊆ flagged`).toBe(true);
        for (const k of keys) expect(dead.has(k), `seed ${seed} step ${step}: ${k} resurrected`).toBe(false);
        for (const k of running) if (!keys.has(k)) dead.add(k);
        running.clear();
        for (const k of keys) running.add(k);
      }
    }
  });
});
