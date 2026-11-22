/**
 * #4447 (S1 of #3781): `teamMetrics(appRef, since, until)`, the server-computed counts of a team's task and worker flow
 * (hrn:node:hadronmemory.com:specs:cor:agt:150 and Definitions :01-:05). Reports 1-4, every count with its ids.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApolloServer } from '@apollo/server';
import { assertObjectType, buildASTSchema, parse } from 'graphql';
import { PrismaClient } from '../../../generated/prisma/index.js';
import { typeDefs } from './typeDefs.js';
import { resolvers, type Context } from './resolvers.js';
import * as taskModule from './resolvers.agentTask.js';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
import { appendAlarmEvent } from '../../../lib/agentTasks/events.js';
import { METRICS_DEFAULT_WINDOW_MS, METRICS_GROUP_CAP, METRICS_IDS_CAP, METRICS_MAX_WINDOW_MS } from '../../../lib/agentTasks/teamMetrics.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
const M = resolvers.Mutation as any;
const server = new ApolloServer<Context>({ typeDefs, resolvers });
beforeAll(() => server.start());
afterAll(() => server.stop());

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const ago = (ms: number) => new Date(Date.now() - ms);
const ctx = (userId?: string): Context => ({ db, userId, roles: ['READER'] });

let appId: string, agentId: string, memberId: string, outsiderId: string, otherAppId: string;
const w: Record<string, string> = {};
const MISSING_APP = generateId(); // well-formed, no such App

const COUNT = 'total ids truncated';
const METRICS = `query($app: ID!, $since: DateTime, $until: DateTime) { teamMetrics(appRef: $app, since: $since, until: $until) {
  appId asOf window { since until }
  startedOwned { all { ${COUNT} } ownersTruncated byOwner { owner { kind id name } tasks { ${COUNT} } projectsTruncated
    byProject { project { handle taskId title noProject } tasks { ${COUNT} } } } }
  projects { truncated items { project { handle taskId title noProject } children { status tasks { ${COUNT} } } } }
  workers { active { ${COUNT} } idle { ${COUNT} } overdue { ${COUNT} } inop { ${COUNT} } }
  flow { completed { ${COUNT} } started { ${COUNT} } }
} }`;
async function run(vars: Record<string, unknown> = {}, userId: string | null = memberId, app: string = appId) {
  const result = await server.executeOperation({ query: METRICS, variables: { app, ...vars } }, { contextValue: ctx(userId ?? undefined) });
  if (result.body.kind !== 'single') throw new Error('Expected single GraphQL result');
  return result.body.singleResult;
}
async function ok(vars: Record<string, unknown> = {}) {
  const r = await run(vars);
  expect(r.errors, JSON.stringify(r.errors)).toBeUndefined();
  return (r.data as any).teamMetrics;
}

async function worker(name: string, opts: { role?: string; session?: boolean; app?: string } = {}) {
  const id = generateId();
  await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, id, appId: opts.app ?? appId, agentId, name, slug: name.toLowerCase(), role: opts.role ?? 'engineer', heldByUserId: memberId } });
  if (opts.session !== false) await db.session.create({ data: { id: generateId(), appId: opts.app ?? appId, agentId, workerId: id, family: 'claude', llmModel: 'claude-sonnet-5-5', startedAt: ago(48 * HOUR), updatedAt: ago(48 * HOUR) } });
  return id;
}
type TaskOpts = { owner: string; assignee?: string | null; status?: string; parent?: string | null; source?: string | null; externalId?: string | null; startedAt?: Date; finishedAt?: Date; cancelledAt?: Date; app?: string; title?: string };
async function task(o: TaskOpts) {
  const status = o.status ?? 'started';
  const assigned = o.assignee ? { assigneeWorkerId: o.assignee, assignedAt: ago(48 * HOUR) } : {};
  return db.agentTask.create({ data: {
    appId: o.app ?? appId, title: o.title ?? 'Synthetic', ownerWorkerId: o.owner, parentTaskId: o.parent ?? null, status,
    source: o.source === undefined ? 'https://github.com/example/repo/issues/1' : o.source, externalId: o.externalId ?? null, ...assigned,
    ...(status === 'started' || status === 'finished' ? { startedAt: o.startedAt ?? ago(2 * HOUR) } : {}),
    ...(status === 'finished' ? { finishedAt: o.finishedAt ?? ago(HOUR), resultOutcome: 'succeeded' } : {}),
    ...(status === 'cancelled' ? { cancelledAt: o.cancelledAt ?? ago(HOUR) } : {}),
  } });
}
async function project(title: string, status = 'started', owner = w.ada) {
  return task({ owner, status, title, source: null, assignee: status === 'pending' ? null : owner });
}
const at0 = () => db.agentTask.create({ data: { appId, title: 'No project', ownerWorkerId: w.ada, status: 'backlog', taskNumber: 0, handle: 'AT0' } });
const idsOf = (c: { ids: string[] }) => [...c.ids].sort();

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { name: 'Metrics', urn: `metrics-${generateId()}.test` } });
  const admin = await db.user.create({ data: { handle: `ma-${generateId()}` } });
  memberId = (await db.user.create({ data: { handle: `mm-${generateId()}` } })).id;
  outsiderId = (await db.user.create({ data: { handle: `mo-${generateId()}` } })).id;
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  agentId = (await M.createAgent({}, { orgRef: org.id, name: 'Metrics Agent' }, ctx(admin.id))).id;
  appId = (await db.app.create({ data: { organizationId: org.id, name: 'Metrics', urn: `metrics-${generateId()}.test:team` } })).id;
  otherAppId = (await db.app.create({ data: { organizationId: org.id, name: 'Other', urn: `metrics-${generateId()}.test:other` } })).id;
  await db.appMember.create({ data: { appId, userId: memberId, role: 'member' } });
  w.ada = await worker('Ada', { role: 'coordinator' });
  w.bo = await worker('Bo', { role: 'coordinator' });
  w.dev1 = await worker('Dev1');
  w.dev2 = await worker('Dev2');
});

describe('#4447 report 1: started owned tasks by owner and project (cor:agt:150:01)', () => {
  it('counts STARTED owned tasks only, by OWNER (not assignee) and project, with the AT0 bucket shown', async () => {
    await at0();
    const p1 = await project('Project one');
    const a1 = await task({ owner: w.ada, assignee: w.dev1, parent: p1.id });
    const a2 = await task({ owner: w.ada, assignee: w.dev1, parent: p1.id, source: null, externalId: 'gh:example/repo#2' });
    const a0 = await task({ owner: w.ada, assignee: w.dev2, parent: (await db.agentTask.findFirstOrThrow({ where: { appId, handle: 'AT0' } })).id });
    const b1 = await task({ owner: w.bo, assignee: w.dev2, parent: p1.id });
    await task({ owner: w.ada, assignee: w.dev1, parent: p1.id, source: null }); // STARTED, tracks no external work: excluded
    await task({ owner: w.ada, parent: p1.id, status: 'pending' }); // not started
    await task({ owner: w.bo, assignee: w.dev1, parent: p1.id, status: 'finished' });
    await task({ owner: w.bo, parent: p1.id, status: 'cancelled' });
    const r = (await ok()).startedOwned;
    // Ada also owns Project one itself, which tracks nothing external and is therefore not an owned task.
    expect(r.all.total).toBe(4);
    expect(idsOf(r.all)).toEqual([a1.id, a2.id, a0.id, b1.id].sort());
    const byOwner = Object.fromEntries(r.byOwner.map((g: any) => [g.owner.id, g]));
    expect(Object.keys(byOwner).sort()).toEqual([w.ada, w.bo].sort());
    expect(byOwner[w.ada].owner).toMatchObject({ kind: 'WORKER', name: 'Ada' });
    expect(byOwner[w.ada].tasks.total).toBe(3);
    expect(idsOf(byOwner[w.ada].tasks)).toEqual([a1.id, a2.id, a0.id].sort());
    expect(byOwner[w.bo].tasks.total).toBe(1);
    expect(idsOf(byOwner[w.bo].tasks)).toEqual([b1.id]);
    // by project, never hiding "No project"
    const ada = Object.fromEntries(byOwner[w.ada].byProject.map((g: any) => [g.project.handle, g]));
    expect(idsOf(ada[p1.handle as string].tasks)).toEqual([a1.id, a2.id].sort());
    expect(ada.AT0.project.noProject).toBe(true);
    expect(ada.AT0.tasks.total).toBe(1);
    expect(ada[p1.handle as string].project).toMatchObject({ taskId: p1.id, title: 'Project one', noProject: false });
  });

  it('a task owned by a person is grouped under that person, sanitized to the party projection', async () => {
    const own = await db.agentTask.create({ data: { appId, title: 'Person task', ownerUserId: memberId, assigneeWorkerId: w.dev1, assignedAt: ago(HOUR), status: 'started', startedAt: ago(HOUR), source: 'https://example.test/issue/9' } });
    const g = (await ok()).startedOwned.byOwner[0];
    expect(g.owner.kind).toBe('USER');
    expect(g.owner.id).toBe(memberId);
    expect(idsOf(g.tasks)).toEqual([own.id]);
  });
});

describe('#4447 report 2: started projects with child counts by status', () => {
  it('lists started top-level tasks other than AT0, each with its direct children counted by status', async () => {
    await at0();
    const p1 = await project('Alpha project');
    await project('Pending project', 'pending');
    await project('Finished project', 'finished');
    const c1 = await task({ owner: w.ada, assignee: w.dev1, parent: p1.id });
    const c2 = await task({ owner: w.ada, parent: p1.id, status: 'pending' });
    await task({ owner: w.ada, parent: p1.id, status: 'pending' });
    const c4 = await task({ owner: w.ada, assignee: w.dev1, parent: p1.id, status: 'finished' });
    const r = (await ok()).projects;
    expect(r.truncated).toBe(false);
    expect(r.items.map((i: any) => i.project.handle)).toEqual([p1.handle]);
    const byStatus = Object.fromEntries(r.items[0].children.map((c: any) => [c.status, c.tasks]));
    expect(byStatus.STARTED).toMatchObject({ total: 1, ids: [c1.id] });
    expect(byStatus.PENDING.total).toBe(2);
    expect(byStatus.PENDING.ids).toContain(c2.id);
    expect(byStatus.FINISHED).toMatchObject({ total: 1, ids: [c4.id] });
    expect(byStatus.CANCELLED).toMatchObject({ total: 0, ids: [], truncated: false });
    expect(byStatus.BACKLOG.total).toBe(0);
  });
});

describe('#4447 report 3: worker counts (cor:agt:150:02-:05)', () => {
  it('active = assignee of a STARTED task; idle = available with nothing assigned; inop on the roster-state clause only', async () => {
    const dev3 = await worker('Dev3'); // bound, free, nothing assigned: idle
    const dev4 = await worker('Dev4', { session: false }); // unbound, no live host: NOT_LAUNCHABLE: inop
    const dev5 = await worker('Dev5'); // own availability record says unavailable: inop
    await db.workerAvailability.create({ data: { workerId: dev5, state: 'unavailable', reason: 'other', setAt: new Date(), setBy: 'worker', setByWorkerId: dev5 } });
    const retired = await worker('Gone');
    await db.worker.update({ where: { id: retired }, data: { retiredAt: new Date() } });
    await task({ owner: w.ada, assignee: w.dev1 }); // dev1 active
    await task({ owner: w.dev2, assignee: w.dev2, status: 'pending' }); // dev2: assigned, not started: neither active nor idle
    await task({ owner: w.dev1, assignee: w.ada }); // Ada active (the owner/assignee roles are not mixed up)
    const r = (await ok()).workers;
    expect(idsOf(r.active)).toEqual([w.dev1, w.ada].sort());
    expect(idsOf(r.idle)).toEqual([w.bo, dev3].sort());
    expect(idsOf(r.inop)).toEqual([dev4, dev5].sort());
    for (const k of ['active', 'idle', 'overdue', 'inop']) expect(r[k].total).toBe(r[k].ids.length);
    expect(JSON.stringify(r)).not.toContain(retired);
  });

  it('a worker can be active and inop at once', async () => {
    await db.workerAvailability.create({ data: { workerId: w.dev1, state: 'unavailable', reason: 'other', setAt: new Date(), setBy: 'worker', setByWorkerId: w.dev1 } });
    await task({ owner: w.ada, assignee: w.dev1 });
    const r = (await ok()).workers;
    expect(r.active.ids).toContain(w.dev1);
    expect(r.inop.ids).toContain(w.dev1);
  });

  async function stallAlarm(taskRow: { id: string; assignedAt: Date | null }, type: 'stall.not-started' | 'stall.no-progress' | 'stall.finish-by' | 'stall.owner-unreactive', assignee: string) {
    return db.$transaction(async (tx) => appendAlarmEvent(tx as never, {
      appId, taskId: taskRow.id, type, episodeStart: taskRow.assignedAt as Date, subjectWorkerId: assignee,
      chain: [{ workerId: w.ada } as never], payload: { windowMinutes: 15 }, createdAt: ago(HOUR),
    }));
  }
  it('overdue = the ASSIGNEE of a task with an alarm in effect; acknowledging or ending the episode moves it', async () => {
    const stalled = await task({ owner: w.ada, assignee: w.dev1, status: 'pending' });
    const row = await db.agentTask.findUniqueOrThrow({ where: { id: stalled.id } });
    const id = await stallAlarm(row, 'stall.not-started', w.dev1);
    expect(id).not.toBeNull();
    let r = (await ok()).workers.overdue;
    expect(r).toMatchObject({ total: 1, ids: [w.dev1] }); // the assignee, never the owner Ada
    // acknowledged: stops counting
    await db.$executeRaw`UPDATE agent_team_events SET acknowledged_at = now(), acknowledged_by_worker_id = ${w.ada} WHERE id = ${id}`;
    r = (await ok()).workers.overdue;
    expect(r.total).toBe(0);
  });
  it('an alarm whose episode ended while the task is still open never counts (a not-started alarm, the task since started)', async () => {
    const moved = await task({ owner: w.ada, assignee: w.dev1, status: 'started' });
    const row = await db.agentTask.findUniqueOrThrow({ where: { id: moved.id } });
    expect(await stallAlarm(row, 'stall.not-started', w.dev1)).not.toBeNull();
    expect((await ok()).workers.overdue.total).toBe(0);
  });
  it('an owner-unreactive alarm in effect is not an overdue clause (cor:agt:150:04 names not-started, no-progress and finish-by)', async () => {
    const parent = await task({ owner: w.ada, assignee: w.dev2, status: 'started' });
    const child = await task({ owner: w.dev2, assignee: w.dev1, parent: parent.id, status: 'finished', finishedAt: ago(2 * HOUR) });
    const childRow = await db.agentTask.findUniqueOrThrow({ where: { id: child.id } });
    const parentRow = await db.agentTask.findUniqueOrThrow({ where: { id: parent.id } });
    const id = await db.$transaction(async (tx) => appendAlarmEvent(tx as never, {
      appId, taskId: parent.id, type: 'stall.owner-unreactive', episodeStart: childRow.finishedAt as Date, subjectWorkerId: w.dev2,
      chain: [{ workerId: w.ada } as never], payload: { windowMinutes: 15, childTaskId: child.id }, createdAt: ago(HOUR),
    }));
    expect(id).not.toBeNull();
    expect(parentRow.assigneeWorkerId).toBe(w.dev2);
    const r = (await ok()).workers;
    expect(r.overdue.total).toBe(0);
  });
  it('a closed alarm never counts (the task finished), and an owner-unreactive alarm is not an overdue clause', async () => {
    const done = await task({ owner: w.ada, assignee: w.dev1, status: 'finished' });
    const doneRow = await db.agentTask.findUniqueOrThrow({ where: { id: done.id } });
    await stallAlarm(doneRow, 'stall.no-progress', w.dev1);
    const open = await task({ owner: w.ada, assignee: w.dev2, status: 'pending' });
    const openRow = await db.agentTask.findUniqueOrThrow({ where: { id: open.id } });
    await stallAlarm(openRow, 'stall.owner-unreactive', w.dev2);
    expect((await ok()).workers.overdue.total).toBe(0);
  });
  it('#4850: a finish-by alarm in effect makes its assignee overdue; acknowledging it stops the count (cor:agt:150:04)', async () => {
    const late = await db.agentTask.create({ data: { appId, title: 'Late', ownerWorkerId: w.ada, assigneeWorkerId: w.dev2, assignedAt: ago(48 * HOUR),
      status: 'started', startedAt: ago(30 * HOUR), finishBy: ago(2 * HOUR), source: 'https://example.test/late' } });
    const id = await db.$transaction(async (tx) => appendAlarmEvent(tx as never, {
      appId, taskId: late.id, type: 'stall.finish-by', episodeStart: late.finishBy as Date, subjectWorkerId: w.dev2,
      chain: [{ workerId: w.ada } as never], payload: { windowMinutes: 60 }, createdAt: ago(HOUR),
    }));
    expect(id).not.toBeNull();
    expect((await ok()).workers.overdue).toMatchObject({ total: 1, ids: [w.dev2], truncated: false }); // the assignee, never the owner Ada
    await db.$executeRaw`UPDATE agent_team_events SET acknowledged_at = now(), acknowledged_by_worker_id = ${w.ada} WHERE id = ${id}`;
    expect((await ok()).workers.overdue.total).toBe(0);
  });
});

describe('#4447 report 4: completed and started in [since, until)', () => {
  it('finishedAt: exactly since counts, exactly until does not; null finishedAt and CANCELLED never count', async () => {
    const since = new Date(Date.now() - 2 * DAY);
    const until = new Date(Date.now() - DAY);
    const atSince = await task({ owner: w.ada, assignee: w.dev1, status: 'finished', startedAt: ago(3 * DAY), finishedAt: since });
    const inside = await task({ owner: w.ada, assignee: w.dev1, status: 'finished', startedAt: ago(3 * DAY), finishedAt: new Date(since.getTime() + HOUR) });
    await task({ owner: w.ada, assignee: w.dev1, status: 'finished', startedAt: ago(3 * DAY), finishedAt: until });
    await task({ owner: w.ada, assignee: w.dev1, status: 'finished', startedAt: ago(3 * DAY), finishedAt: new Date(since.getTime() - 1) });
    await task({ owner: w.ada, status: 'cancelled', cancelledAt: new Date(since.getTime() + HOUR) });
    await task({ owner: w.ada, assignee: w.dev1, status: 'started', startedAt: ago(3 * DAY) }); // finishedAt null
    const r = (await ok({ since: since.toISOString(), until: until.toISOString() })).flow;
    expect(r.completed.total).toBe(2);
    expect(idsOf(r.completed)).toEqual([atSince.id, inside.id].sort());
  });
  it('started by startedAt over the same half-open window', async () => {
    const since = new Date(Date.now() - 2 * DAY);
    const until = new Date(Date.now() - DAY);
    const atSince = await task({ owner: w.ada, assignee: w.dev1, startedAt: since });
    await task({ owner: w.ada, assignee: w.dev1, startedAt: until });
    await task({ owner: w.ada, assignee: w.dev1, startedAt: new Date(since.getTime() - 1) });
    const r = (await ok({ since: since.toISOString(), until: until.toISOString() })).flow;
    expect(r.started).toMatchObject({ total: 1, ids: [atSince.id] });
  });
  it('defaults to the last 7 days; reports 1-3 ignore the window (snapshots)', async () => {
    const inWeek = await task({ owner: w.ada, assignee: w.dev1, status: 'finished', startedAt: ago(6 * DAY), finishedAt: ago(5 * DAY) });
    await task({ owner: w.ada, assignee: w.dev1, status: 'finished', startedAt: ago(9 * DAY), finishedAt: ago(8 * DAY) });
    await task({ owner: w.ada, assignee: w.dev2, startedAt: ago(20 * DAY) }); // started long ago, still STARTED now
    const d = await ok();
    expect(d.flow.completed.ids).toEqual([inWeek.id]);
    expect(new Date(d.window.until).getTime() - new Date(d.window.since).getTime()).toBe(7 * DAY);
    const narrow = await ok({ since: ago(HOUR).toISOString(), until: new Date().toISOString() });
    expect(narrow.startedOwned.all.total).toBe(d.startedOwned.all.total);
    expect(narrow.startedOwned.all.total).toBe(1);
    expect(narrow.workers.active.total).toBe(d.workers.active.total);
  });
  it('an omitted until is now; an omitted since is until minus 7 days', async () => {
    const until = new Date(Date.now() - 10 * DAY);
    const d = await ok({ until: until.toISOString() });
    expect(new Date(d.window.until).getTime()).toBe(until.getTime());
    expect(new Date(d.window.since).getTime()).toBe(until.getTime() - 7 * DAY);
  });
});

describe('#4447 bounds', () => {
  it('refuses since after until, and a window over 31 days, as typed bad input before any read (an outsider and a missing App get the same)', async () => {
    const now = Date.now();
    for (const userId of [memberId, outsiderId]) {
      for (const app of [appId, MISSING_APP]) {
        const inverted = await run({ since: new Date(now).toISOString(), until: new Date(now - HOUR).toISOString() }, userId, app);
        expect(inverted.errors?.[0]?.extensions?.code, 'since > until').toBe('BAD_USER_INPUT');
        const wide = await run({ since: new Date(now - 32 * DAY).toISOString(), until: new Date(now).toISOString() }, userId, app);
        expect(wide.errors?.[0]?.extensions?.code, '> 31 days').toBe('BAD_USER_INPUT');
      }
    }
    const edge = await run({ since: new Date(now - 31 * DAY).toISOString(), until: new Date(now).toISOString() });
    expect(edge.errors, 'exactly 31 days is allowed').toBeUndefined();
  });
  it('caps ids at 200 with the exact total and a loud truncated flag', async () => {
    const rows = Array.from({ length: 205 }, (_, i) => ({ appId, title: `Bulk ${i}`, ownerWorkerId: w.ada, assigneeWorkerId: w.dev1, assignedAt: ago(HOUR), status: 'started', startedAt: ago(HOUR), source: `https://example.test/${i}` }));
    await db.agentTask.createMany({ data: rows });
    const r = (await ok()).startedOwned;
    expect(r.all.total).toBe(205);
    expect(r.all.ids).toHaveLength(200);
    expect(r.all.truncated).toBe(true);
    expect(r.byOwner[0].tasks).toMatchObject({ total: 205, truncated: true });
    expect(new Set(r.all.ids).size).toBe(200);
  });
  it('a count that is not cut short says so', async () => {
    await task({ owner: w.ada, assignee: w.dev1 });
    expect((await ok()).startedOwned.all.truncated).toBe(false);
  });
});

describe('#4447 audience: the roster gate, task data behind the task readers', () => {
  it('an outsider and a missing App are refused identically (APP_NOT_FOUND, no existence oracle)', async () => {
    const outsider = await run({}, outsiderId);
    const missing = await run({}, outsiderId, MISSING_APP);
    expect(outsider.errors?.[0]?.extensions?.code).toBe('APP_NOT_FOUND');
    expect(missing.errors?.[0]?.extensions?.code, 'missing: ' + missing.errors?.[0]?.message).toBe('APP_NOT_FOUND');
    expect(outsider.errors?.[0]?.message.replace(appId, '<ref>')).toBe(missing.errors?.[0]?.message.replace(MISSING_APP, '<ref>'));
    const anon = await run({}, null);
    expect(anon.errors?.[0]?.extensions?.code, 'anon: ' + anon.errors?.[0]?.message).toBe('APP_NOT_FOUND');
  });
  it('returns the same refusal teamRoster gives an outsider', async () => {
    const roster = await server.executeOperation({ query: 'query($a: ID!){ teamRoster(appRef:$a){ appId } }', variables: { a: appId } }, { contextValue: ctx(outsiderId) });
    const metrics = await run({}, outsiderId);
    const rosterErr = (roster.body as any).singleResult.errors[0];
    expect(metrics.errors?.[0]?.extensions?.code).toBe(rosterErr.extensions.code);
    expect(metrics.errors?.[0]?.message).toBe(rosterErr.message);
  });
  it('a reader who may see the roster but not the tasks gets worker counts and no task data', async () => {
    await task({ owner: w.ada, assignee: w.dev1 });
    const spy = vi.spyOn(taskModule, 'mayReadAppTasks').mockResolvedValue(false);
    try {
      const d = await ok();
      expect(d.startedOwned).toBeNull();
      expect(d.projects).toBeNull();
      expect(d.flow).toBeNull();
      expect(d.workers.idle.total).toBeGreaterThan(0);
      expect(spy).toHaveBeenCalled();
    } finally { spy.mockRestore(); }
  });
  it("never reports another App's tasks or workers", async () => {
    const stranger = await worker('Stranger', { app: otherAppId });
    await task({ owner: stranger, assignee: stranger, app: otherAppId });
    const d = await ok();
    expect(d.startedOwned.all.total).toBe(0);
    expect(JSON.stringify(d)).not.toContain(stranger);
  });
});

describe('#4447 cost: the query count does not grow with workers or tasks', () => {
  it('reads with the same number of statements for 4 and for 14 workers, and 3 and 33 tasks', async () => {
    const logged = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL, log: [{ emit: 'event', level: 'query' }] });
    const seen: string[] = [];
    logged.$on('query', (e: { query: string }) => { seen.push(e.query); });
    const measure = async () => {
      seen.length = 0;
      const barrier = `metrics-4447-${generateId()}`;
      const data = await (resolvers.Query as any).teamMetrics({}, { appRef: appId }, { db: logged, userId: memberId, roles: ['READER'] } as Context);
      await logged.$queryRawUnsafe(`SELECT '${barrier}'`);
      await vi.waitFor(() => expect(seen.some((q) => q.includes(barrier))).toBe(true));
      return { data, count: seen.filter((q) => !q.includes(barrier) && !/^(BEGIN|COMMIT|SET|ROLLBACK)/i.test(q.trim())).length };
    };
    try {
      for (let i = 0; i < 3; i++) await task({ owner: w.ada, assignee: w.dev1, source: `https://example.test/a${i}` });
      const small = await measure();
      for (let i = 0; i < 10; i++) {
        const id = await worker(`Extra${i}`);
        for (let j = 0; j < 3; j++) await task({ owner: id, assignee: id, source: `https://example.test/b${i}-${j}` });
      }
      const big = await measure();
      expect(small.data.startedOwned.all.total).toBe(3);
      expect(big.data.startedOwned.all.total).toBe(33);
      expect(big.count).toBe(small.count);
      expect(small.count).toBeGreaterThan(0);
    } finally { await logged.$disconnect(); }
  });
});

describe('#4447 SDL', () => {
  const schema = buildASTSchema(typeof typeDefs === 'string' ? parse(typeDefs) : typeDefs);
  it('declares teamMetrics(appRef: ID!, since: DateTime, until: DateTime) with described types', () => {
    const field = assertObjectType(schema.getType('Query')).getFields().teamMetrics;
    expect(field, 'teamMetrics exists').toBeDefined();
    expect(field.args.map((a) => `${a.name}:${a.type}`)).toEqual(['appRef:ID!', 'since:DateTime', 'until:DateTime']);
    expect(String(field.type)).toBe('TeamMetrics!');
    expect(field.description).toMatch(/cor:agt:150/);
    for (const t of ['TeamMetrics', 'TeamMetricsCount', 'TeamMetricsWorkers', 'TeamMetricsFlow']) {
      expect(assertObjectType(schema.getType(t)).description, `${t} is described`).toBeTruthy();
    }
    expect(Object.keys(assertObjectType(schema.getType('TeamMetricsCount')).getFields()).sort()).toEqual(['ids', 'total', 'truncated']);
  });
});

/**
 * #4850 (follow-ups from the #4848 seats). The appId pins are cross-App isolation proofs: every App numbers its own projects
 * from AT1, so a lookup by handle that loses its App scope would attach another App's project to this one.
 */
