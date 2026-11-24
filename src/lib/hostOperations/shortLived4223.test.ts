/**
 * #4223 (S2 of the Team on Orca epic, #4229) — a short-lived worker's session ends with its last task.
 *
 * cor:agt:050:10, the short-lived paragraph (Proposed; Holger's G7 ruling, decision log 2026-11-15 15:10): for a
 * worker of a SHORT_LIVED Agent `closeSessionWhenDone` is not read. While any task assigned to it is open (pending or
 * started, one waiting on its child tasks included) nothing asks it to end its session. When the last one finishes or
 * is cancelled it is asked, and after the App's grace the platform ends the session through its host. It never
 * requests a context reset (cor:agt:050:27 part 9; G4). Its next assignment starts it afresh (cor:agt:070:08).
 *
 * The fixture's Agent has `resetContextAfterTask` on, so every "no reset" line below would otherwise record one.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { resolvers } from '../../api/graphql/schema/resolvers.js';
import type { Context } from '../../api/graphql/schema/resolvers.helpers.js';
import { setUpResetFixture, type ResetFixture } from '../../test/contextResetFixture.js';
import { resolveSessionEndRequest, sweepSessionEndRequests } from './sessionEnd.js';
import { pendingTaskWakes } from '../agentTasks/taskWakes.js';
import { loadWorkerWorkStates } from '../agentTasks/matcher.js';
import { taskMatcherTick } from '../../jobs/taskMatcher.js';
import { loadHostDesiredState } from '../desiredState/desiredState.js';

vi.mock('../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));

const M = resolvers.Mutation as any;
const ctx = (userId?: string): Context => ({ db, userId, roles: ['READER'] }) as Context;
const MIN = 60_000;

let f: ResetFixture;

/** The task's latest request (a task may carry several, #4223). */
const requestOf = (taskId: string) => db.taskSessionEndRequest.findFirst({ where: { taskId }, orderBy: [{ requestedAt: 'desc' }, { id: 'desc' }] });
const resets = () => db.contextReset.count();
const setLifecycle = (lifecycle: 'LONG_LIVED' | 'SHORT_LIVED') => db.agent.update({ where: { id: f.agentId }, data: { lifecycle } });
/** A pending task assigned to `who`, written directly (no launch, no wake). */
const pendingTask = (who: { id: string } = f.kit, extra: Record<string, unknown> = {}) =>
  db.agentTask.create({
    data: { appId: f.app.id, title: 'Next', ownerUserId: f.manager.id, assigneeWorkerId: who.id, status: 'pending', assignedAt: new Date(), closeSessionWhenDone: false, ...extra },
    select: { id: true },
  });
/** Kit registered on orca1 with a worktree, so a start can name one. */
const registerWithWorktree = () =>
  M.registerHost({}, {
    input: {
      appRef: f.app.id, label: 'Orca', pollIntervalSeconds: 600, capabilities: ['worker.reset-context'],
      workers: [{ worker: f.kit.id, family: 'claude', worktrees: ['hadron-server/kit'] }],
    },
  }, f.keyCtx());
const starts = () => db.hostOperation.findMany({ where: { type: 'worker.start' } });
const unassigned = () =>
  db.agentTask.create({ data: { appId: f.app.id, title: 'Do it', ownerUserId: f.manager.id, closeSessionWhenDone: false }, select: { id: true } });
const assignKit = (taskId: string) => M.assignAgentTask({}, { taskRef: taskId, assignee: { worker: f.kit.id } }, ctx(f.manager.id));

beforeEach(async () => {
  f = await setUpResetFixture();
  await setLifecycle('SHORT_LIVED');
});

