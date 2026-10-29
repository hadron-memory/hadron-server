/** #2644: blocker lifecycle, serial graph decisions, priority and exact assigner authority. */
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';
const M = resolvers.Mutation as any;
const F = resolvers as any;
let appId: string, ownerId: string, memberId: string;
const ctx = (userId = ownerId): Context => ({ db, userId, roles: ['READER'] });
const create = (input = {}, c = ctx()) => M.createAgentTask(null, { input: { appRef: appId, title: 'Synthetic task', ...input } }, c);
const add = (taskId: string, blockerTaskId: string, c = ctx()) => M.addAgentTaskBlocker(null, { taskId, blockerTaskId }, c);
const remove = (taskId: string, blockerTaskId: string) => M.removeAgentTaskBlocker(null, { taskId, blockerTaskId }, ctx());
const code = async (fn: () => Promise<unknown>) => { try { await fn(); return 'SUCCESS'; } catch (e) { return (e as any).extensions?.code ?? (e as Error).message; } };
beforeEach(async () => {
  await cleanDb(db);
  ownerId = (await db.user.create({ data: { id: generateId(), name: 'Owner' } })).id;
  memberId = (await db.user.create({ data: { id: generateId(), name: 'Member' } })).id;
  const agent = await db.agent.create({ data: { id: generateId(), ownerUserId: ownerId, name: 'Synthetic', urn: '@owner:agent' } });
  appId = (await db.app.create({ data: { id: generateId(), ownerUserId: ownerId, name: 'Synthetic', urn: '@owner:app' } })).id;
  await db.appMember.create({ data: { appId, userId: memberId, role: 'member' } });
});
describe('#2644 blockers and priority', () => {
  it('defaults priority1 and atomically creates blockers without changing status/manual assignment', async () => {
    const b = await create();
    const t = await create({ blockedBy: [b.id], assignee: { user: ownerId } });
    expect(t).toMatchObject({ priority: 1, blocked: true, status: 'pending', assigneeUserId: ownerId });
    expect(await F.AgentTask.blockedBy(t, {}, ctx())).toEqual([expect.objectContaining({ id: b.id })]);
    expect(await code(() => M.startAgentTask(null, { taskId: t.id }, ctx()))).toBe('TASK_BLOCKED');
  });
  it('last blocker alone releases and records exactly once, preserving manual assignee', async () => {
    const a = await create(), b = await create();
    const t = await create({ blockedBy: [a.id, b.id], assignee: { user: ownerId } });
    await M.cancelAgentTask(null, { taskId: a.id }, ctx());
    expect((await db.agentTask.findUniqueOrThrow({ where: { id: t.id } })) as any).toMatchObject({ blocked: true, releasedAt: null });
    await M.cancelAgentTask(null, { taskId: b.id }, ctx());
    expect((await db.agentTask.findUniqueOrThrow({ where: { id: t.id } })) as any).toMatchObject({ blocked: false, releasedAt: expect.any(Date), assigneeUserId: ownerId });
    await remove(t.id, a.id);
    expect(await db.agentTeamEvent.count({ where: { taskId: t.id, type: 'task.released' } })).toBe(1);
    await M.startAgentTask(null, { taskId: t.id }, ctx());
    expect(await code(() => add(t.id, a.id))).toBe('TASK_INVALID_TRANSITION');
  });
  it('edge removal and physical blocker deletion release and repeated blocks get new anchors', async () => {
    const a = await create(), b = await create(), t = await create({ blockedBy: [a.id] });
    await remove(t.id, a.id);
    const one = (await db.agentTask.findUniqueOrThrow({ where: { id: t.id } }) as any).releasedAt;
    await add(t.id, b.id);
    await db.agentTask.delete({ where: { id: b.id } });
    const two = await db.agentTask.findUniqueOrThrow({ where: { id: t.id } }) as any;
    expect(two.blocked).toBe(false);
    expect(two.releasedAt.getTime()).toBeGreaterThanOrEqual(one.getTime());
    expect(await db.agentTeamEvent.count({ where: { taskId: t.id, type: 'task.released' } })).toBe(2);
  });
  it('refuses self, indirect and concurrent opposite-edge cycles without a partial graph', async () => {
    const a = await create(), b = await create(), c = await create();
    expect(await code(() => add(a.id, a.id))).toBe('TASK_BLOCKER_CYCLE');
    await add(a.id, b.id); await add(b.id, c.id);
    expect(await code(() => add(c.id, a.id))).toBe('TASK_BLOCKER_CYCLE');
    await remove(a.id, b.id); await remove(b.id, c.id);
    const results = await Promise.all([code(() => add(a.id, b.id)), code(() => add(b.id, a.id))]);
    expect(results.sort()).toEqual(['SUCCESS', 'TASK_BLOCKER_CYCLE']);
  });
  it('priority range is1..5 and assignee-only creators/setters cannot bypass assigner authority', async () => {
    const t = await create({ assignee: { user: memberId } });
    expect(await code(() => M.setAgentTaskPriority(null, { taskId: t.id, priority: 5 }, ctx(memberId)))).toBe('TASK_NOT_OWNER');
    expect(await code(() => add(t.id, t.id, ctx(memberId)))).toBe('TASK_NOT_OWNER');
    for (const priority of [0, 6]) expect(await code(() => M.setAgentTaskPriority(null, { taskId: t.id, priority }, ctx()))).toBe('BAD_USER_INPUT');
    expect(await M.setAgentTaskPriority(null, { taskId: t.id, priority: 5 }, ctx())).toMatchObject({ priority: 5 });
    const before = await db.agentTask.count();
    expect(await code(() => create({ priority: 1, owner: { user: ownerId } }, ctx(memberId)))).toBe('TASK_NOT_OWNER');
    expect(await db.agentTask.count()).toBe(before);
  });
});