describe('#4850 same-App only: a same-handle project in another App never appears in any report (cor:agt:150, cor:agt:050:01)', () => {
  it("report 1's project title, report 2's started projects and report 4's window read this App's rows only", async () => {
    const ours = await project('Our project');
    const mine = await task({ owner: w.ada, assignee: w.dev1, parent: ours.id });
    // The other App's AT1, created later (so a lookup that drops the App would find it last and, unordered, could pick it).
    const stranger = await worker('Stranger', { app: otherAppId });
    const theirs = await task({ owner: stranger, assignee: stranger, status: 'started', title: 'FOREIGN-4850-TITLE', source: null, app: otherAppId });
    const theirChild = await task({ owner: stranger, assignee: stranger, parent: theirs.id, status: 'finished', app: otherAppId, finishedAt: ago(HOUR) });
    const theirStarted = await task({ owner: stranger, assignee: stranger, parent: theirs.id, status: 'started', app: otherAppId });
    expect(theirs.handle, 'both Apps number their first project AT1').toBe(ours.handle);
    const d = await ok();
    const cell = d.startedOwned.byOwner[0].byProject.find((g: any) => g.project.handle === ours.handle);
    expect(cell.project).toMatchObject({ taskId: ours.id, title: 'Our project' });
    expect(idsOf(cell.tasks)).toEqual([mine.id]);
    expect(d.projects.items.map((i: any) => i.project.taskId)).toEqual([ours.id]);
    expect(d.flow.completed.total).toBe(0);
    expect(idsOf(d.flow.started)).toEqual([ours.id, mine.id].sort());
    const text = JSON.stringify(d);
    for (const foreign of ['FOREIGN-4850-TITLE', theirs.id, theirChild.id, theirStarted.id, stranger]) expect(text).not.toContain(foreign);
  });
});