describe('the last task ending ends the session (cor:agt:050:10, short-lived)', () => {
  it('S6: finishing the last task with closeSessionWhenDone no asks Kit to end its session, and requests no context reset', async () => {
    const t = await f.startedTask({ close: false });
    await f.finish(t.id);
    const r = await requestOf(t.id);
    expect(r).toMatchObject({ workerId: f.kit.id, sessionId: f.session.id, requestedByWorkerId: f.kit.id, resolution: null });
    expect(r!.dueAt.getTime() - r!.requestedAt.getTime()).toBe(10 * MIN);
    const [e] = await db.agentTeamEvent.findMany({ where: { type: 'task.session-end-requested' } });
    expect(e).toMatchObject({ taskId: t.id, subjectWorkerId: f.kit.id });
    expect(e!.payload).toMatchObject({ sessionId: f.session.id, graceMinutes: 10, lifecycle: 'SHORT_LIVED' });
    expect(await resets()).toBe(0);
    expect(await db.hostOperation.count({ where: { type: 'worker.reset-context' } })).toBe(0);
  });

  it('with the App\'s grace at its 1-minute minimum, the platform issues worker.end for that session one minute after the finish', async () => {
    await M.setAgentTaskStallSchedule({}, { appRef: f.app.id, input: { sessionEndGraceMinutes: 1 } }, ctx(f.manager.id));
    const t = await f.startedTask();
    await f.finish(t.id);
    const r = (await requestOf(t.id))!;
    expect(r.dueAt.getTime() - r.requestedAt.getTime()).toBe(1 * MIN);
    expect(await resolveSessionEndRequest(db, r.id, new Date(r.dueAt.getTime() - 1))).toBeNull();
    expect(await sweepSessionEndRequests(db, r.dueAt)).toBe(1);
    const [op] = await db.hostOperation.findMany();
    expect(op).toMatchObject({ type: 'worker.end', hostId: 'orca1', workerId: f.kit.id, issuedBy: 'platform', status: 'issued' });
    expect(op!.args).toEqual({ workerId: f.kit.id, sessionId: f.session.id });
  });

  it('cancelling the last task, never started, asks too and wakes Kit (END_SESSION)', async () => {
    const t = await pendingTask();
    await f.cancel(t.id);
    const r = await requestOf(t.id);
    expect(r).toMatchObject({ sessionId: f.session.id, requestedByWorkerId: null });
    const due = (await pendingTaskWakes(db, [f.kit.id], new Date())).get(f.kit.id) ?? [];
    expect(due.map((w) => [w.event, w.taskId])).toEqual([['END_SESSION', t.id]]);
    expect(await resets()).toBe(0);
  });

  it('a worker with no open session is simply free: nothing is asked', async () => {
    const t = await f.startedTask();
    await db.session.update({ where: { id: f.session.id }, data: { endedAt: new Date() } });
    await f.finish(t.id);
    expect(await requestOf(t.id)).toBeNull();
  });

  it('once asked, Kit is not matched to new work until that session ends, and its desired state is stopped', async () => {
    await db.app.update({ where: { id: f.app.id }, data: { sweepMode: 'APPLY' } });
    const t = await f.startedTask();
    await f.finish(t.id);
    const state = (await loadWorkerWorkStates(db, f.app.id, new Date())).find((w) => w.id === f.kit.id)!;
    expect(state.endingSession).toBe(true);
    const row = (await loadHostDesiredState(db, f.app.id, 'orca1', new Date()))!.workers.find((w) => w.workerId === f.kit.id)!;
    expect(row).toMatchObject({ desired: 'STOPPED', reason: 'NO_OPEN_TASK', openSessionId: f.session.id });
  });
});

