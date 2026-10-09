/**
 * #1706 (Task Management T2) — the stall evaluator, the alarm chain and its
 * escalation, acknowledgement, and the stall mark on availability.
 *
 * Every Scenario of cor:agt:050:13–:20 and cor:agt:060:07, against a
 * CONTROLLABLE clock: tasks, sessions and notes are written with explicit
 * timestamps around 10:00 on one day, and each pass is `taskStallTick(db, at)`.
 * Session activity is real session rows, read through the one derivation the
 * roster uses, never a stub.
 *
 * Cast (the specs' own): Ada owns the root task; Anne is its assignee and owns
 * the review child Rook is assigned; Liam owns nothing in the chain. A person,
 * `mia`, is an App member who owns or holds tasks where a scenario needs a
 * person.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GraphQLError } from 'graphql';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../id.js';
import { runAsActor } from '../requestActor.js';
import { resolvers, type Context } from '../../api/graphql/schema/resolvers.js';
import { taskStallTick } from '../../jobs/taskStallEvaluator.js';
import { evaluateStalls, wakeDueOwners } from './stall.js';
import { loadAvailableForWork } from './availability.js';

vi.mock('../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

const M = resolvers.Mutation as any;
const Q = resolvers.Query as any;

const DAY = '2026-10-09';
/** `at('10:15')` — a moment on the scenario day, UTC; seconds and ms allowed (`'10:14:59.999'`). */
const at = (hhmm: string): Date => new Date(`${DAY}T${hhmm.length === 5 ? `${hhmm}:00` : hhmm}Z`);
const MINUTE = 60_000;

function ctx(userId?: string): Context {
  return { db, userId, roles: ['READER'] };
}

async function expectCode(p: Promise<unknown>, code: string) {
  try {
    await p;
    expect.fail(`expected rejection with extensions.code=${code}`);
  } catch (e) {
    expect(e).toBeInstanceOf(GraphQLError);
    expect((e as GraphQLError).extensions?.code).toBe(code);
  }
}

let app: { id: string };
let agentId: string;
let admin: { id: string };
let mia: { id: string };
let outsider: { id: string };
let ada: { id: string };
let anne: { id: string };
let rook: { id: string };
let liam: { id: string };

const asWorker = (w: { id: string }, fn: () => Promise<any>): Promise<any> =>
  runAsActor({ workerId: w.id, agentId }, fn);

