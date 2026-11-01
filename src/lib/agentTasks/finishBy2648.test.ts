/**
 * #2648 (cor:agt:050:14, Finish-by details) — a task with a finish-by time is exempt from every stall window and
 * raises exactly one finish-by alarm once the time has passed and the task is neither finished nor cancelled.
 *
 * Same cast and controllable clock as endedAlarmEpisodes2200.test.ts: Ada owns the root task, Anne is its assignee;
 * the chain is [Ada, App manager], so row 1 escalates one window (the no-progress window, 60 min) after the alarm.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../id.js';
import { resolvers, type Context } from '../../api/graphql/schema/resolvers.js';
import { taskStallTick } from '../../jobs/taskStallEvaluator.js';
import { stallCandidates, STALL_WINDOW_DEFAULTS, type StallInputs } from './stall.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../workerSignature.js';

const M = resolvers.Mutation as any;
const DAY = '2026-10-09';
const at = (hhmm: string): Date => new Date(`${DAY}T${hhmm}:00Z`);
const ctx = (userId?: string): Context => ({ db, userId, roles: ['READER'] });

let app: { id: string };
let agentId: string;
let ada: { id: string };
let anne: { id: string };

beforeEach(async () => {
  await cleanDb(db);
  const n = Math.floor(Math.random() * 1_000_000);
  const org = await db.organization.create({ data: { name: 'FinishBy', urn: `finishby-${n}.example` } });
  const admin = await db.user.create({ data: { githubId: 500_000 + n, githubUsername: `fb-admin-${n}`, roles: ['READER'] } });
  const mia = await db.user.create({ data: { githubId: 600_000 + n, githubUsername: `fb-mia-${n}`, roles: ['READER'] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  const agent = await M.createAgent({}, { orgId: org.id, name: 'Team Agent' }, ctx(admin.id));
  agentId = agent.id;
  app = await db.app.create({ data: { organizationId: org.id, name: 'Team', urn: `finishby-${n}.example:team` }, select: { id: true } });
  await db.appMember.create({ data: { appId: app.id, userId: mia.id, role: 'member' } });
  const worker = (name: string) =>
    db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: app.id, agentId, name, slug: name.toLowerCase(), heldByUserId: mia.id }, select: { id: true } });
  ada = await worker('Ada');
  anne = await worker('Anne');
});

type TaskData = Record<string, unknown>;
const task = (data: TaskData) =>
  db.agentTask.create({ data: { appId: app.id, title: 'T', createdAt: at('09:00'), ...data }, select: { id: true } });
const assignedToAnne = (assignedAt: string, extra: TaskData = {}) =>
  task({ ownerWorkerId: ada.id, assigneeWorkerId: anne.id, assignedAt: at(assignedAt), createdAt: at(assignedAt), ...extra });
const startedByAnne = (extra: TaskData = {}) =>
  assignedToAnne('09:30', { status: 'started', startedAt: at('10:00'), ...extra });
const drive = (t: string) =>
  db.session.create({ data: { id: generateId(), appId: app.id, workerId: anne.id, agentId, startedAt: at(t), updatedAt: at(t) } });
const edited = (taskId: string, t: string, fields: string[]) =>
  db.agentTeamEvent.create({ data: { appId: app.id, taskId, type: 'task.edited', payload: { fields }, createdAt: at(t) } });
const tick = (t: string) => taskStallTick(db, at(t));
const alarms = (type?: string) =>
  db.agentTeamEvent.findMany({ where: { severity: 'alarm', taskId: { not: null }, ...(type ? { type } : {}) }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
const rows = (eventId: string) => db.agentTeamAlarmSchedule.findMany({ where: { eventId }, orderBy: { chainIndex: 'asc' } });

describe('#2648 — the finish-by alarm (cor:agt:050:14)', () => {
  it('a started task with a finish-by time raises no stall alarm inside the windows, then exactly one finish-by alarm', async () => {
    await startedByAnne({ finishBy: at('13:00') });
    await drive('10:00');
    await tick('11:00'); // no-progress would be due here
    await tick('12:59');
    expect(await alarms()).toEqual([]);
    await tick('13:00');
    await tick('13:05');
    const raised = await alarms();
    expect(raised).toHaveLength(1);
    expect(raised[0]).toMatchObject({ type: 'stall.finish-by', taskId: expect.any(String), episodeStart: at('13:00') });
  });

  it('a pending assigned task and a queued task raise neither not-started nor unassignable while finish-by is set', async () => {
    await assignedToAnne('10:00', { finishBy: at('12:00') });
    const queued = await task({ ownerWorkerId: ada.id, createdAt: at('10:00'), finishBy: at('12:00') });
    await db.agentTeamEvent.create({ data: { appId: app.id, taskId: queued.id, type: 'assignment.queued', createdAt: at('10:00') } });
    await tick('10:15');
    await tick('10:30');
    await tick('11:59');
    expect(await alarms()).toEqual([]);
    await tick('12:00');
    expect((await alarms()).map((a) => a.type)).toEqual(['stall.finish-by', 'stall.finish-by']);
  });

  it('a task finished or cancelled before its finish-by time raises nothing', async () => {
    const a = await startedByAnne({ finishBy: at('12:00') });
    const b = await assignedToAnne('10:00', { finishBy: at('12:00') });
    await db.agentTask.update({ where: { id: a.id }, data: { status: 'finished', finishedAt: at('11:00'), resultOutcome: 'succeeded' } });
    await db.agentTask.update({ where: { id: b.id }, data: { status: 'cancelled', cancelledAt: at('11:00') } });
    await tick('12:00');
    await tick('14:00');
    expect(await alarms()).toEqual([]);
  });

  it('a backlog task raises no finish-by alarm', async () => {
    await task({ ownerWorkerId: ada.id, status: 'backlog', createdAt: at('10:00'), finishBy: at('12:00') });
    await tick('12:00');
    await tick('14:00');
    expect(await alarms()).toEqual([]);
  });

  it('a task with no finish-by time keeps the ordinary windows and never raises a finish-by alarm', async () => {
    await assignedToAnne('10:00');
    await tick('10:15');
    expect((await alarms()).map((a) => a.type)).toEqual(['stall.not-started']);
  });

  it('a task blocked when its finish-by time passes raises at its release, not before; one alarm', async () => {
    const t = await assignedToAnne('10:00', { finishBy: at('12:00'), blocked: true });
    await tick('12:00');
    await tick('12:20');
    expect(await alarms()).toEqual([]);
    await db.agentTask.update({ where: { id: t.id }, data: { blocked: false, releasedAt: at('12:30') } });
    await tick('12:30');
    await tick('12:45');
    expect(await alarms('stall.finish-by')).toHaveLength(1);
  });

  it('blocking after the alarm does not end its episode: the next owner is still woken', async () => {
    const t = await assignedToAnne('10:00', { finishBy: at('12:00') });
    await tick('12:00');
    const [alarm] = await alarms('stall.finish-by');
    expect(await rows(alarm.id)).toHaveLength(2);
    await db.agentTask.update({ where: { id: t.id }, data: { blocked: true } });
    await tick('13:00'); // row 1: 12:00 + the no-progress window
    expect((await rows(alarm.id))[1]).toMatchObject({ wokenAt: at('13:00'), endedAt: null });
    await db.agentTask.update({ where: { id: t.id }, data: { blocked: false, releasedAt: at('13:10') } });
    await tick('13:10');
    expect(await alarms('stall.finish-by')).toHaveLength(1);
  });

  it('assigning, reassigning or starting the task does not end the episode', async () => {
    const t = await task({ ownerWorkerId: ada.id, createdAt: at('10:00'), finishBy: at('12:00') });
    await tick('12:00');
    const [alarm] = await alarms('stall.finish-by');
    await db.agentTask.update({ where: { id: t.id }, data: { assigneeWorkerId: anne.id, assignedAt: at('12:10'), status: 'started', startedAt: at('12:20') } });
    await tick('13:00');
    expect((await rows(alarm.id))[1]).toMatchObject({ wokenAt: at('13:00'), endedAt: null });
    expect(await alarms()).toHaveLength(1);
  });

  it('editing the finish-by time ends the episode; the new time starts a new one', async () => {
    const t = await startedByAnne({ finishBy: at('12:00') });
    await tick('12:00');
    const [first] = await alarms('stall.finish-by');
    await db.agentTask.update({ where: { id: t.id }, data: { finishBy: at('14:00') } });
    await edited(t.id, '12:10', ['finishBy']);
    await tick('13:00');
    expect((await rows(first.id))[1]).toMatchObject({ wokenAt: null, endedAt: at('13:00') });
    await tick('13:59');
    expect(await alarms()).toHaveLength(1);
    await tick('14:00');
    const second = (await alarms('stall.finish-by')).find((a) => a.id !== first.id);
    expect(second).toMatchObject({ episodeStart: at('14:00') });
  });

  it('clearing it brings the ordinary windows back, counted from the edit', async () => {
    const t = await startedByAnne({ finishBy: at('12:00') });
    await drive('10:00');
    await db.agentTask.update({ where: { id: t.id }, data: { finishBy: null } });
    await edited(t.id, '11:30', ['finishBy']);
    await tick('12:00');
    await tick('12:29');
    expect(await alarms()).toEqual([]);
    await tick('12:30');
    expect(await alarms()).toMatchObject([{ type: 'stall.no-progress', episodeStart: at('11:30') }]);
  });

  it('clearing it on a pending task floors the start window at the edit, not the assignment', async () => {
    const t = await assignedToAnne('10:00', { finishBy: at('12:00') });
    await db.agentTask.update({ where: { id: t.id }, data: { finishBy: null } });
    await edited(t.id, '11:30', ['finishBy']);
    await tick('11:30');
    await tick('11:44');
    expect(await alarms()).toEqual([]);
    await tick('11:45');
    expect(await alarms()).toMatchObject([{ type: 'stall.not-started', episodeStart: at('11:30') }]);
  });
});

describe('#2648 — a stop signal never moves the deadline (pure)', () => {
  const t = (hhmm: string) => at(hhmm);
  const input = (): StallInputs => ({
    task: { id: 'task', appId: 'app', status: 'started', parentTaskId: null, ownerWorkerId: 'ada', ownerUserId: null,
      assigneeWorkerId: 'anne', assigneeUserId: null, assignedAt: t('09:30'), startedAt: t('10:00'), createdAt: t('09:00'),
      startBy: null, finishBy: t('12:00'), blocked: false, releasedAt: null },
    openChildCount: 0, lastChildEndedAt: null, lastProgressAt: null, assigneeActivityAt: null, queuedAt: null, endedChildren: [],
  });

  it('a deadline that passes under a stop raises when the stop lifts, with the deadline as its episode', () => {
    const i = input();
    i.stopIntervals = new Map([['anne', [{ start: t('11:30'), end: t('12:45') }]]]);
    expect(stallCandidates(i, STALL_WINDOW_DEFAULTS, t('12:00'))).toEqual([]);
    expect(stallCandidates(i, STALL_WINDOW_DEFAULTS, t('12:44'))).toEqual([]);
    expect(stallCandidates(i, STALL_WINDOW_DEFAULTS, t('12:45'))).toMatchObject([{ rule: 'finish-by', episodeStart: t('12:00'), dueAt: t('12:00') }]);
  });

  it('a queued task is held by its own stop holds', () => {
    const i = input();
    i.task.assigneeWorkerId = null; i.task.status = 'pending'; i.task.startedAt = null; i.task.assignedAt = null;
    i.stopHolds = [{ start: t('11:00'), end: null }];
    expect(stallCandidates(i, STALL_WINDOW_DEFAULTS, t('13:00'))).toEqual([]);
    i.stopHolds = [];
    expect(stallCandidates(i, STALL_WINDOW_DEFAULTS, t('13:00'))).toMatchObject([{ rule: 'finish-by' }]);
  });

  it('the running question still names the episode while blocked or stopped', () => {
    const i = input();
    i.task.blocked = true; i.task.status = 'pending'; i.task.startedAt = null;
    i.stopIntervals = new Map([['anne', [{ start: t('11:00'), end: null }]]]);
    expect(stallCandidates(i, STALL_WINDOW_DEFAULTS, t('13:00'))).toEqual([]);
    expect(stallCandidates(i, STALL_WINDOW_DEFAULTS, t('13:00'), { episodesRunning: true }))
      .toMatchObject([{ rule: 'finish-by', episodeStart: t('12:00') }]);
  });
});

describe('#2648 — BLIND P3: clearing floors every ordinary window at the edit (pure)', () => {
  const base = (): StallInputs => ({
    task: { id: 'task', appId: 'app', status: 'pending', parentTaskId: null, ownerWorkerId: 'ada', ownerUserId: null,
      assigneeWorkerId: null, assigneeUserId: null, assignedAt: null, startedAt: null, createdAt: at('10:00'),
      startBy: null, finishBy: null, blocked: false, releasedAt: null },
    openChildCount: 0, lastChildEndedAt: null, lastProgressAt: null, assigneeActivityAt: null, queuedAt: at('10:00'), endedChildren: [],
    finishByEditedAt: at('11:30'),
  });

  it('a queued task gets its full assignment window from the clearing edit', () => {
    const i = base();
    expect(stallCandidates(i, STALL_WINDOW_DEFAULTS, at('11:59'))).toEqual([]);
    expect(stallCandidates(i, STALL_WINDOW_DEFAULTS, at('12:00'))).toMatchObject([{ rule: 'unassignable', episodeStart: at('11:30') }]);
  });

  it('the owner-reaction window also counts from the clearing edit', () => {
    const i = base();
    i.task.assigneeWorkerId = 'anne'; i.task.assignedAt = at('09:30'); i.task.status = 'started'; i.task.startedAt = at('09:40');
    i.endedChildren = [{ id: 'child', endedAt: at('10:00'), ownerWorkerId: 'anne', ownerActivityAt: null }];
    i.lastChildEndedAt = at('10:00');
    const reaction = (now: string) => stallCandidates(i, STALL_WINDOW_DEFAULTS, at(now)).filter((c) => c.rule === 'owner-unreactive');
    expect(reaction('11:49')).toEqual([]);
    expect(reaction('11:50')).toMatchObject([{ episodeStart: at('11:30') }]);
  });
});