describe('an open task keeps the worker up (G7: no parking)', () => {
  it('S8: a second open task, pending, keeps Kit up: finishing the first asks nothing even with closeSessionWhenDone yes, and resets nothing', async () => {
    const first = await f.startedTask({ close: true });
    const second = await pendingTask();
    await f.finish(first.id);
    expect(await requestOf(first.id)).toBeNull();
    expect(await db.agentTeamEvent.count({ where: { type: 'task.session-end-requested' } })).toBe(0);
    expect(await resets()).toBe(0);
    expect(await sweepSessionEndRequests(db, new Date(Date.now() + 60 * MIN))).toBe(0);
    expect((await db.session.findUniqueOrThrow({ where: { id: f.session.id } })).endedAt).toBeNull();
    // The second one is the last: finishing it asks.
    await f.asWorker(f.kit, () => M.startAgentTask({}, { taskRef: second.id }, ctx(f.holder.id)));
    await f.finish(second.id);
    expect(await requestOf(second.id)).toMatchObject({ sessionId: f.session.id, resolution: null });
    expect(await resets()).toBe(0);
  });

  it('a second open task, started, keeps Kit up when the first is cancelled', async () => {
    const first = await f.startedTask({ close: true });
    await f.startedTask();
    await f.cancel(first.id);
    expect(await requestOf(first.id)).toBeNull();
    expect(await resets()).toBe(0);
  });

  it('two tasks ending at once: exactly one of them asks (the count is read under the per-worker lock)', async () => {
    for (let round = 0; round < 3; round += 1) {
      const mine = await f.startedTask();
      const other = await pendingTask();
      await Promise.all([f.finish(mine.id), f.cancel(other.id)]);
      const asked = await db.taskSessionEndRequest.findMany({ where: { taskId: { in: [mine.id, other.id] } } });
      expect(asked.map((r) => r.sessionId)).toEqual([f.session.id]);
    }
    expect(await resets()).toBe(0);
  });

  it('S5/S7: a build task waiting on its child tasks keeps Kit up; a child finishing or being cancelled asks nothing of Kit', async () => {
    const build = await f.startedTask();
    const child = (title: string) =>
      db.agentTask.create({
        data: {
          appId: f.app.id, title, ownerWorkerId: f.kit.id, parentTaskId: build.id, assigneeWorkerId: f.ada.id, status: 'pending',
          assignedAt: new Date(), closeSessionWhenDone: true,
        },
        select: { id: true },
      });
    const review = await child('Review');
    const merge = await child('Merge');
    await f.asWorker(f.ada, () => M.startAgentTask({}, { taskRef: review.id }, ctx(f.holder.id)));
    await f.finish(review.id, f.ada);
    await f.asWorker(f.kit, () => M.cancelAgentTask({}, { taskRef: merge.id }, ctx(f.holder.id)));
    expect(await db.taskSessionEndRequest.count({ where: { workerId: f.kit.id } })).toBe(0);
    expect((await db.session.findUniqueOrThrow({ where: { id: f.session.id } })).endedAt).toBeNull();
    // Only then does Kit finish its own task, its last one.
    await f.finish(build.id);
    expect(await requestOf(build.id)).toMatchObject({ workerId: f.kit.id, sessionId: f.session.id });
  });
});

describe('who the rule covers', () => {
  it('control: a LONG_LIVED Agent keeps the ordinary rule (closeSessionWhenDone no asks nothing; the reset is requested)', async () => {
    await setLifecycle('LONG_LIVED');
    const t = await f.startedTask({ close: false });
    await f.finish(t.id);
    expect(await requestOf(t.id)).toBeNull();
    expect(await resets()).toBe(1);
  });

  it('control: a LONG_LIVED Agent with closeSessionWhenDone yes is asked even while it holds another open task', async () => {
    await setLifecycle('LONG_LIVED');
    const t = await f.startedTask({ close: true });
    await pendingTask();
    await f.finish(t.id);
    expect(await requestOf(t.id)).toMatchObject({ sessionId: f.session.id });
  });

  it('a worker marked leave-alone keeps the ordinary rule: its last task ending with closeSessionWhenDone no asks nothing; with yes it asks even beside an open task', async () => {
    await db.worker.update({ where: { id: f.kit.id }, data: { leaveAlone: true, leaveAloneReason: 'migration', leaveAloneAt: new Date() } });
    const quiet = await f.startedTask({ close: false });
    await f.finish(quiet.id);
    expect(await requestOf(quiet.id)).toBeNull();
    const asked = await f.startedTask({ close: true });
    await pendingTask();
    await f.finish(asked.id);
    expect(await requestOf(asked.id)).toMatchObject({ sessionId: f.session.id });
    // Short-lived all the same: never a context reset.
    expect(await resets()).toBe(0);
  });
});

