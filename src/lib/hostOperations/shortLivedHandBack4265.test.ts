/**
 * #4265 (follow-up to #4223, S2 of the Team on Orca epic, #4229) — a short-lived worker that HANDS BACK its last open
 * task is asked to end its session, as on a finish, a cancel or a reassignment away.
 *
 * cor:agt:050:10 r20, the short-lived paragraph (Proposed; Peter, team chat #109434): "When it hands that task back,
 * the same holds". cor:agt:050:29 governs the hand-back itself (the assignee only, a started task, back to the queue
 * with no assignee) and is unchanged. Before this, a hand-back asked nothing: the session stayed open with no task
 * while the worker's desired state read stopped.
 *
 * The fixture's Agent has `resetContextAfterTask` on; a hand-back never requests a context reset.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { resolvers } from '../../api/graphql/schema/resolvers.js';
import type { Context } from '../../api/graphql/schema/resolvers.helpers.js';
import { setUpResetFixture, type ResetFixture } from '../../test/contextResetFixture.js';
import { sweepSessionEndRequests } from './sessionEnd.js';
import { pendingTaskWakes } from '../agentTasks/taskWakes.js';

vi.mock('../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));

const M = resolvers.Mutation as any;
const F = resolvers as any;
const ctx = (userId?: string): Context => ({ db, userId, roles: ['READER'] }) as Context;
const MIN = 60_000;

let f: ResetFixture;

const requestsOf = (taskId: string) => db.taskSessionEndRequest.findMany({ where: { taskId }, orderBy: [{ requestedAt: 'asc' }, { id: 'asc' }] });
const asked = () => db.agentTeamEvent.count({ where: { type: 'task.session-end-requested' } });
const setLifecycle = (lifecycle: 'LONG_LIVED' | 'SHORT_LIVED') => db.agent.update({ where: { id: f.agentId }, data: { lifecycle } });
/** A pending task assigned to `who`, written directly (no launch, no wake). */
const pendingTask = (who: { id: string } = f.kit) =>
  db.agentTask.create({
    data: { appId: f.app.id, title: 'Next', ownerUserId: f.manager.id, assigneeWorkerId: who.id, status: 'pending', assignedAt: new Date(), closeSessionWhenDone: false },
    select: { id: true },
  });
const handBack = (taskId: string, w: { id: string } = f.kit) =>
  f.asWorker(w, () => M.handBackAgentTask({}, { taskRef: taskId, reason: { code: 'CANNOT_DO' } }, ctx(f.holder.id)));
const endSessionWakes = async (w: { id: string } = f.kit) =>
  ((await pendingTaskWakes(db, [w.id], new Date())).get(w.id) ?? []).filter((x) => x.event === 'END_SESSION').map((x) => x.taskId);
/** The re-queued task given to Ada by hand and started by her. */
const adaTakes = async (taskId: string) => {
  await M.assignAgentTask({}, { taskRef: taskId, assignee: { worker: f.ada.id } }, ctx(f.manager.id));
  await f.asWorker(f.ada, () => M.startAgentTask({}, { taskRef: taskId }, ctx(f.holder.id)));
};

beforeEach(async () => {
  f = await setUpResetFixture();
  await setLifecycle('SHORT_LIVED');
});

describe('handing back the last open task ends the session (cor:agt:050:10 r20, #4265)', () => {
  it('Kit hands back its only open task: one request for its open session, by its lifecycle, cause handed-back; no reset; worker.end after the grace', async () => {
    const t = await f.startedTask();
    const back = await handBack(t.id);
    expect(back).toMatchObject({ status: 'pending', assigneeWorkerId: null });
    const [r, ...more] = await requestsOf(t.id);
    expect(more).toEqual([]);
    expect(r).toMatchObject({ workerId: f.kit.id, sessionId: f.session.id, requestedByWorkerId: f.kit.id, resolution: null });
    expect(r!.dueAt.getTime() - r!.requestedAt.getTime()).toBe(10 * MIN);
    const e = await db.agentTeamEvent.findUniqueOrThrow({ where: { id: r!.eventId } });
    expect(e).toMatchObject({ type: 'task.session-end-requested', taskId: t.id, subjectWorkerId: f.kit.id, actorWorkerId: f.kit.id });
    expect(e.payload).toMatchObject({ sessionId: f.session.id, lifecycle: 'SHORT_LIVED', cause: 'handed-back' });
    expect(await db.contextReset.count()).toBe(0);
    expect(await sweepSessionEndRequests(db, r!.dueAt)).toBe(1);
    expect((await db.hostOperation.findMany({ where: { type: 'worker.end' } })).map((o) => o.args)).toEqual([{ workerId: f.kit.id, sessionId: f.session.id }]);
  });

  it('Kit is woken for it (END_SESSION): the task has no assignee, so Kit has no task to read the ask on', async () => {
    const t = await f.startedTask();
    const back = await handBack(t.id);
    expect(await endSessionWakes()).toEqual([t.id]);
    // The queued task shows no request to anyone, Kit included.
    expect(await F.AgentTask.sessionEndRequest(back, {}, ctx(f.manager.id))).toBeNull();
    expect(await f.asWorker(f.kit, () => F.AgentTask.sessionEndRequest(back, {}, ctx(f.holder.id)))).toBeNull();
  });

  it('with no open session Kit is simply free: nothing is asked', async () => {
    const t = await f.startedTask();
    await db.session.update({ where: { id: f.session.id }, data: { endedAt: new Date() } });
    await handBack(t.id);
    expect(await requestsOf(t.id)).toEqual([]);
    expect(await asked()).toBe(0);
  });
});

