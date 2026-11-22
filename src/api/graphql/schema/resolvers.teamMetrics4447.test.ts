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

const COUNT = 'total ids truncated';
const METRICS = `query($app: ID!, $since: DateTime, $until: DateTime) { teamMetrics(appRef: $app, since: $since, until: $until) {
  appId asOf window { since until }
  startedOwned { all { ${COUNT} } ownersTruncated byOwner { owner { kind id name } tasks { ${COUNT} } projectsTruncated
    byProject { project { handle taskId title noProject } tasks { ${COUNT} } } } }
  projects { truncated items { project { handle taskId title noProject } children { status tasks { ${COUNT} } } } }
  workers { active { ${COUNT} } idle { ${COUNT} } overdue { ${COUNT} } inop { ${COUNT} } }
  flow { completed { ${COUNT} } started { ${COUNT} } }
} }`;
async function run(vars: Record<string, unknown> = {}, userId: string | undefined = memberId, app: string = appId) {
  const result = await server.executeOperation({ query: METRICS, variables: { app, ...vars } }, { contextValue: ctx(userId) });
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
    expect(idsOf(ada[p1.handle].tasks)).toEqual([a1.id, a2.id].sort());
    expect(ada.AT0.project.noProject).toBe(true);
    expect(ada.AT0.tasks.total).toBe(1);
    expect(ada[p1.handle].project).toMatchObject({ taskId: p1.id, title: 'Project one', noProject: false });
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
  it('a closed alarm never counts (the task finished), and an owner-unreactive alarm is not an overdue clause', async () => {
    const done = await task({ owner: w.ada, assignee: w.dev1, status: 'finished' });
    const doneRow = await db.agentTask.findUniqueOrThrow({ where: { id: done.id } });
    await stallAlarm(doneRow, 'stall.no-progress', w.dev1);
    const open = await task({ owner: w.ada, assignee: w.dev2, status: 'pending' });
    const openRow = await db.agentTask.findUniqueOrThrow({ where: { id: open.id } });
    await stallAlarm(openRow, 'stall.owner-unreactive', w.dev2);
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
      for (const app of [appId, 'no-such-app']) {
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
    const missing = await run({}, outsiderId, 'no-such-app');
    expect(outsider.errors?.[0]?.extensions?.code).toBe('APP_NOT_FOUND');
    expect(missing.errors?.[0]?.extensions?.code).toBe('APP_NOT_FOUND');
    expect(outsider.errors?.[0]?.message.replace(appId, '<ref>')).toBe(missing.errors?.[0]?.message.replace('no-such-app', '<ref>'));
    const anon = await run({}, undefined);
    expect(anon.errors?.[0]?.extensions?.code).toBe('APP_NOT_FOUND');
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
  it('reads with the same number of statements for 4 and for 14 workers, and 3 and 30 tasks', async () => {
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