describe('the next assignment starts a fresh run (cor:agt:070:08)', () => {
  beforeEach(async () => {
    await registerWithWorktree();
  });

  it('after the session ended, assigning Kit issues worker.start naming the task, with no person present', async () => {
    const t = await f.startedTask();
    await f.finish(t.id);
    await db.session.update({ where: { id: f.session.id }, data: { endedAt: new Date() } });
    const next = await unassigned();
    await assignKit(next.id);
    const [op, ...more] = await starts();
    expect(more).toEqual([]);
    expect(op).toMatchObject({ hostId: 'orca1', workerId: f.kit.id, issuedBy: 'platform', issuedByUserId: null, holdUserId: f.holder.id });
    expect(op!.args).toEqual({ workerId: f.kit.id, worktree: 'hadron-server/kit', family: 'claude', taskId: next.id });
  });

  it('a queued task matched to Kit after its session ended starts it too, naming that task', async () => {
    await db.session.update({ where: { id: f.session.id }, data: { endedAt: new Date() } });
    await db.worker.update({ where: { id: f.ada.id }, data: { retiredAt: new Date() } });
    const next = await unassigned();
    await db.agentTask.update({ where: { id: next.id }, data: { status: 'pending' } });
    await taskMatcherTick(db, new Date());
    expect((await db.agentTask.findUniqueOrThrow({ where: { id: next.id } })).assigneeWorkerId).toBe(f.kit.id);
    expect((await starts()).map((o) => o.args)).toEqual([{ workerId: f.kit.id, worktree: 'hadron-server/kit', family: 'claude', taskId: next.id }]);
  });

  it('an unheld worker is not started', async () => {
    await db.session.update({ where: { id: f.session.id }, data: { endedAt: new Date() } });
    await db.worker.update({ where: { id: f.kit.id }, data: { heldByUserId: null, heldAt: null } });
    await assignKit((await unassigned()).id);
    expect(await starts()).toEqual([]);
  });

  it('under a team pause nothing is started: the task waits, assigned and pending; lifting the pause starts it (Peter, #108945)', async () => {
    await db.session.update({ where: { id: f.session.id }, data: { endedAt: new Date() } });
    await M.setTeamPause({}, { appRef: f.app.id, paused: true }, ctx(f.manager.id));
    const next = await unassigned();
    await assignKit(next.id);
    expect(await starts()).toEqual([]);
    expect(await db.agentTask.findUniqueOrThrow({ where: { id: next.id } })).toMatchObject({ assigneeWorkerId: f.kit.id, status: 'pending' });
    // Lifted: the task assigned during the pause starts Kit, once, naming that task.
    await M.setTeamPause({}, { appRef: f.app.id, paused: false }, ctx(f.manager.id));
    expect((await starts()).map((o) => [o.issuedBy, o.args])).toEqual([
      ['platform', { workerId: f.kit.id, worktree: 'hadron-server/kit', family: 'claude', taskId: next.id }],
    ]);
    // A second pause and lift issues nothing more: that start is still in flight.
    await M.setTeamPause({}, { appRef: f.app.id, paused: true }, ctx(f.manager.id));
    await M.setTeamPause({}, { appRef: f.app.id, paused: false }, ctx(f.manager.id));
    expect(await starts()).toHaveLength(1);
  });

  it('lifting a pause starts only for tasks assigned during it: an older open task of an unbound worker starts nobody, and a lift with no pause does nothing', async () => {
    await db.session.update({ where: { id: f.session.id }, data: { endedAt: new Date() } });
    const old = await pendingTask(f.kit, { assignedAt: new Date(Date.now() - 60 * MIN) });
    await M.setTeamPause({}, { appRef: f.app.id, paused: false }, ctx(f.manager.id));
    await M.setTeamPause({}, { appRef: f.app.id, paused: true }, ctx(f.manager.id));
    await M.setTeamPause({}, { appRef: f.app.id, paused: false }, ctx(f.manager.id));
    expect(await starts()).toEqual([]);
    expect((await db.agentTask.findUniqueOrThrow({ where: { id: old.id } })).status).toBe('pending');
  });

  it('a task assigned during a pause and ended or moved before the lift starts nobody; a worker with an open session is not started over', async () => {
    await db.session.update({ where: { id: f.session.id }, data: { endedAt: new Date() } });
    await M.setTeamPause({}, { appRef: f.app.id, paused: true }, ctx(f.manager.id));
    const gone = await unassigned();
    await assignKit(gone.id);
    await f.cancel(gone.id);
    const open = await unassigned();
    await assignKit(open.id);
    await f.bind(f.kit);
    await M.setTeamPause({}, { appRef: f.app.id, paused: false }, ctx(f.manager.id));
    expect(await starts()).toEqual([]);
  });

  it('Cedric N1: the lift starts a task MATCHED during the pause as the family the matcher chose, and one reassigned by hand since as a hand assignment (no family)', async () => {
    await db.session.update({ where: { id: f.session.id }, data: { endedAt: new Date() } });
    await db.worker.update({ where: { id: f.ada.id }, data: { retiredAt: new Date() } });
    const codexOnly = () =>
      M.registerHost({}, {
        input: {
          appRef: f.app.id, label: 'Orca', pollIntervalSeconds: 600, capabilities: ['worker.reset-context'],
          workers: [{ worker: f.kit.id, family: 'codex', worktrees: ['hadron-server/kit'] }],
        },
      }, f.keyCtx());
    await M.setTeamPause({}, { appRef: f.app.id, paused: true }, ctx(f.manager.id));
    const matched = await unassigned();
    await db.agentTask.update({ where: { id: matched.id }, data: { status: 'pending' } });
    await taskMatcherTick(db, new Date());
    expect((await db.agentTask.findUniqueOrThrow({ where: { id: matched.id } })).assigneeWorkerId).toBe(f.kit.id);
    const [m] = await db.agentTeamEvent.findMany({ where: { taskId: matched.id, type: 'assignment.matched' } });
    expect((m!.payload as { family: string }).family).toBe('claude');
    expect(await starts()).toEqual([]);
    // The host now launches Kit only as codex. The match was as claude, so the lift starts nothing as another family.
    await codexOnly();
    await M.setTeamPause({}, { appRef: f.app.id, paused: false }, ctx(f.manager.id));
    expect(await starts()).toEqual([]);
    // Moved by hand to a person and back to Kit during a second pause: the latest assignment is a hand one, which
    // names no family (launchAssignee passes none either), so the lift starts Kit as the host launches it.
    await M.setTeamPause({}, { appRef: f.app.id, paused: true }, ctx(f.manager.id));
    await M.reassignAgentTask({}, { taskRef: matched.id, assignee: { user: f.holder.id } }, ctx(f.manager.id));
    await M.reassignAgentTask({}, { taskRef: matched.id, assignee: { worker: f.kit.id } }, ctx(f.manager.id));
    expect(await starts()).toEqual([]);
    await M.setTeamPause({}, { appRef: f.app.id, paused: false }, ctx(f.manager.id));
    expect((await starts()).map((o) => o.args)).toEqual([{ workerId: f.kit.id, worktree: 'hadron-server/kit', family: 'codex', taskId: matched.id }]);
  });

  it('D3: a process that died mid-task is never restarted by a second worker.start: the session is open, so no assignment or matcher pass issues one', async () => {
    const t = await f.startedTask();
    // Kit's process is gone; the platform sees only an open, quiet session.
    const quiet = new Date(Date.now() - 3 * 86_400_000);
    await db.session.update({ where: { id: f.session.id }, data: { startedAt: quiet, updatedAt: quiet } });
    await assignKit((await unassigned()).id);
    await taskMatcherTick(db, new Date());
    expect(await starts()).toEqual([]);
    expect(await requestOf(t.id)).toBeNull();
    // The host relaunches it under the same session: the desired state names it.
    await db.app.update({ where: { id: f.app.id }, data: { sweepMode: 'APPLY' } });
    const row = (await loadHostDesiredState(db, f.app.id, 'orca1', new Date()))!.workers.find((w) => w.workerId === f.kit.id)!;
    expect(row).toMatchObject({ desired: 'RUNNING', reason: 'HOLDS_TASK', openSessionId: f.session.id });
  });
});