describe('who is not asked', () => {
  it('another open task keeps Kit up: handing one of two back asks nothing (the other pending, or started)', async () => {
    const t = await f.startedTask();
    await pendingTask();
    await handBack(t.id);
    expect(await requestsOf(t.id)).toEqual([]);
    const second = await f.startedTask();
    await f.startedTask();
    await handBack(second.id);
    expect(await requestsOf(second.id)).toEqual([]);
    expect(await asked()).toBe(0);
  });

  it('a LONG_LIVED worker handing back its last task is not asked, whatever closeSessionWhenDone says', async () => {
    await setLifecycle('LONG_LIVED');
    const yes = await f.startedTask({ close: true });
    await handBack(yes.id);
    expect(await requestsOf(yes.id)).toEqual([]);
    const no = await f.startedTask({ close: false });
    await handBack(no.id);
    expect(await requestsOf(no.id)).toEqual([]);
    expect(await asked()).toBe(0);
  });

  it('a short-lived worker marked leave-alone handing back its last task is not asked, whatever closeSessionWhenDone says', async () => {
    await db.worker.update({ where: { id: f.kit.id }, data: { leaveAlone: true, leaveAloneReason: 'migration', leaveAloneAt: new Date() } });
    const yes = await f.startedTask({ close: true });
    await handBack(yes.id);
    expect(await requestsOf(yes.id)).toEqual([]);
    const no = await f.startedTask({ close: false });
    await handBack(no.id);
    expect(await requestsOf(no.id)).toEqual([]);
    expect(await asked()).toBe(0);
    // Control: unmarked, the very same hand-back asks.
    await db.worker.update({ where: { id: f.kit.id }, data: { leaveAlone: false, leaveAloneReason: null, leaveAloneAt: null } });
    const plain = await f.startedTask({ close: false });
    await handBack(plain.id);
    expect(await requestsOf(plain.id)).toMatchObject([{ workerId: f.kit.id }]);
  });

  it('a refused hand-back (a pending task; not the assignee) asks nothing', async () => {
    const p = await pendingTask();
    await expect(handBack(p.id)).rejects.toMatchObject({ extensions: { code: 'TASK_INVALID_TRANSITION' } });
    const t = await f.startedTask();
    await expect(handBack(t.id, f.ada)).rejects.toBeTruthy();
    expect(await asked()).toBe(0);
  });
});

describe('the re-queued task and its next assignee (the own-worker rule, #4253)', () => {
  it('the next assignee never reads Kit\'s request on the task, while it holds the task or after it finishes it; Kit stays woken', async () => {
    await f.bind(f.ada);
    await pendingTask(f.ada); // Ada keeps another open task, so finishing asks nothing of her
    const t = await f.startedTask();
    await handBack(t.id);
    await adaTakes(t.id);
    const held = await db.agentTask.findUniqueOrThrow({ where: { id: t.id } });
    expect(await f.asWorker(f.ada, () => F.AgentTask.sessionEndRequest(held, {}, ctx(f.holder.id)))).toBeNull();
    expect(await F.AgentTask.sessionEndRequest(held, {}, ctx(f.manager.id))).toBeNull();
    expect(await endSessionWakes()).toEqual([t.id]);
    expect(await endSessionWakes(f.ada)).toEqual([]);
    const finished = await f.finish(t.id, f.ada);
    expect((await requestsOf(t.id)).map((r) => r.workerId)).toEqual([f.kit.id]);
    expect(await f.asWorker(f.ada, () => F.AgentTask.sessionEndRequest(finished, {}, ctx(f.holder.id)))).toBeNull();
    expect(await F.AgentTask.sessionEndRequest(finished, {}, ctx(f.manager.id))).toBeNull();
  });

  it('a task can ask twice: Kit when it hands it back, Ada when she finishes it as her last; the task shows only Ada\'s', async () => {
    const adaSession = await f.bind(f.ada);
    const t = await f.startedTask();
    await handBack(t.id);
    await adaTakes(t.id);
    const finished = await f.finish(t.id, f.ada);
    expect((await requestsOf(t.id)).map((r) => [r.workerId, r.sessionId])).toEqual([[f.kit.id, f.session.id], [f.ada.id, adaSession.id]]);
    expect(await F.AgentTask.sessionEndRequest(finished, {}, ctx(f.holder.id))).toMatchObject({ workerId: f.ada.id, sessionId: adaSession.id });
    // Kit, reading the task Ada finished, never reads Ada's request as its own.
    expect(await f.asWorker(f.kit, () => F.AgentTask.sessionEndRequest(finished, {}, ctx(f.holder.id)))).toBeNull();
  });
});

describe('one request per worker under concurrency', () => {
  it('a hand-back and Kit\'s finish of its other task at once: exactly one asks Kit (the count is read under the per-worker lock)', async () => {
    const mine = await f.startedTask();
    const other = await f.startedTask();
    await Promise.all([f.finish(mine.id), handBack(other.id)]);
    expect(await db.taskSessionEndRequest.count({ where: { workerId: f.kit.id } })).toBe(1);
  });
});