beforeEach(async () => {
  await cleanDb(db);
  const n = Math.floor(Math.random() * 1_000_000);
  const org = await db.organization.create({ data: { name: 'Stall', urn: `stall-${n}.example` } });
  admin = await db.user.create({ data: { githubId: 300_000 + n, githubUsername: `st-admin-${n}`, roles: ['READER'] } });
  mia = await db.user.create({ data: { githubId: 400_000 + n, githubUsername: `st-mia-${n}`, roles: ['READER'] } });
  outsider = await db.user.create({ data: { githubId: 500_000 + n, githubUsername: `st-out-${n}`, roles: ['READER'] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  const agent = await M.createAgent({}, { orgId: org.id, name: 'Team Agent' }, ctx(admin.id));
  agentId = agent.id;
  app = await db.app.create({ data: { organizationId: org.id, name: 'Team', urn: `stall-${n}.example:team` }, select: { id: true } });
  await db.appMember.create({ data: { appId: app.id, userId: mia.id, role: 'member' } });
  const worker = (name: string) =>
    db.worker.create({ data: { appId: app.id, agentId, name, slug: name.toLowerCase(), heldByUserId: mia.id }, select: { id: true } });
  ada = await worker('Ada');
  anne = await worker('Anne');
  rook = await worker('Rook');
  liam = await worker('Liam');
});

// ── Fixtures with explicit times ──────────────────────────────────────────

type TaskData = Record<string, unknown>;

/** A task row written directly, so every timestamp is the scenario's. */
async function task(data: TaskData) {
  return db.agentTask.create({
    data: { appId: app.id, title: 'T', createdAt: at('09:00'), ...data },
    select: { id: true },
  });
}

/** Anne's assigned task, owned by Ada, assigned at `assignedAt`. */
const assignedToAnne = (assignedAt: string, extra: TaskData = {}) =>
  task({ ownerWorkerId: ada.id, assigneeWorkerId: anne.id, assignedAt: at(assignedAt), createdAt: at(assignedAt), ...extra });

/** Anne's started task, owned by Ada. */
const startedByAnne = (startedAt: string, extra: TaskData = {}) =>
  assignedToAnne('09:30', { status: 'started', startedAt: at(startedAt), ...extra });

/** A Hadron call by `w` through its worker session at `t` (cor:agt:050:12). */
async function drive(w: { id: string }, t: string) {
  await db.session.create({
    data: { id: generateId(), appId: app.id, workerId: w.id, agentId, startedAt: at(t), updatedAt: at(t) },
  });
}

/** A still-working note on the task at `t` (a `task.progress` event, cor:agt:050:12). */
async function note(taskId: string, t: string, by: { id: string } = anne) {
  await db.agentTeamEvent.create({
    data: { appId: app.id, taskId, type: 'task.progress', actorWorkerId: by.id, createdAt: at(t) },
  });
}

const tick = (t: string) => taskStallTick(db, at(t));
const alarms = (type?: string) =>
  db.agentTeamEvent.findMany({
    where: { severity: 'alarm', ...(type ? { type } : {}) },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
const wakes = (eventId: string) => db.alarmWake.findMany({ where: { eventId }, orderBy: { chainIndex: 'asc' } });

// ── cor:agt:050:14 — not started ──────────────────────────────────────────

describe('cor:agt:050:14 — a task not started in time raises an alarm', () => {
  it('S1: assigned at 10:00 with no start-by time, still pending at 10:15 → one not-started alarm', async () => {
    const t = await assignedToAnne('10:00');
    await tick('10:14:59.999');
    expect(await alarms()).toEqual([]);
    await tick('10:15');
    const [a, ...rest] = await alarms();
    expect(rest).toEqual([]);
    expect(a).toMatchObject({
      type: 'stall.not-started', taskId: t.id, severity: 'alarm', subjectWorkerId: anne.id,
      episodeStart: at('10:00'), createdAt: at('10:15'), chain: [{ workerId: ada.id }],
      payload: { windowMinutes: 15, assignee: { workerId: anne.id } },
      acknowledgedAt: null,
    });
  });

  it('S2: started at 10:10 → no alarm at 10:15', async () => {
    await assignedToAnne('10:00', { status: 'started', startedAt: at('10:10') });
    await drive(anne, '10:10');
    await tick('10:15');
    expect(await alarms()).toEqual([]);
  });

  it('S3: activity (a Hadron call) at 10:14 without starting does not stop it', async () => {
    await assignedToAnne('10:00');
    await drive(anne, '10:14');
    await tick('10:15');
    expect((await alarms()).map((a) => a.type)).toEqual(['stall.not-started']);
  });

  it('an explicit start-by later than the assignment is the deadline', async () => {
    await assignedToAnne('10:00', { startBy: at('10:40') });
    await tick('10:39');
    expect(await alarms()).toEqual([]);
    await tick('10:40');
    expect((await alarms()).map((a) => a.type)).toEqual(['stall.not-started']);
  });

  it('a reassignment ends the episode; the new assignee gets a fresh window, even past start-by (interim)', async () => {
    const t = await assignedToAnne('10:00', { startBy: at('10:10') });
    await tick('10:10');
    expect(await alarms()).toHaveLength(1);
    await tick('11:00'); // S of 050:13: still pending an hour on, same episode, no second alarm
    expect(await alarms()).toHaveLength(1);
    await db.agentTask.update({ where: { id: t.id }, data: { assigneeWorkerId: liam.id, assignedAt: at('11:05') } });
    await tick('11:19');
    expect(await alarms()).toHaveLength(1);
    await tick('11:20');
    const second = (await alarms())[1];
    expect(second).toMatchObject({ type: 'stall.not-started', episodeStart: at('11:05'), subjectWorkerId: liam.id });
  });

  it('a queued task raises no not-started alarm (050:17 covers it)', async () => {
    await task({ ownerWorkerId: ada.id, createdAt: at('10:00') });
    await tick('10:20');
    expect(await alarms()).toEqual([]);
  });

  it('a person assignee is alarmed too, and is never marked unavailable', async () => {
    await task({ ownerWorkerId: ada.id, assigneeUserId: mia.id, assignedAt: at('10:00'), createdAt: at('10:00') });
    await tick('10:15');
    expect((await alarms()).map((a) => [a.type, a.subjectWorkerId])).toEqual([['stall.not-started', null]]);
    expect(await db.workerAvailability.count()).toBe(0);
  });
});

// ── cor:agt:050:15 — no progress ──────────────────────────────────────────

describe('cor:agt:050:15 — a started task with no progress raises an alarm', () => {
  it('S1: started, no open children, last activity 10:00 → alarm at 11:00', async () => {
    const t = await startedByAnne('10:00');
    await drive(anne, '10:00');
    await tick('10:59:59.999');
    expect(await alarms()).toEqual([]);
    await tick('11:00');
    expect(await alarms()).toEqual([
      expect.objectContaining({ type: 'stall.no-progress', taskId: t.id, episodeStart: at('10:00'), subjectWorkerId: anne.id }),
    ]);
  });

  it('S2: a still-working note at 10:50 → no alarm at 11:00; the window restarts from the note', async () => {
    const t = await startedByAnne('10:00');
    await note(t.id, '10:50');
    await tick('11:00');
    expect(await alarms()).toEqual([]);
    await tick('11:50');
    expect(await alarms()).toEqual([expect.objectContaining({ type: 'stall.no-progress', episodeStart: at('10:50') })]);
  });

  it('any Hadron call through the session counts, about this task or not (050:12)', async () => {
    await startedByAnne('10:00');
    await drive(anne, '10:45');
    await tick('11:00');
    expect(await alarms()).toEqual([]);
  });

  it('S3: a teammate reading the task (their own activity) does not reset it', async () => {
    const t = await startedByAnne('10:00');
    await drive(liam, '10:30');
    await Q.agentTask({}, { id: t.id }, ctx(mia.id)); // a person reading it
    await tick('11:00');
    expect((await alarms()).map((a) => a.type)).toEqual(['stall.no-progress']);
  });

  it('a task waiting on children does not alarm', async () => {
    const t = await startedByAnne('10:00');
    await task({ parentTaskId: t.id, ownerWorkerId: anne.id, assigneeWorkerId: rook.id, assignedAt: at('10:05'), status: 'started', startedAt: at('10:06') });
    await drive(rook, '11:30');
    await tick('12:00');
    expect((await alarms()).filter((a) => a.taskId === t.id)).toEqual([]);
  });

  it('edge case: the window counts from when the last open child ended', async () => {
    const t = await startedByAnne('10:00');
    await task({
      parentTaskId: t.id, ownerWorkerId: anne.id, assigneeWorkerId: rook.id, assignedAt: at('10:05'),
      status: 'cancelled', cancelledAt: at('10:40'),
    });
    await tick('11:00');
    expect(await alarms()).toEqual([]);
    await tick('11:40');
    expect(await alarms()).toEqual([expect.objectContaining({ type: 'stall.no-progress', taskId: t.id, episodeStart: at('10:40') })]);
  });

  it('edge case: reassigned while started, the window counts from the reassignment', async () => {
    const t = await startedByAnne('10:00');
    await db.agentTask.update({ where: { id: t.id }, data: { assigneeWorkerId: liam.id, assignedAt: at('10:30') } });
    await tick('11:00');
    expect(await alarms()).toEqual([]);
    await tick('11:30');
    expect(await alarms()).toEqual([
      expect.objectContaining({ type: 'stall.no-progress', episodeStart: at('10:30'), subjectWorkerId: liam.id }),
    ]);
  });
});

// ── cor:agt:050:16 — owner didn't react ───────────────────────────────────

describe('cor:agt:050:16 r2 — an owner who doesn\'t react to a finished child raises an alarm', () => {
  /** Ada's task P, assigned to Anne and started; Rook's review child of it, owned by Anne, finished at `finished`. */
  async function reviewFinished(finished: string, childStatus: 'finished' | 'cancelled' = 'finished') {
    const parent = await assignedToAnne('09:00', { status: 'started', startedAt: at('09:10') });
    const child = await task({
      parentTaskId: parent.id, ownerWorkerId: anne.id, assigneeWorkerId: rook.id, assignedAt: at('09:20'),
      status: childStatus, startedAt: at('09:30'),
      ...(childStatus === 'finished'
        ? { finishedAt: at(finished), resultOutcome: 'succeeded' }
        : { cancelledAt: at(finished) }),
    });
    return { parent, child };
  }

  it('S1: Rook finishes Anne\'s review at 10:00, Anne silent → at 10:20 the alarm is about the parent and goes to Ada', async () => {
    const { parent, child } = await reviewFinished('10:00');
    await drive(anne, '09:45');
    await tick('10:19');
    expect(await alarms('stall.owner-unreactive')).toEqual([]);
    await tick('10:20');
    expect(await alarms('stall.owner-unreactive')).toEqual([expect.objectContaining({
      taskId: parent.id, episodeStart: at('10:00'), subjectWorkerId: anne.id,
      chain: [{ workerId: ada.id }], payload: { windowMinutes: 20, assignee: { workerId: anne.id }, childTaskId: child.id },
    })]);
    const [w] = await wakes((await alarms('stall.owner-unreactive'))[0].id);
    expect(w).toMatchObject({ chainIndex: 0, wokenAt: at('10:20') });
  });

  it('S2: Anne makes a Hadron call at 10:05 → no alarm at 10:20', async () => {
    await reviewFinished('10:00');
    await drive(anne, '10:05');
    await tick('10:20');
    expect(await alarms('stall.owner-unreactive')).toEqual([]);
  });

  it('S3: activity at 09:59, before the child finished, does not count', async () => {
    await reviewFinished('10:00');
    await drive(anne, '09:59');
    await tick('10:20');
    expect(await alarms('stall.owner-unreactive')).toHaveLength(1);
  });

  it('a second child finishing in the same silence is the same episode: one alarm', async () => {
    const { parent } = await reviewFinished('10:00');
    await task({
      parentTaskId: parent.id, ownerWorkerId: anne.id, assigneeWorkerId: liam.id, assignedAt: at('09:20'),
      status: 'finished', startedAt: at('09:30'), finishedAt: at('10:10'), resultOutcome: 'succeeded',
    });
    await tick('10:20');
    await tick('10:30');
    expect((await alarms('stall.owner-unreactive')).map((a) => a.episodeStart)).toEqual([at('10:00')]);
  });

  it('interim: a cancelled child starts no window (only a finished one, as decided)', async () => {
    await reviewFinished('10:00', 'cancelled');
    await tick('10:30');
    expect(await alarms('stall.owner-unreactive')).toEqual([]);
  });

  it('interim: no alarm when the parent has already ended', async () => {
    const { parent } = await reviewFinished('10:00');
    await db.agentTask.update({ where: { id: parent.id }, data: { status: 'cancelled', cancelledAt: at('10:01') } });
    await tick('10:30');
    expect(await alarms()).toEqual([]);
  });

  it('a person as the parent\'s assignee: only a move on the parent stops it (interim)', async () => {
    const parent = await task({ ownerWorkerId: ada.id, assigneeUserId: mia.id, assignedAt: at('09:00'), status: 'started', startedAt: at('09:10') });
    await task({
      parentTaskId: parent.id, ownerUserId: mia.id, assigneeWorkerId: rook.id, assignedAt: at('09:20'),
      status: 'finished', startedAt: at('09:30'), finishedAt: at('10:00'), resultOutcome: 'succeeded',
    });
    await tick('10:20');
    expect(await alarms('stall.owner-unreactive')).toEqual([expect.objectContaining({ taskId: parent.id, subjectWorkerId: null })]);
  });
});

// ── cor:agt:050:17 — couldn't be assigned ─────────────────────────────────

describe('cor:agt:050:17 — a task nobody could be assigned raises an alarm', () => {
  it('S1: queued at 10:00 → alarm at 10:30, to its owner chain, about no worker', async () => {
    const t = await task({ ownerWorkerId: ada.id, createdAt: at('10:00') });
    await tick('10:29');
    expect(await alarms()).toEqual([]);
    await tick('10:30');
    expect(await alarms()).toEqual([expect.objectContaining({
      type: 'assignment.unassignable', taskId: t.id, episodeStart: at('10:00'), subjectWorkerId: null,
      chain: [{ workerId: ada.id }], payload: { windowMinutes: 30 },
    })]);
  });

  it('S2: assigned at 10:20 → no alarm at 10:30', async () => {
    const t = await task({ ownerUserId: mia.id, createdAt: at('10:00') });
    await db.agentTask.update({ where: { id: t.id }, data: { assigneeWorkerId: anne.id, assignedAt: at('10:20') } });
    await tick('10:30');
    expect(await alarms()).toEqual([]);
  });

  it('S3: a person outside the App cannot cancel it to silence it; the alarm is raised', async () => {
    const t = await task({ ownerUserId: mia.id, createdAt: at('10:00') });
    await expectCode(M.cancelAgentTask({}, { taskId: t.id }, ctx(outsider.id)), 'TASK_NOT_FOUND');
    await tick('10:30');
    expect((await alarms()).map((a) => a.type)).toEqual(['assignment.unassignable']);
  });
});

// ── cor:agt:050:13 — episodes ─────────────────────────────────────────────

describe('cor:agt:050:13 — exactly one alarm per stall episode', () => {
  it('a re-run of the same pass is a no-op', async () => {
    await assignedToAnne('10:00');
    expect((await tick('10:15')).raised).toBe(1);
    expect(await tick('10:15')).toEqual({ raised: 0, woken: 0, cleared: 0 });
    expect(await alarms()).toHaveLength(1);
  });

  it('two concurrent passes write exactly one alarm per episode, one wake set, one stall mark', async () => {
    for (let i = 0; i < 5; i += 1) {
      await task({ ownerWorkerId: ada.id, assigneeWorkerId: anne.id, assignedAt: at('10:00'), createdAt: at('10:00') });
    }
    const results = await Promise.all([evaluateStalls(db, at('10:15')), evaluateStalls(db, at('10:15'))]);
    expect(results[0].length + results[1].length).toBe(5);
    expect(await alarms()).toHaveLength(5);
    expect(await db.alarmWake.count()).toBe(5);
    expect(await db.agentTeamEvent.count({ where: { type: 'availability.changed' } })).toBe(1);
  });

  it('the key is the move that began the episode, not the evaluator clock: later passes agree', async () => {
    await assignedToAnne('10:00');
    await tick('10:15');
    await tick('10:16');
    await tick('12:00');
    expect((await alarms()).map((a) => a.episodeStart)).toEqual([at('10:00')]);
  });

  it('a move ends the episode, and the condition holding again is a new one', async () => {
    const t = await startedByAnne('10:00');
    await tick('11:00');
    await note(t.id, '11:10');
    await tick('12:09');
    expect(await alarms()).toHaveLength(1);
    await tick('12:10');
    expect((await alarms()).map((a) => a.episodeStart)).toEqual([at('10:00'), at('11:10')]);
  });

  it('the database refuses a second alarm for one episode (the unique key, not a read)', async () => {
    const t = await assignedToAnne('10:00');
    const row = {
      appId: app.id, taskId: t.id, type: 'stall.not-started', severity: 'alarm',
      chain: [{ workerId: ada.id }], episodeStart: at('10:00'),
    };
    await db.agentTeamEvent.create({ data: row });
    await expect(db.agentTeamEvent.create({ data: row })).rejects.toThrow(/agent_team_events_episode_uniq|Unique constraint/);
  });
});

// ── cor:agt:050:18 / :19 — the chain and escalation ──────────────────────

describe('cor:agt:050:18 / :19 — every owner up the chain sees it; only the nearest is woken first', () => {
  /** Rook's review, owned by Anne, under Ada's task: stalls not-started at 10:15. */
  async function stalledReview() {
    const root = await assignedToAnne('09:00', { status: 'started', startedAt: at('09:05') });
    await drive(anne, '10:15');
    const review = await task({ parentTaskId: root.id, ownerWorkerId: anne.id, assigneeWorkerId: rook.id, assignedAt: at('10:00') });
    await tick('10:15');
    const [alarm] = await alarms('stall.not-started');
    return { root, review, alarm };
  }

  it('050:18 S1: both Anne and Ada are in the chain, nearest first', async () => {
    const { review, alarm } = await stalledReview();
    expect(alarm).toMatchObject({ taskId: review.id, chain: [{ workerId: anne.id }, { workerId: ada.id }] });
  });

  it('050:18 S2: Liam, owning nothing in the chain, reads the alarm only as any reader of the events', async () => {
    const { alarm } = await stalledReview();
    const seen = await asWorker(liam, () => Q.agentTeamEvents({}, { appRef: app.id, alarmsOnly: true }, ctx(mia.id)));
    expect(seen.map((e: { id: string }) => e.id)).toEqual([alarm.id]);
    expect(alarm.chain).not.toContainEqual({ workerId: liam.id });
  });

  it('an owner appearing twice in the chain is kept once, at the nearest position', async () => {
    const root = await task({ ownerWorkerId: ada.id, assigneeWorkerId: anne.id, assignedAt: at('09:00'), status: 'started', startedAt: at('09:05') });
    await drive(anne, '10:15');
    const mid = await task({ parentTaskId: root.id, ownerWorkerId: anne.id, assigneeWorkerId: ada.id, assignedAt: at('09:10'), status: 'started', startedAt: at('09:11') });
    await drive(ada, '10:15');
    await task({ parentTaskId: mid.id, ownerWorkerId: ada.id, assigneeWorkerId: rook.id, assignedAt: at('10:00') });
    await tick('10:15');
    const [a] = await alarms('stall.not-started');
    expect(a.chain).toEqual([{ workerId: ada.id }, { workerId: anne.id }]);
  });

  it('050:19 S1–S3: Anne is woken at once; Ada not before the window passes again, then she is', async () => {
    const { alarm } = await stalledReview();
    expect(await wakes(alarm.id)).toEqual([
      expect.objectContaining({ chainIndex: 0, dueAt: at('10:15'), wokenAt: at('10:15') }),
      expect.objectContaining({ chainIndex: 1, dueAt: at('10:30'), wokenAt: null }),
    ]);
    await tick('10:29:59.999'); // S3: Ada may read it, but is not woken
    expect((await wakes(alarm.id))[1].wokenAt).toBeNull();
    await tick('10:30'); // S2
    expect((await wakes(alarm.id))[1].wokenAt).toEqual(at('10:30'));
  });

  it('the root task\'s owner ends the chain (interim: nobody beyond is woken)', async () => {
    const t = await assignedToAnne('10:00');
    await tick('10:15');
    const [a] = await alarms();
    expect(a.taskId).toBe(t.id);
    expect(await wakes(a.id)).toHaveLength(1);
  });
});

// ── cor:agt:050:20 — acknowledgement ──────────────────────────────────────

describe('cor:agt:050:20 — acknowledging an alarm stops its escalation', () => {
  async function stalledReview() {
    const root = await assignedToAnne('09:00', { status: 'started', startedAt: at('09:05') });
    await drive(anne, '10:15');
    const review = await task({ parentTaskId: root.id, ownerWorkerId: anne.id, assigneeWorkerId: rook.id, assignedAt: at('10:00') });
    await tick('10:15');
    const [alarm] = await alarms('stall.not-started');
    return { review, alarm };
  }
  const ack = (as: { id: string }, eventId: string) =>
    asWorker(as, () => M.acknowledgeAlarm({}, { eventId }, ctx(mia.id)));

  it('S1: Anne acknowledges → Ada is never woken, now or later (escalation resumes for nobody above)', async () => {
    const { alarm } = await stalledReview();
    const before = Date.now();
    const acked = await ack(anne, alarm.id);
    expect(acked).toMatchObject({ id: alarm.id, acknowledgedByWorkerId: anne.id, acknowledgedByUserId: mia.id });
    // Stamped with the server's clock (Rook P3-2): there is no client time to pass.
    expect(acked.acknowledgedAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(acked.acknowledgedAt.getTime()).toBeLessThanOrEqual(Date.now());
    for (const t of ['10:30', '10:45', '12:00']) await tick(t);
    expect((await wakes(alarm.id))[1].wokenAt).toBeNull();
  });

  it('S2: after an acknowledgement the episode continues until the task moves (no new alarm, no end)', async () => {
    const { review, alarm } = await stalledReview();
    await ack(anne, alarm.id);
    await tick('11:00');
    expect(await alarms('stall.not-started')).toHaveLength(1);
    expect((await db.agentTask.findUniqueOrThrow({ where: { id: review.id } })).status).toBe('pending');
  });

  it('S3: Liam, not in the chain, is refused; so is the person driving an owner when acting as themselves', async () => {
    const { alarm } = await stalledReview();
    await expectCode(ack(liam, alarm.id), 'ALARM_NOT_IN_CHAIN');
    await expectCode(M.acknowledgeAlarm({}, { eventId: alarm.id }, ctx(mia.id)), 'ALARM_NOT_IN_CHAIN');
    expect((await db.agentTeamEvent.findUniqueOrThrow({ where: { id: alarm.id } })).acknowledgedAt).toBeNull();
  });

  it('any owner up the chain may acknowledge — Ada, further up', async () => {
    const { alarm } = await stalledReview();
    await expect(ack(ada, alarm.id)).resolves.toMatchObject({ acknowledgedByWorkerId: ada.id });
  });

  it('edge case: a second acknowledgement is refused and the first stands', async () => {
    const { alarm } = await stalledReview();
    const first = await ack(anne, alarm.id);
    await expectCode(ack(ada, alarm.id), 'ALARM_ALREADY_ACKNOWLEDGED');
    expect(await db.agentTeamEvent.findUniqueOrThrow({ where: { id: alarm.id } })).toMatchObject({
      acknowledgedByWorkerId: anne.id, acknowledgedAt: first.acknowledgedAt,
    });
  });

  it('a person owner in the chain acknowledges as themselves', async () => {
    await task({ ownerUserId: mia.id, assigneeWorkerId: anne.id, assignedAt: at('10:00'), createdAt: at('10:00') });
    await tick('10:15');
    const [a] = await alarms();
    await expect(M.acknowledgeAlarm({}, { eventId: a.id }, ctx(mia.id))).resolves.toMatchObject({
      acknowledgedByUserId: mia.id, acknowledgedByWorkerId: null,
    });
  });

  it('an ordinary event is not an alarm; an alarm of an App you do not participate in reads as missing', async () => {
    const { review, alarm } = await stalledReview();
    const ordinary = await db.agentTeamEvent.create({ data: { appId: app.id, taskId: review.id, type: 'task.started' } });
    await expectCode(ack(anne, ordinary.id), 'NOT_AN_ALARM');
    await expectCode(M.acknowledgeAlarm({}, { eventId: alarm.id }, ctx(outsider.id)), 'ALARM_NOT_FOUND');
    await expectCode(M.acknowledgeAlarm({}, { eventId: generateId() }, ctx(mia.id)), 'ALARM_NOT_FOUND');
  });

  it('an acknowledgement that commits while the escalation waits on the alarm wakes nobody (FOR SHARE vs FOR UPDATE)', async () => {
    const { alarm } = await stalledReview();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let locked!: () => void;
    const holding = new Promise<void>((r) => { locked = r; });
    // The acknowledging transaction, held open after taking its lock.
    const held = db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM agent_team_events WHERE id = ${alarm.id} FOR UPDATE`;
      locked();
      await gate;
      await tx.agentTeamEvent.update({
        where: { id: alarm.id },
        data: { acknowledgedAt: new Date(), acknowledgedByWorkerId: anne.id },
      });
    }, { timeout: 20_000 });
    await holding;
    const woken = wakeDueOwners(db, at('10:30'));
    // Wait until the escalation is blocked on the alarm's row lock.
    for (let i = 0; i < 200; i += 1) {
      const [{ n }] = await db.$queryRaw<{ n: number }[]>`
        SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%FOR SHARE OF e%'`;
      if (n > 0) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    release();
    await held;
    expect(await woken).toBe(0);
    expect((await wakes(alarm.id))[1].wokenAt).toBeNull();
  });
});

// ── cor:agt:060:07 — a stall makes the assignee unavailable ───────────────

describe('cor:agt:060:07 — a stall makes the assignee unavailable until it acts again', () => {
  it('S1: a no-progress alarm on Anne makes her unavailable, reason stalled, set by the stall rule', async () => {
    await startedByAnne('10:00');
    await tick('11:00');
    const [a] = await alarms();
    expect(await db.workerAvailability.findUnique({ where: { workerId: anne.id } })).toMatchObject({
      state: 'unavailable', reason: 'stalled', setBy: 'stall-rule', setAt: at('11:00'), until: null,
    });
    expect(await db.agentTeamEvent.findMany({ where: { type: 'availability.changed' } })).toEqual([
      expect.objectContaining({ subjectWorkerId: anne.id, payload: expect.objectContaining({ state: 'unavailable', reason: 'stalled', setBy: 'stall-rule', alarmEventId: a.id }) }),
    ]);
    expect((await loadAvailableForWork(db, [{ id: anne.id, appId: app.id, family: null }], at('11:01'))).get(anne.id)).toBe(false);
  });

  it('S2: her next Hadron call makes her available again — at once for the predicate, then recorded', async () => {
    await startedByAnne('10:00');
    await tick('11:00');
    await drive(anne, '11:05');
    expect((await loadAvailableForWork(db, [{ id: anne.id, appId: app.id, family: null }], at('11:06'))).get(anne.id)).toBe(true);
    expect((await tick('11:06')).cleared).toBe(1);
    expect(await db.workerAvailability.findUnique({ where: { workerId: anne.id } })).toMatchObject({
      state: 'available', reason: null, setBy: 'stall-rule', setAt: at('11:06'),
    });
    expect((await db.agentTeamEvent.findMany({ where: { type: 'availability.changed' }, orderBy: { createdAt: 'asc' } }))
      .map((e) => (e.payload as { state: string }).state)).toEqual(['unavailable', 'available']);
    expect((await tick('11:07')).cleared).toBe(0);
  });

  it('a not-started alarm marks too; owner-unreactive and unassignable mark nobody (interim)', async () => {
    await assignedToAnne('10:00');
    await task({ ownerWorkerId: ada.id, createdAt: at('09:00') });
    await tick('10:15');
    expect((await alarms()).map((a) => a.type).sort()).toEqual(['assignment.unassignable', 'stall.not-started']);
    expect((await db.workerAvailability.findMany()).map((r) => r.workerId)).toEqual([anne.id]);
  });

  it('a stall never overwrites a mark in effect for another reason', async () => {
    await db.workerAvailability.create({
      data: { workerId: anne.id, state: 'unavailable', reason: 'out-of-tokens', until: at('18:00'), setAt: at('09:00'), setBy: 'holder', setByUserId: mia.id },
    });
    await assignedToAnne('10:00');
    await tick('10:15');
    expect(await alarms()).toHaveLength(1);
    expect(await db.workerAvailability.findUnique({ where: { workerId: anne.id } })).toMatchObject({ reason: 'out-of-tokens', until: at('18:00') });
    expect(await db.agentTeamEvent.count({ where: { type: 'availability.changed' } })).toBe(0);
  });

  it('a lapsed mark is replaced by the stall', async () => {
    await db.workerAvailability.create({
      data: { workerId: anne.id, state: 'unavailable', reason: 'other', until: at('10:05'), setAt: at('09:00'), setBy: 'holder' },
    });
    await assignedToAnne('10:00');
    await tick('10:15');
    expect(await db.workerAvailability.findUnique({ where: { workerId: anne.id } })).toMatchObject({ reason: 'stalled', until: null });
  });
});

// ── Per-App windows and the evaluator's scope ─────────────────────────────

describe('per-App stall windows and scope', () => {
  it('an App\'s own window replaces the default; null returns it to the default', async () => {
    await M.setAgentTaskStallWindows({}, { appRef: app.id, input: { notStartedMinutes: 5 } }, ctx(admin.id));
    await assignedToAnne('10:00');
    await tick('10:05');
    expect(await alarms()).toEqual([expect.objectContaining({ type: 'stall.not-started', payload: expect.objectContaining({ windowMinutes: 5 }) })]);
    const back = await M.setAgentTaskStallWindows({}, { appRef: app.id, input: { notStartedMinutes: null } }, ctx(admin.id));
    expect(back).toMatchObject({ notStartedMinutes: 15, noProgressMinutes: 60, ownerReactionMinutes: 20, assignmentMinutes: 30 });
  });

  it('an uninstalled or deleted App\'s tasks are not evaluated', async () => {
    await assignedToAnne('10:00');
    await db.app.update({ where: { id: app.id }, data: { uninstalledAt: at('10:01') } });
    await tick('10:30');
    expect(await alarms()).toEqual([]);
  });

  it('the escalation step is the alarm\'s own window', async () => {
    await M.setAgentTaskStallWindows({}, { appRef: app.id, input: { assignmentMinutes: 10 } }, ctx(admin.id));
    const root = await task({ ownerWorkerId: ada.id, assigneeWorkerId: anne.id, assignedAt: at('09:00'), status: 'started', startedAt: at('09:01') });
    await drive(anne, '10:10');
    await task({ parentTaskId: root.id, ownerWorkerId: anne.id, createdAt: at('10:00') });
    await tick('10:10');
    const [a] = await alarms('assignment.unassignable');
    expect((await wakes(a.id)).map((w) => w.dueAt)).toEqual([at('10:10'), at('10:20')]);
    expect((await taskStallTick(db, new Date(at('10:20').getTime() - MINUTE))).woken).toBe(0);
  });
});