describe('the last task reassigned away ends the session too (Peter, team chat #108497)', () => {
  const F = resolvers as any;
  const reassign = (taskId: string, to: { id: string }, c = ctx(f.manager.id)) =>
    M.reassignAgentTask({}, { taskRef: taskId, assignee: { worker: to.id } }, c);
  const requestsOf = (taskId: string) => db.taskSessionEndRequest.findMany({ where: { taskId }, orderBy: [{ requestedAt: 'asc' }, { id: 'asc' }] });

  it('reassigning Kit\'s last open task to Ada asks Kit to end its session, wakes it (END_SESSION), and requests no reset', async () => {
    const t = await f.startedTask();
    await reassign(t.id, f.ada);
    const [r, ...more] = await requestsOf(t.id);
    expect(more).toEqual([]);
    expect(r).toMatchObject({ workerId: f.kit.id, sessionId: f.session.id, requestedByWorkerId: null, resolution: null });
    expect(r!.dueAt.getTime() - r!.requestedAt.getTime()).toBe(10 * MIN);
    const e = await db.agentTeamEvent.findUniqueOrThrow({ where: { id: r!.eventId } });
    expect(e).toMatchObject({ type: 'task.session-end-requested', taskId: t.id, subjectWorkerId: f.kit.id });
    expect(e.payload).toMatchObject({ sessionId: f.session.id, lifecycle: 'SHORT_LIVED', cause: 'reassigned' });
    const due = (await pendingTaskWakes(db, [f.kit.id], new Date())).get(f.kit.id) ?? [];
    expect(due.filter((w) => w.event === 'END_SESSION').map((w) => w.taskId)).toEqual([t.id]);
    expect(await resets()).toBe(0);
    // After the grace the platform ends that session through Kit's host.
    expect(await sweepSessionEndRequests(db, r!.dueAt)).toBe(1);
    expect((await db.hostOperation.findMany({ where: { type: 'worker.end' } })).map((o) => o.args)).toEqual([{ workerId: f.kit.id, sessionId: f.session.id }]);
  });

  it('a pending last task reassigned away asks too', async () => {
    const t = await pendingTask();
    await reassign(t.id, f.ada);
    expect(await requestsOf(t.id)).toMatchObject([{ workerId: f.kit.id, sessionId: f.session.id }]);
  });

  it('another open task keeps Kit up: reassigning one of two away asks nothing', async () => {
    const t = await f.startedTask({ close: true });
    await pendingTask();
    await reassign(t.id, f.ada);
    expect(await requestsOf(t.id)).toEqual([]);
    expect(await db.agentTeamEvent.count({ where: { type: 'task.session-end-requested' } })).toBe(0);
  });

  it('control: a LONG_LIVED Agent, a leave-alone worker, and a move to a person: Kit is asked only by its lifecycle', async () => {
    await setLifecycle('LONG_LIVED');
    const long = await f.startedTask({ close: true });
    await reassign(long.id, f.ada);
    expect(await requestsOf(long.id)).toEqual([]);
    await setLifecycle('SHORT_LIVED');
    await db.worker.update({ where: { id: f.kit.id }, data: { leaveAlone: true, leaveAloneReason: 'migration', leaveAloneAt: new Date() } });
    const marked = await f.startedTask({ close: true });
    await reassign(marked.id, f.ada);
    expect(await requestsOf(marked.id)).toEqual([]);
    await db.worker.update({ where: { id: f.kit.id }, data: { leaveAlone: false, leaveAloneReason: null, leaveAloneAt: null } });
    // To a person: Kit still loses its last task.
    const toPerson = await f.startedTask();
    await M.reassignAgentTask({}, { taskRef: toPerson.id, assignee: { user: f.holder.id } }, ctx(f.manager.id));
    expect(await requestsOf(toPerson.id)).toMatchObject([{ workerId: f.kit.id }]);
  });

  it('a task can ask twice, once per worker: Kit when it is moved away, Ada when she finishes it as her last; the task shows only its own assignee\'s request', async () => {
    const adaSession = await f.bind(f.ada);
    const t = await f.startedTask();
    const moved = await reassign(t.id, f.ada);
    // The task is Ada's now: the request it made of Kit is Kit's wake, never something the task's reader acts on.
    expect(await F.AgentTask.sessionEndRequest(moved, {}, ctx(f.manager.id))).toBeNull();
    const finished = await f.finish(t.id, f.ada);
    const all = await requestsOf(t.id);
    expect(all.map((r) => [r.workerId, r.sessionId])).toEqual([[f.kit.id, f.session.id], [f.ada.id, adaSession.id]]);
    expect(await F.AgentTask.sessionEndRequest(finished, {}, ctx(f.holder.id))).toMatchObject({ workerId: f.ada.id, sessionId: adaSession.id, resolution: null });
  });

  it('Cedric P2-1: a later finisher never reads the former assignee\'s request on the task', async () => {
    await f.bind(f.ada);
    await pendingTask(f.ada); // Ada keeps another open task, so finishing asks nothing of her
    const t = await f.startedTask();
    await reassign(t.id, f.ada);
    const finished = await f.finish(t.id, f.ada);
    expect((await requestsOf(t.id)).map((r) => r.workerId)).toEqual([f.kit.id]);
    expect(await F.AgentTask.sessionEndRequest(finished, {}, ctx(f.holder.id))).toBeNull();
    // Moved to a person: the task shows nothing either.
    const p = await f.startedTask();
    const toPerson = await M.reassignAgentTask({}, { taskRef: p.id, assignee: { user: f.holder.id } }, ctx(f.manager.id));
    expect(await F.AgentTask.sessionEndRequest(toPerson, {}, ctx(f.manager.id))).toBeNull();
  });

  it('Peter #108945: a worker reads only a request addressed to itself; a person reads the assignee\'s', async () => {
    const t = await f.startedTask();
    const finished = await f.finish(t.id);
    // Kit, the asked worker, and a person (the holder, the manager) read it.
    expect(await f.asWorker(f.kit, () => F.AgentTask.sessionEndRequest(finished, {}, ctx(f.holder.id)))).toMatchObject({ workerId: f.kit.id, sessionId: f.session.id });
    expect(await F.AgentTask.sessionEndRequest(finished, {}, ctx(f.manager.id))).toMatchObject({ workerId: f.kit.id });
    // Ada, another worker reading Kit's task, never reads an ask to end a session that is not hers.
    expect(await f.asWorker(f.ada, () => F.AgentTask.sessionEndRequest(finished, {}, ctx(f.holder.id)))).toBeNull();
  });

  it('Kit moving its own last task away is still woken (END_SESSION): it cannot read the ask on a task that is no longer its', async () => {
    const t = await db.agentTask.create({
      data: { appId: f.app.id, title: 'Mine to give', ownerWorkerId: f.kit.id, assigneeWorkerId: f.kit.id, status: 'pending', assignedAt: new Date(), closeSessionWhenDone: false },
      select: { id: true },
    });
    await f.asWorker(f.kit, () => reassign(t.id, f.ada, ctx(f.holder.id)));
    expect(await requestsOf(t.id)).toMatchObject([{ workerId: f.kit.id, requestedByWorkerId: f.kit.id }]);
    const due = (await pendingTaskWakes(db, [f.kit.id], new Date())).get(f.kit.id) ?? [];
    expect(due.filter((w) => w.event === 'END_SESSION').map((w) => w.taskId)).toEqual([t.id]);
    // Control: a worker that FINISHED its own last task reads the ask on the task and is not woken for it.
    await db.session.update({ where: { id: f.session.id }, data: { endedAt: new Date() } });
    const again = await f.bind(f.kit);
    const own = await f.startedTask();
    await f.finish(own.id);
    expect(await requestOf(own.id)).toMatchObject({ sessionId: again.id });
    const after = (await pendingTaskWakes(db, [f.kit.id], new Date())).get(f.kit.id) ?? [];
    expect(after.filter((w) => w.event === 'END_SESSION')).toEqual([]);
  });

  it('Cedric P2-2: a reassignment to the same worker is refused and asks nothing', async () => {
    const t = await f.startedTask();
    await expect(reassign(t.id, f.kit)).rejects.toMatchObject({ extensions: { code: 'TASK_INVALID_TRANSITION' } });
    expect(await requestsOf(t.id)).toEqual([]);
  });

  it('moved away and back, then finished: two requests of Kit; the task shows the later one', async () => {
    await f.bind(f.ada);
    await pendingTask(f.ada);
    const t = await f.startedTask();
    await reassign(t.id, f.ada);
    await reassign(t.id, f.kit);
    await f.asWorker(f.kit, () => M.startAgentTask({}, { taskRef: t.id }, ctx(f.holder.id))).catch(() => undefined);
    const finished = await f.finish(t.id);
    const all = await requestsOf(t.id);
    expect(all.map((r) => r.workerId)).toEqual([f.kit.id, f.kit.id]);
    expect(await F.AgentTask.sessionEndRequest(finished, {}, ctx(f.holder.id))).toMatchObject({ workerId: f.kit.id, requestedAt: all[1]!.requestedAt });
  });

  it('the move and Kit\'s own finish of another task at once: exactly one asks Kit', async () => {
    const mine = await f.startedTask();
    const other = await pendingTask();
    await Promise.all([f.finish(mine.id), reassign(other.id, f.ada)]);
    expect(await db.taskSessionEndRequest.count({ where: { workerId: f.kit.id } })).toBe(1);
  });
});
