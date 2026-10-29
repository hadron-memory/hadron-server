/** #2644: blocker lifecycle, serial graph decisions, priority and exact assigner authority. */
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { ApolloServer } from '@apollo/server';
import { typeDefs } from './typeDefs.js';
import { loadStallInputs, stallCandidates, raiseStallAlarm, STALL_WINDOW_DEFAULTS } from '../../../lib/agentTasks/stall.js';
import { runAsActor } from '../../../lib/requestActor.js';
import { lockTaskGraph } from '../../../lib/agentTasks/blockers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';
const M = resolvers.Mutation as any;
const F = resolvers as any;
let appId: string, ownerId: string, memberId: string;
const ctx = (userId = ownerId): Context => ({ db, userId, roles: ['READER'] });
const create = (input = {}, c = ctx()) => M.createAgentTask(null, { input: { appRef: appId, title: 'Synthetic task', ...input } }, c);
const add = (taskId: string, blockerTaskId: string, c = ctx()) => M.addAgentTaskBlocker(null, { taskRef: taskId, blockerTaskRef: blockerTaskId }, c);
const remove = (taskId: string, blockerTaskId: string) => M.removeAgentTaskBlocker(null, { taskRef: taskId, blockerTaskRef: blockerTaskId }, ctx());
const code = async (fn: () => Promise<unknown>) => { try { await fn(); return 'SUCCESS'; } catch (e) { return (e as any).extensions?.code ?? (e as Error).message; } };
beforeEach(async () => {
  await cleanDb(db);
  ownerId = (await db.user.create({ data: { id: generateId(), name: 'Owner', handle: 'syntheticowner' } })).id;
  memberId = (await db.user.create({ data: { id: generateId(), name: 'Member', handle: 'syntheticmember' } })).id;
  const agent = await db.agent.create({ data: { id: generateId(), ownerUserId: ownerId, name: 'Synthetic', urn: 'syntheticowner:agent' } });
  appId = (await db.app.create({ data: { id: generateId(), ownerUserId: ownerId, name: 'Synthetic', urn: 'syntheticowner:app' } })).id;
  await db.appMember.create({ data: { appId, userId: memberId, role: 'member' } });
});
describe('#2644 blockers and priority', () => {
  it('defaults priority1 and atomically creates blockers without changing status/manual assignment', async () => {
    const b = await create();
    const t = await create({ blockedBy: [b.id], assignee: { user: ownerId } });
    expect(t).toMatchObject({ priority: 1, blocked: true, status: 'pending', assigneeUserId: ownerId });
    expect(await F.AgentTask.blockedBy(t, {}, ctx())).toMatchObject({ items: [expect.objectContaining({ id: b.id })], total: 1, hasMore: false });
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
  it('serializes two opposite-edge writes that are both queued on the graph lock', async () => {
    const a = await create(), b = await create();
    let unlock!: () => void, ready!: (pid: number) => void;
    const holding = new Promise<void>((r) => { unlock = r; });
    const arrived = new Promise<number>((r) => { ready = r; });
    const holder = db.$transaction(async (tx) => {
      await lockTaskGraph(tx, appId);
      const [row] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      ready(row.pid); await holding;
    });
    const pid = await arrived;
    const first = code(() => add(a.id, b.id)), second = code(() => add(b.id, a.id));
    try {
      let waiting = 0;
      for (let i = 0; i < 100 && waiting < 2; i++) {
        const [row] = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM pg_locks w
          JOIN pg_locks h ON h.locktype=w.locktype AND h.database IS NOT DISTINCT FROM w.database
            AND h.classid=w.classid AND h.objid=w.objid AND h.objsubid=w.objsubid
          WHERE h.pid=${pid} AND h.granted AND NOT w.granted`;
        waiting = Number(row.n);
        if (waiting < 2) await new Promise((r) => setTimeout(r, 10));
      }
      expect(waiting).toBe(2);
    } finally { unlock(); await holder; }
    expect((await Promise.all([first, second])).sort()).toEqual(['SUCCESS', 'TASK_BLOCKER_CYCLE']);
  });
  it('preserves append-only history when physical deletion releases a dependent', async () => {
    const b = await create(), t = await create({ blockedBy: [b.id] });
    const events = await db.agentTeamEvent.findMany({ where: { taskId: b.id } });
    await db.agentTask.delete({ where: { id: b.id } });
    expect(await db.agentTeamEvent.findMany({ where: { taskId: b.id } })).toEqual(events);
    expect(await db.agentTask.findUniqueOrThrow({ where: { id: t.id } })).toMatchObject({ blocked: false });
  });
  it('refuses cross-App and unknown blocker refs identically, atomically on create too', async () => {
    const foreignApp = await db.app.create({ data: { ownerUserId: memberId, name: 'Foreign', urn: 'syntheticmember:foreign' } });
    const foreign = await db.agentTask.create({ data: { appId: foreignApp.id, title: 'Foreign', ownerUserId: memberId } });
    const t = await create();
    for (const blockerTaskId of [foreign.id, generateId()]) {
      expect(await code(() => add(t.id, blockerTaskId))).toBe('TASK_NOT_FOUND');
      const before = await db.agentTask.count();
      expect(await code(() => create({ blockedBy: [blockerTaskId] }))).toBe('TASK_NOT_FOUND');
      expect(await db.agentTask.count()).toBe(before);
    }
  });
  it('rechecks management authority and denies App keys', async () => {
    const t = await create({ owner: { user: memberId } });
    await db.appMember.create({ data: { appId, userId: ownerId, role: 'member' } });
    const stale = ctx();
    await M.setAgentTaskPriority(null, { taskRef: t.id, priority: 2 }, stale);
    await db.app.update({ where: { id: appId }, data: { ownerUserId: memberId } });
    expect(await code(() => M.setAgentTaskPriority(null, { taskRef: t.id, priority: 3 }, stale))).toBe('TASK_NOT_OWNER');
    expect(await code(() => M.setAgentTaskPriority(null, { taskRef: t.id, priority: 3 }, { db, appId, roles: [] }))).toBe('TASK_NOT_FOUND');
  });
  it('uses worker ownership/reporting authority without inheriting the driver management role', async () => {
    const agent = await db.agent.findFirstOrThrow({ where: { ownerUserId: ownerId } });
    const senior = await db.worker.create({ data: { appId, agentId: agent.id, name: 'Senior', slug: 'senior', signature: '', trailer: '' } });
    const worker = await db.worker.create({ data: { appId, agentId: agent.id, name: 'Junior', slug: 'junior', signature: '', trailer: '', reportsToWorkerId: senior.id } });
    const as = (id: string, fn: () => Promise<any>) => runAsActor({ workerId: id, agentId: agent.id }, fn);
    const t = await as(worker.id, () => create());
    expect(await as(worker.id, () => M.setAgentTaskPriority(null, { taskRef: t.id, priority: 2 }, ctx()))).toMatchObject({ priority: 2 });
    expect(await as(senior.id, () => M.setAgentTaskPriority(null, { taskRef: t.id, priority: 3 }, ctx()))).toMatchObject({ priority: 3 });
    const humanOwned = await create();
    expect(await code(() => as(senior.id, () => M.setAgentTaskPriority(null, { taskRef: humanOwned.id, priority: 4 }, ctx())))).toBe('TASK_NOT_OWNER');
  });
  it('finishing the last blocker releases and explicit assignment/park/ready remain available', async () => {
    const b = await create({ assignee: { user: ownerId } });
    const t = await create({ blockedBy: [b.id], status: 'BACKLOG' });
    await M.makeAgentTaskReady(null, { taskId: t.id }, ctx());
    await M.parkAgentTask(null, { taskId: t.id }, ctx());
    expect(await M.assignAgentTask(null, { taskId: t.id, assignee: { user: ownerId } }, ctx())).toMatchObject({ blocked: true, status: 'pending' });
    await M.startAgentTask(null, { taskId: b.id }, ctx());
    await M.finishAgentTask(null, { taskId: b.id, result: { outcome: 'succeeded' } }, ctx());
    expect(await db.agentTask.findUniqueOrThrow({ where: { id: t.id } })).toMatchObject({ blocked: false, releasedAt: expect.any(Date), assigneeUserId: ownerId });
    expect(await db.agentTeamEvent.count({ where: { taskId: t.id, type: 'task.released' } })).toBe(1);
  });
  it('SQL rejects same-App violations, cycles, invalid priorities and blocked starts', async () => {
    const a = await create(), b = await create({ blockedBy: [a.id], assignee: { user: ownerId } });
    await expect(db.agentTaskBlocker.create({ data: { taskId: a.id, blockerTaskId: b.id } })).rejects.toThrow();
    await expect(db.agentTask.update({ where: { id: b.id }, data: { status: 'started', startedAt: new Date() } })).rejects.toThrow();
    await expect(db.agentTask.update({ where: { id: a.id }, data: { priority: 0 } })).rejects.toThrow();
    const foreignApp = await db.app.create({ data: { ownerUserId: memberId, name: 'Other', urn: 'syntheticmember:other' } });
    const foreign = await db.agentTask.create({ data: { appId: foreignApp.id, title: 'Other', ownerUserId: memberId } });
    await expect(db.agentTaskBlocker.create({ data: { taskId: a.id, blockerTaskId: foreign.id } })).rejects.toThrow();
    await expect(db.agentTask.update({ where: { id: a.id }, data: { appId: foreignApp.id } })).rejects.toThrow();
    await expect(db.agentTask.update({ where: { id: b.id }, data: { appId: foreignApp.id } })).rejects.toThrow();
  });
  it('the real stall loader and final raise recheck suppress a newly blocked candidate and floor release', async () => {
    const b = await create({ status: 'BACKLOG' });
    const t = await create({ assignee: { user: ownerId }, startBy: new Date(Date.now() - 120_000).toISOString() });
    await db.agentTask.update({ where: { id: t.id }, data: { assignedAt: new Date(Date.now() - 3_600_000) } });
    const now = new Date();
    const [before] = await loadStallInputs(db, { id: t.id }, now);
    const candidate = stallCandidates(before, STALL_WINDOW_DEFAULTS, now)[0];
    expect(candidate.rule).toBe('not-started');
    await add(t.id, b.id);
    expect(await raiseStallAlarm(db, candidate, now)).toBeNull();
    await remove(t.id, b.id);
    const row = await db.agentTask.findUniqueOrThrow({ where: { id: t.id } });
    const release = row.releasedAt!;
    const [after] = await loadStallInputs(db, { id: t.id }, release);
    expect(stallCandidates(after, STALL_WINDOW_DEFAULTS, new Date(release.getTime() + 14 * 60_000))).toEqual([]);
    expect(stallCandidates(after, STALL_WINDOW_DEFAULTS, new Date(release.getTime() + 15 * 60_000))[0]).toMatchObject({ rule: 'not-started', episodeStart: release });
  });
  it('GraphQL exposes create, priority, blocker changes and bounded dependency pages', async () => {
    const server = new ApolloServer<Context>({ typeDefs, resolvers });
    try {
      const b = await create();
      const response = await server.executeOperation({ query: `mutation($input: CreateAgentTaskInput!) {
        createAgentTask(input:$input) { id priority blocked blockedBy(limit:0) { items { id } total hasMore } }
      }`, variables: { input: { appRef: appId, title: 'Wire', priority: 4, blockedBy: [b.id] } } }, { contextValue: ctx() });
      expect(response.body.kind).toBe('single');
      if (response.body.kind === 'single') {
        expect(response.body.singleResult.errors).toBeUndefined();
        expect(response.body.singleResult.data).toMatchObject({ createAgentTask: { priority: 4, blocked: true,
          blockedBy: { items: [], total: 1, hasMore: true } } });
        const t = (response.body.singleResult.data as any).createAgentTask;
        const stored = await db.agentTask.findUniqueOrThrow({ where: { id: t.id } });
        const changed = await server.executeOperation({ query: `mutation($t:ID!,$b:ID!) {
          priority: setAgentTaskPriority(taskRef:$t,priority:2) { priority }
          unlink: removeAgentTaskBlocker(taskRef:$t,blockerTaskRef:$b) { blocked }
          relink: addAgentTaskBlocker(taskRef:$t,blockerTaskRef:$b) { blocked }
        }`, variables: { t: `hrn:agenttask:syntheticowner:app:${stored.handle}`, b: b.handle } }, { contextValue: ctx() });
        expect(changed.body.kind).toBe('single');
        if (changed.body.kind === 'single') {
          expect(changed.body.singleResult.errors).toBeUndefined();
          expect(changed.body.singleResult.data).toMatchObject({ priority: { priority: 2 }, unlink: { blocked: false }, relink: { blocked: true } });
        }
      }
    } finally { await server.stop(); }
  });
  it('returns the actual matched assignee after releasing a queued task', async () => {
    const agent = await db.agent.findFirstOrThrow({ where: { ownerUserId: ownerId } });
    await db.agent.update({ where: { id: agent.id }, data: { usesTasks: true } });
    const w = await db.worker.create({ data: { appId, agentId: agent.id, name: 'Ready', slug: 'ready', signature: '', trailer: '' } });
    await db.session.create({ data: { id: generateId(), appId, agentId: agent.id, workerId: w.id, userId: ownerId, family: 'codex' } });
    const b = await create({ status: 'BACKLOG' });
    const t = await create({ blockedBy: [b.id] });
    expect(t.assigneeWorkerId).toBeNull();
    expect(await remove(t.id, b.id)).toMatchObject({ blocked: false, assigneeWorkerId: w.id });
  });
  it('priority range is1..5 and assignee-only creators/setters cannot bypass assigner authority', async () => {
    const t = await create({ assignee: { user: memberId } });
    expect(await code(() => M.setAgentTaskPriority(null, { taskRef: t.id, priority: 5 }, ctx(memberId)))).toBe('TASK_NOT_OWNER');
    expect(await code(() => add(t.id, t.id, ctx(memberId)))).toBe('TASK_NOT_OWNER');
    for (const priority of [0, 6]) expect(await code(() => M.setAgentTaskPriority(null, { taskRef: t.id, priority }, ctx()))).toBe('BAD_USER_INPUT');
    expect(await M.setAgentTaskPriority(null, { taskRef: t.id, priority: 5 }, ctx())).toMatchObject({ priority: 5 });
    const before = await db.agentTask.count();
    expect(await code(() => create({ priority: 1, owner: { user: ownerId } }, ctx(memberId)))).toBe('TASK_NOT_OWNER');
    expect(await db.agentTask.count()).toBe(before);
  });
});