describe('#4850 truncation: a short list never reads as the whole one (cor:api:120:04)', () => {
  it('more than 200 owners: 200 groups and ownersTruncated', async () => {
    const people = Array.from({ length: 201 }, () => ({ id: generateId(), handle: `mt-${generateId()}` }));
    await db.user.createMany({ data: people });
    await db.agentTask.createMany({ data: people.map((u, i) => ({ appId, title: `Owner ${i}`, ownerUserId: u.id, assigneeWorkerId: w.dev1,
      assignedAt: ago(HOUR), status: 'started', startedAt: ago(HOUR), source: `https://example.test/o${i}` })) });
    const r = (await ok()).startedOwned;
    expect(r.all).toMatchObject({ total: 201, truncated: true });
    expect(r.all.ids).toHaveLength(200);
    expect(r.byOwner).toHaveLength(200);
    expect(r.ownersTruncated).toBe(true);
  });
  it('one owner across more than 200 projects: 200 project groups and projectsTruncated; more than 200 started projects: truncated', async () => {
    await db.agentTask.createMany({ data: Array.from({ length: 201 }, (_, i) => ({ appId, title: `P${i}`, ownerWorkerId: w.ada, assigneeWorkerId: w.ada,
      assignedAt: ago(HOUR), status: 'started', startedAt: ago(HOUR) })) });
    const parents = await db.agentTask.findMany({ where: { appId, parentTaskId: null, taskNumber: { gt: 0 } }, select: { id: true } });
    expect(parents).toHaveLength(201);
    await db.agentTask.createMany({ data: parents.map((p, i) => ({ appId, title: `C${i}`, parentTaskId: p.id, ownerWorkerId: w.bo, assigneeWorkerId: w.dev1,
      assignedAt: ago(HOUR), status: 'started', startedAt: ago(HOUR), source: `https://example.test/c${i}` })) });
    const d = await ok();
    const bo = d.startedOwned.byOwner.find((g: any) => g.owner.id === w.bo);
    expect(bo.tasks).toMatchObject({ total: 201, truncated: true });
    expect(bo.byProject).toHaveLength(200);
    expect(bo.projectsTruncated).toBe(true);
    expect(d.projects.items).toHaveLength(200);
    expect(d.projects.truncated).toBe(true);
  });
  it("a project's children and report 4's counts cap their ids at 200 with the exact total", async () => {
    const p = await project('Big');
    await db.agentTask.createMany({ data: Array.from({ length: 203 }, (_, i) => ({ appId, title: `F${i}`, parentTaskId: p.id, ownerWorkerId: w.ada,
      assigneeWorkerId: w.dev1, assignedAt: ago(3 * HOUR), status: 'finished', startedAt: ago(2 * HOUR), finishedAt: ago(HOUR), resultOutcome: 'succeeded' })) });
    const d = await ok();
    const finished = d.projects.items[0].children.find((c: any) => c.status === 'FINISHED').tasks;
    expect(finished).toMatchObject({ total: 203, truncated: true });
    expect(new Set(finished.ids).size).toBe(200);
    expect(d.flow.completed).toMatchObject({ total: 203, truncated: true });
    expect(d.flow.completed.ids).toHaveLength(200);
    expect(d.flow.started).toMatchObject({ total: 204, truncated: true }); // the project itself started in the window too
  });
});

