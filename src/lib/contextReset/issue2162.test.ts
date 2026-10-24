/**
 * #2162 (cor:agt:050:27) — the issue step: a task the worker started ends, and the finishing transaction records one
 * context reset and one `worker.reset-context` operation for a live host that registers the worker AND declared the
 * capability; or none at all. The finish never depends on it (the savepoint boundary).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { code, M, MIN, ctx, setUpResetFixture, type ResetFixture } from '../../test/contextResetFixture.js';
import { __contextResetTesting, CONTEXT_RESET_FAILED_EVENT, CONTEXT_RESET_REQUESTED_EVENT } from './contextReset.js';

vi.mock('../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));

let f: ResetFixture;
beforeEach(async () => {
  f = await setUpResetFixture();
});
afterEach(() => {
  delete __contextResetTesting.beforeIssueInsert;
});

const resetOf = (taskId: string) => db.contextReset.findUnique({ where: { taskId } });

describe('a reset is requested when a started task ends (cor:agt:050:27 §1)', () => {
  it('finishing: one reset for Kit\'s open session and one operation to orca1, the task outcome and the binding unchanged', async () => {
    const t = await f.startedTask();
    const finished = await f.finish(t.id) as { status: string; outcome: string };
    expect(finished).toMatchObject({ status: 'finished', resultOutcome: 'succeeded' });
    const r = await resetOf(t.id);
    expect(r).toMatchObject({ workerId: f.kit.id, sessionId: f.session.id, hostId: 'orca1', phase: 'requested', reason: null, epoch: 0, endedAt: null });
    const [op] = await db.hostOperation.findMany();
    expect(op).toMatchObject({ id: r!.hostOperationId, type: 'worker.reset-context', hostId: 'orca1', workerId: f.kit.id, issuedBy: 'platform', status: 'issued' });
    expect(op!.args).toEqual({ workerId: f.kit.id, sessionId: f.session.id, taskId: t.id, resetId: r!.id });
    const [e] = await db.agentTeamEvent.findMany({ where: { type: CONTEXT_RESET_REQUESTED_EVENT } });
    expect(e).toMatchObject({ taskId: t.id, subjectWorkerId: f.kit.id, actorWorkerId: f.kit.id });
    expect(e!.payload).toMatchObject({ resetId: r!.id, issued: true, operationId: op!.id, hostId: 'orca1' });
    // A shed, never a session end (R121): the session and the worker's binding stay.
    expect((await db.session.findUniqueOrThrow({ where: { id: f.session.id } })).endedAt).toBeNull();
    expect(await db.taskSessionEndRequest.count()).toBe(0);
    expect(await db.hostOperation.count({ where: { type: 'worker.end' } })).toBe(0);
  });

  it('cancelling a started task requests one too; cancelling one never started requests none (R117)', async () => {
    const t = await f.startedTask();
    await f.cancel(t.id);
    expect(await resetOf(t.id)).toMatchObject({ phase: 'requested' });
    const pending = await db.agentTask.create({
      data: { appId: f.app.id, title: 'Never started', ownerUserId: f.manager.id, assigneeWorkerId: f.kit.id, status: 'pending', assignedAt: new Date(), closeSessionWhenDone: false },
      select: { id: true },
    });
    await f.cancel(pending.id);
    expect(await resetOf(pending.id)).toBeNull();
  });

  it('the setting off: nothing (R115)', async () => {
    await M.updateAgent({}, { ref: f.agentId, resetContextAfterTask: false }, ctx(f.manager.id));
    const t = await f.startedTask();
    await f.finish(t.id);
    expect(await resetOf(t.id)).toBeNull();
    expect(await db.hostOperation.count()).toBe(0);
  });

  it('a task started by another worker and then reassigned to Kit: nothing (R117)', async () => {
    const t = await f.startedTask({ assignee: f.ada });
    await M.reassignAgentTask({}, { taskId: t.id, assignee: { worker: f.kit.id } }, ctx(f.manager.id));
    await f.finish(t.id);
    expect(await resetOf(t.id)).toBeNull();
  });

  it('Kit holds another started task: nothing', async () => {
    const t = await f.startedTask();
    await f.startedTask();
    await f.finish(t.id);
    expect(await resetOf(t.id)).toBeNull();
  });

  it('under a team pause: nothing (R120)', async () => {
    const t = await f.startedTask();
    await db.app.update({ where: { id: f.app.id }, data: { teamPausedAt: new Date() } });
    await f.finish(t.id).catch(() => undefined);
    // Whether a paused App lets the finish through is the pause's rule; a reset is never requested under it.
    expect(await resetOf(t.id)).toBeNull();
  });

  it('a session end asked for the same task wins: no reset (R119)', async () => {
    const t = await f.startedTask({ close: true });
    await f.finish(t.id);
    expect(await db.taskSessionEndRequest.count({ where: { taskId: t.id } })).toBe(1);
    expect(await resetOf(t.id)).toBeNull();
  });

  it('Kit has no open session: nothing', async () => {
    const t = await f.startedTask();
    await db.session.update({ where: { id: f.session.id }, data: { endedAt: new Date() } });
    await f.finish(t.id);
    expect(await resetOf(t.id)).toBeNull();
  });
});

describe('the capability gate (cor:agt:070:01, Proposed)', () => {
  it('a host that did not declare the capability is never issued one: the reset is recorded failed HOST_UNSUPPORTED', async () => {
    await f.register(f.orca1, { capabilities: null });
    const t = await f.startedTask();
    await f.finish(t.id);
    const r = await resetOf(t.id);
    expect(r).toMatchObject({ phase: 'failed', reason: 'HOST_UNSUPPORTED', hostId: null, hostOperationId: null });
    expect(r!.endedAt).not.toBeNull();
    expect(await db.hostOperation.count()).toBe(0);
    const failed = await db.agentTeamEvent.findMany({ where: { type: CONTEXT_RESET_FAILED_EVENT } });
    expect(failed.map((e) => (e.payload as { reason: string }).reason)).toEqual(['HOST_UNSUPPORTED']);
  });

  it('a lapsed registration counts as none', async () => {
    await db.hostRegistration.updateMany({ data: { refreshedAt: new Date(Date.now() - 120 * MIN) } });
    const t = await f.startedTask();
    await f.finish(t.id);
    expect(await resetOf(t.id)).toMatchObject({ phase: 'failed', reason: 'HOST_UNSUPPORTED' });
  });

  it('a capable host that does not register Kit is not chosen', async () => {
    await f.register(f.orca1, { capabilities: null });
    const orca2 = await f.hostKey('orca2');
    await f.register(orca2, { workers: [f.ada.id] });
    const t = await f.startedTask();
    await f.finish(t.id);
    expect(await resetOf(t.id)).toMatchObject({ reason: 'HOST_UNSUPPORTED' });
  });

  it('registerHost refuses an unknown capability, and reads back the declared set', async () => {
    expect(await code(f.register(f.orca1, { capabilities: ['worker.teleport'] }))).toBe('BAD_HOST_REGISTRATION');
    const regs = await db.hostRegistration.findMany({ select: { capabilities: true } });
    expect(regs).toEqual([{ capabilities: ['worker.reset-context'] }]);
  });

  it('nobody issues worker.reset-context by hand', async () => {
    const t = await f.startedTask();
    expect(await code(M.issueHostOperation({}, {
      input: { appRef: f.app.id, hostId: 'orca1', worker: f.kit.id, type: 'worker.reset-context', args: { sessionId: f.session.id, taskId: t.id, resetId: t.id } },
    }, ctx(f.manager.id)))).toBe('HOST_OPERATION_NOT_ISSUABLE');
  });
});

describe('the finish never depends on the reset (the savepoint boundary)', () => {
  it('an SQL error inside the issue step: the finish commits its outcome, with no reset and no operation', async () => {
    __contextResetTesting.beforeIssueInsert = async (tx) => {
      await tx.$executeRawUnsafe('SELECT 1/0');
    };
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const t = await f.startedTask();
    expect(await f.finish(t.id)).toMatchObject({ status: 'finished', resultOutcome: 'succeeded' });
    spy.mockRestore();
    expect(await db.agentTask.findUniqueOrThrow({ where: { id: t.id } })).toMatchObject({ status: 'finished', resultOutcome: 'succeeded' });
    expect(await resetOf(t.id)).toBeNull();
    expect(await db.hostOperation.count()).toBe(0);
    expect(await db.agentTeamEvent.count({ where: { type: 'task.finished', taskId: t.id } })).toBe(1);
  });
});

describe('once per finish (§5)', () => {
  it('a second finish is refused as ended and requests nothing more', async () => {
    const t = await f.startedTask();
    await f.finish(t.id);
    expect(await code(f.finish(t.id))).toBe('TASK_ENDED');
    expect(await db.contextReset.count()).toBe(1);
    expect(await db.hostOperation.count()).toBe(1);
  });
});

describe('the Agent field', () => {
  it('round-trips through create and update; whoever cannot manage the Agent may not set it', async () => {
    const a = await db.agent.findUniqueOrThrow({ where: { id: f.agentId } });
    expect(a.resetContextAfterTask).toBe(true);
    const off = await M.updateAgent({}, { ref: f.agentId, resetContextAfterTask: false }, ctx(f.manager.id));
    expect(off.resetContextAfterTask).toBe(false);
    const kept = await M.updateAgent({}, { ref: f.agentId, resetContextAfterTask: null }, ctx(f.manager.id));
    expect(kept.resetContextAfterTask).toBe(false);
    const fresh = await M.createAgent({}, { orgId: f.orgId, name: 'Default Agent' }, ctx(f.manager.id));
    expect(fresh.resetContextAfterTask).toBe(false);
    await expect(M.updateAgent({}, { ref: f.agentId, resetContextAfterTask: true }, ctx(f.holder.id))).rejects.toThrow();
    expect((await db.agent.findUniqueOrThrow({ where: { id: f.agentId } })).resetContextAfterTask).toBe(false);
  });
});
