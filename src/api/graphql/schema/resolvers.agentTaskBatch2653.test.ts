/**
 * #2653 (hrn:node:hadronmemory.com:specs:cor:agt:050:06, "Creating several at once"; ruling 0011 A): one call creates
 * a list of tasks, all or none. Each task is judged as if created alone, the first refusal refuses the call and names
 * its position (1-based), handles and returns follow list order, events are a single create's, warnings are filed per
 * task after commit, blockers may name an existing task or another task of the call by position, and the cap is 25.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
import { resolvers, type Context } from './resolvers.js';
import { typeDefs } from './typeDefs.js';
import { shapeResponseWarnings } from './resolvers.taskWarnings.js';
import { setStopSignal } from '../../../lib/stopSignals/lifecycle.js';
import { lockStopFence } from '../../../lib/stopSignals/state.js';

const M = resolvers.Mutation as any;
let appId: string, ownerId: string, memberId: string, outsiderId: string;
const ctx = (userId = ownerId): Context => ({ db, userId, roles: ['READER'] });
const INFO = { path: { key: 'createAgentTasks', prev: undefined, typename: 'Mutation' } };
const item = (task: Record<string, unknown> = {}, blockedByPositions?: number[]) =>
  ({ task: { title: 'Synthetic task', source: 'https://example.test/1', ...task }, ...(blockedByPositions ? { blockedByPositions } : {}) });
const batch = (tasks: unknown[], c = ctx(), ref: string = appId, info: unknown = INFO) =>
  M.createAgentTasks(null, { appRef: ref, tasks }, c, info);
const single = (input = {}, c = ctx()) =>
  M.createAgentTask(null, { input: { appRef: appId, title: 'Single', source: 'https://example.test/s', ...input } }, c);
const refusal = async (fn: () => Promise<unknown>) => {
  try { await fn(); return { code: 'SUCCESS', position: undefined }; } catch (e) {
    const ext = (e as any).extensions ?? {};
    return { code: ext.code ?? (e as Error).message, position: ext.position };
  }
};
const realTasks = () => db.agentTask.count({ where: { appId, handle: { not: 'AT0' } } });

beforeEach(async () => {
  await cleanDb(db);
  ownerId = (await db.user.create({ data: { id: generateId(), name: 'Owner', handle: 'syntheticowner' } })).id;
  memberId = (await db.user.create({ data: { id: generateId(), name: 'Member', handle: 'syntheticmember' } })).id;
  outsiderId = (await db.user.create({ data: { id: generateId(), name: 'Outsider', handle: 'syntheticoutsider' } })).id;
  appId = (await db.app.create({ data: { id: generateId(), ownerUserId: ownerId, name: 'Synthetic', urn: 'syntheticowner:app' } })).id;
  await db.appMember.create({ data: { appId, userId: memberId, role: 'member' } });
});

describe('#2653 createAgentTasks (cor:agt:050:06 creating several at once)', () => {
  it('SDL: the mutation, its item input and the position field exist', () => {
    expect(typeDefs).toMatch(/createAgentTasks\(appRef: ID!, tasks: \[CreateAgentTasksItemInput!\]!\): \[AgentTask!\]!/);
    expect(typeDefs).toMatch(/input CreateAgentTasksItemInput \{[\s\S]*task: CreateAgentTaskInput![\s\S]*blockedByPositions: \[Int!\]/);
  });

  it('creates five tasks in one call, handles and returns in list order', async () => {
    const made = await batch([1, 2, 3, 4, 5].map(n => item({ title: `Task ${n}` })));
    expect(made.map((t: any) => t.title)).toEqual(['Task 1', 'Task 2', 'Task 3', 'Task 4', 'Task 5']);
    expect(made.map((t: any) => t.handle)).toEqual(['AT0.1', 'AT0.2', 'AT0.3', 'AT0.4', 'AT0.5']);
    const rows = await db.agentTask.findMany({ where: { id: { in: made.map((t: any) => t.id) } } });
    expect(rows).toHaveLength(5);
    expect(new Set(rows.map(r => r.ownerUserId))).toEqual(new Set([ownerId]));
  });

  it('S6: the fourth refused leaves nothing, names position 4, and spends no handle', async () => {
    const tasks = [item(), item(), item(), item({ assignee: { user: outsiderId } }), item()];
    expect(await refusal(() => batch(tasks))).toEqual({ code: 'TASK_ASSIGNEE_INVALID', position: 4 });
    expect(await realTasks()).toBe(0);
    expect(await db.agentTeamEvent.count({ where: { appId } })).toBe(0);
    // The counter rolled back with the call: the next create takes the first number.
    expect((await single()).handle).toBe('AT0.1');
  });

  it('a refusal judged before the write also names its position and writes nothing', async () => {
    expect(await refusal(() => batch([item(), item({ title: '   ' })]))).toEqual({ code: 'BAD_USER_INPUT', position: 2 });
    expect(await realTasks()).toBe(0);
  });

  it('S7: 26 tasks are refused before anything is created; 25 pass; an empty list is refused', async () => {
    expect((await refusal(() => batch(Array.from({ length: 26 }, () => item())))).code).toBe('TASK_BATCH_TOO_LARGE');
    expect(await db.agentTask.count({ where: { appId } })).toBe(0);
    expect((await refusal(() => batch([]))).code).toBe('BAD_USER_INPUT');
    expect(await batch(Array.from({ length: 25 }, () => item()))).toHaveLength(25);
  });

  it('records exactly the events single creates record, and nothing for a refused call', async () => {
    const made = await batch([item({ title: 'A' }), item({ title: 'B', assignee: { user: memberId } }), item({ title: 'C' })]);
    const types = async (id: string) => (await db.agentTeamEvent.findMany({ where: { taskId: id } })).map(e => e.type).sort();
    expect(await types(made[0].id)).toEqual(['assignment.queued', 'task.created']);
    expect(await types(made[1].id)).toEqual(['task.assigned', 'task.created']);
    expect(await types(made[2].id)).toEqual(['assignment.queued', 'task.created']);
    // The same three made one at a time record the same kinds of event.
    const one = await single({ title: 'B1', assignee: { user: memberId } });
    expect(await types(one.id)).toEqual(await types(made[1].id));
    const before = await db.agentTeamEvent.count({ where: { appId } });
    await refusal(() => batch([item(), item({ owner: { user: outsiderId } })]));
    expect(await db.agentTeamEvent.count({ where: { appId } })).toBe(before);
  });

  it('files each task\'s warnings after commit under its own position, and none for a refused call', async () => {
    const c = ctx();
    await batch([item({ source: null }), item(), item({ source: null })], c);
    const paths = (c.taskWarnings ?? []).map(w => [w.path, w.warning.code]);
    expect(paths).toEqual([['createAgentTasks.1', 'task.create.no-source'], ['createAgentTasks.3', 'task.create.no-source']]);
    // A mutation that errored contributes none, its per-task paths included.
    expect(shapeResponseWarnings(c.taskWarnings ?? [], new Set(['createAgentTasks']))).toEqual([]);
    const refused = ctx();
    await refusal(() => batch([item({ source: null }), item({ assignee: { user: outsiderId } })], refused));
    expect(refused.taskWarnings ?? []).toEqual([]);
  });

  it('blocks by position and by existing task; refuses a self-block, a cycle and a position out of range', async () => {
    const existing = await single();
    const made = await batch([item(), item({ blockedBy: [existing.id] }, [1]), item({}, [1, 2])]);
    const edges = async (id: string) => (await db.agentTaskBlocker.findMany({ where: { taskId: id } })).map(b => b.blockerTaskId).sort();
    expect(await edges(made[0].id)).toEqual([]);
    expect(await edges(made[1].id)).toEqual([existing.id, made[0].id].sort());
    expect(await edges(made[2].id)).toEqual([made[0].id, made[1].id].sort());
    expect(made[1]).toMatchObject({ blocked: true });
    const before = await realTasks();
    expect(await refusal(() => batch([item(), item({}, [2])]))).toEqual({ code: 'TASK_BLOCKER_CYCLE', position: 2 });
    expect(await refusal(() => batch([item({}, [2]), item({}, [1])]))).toEqual({ code: 'TASK_BLOCKER_CYCLE', position: 2 });
    expect(await refusal(() => batch([item(), item({}, [3])]))).toEqual({ code: 'BAD_USER_INPUT', position: 2 });
    expect(await refusal(() => batch([item({}, [0])]))).toEqual({ code: 'BAD_USER_INPUT', position: 1 });
    expect(await realTasks()).toBe(before);
  });

  it('naming blockers by position needs the assigner authority, as blockedBy does', async () => {
    // A member creating a task owned by someone else cannot direct it, so it cannot block it.
    const refused = await refusal(() => batch([item(), item({ owner: { user: ownerId } }, [1])], ctx(memberId)));
    expect(refused).toEqual({ code: 'TASK_NOT_OWNER', position: 2 });
    expect(await realTasks()).toBe(0);
  });

  it('creates child tasks of an existing parent the caller is assigned; another App\'s parent reads as not found', async () => {
    const parent = await single({ assignee: { user: ownerId } });
    const made = await batch([item({ parentTaskId: parent.id }), item({ parentTaskId: parent.id })]);
    expect(made.map((t: any) => t.handle)).toEqual([`${parent.handle}.1`, `${parent.handle}.2`]);
    const foreignApp = await db.app.create({ data: { ownerUserId: ownerId, name: 'Other', urn: 'syntheticowner:other' } });
    const foreignParent = await M.createAgentTask(null, { input: { appRef: foreignApp.id, title: 'Foreign', assignee: { user: ownerId } } }, ctx());
    expect(await refusal(() => batch([item(), item({ parentTaskId: foreignParent.id })]))).toEqual({ code: 'TASK_NOT_FOUND', position: 2 });
    // A root task naming another App is refused as that App is, never created in the call's App.
    expect(await refusal(() => batch([item({ appRef: foreignApp.id })]))).toEqual({ code: 'APP_NOT_FOUND', position: 1 });
    expect(await db.agentTask.count({ where: { parentTaskId: parent.id } })).toBe(2);
  });

  it('a child under a parent the caller is not assigned is refused like a single create', async () => {
    const parent = await single({ assignee: { user: memberId } });
    expect(await refusal(() => batch([item({ parentTaskId: parent.id })]))).toEqual({ code: 'TASK_NOT_ASSIGNEE', position: 1 });
  });

  it('cross-tenant: an outsider is refused as for a single create, and a foreign owner is TASK_OWNER_INVALID at its position', async () => {
    expect((await refusal(() => batch([item()], ctx(outsiderId)))).code).toBe('APP_NOT_FOUND');
    expect(await refusal(() => batch([item(), item({ owner: { user: outsiderId } })]))).toEqual({ code: 'TASK_OWNER_INVALID', position: 2 });
    expect(await realTasks()).toBe(0);
  });

  it('a stop-covered worker assignee refuses the whole call at its position', async () => {
    const agent = await db.agent.create({ data: { id: generateId(), ownerUserId: ownerId, name: 'Synthetic', urn: 'syntheticowner:agent' } });
    const w = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId, agentId: agent.id, name: 'Rook', slug: 'rook' } });
    await db.$transaction(async (tx) => {
      await lockStopFence(tx, appId, 'exclusive');
      await setStopSignal(tx, { appId, level: 'pause', scope: 'worker', targetWorkerId: w.id, targetHostRegistrationId: null, until: null, by: { userId: ownerId, actor: { userId: ownerId, workerId: null, agentId: null } } }, new Date());
    });
    const alone = await refusal(() => single({ assignee: { worker: w.id } }));
    expect(alone.code).not.toBe('SUCCESS');
    expect(await refusal(() => batch([item(), item({ assignee: { worker: w.id } })]))).toEqual({ code: alone.code, position: 2 });
    expect(await realTasks()).toBe(0);
  });

  it('two calls locking the same two parents in opposite list order both commit (no deadlock)', async () => {
    const p = await single({ assignee: { user: ownerId } });
    const q = await single({ assignee: { user: ownerId } });
    for (let round = 0; round < 3; round++) {
      const results = await Promise.allSettled([
        batch([item({ parentTaskId: p.id }), item({ parentTaskId: q.id })]),
        batch([item({ parentTaskId: q.id }), item({ parentTaskId: p.id })]),
        single({ parentTaskId: p.id, appRef: undefined }),
      ]);
      expect(results.map(r => r.status)).toEqual(['fulfilled', 'fulfilled', 'fulfilled']);
    }
    expect(await db.agentTask.count({ where: { parentTaskId: p.id } })).toBe(9);
    const handles = (await db.agentTask.findMany({ where: { parentTaskId: p.id }, select: { handle: true } })).map(r => r.handle);
    expect(new Set(handles).size).toBe(9);
  }, 20000);

  it('is not idempotent: the same list sent twice makes two sets', async () => {
    await batch([item({ title: 'X' })]);
    await batch([item({ title: 'X' })]);
    expect(await db.agentTask.count({ where: { appId, title: 'X' } })).toBe(2);
  });
});