describe('#4850 one clock: an omitted until is the instant the snapshots were read', () => {
  it('window.until equals asOf when until is omitted', async () => {
    const d = await ok();
    expect(d.window.until).toBe(d.asOf);
    expect(new Date(d.window.until).getTime() - new Date(d.window.since).getTime()).toBe(7 * DAY);
  });
});

describe('#4850 SDL: the owner is the party projection and the caps come from the constants', () => {
  const schema = buildASTSchema(typeof typeDefs === 'string' ? parse(typeDefs) : typeDefs);
  it('TeamMetricsOwnerGroup.owner is AgentTaskParty (kind, id, name, urn), never a Worker or User', () => {
    const owner = assertObjectType(schema.getType('TeamMetricsOwnerGroup')).getFields().owner;
    expect(String(owner.type)).toBe('AgentTaskParty');
    expect(Object.keys(assertObjectType(schema.getType('AgentTaskParty')).getFields()).sort()).toEqual(['id', 'kind', 'name', 'urn']);
  });
  it('every cap the SDL states is the value the code enforces', () => {
    const desc = (t: string, f?: string) => {
      const type = assertObjectType(schema.getType(t));
      return (f ? type.getFields()[f].description : type.description) ?? '';
    };
    expect(desc('TeamMetricsCount')).toContain(`at most ${METRICS_IDS_CAP} of them`);
    expect(desc('TeamMetricsOwnerGroup', 'byProject')).toContain(`at most ${METRICS_GROUP_CAP} projects`);
    expect(desc('TeamMetricsStartedOwned', 'byOwner')).toContain(`At most ${METRICS_GROUP_CAP} owners`);
    expect(desc('TeamMetricsProjects')).toContain(`at most ${METRICS_GROUP_CAP} projects`);
    const query = assertObjectType(schema.getType('Query')).getFields().teamMetrics.description ?? '';
    expect(query).toContain(`the last ${METRICS_DEFAULT_WINDOW_MS / DAY} days`);
    expect(query).toContain(`over ${METRICS_MAX_WINDOW_MS / DAY} days`);
  });
});
