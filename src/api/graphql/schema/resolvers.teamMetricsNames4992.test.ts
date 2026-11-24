/**
 * #4992 (Refs hadron-portal#2535 item 3): every id in a `teamMetrics` count carries its name in the SAME call, `named`
 * beside `ids` (hrn:node:hadronmemory.com:specs:cor:agt:150). Additive: `ids` keeps its type. Names are read in one batch for
 * the whole response, and ride the gate of the count they sit in: a reader without task standing gets task counts null,
 * so no task title; a worker's name follows the roster audience.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApolloServer } from '@apollo/server';
import { assertObjectType, buildASTSchema, parse, isNonNullType, isListType, getNamedType } from 'graphql';
import { PrismaClient } from '../../../generated/prisma/index.js';
import { typeDefs } from './typeDefs.js';
import { resolvers, type Context } from './resolvers.js';
import * as taskModule from './resolvers.agentTask.js';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
import { METRICS_IDS_CAP, attachMetricNames } from '../../../lib/agentTasks/teamMetrics.js';

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

const COUNT = 'total ids truncated named { id name }';
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
/** The two fields the one-clock pin reads; the rest of the response stays untyped, as everywhere else in this file. */
type TeamMetricsClock = { asOf: string; window: { since: string; until: string } };
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
type TaskOpts = { owner: string; assignee?: string | null; status?: string; parent?: string | null; source?: string | null; externalId?: string | null; startedAt?: Date; finishedAt?: Date; cancelledAt?: Date; app?: string; title?: string; isProject?: boolean };
async function task(o: TaskOpts) {
  const status = o.status ?? 'started';
  const assigned = o.assignee ? { assigneeWorkerId: o.assignee, assignedAt: ago(48 * HOUR) } : {};
  return db.agentTask.create({ data: {
    appId: o.app ?? appId, title: o.title ?? 'Synthetic', ownerWorkerId: o.owner, parentTaskId: o.parent ?? null, status,
    source: o.source === undefined ? 'https://github.com/example/repo/issues/1' : o.source, externalId: o.externalId ?? null, isProject: o.isProject ?? false, ...assigned,
    ...(status === 'started' || status === 'finished' ? { startedAt: o.startedAt ?? ago(2 * HOUR) } : {}),
    ...(status === 'finished' ? { finishedAt: o.finishedAt ?? ago(HOUR), resultOutcome: 'succeeded' } : {}),
    ...(status === 'cancelled' ? { cancelledAt: o.cancelledAt ?? ago(HOUR) } : {}),
  } });
}
/** #4997: a project carries the project marker; being top-level makes a task nothing (cor:agt:150 A project). */
async function project(title: string, status = 'started', owner = w.ada) {
  return task({ owner, status, title, source: null, assignee: status === 'pending' ? null : owner, isProject: true });
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


type Named = { id: string; name: string | null };
type Cnt = { total: number; ids: string[]; truncated: boolean; named: Named[] };
const nameOf = (c: Cnt, id: string) => c.named.find((n) => n.id === id)?.name;
/** Every count in a response, wherever it sits. */
function allCounts(d: any): Cnt[] {
  const out: Cnt[] = [];
  const walk = (v: any) => {
    if (!v || typeof v !== 'object') return;
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (Array.isArray(v.ids) && 'total' in v) { out.push(v as Cnt); return; }
    Object.values(v).forEach(walk);
  };
  walk(d);
  return out;
}

describe('#4992 every drilled id carries its name, same call', () => {
  it('names each task id (its title) in reports 1, 2 and 4 and each worker id (its name) in report 3, in the order of ids', async () => {
    const p1 = await project('Project one');
    const t1 = await task({ owner: w.ada, assignee: w.dev1, parent: p1.id, title: 'Alpha task' });
    const t2 = await task({ owner: w.bo, assignee: w.dev2, parent: p1.id, title: 'Beta task' });
    const f1 = await task({ owner: w.ada, assignee: w.dev1, parent: p1.id, status: 'finished', title: 'Gamma finished' });
    const d = await ok();
    expect(nameOf(d.startedOwned.all, t1.id)).toBe('Alpha task');
    expect(nameOf(d.startedOwned.all, t2.id)).toBe('Beta task');
    const ada = d.startedOwned.byOwner.find((g: any) => g.owner.id === w.ada);
    expect(nameOf(ada.tasks, t1.id)).toBe('Alpha task');
    expect(nameOf(ada.byProject[0].tasks, t1.id)).toBe('Alpha task');
    const row = d.projects.items.find((i: any) => i.project.taskId === p1.id);
    const fin = row.children.find((c: any) => c.status === 'FINISHED').tasks;
    expect(nameOf(fin, f1.id)).toBe('Gamma finished');
    expect(nameOf(d.flow.completed, f1.id)).toBe('Gamma finished');
    expect(nameOf(d.flow.started, t1.id)).toBe('Alpha task');
    expect(nameOf(d.workers.active, w.dev1)).toBe('Dev1');
    expect(nameOf(d.workers.idle, w.bo)).toBe('Bo');
    for (const c of allCounts(d)) {
      expect(c.named.map((n) => n.id)).toEqual(c.ids);
      expect(c.named.every((n) => typeof n.name === 'string' && n.name.length > 0)).toBe(true);
    }
  });
  it('a name is only the name: the task title or the worker name, nothing else of the thing named', async () => {
    await task({ owner: w.ada, assignee: w.dev1, title: 'Only a title' });
    const d = await ok();
    for (const c of allCounts(d)) for (const n of c.named) expect(Object.keys(n).sort()).toEqual(['id', 'name']);
    const json = JSON.stringify(d);
    expect(json).not.toContain(memberId);
    expect(json).not.toContain('heldByUserId');
  });
  it('a reader who may see the roster but not the tasks gets worker names and no task data (no task title anywhere)', async () => {
    await task({ owner: w.ada, assignee: w.dev1, title: 'Secret task title' });
    const spy = vi.spyOn(taskModule, 'mayReadAppTasks').mockResolvedValue(false);
    try {
      const d = await ok();
      expect(d.startedOwned).toBeNull();
      expect(d.projects).toBeNull();
      expect(d.flow).toBeNull();
      expect(nameOf(d.workers.idle, w.bo)).toBe('Bo');
      expect(JSON.stringify(d)).not.toContain('Secret task title');
    } finally { spy.mockRestore(); }
  });
  it('an outsider and a missing App are refused identically, asking for names changes nothing', async () => {
    await task({ owner: w.ada, assignee: w.dev1, title: 'Hidden' });
    const outsider = await run({}, outsiderId);
    const missing = await run({}, outsiderId, MISSING_APP);
    expect(outsider.data ?? null).toBeNull();
    expect(outsider.errors?.[0]?.extensions?.code).toBe('APP_NOT_FOUND');
    expect(missing.errors?.[0]?.extensions?.code).toBe('APP_NOT_FOUND');
    expect(outsider.errors?.[0]?.message.replace(appId, '<ref>')).toBe(missing.errors?.[0]?.message.replace(MISSING_APP, '<ref>'));
  });
  it("never names another App's task or worker", async () => {
    const stranger = await worker('Stranger Worker', { app: otherAppId });
    await task({ owner: stranger, assignee: stranger, app: otherAppId, title: 'Stranger task' });
    const json = JSON.stringify(await ok());
    expect(json).not.toContain('Stranger Worker');
    expect(json).not.toContain('Stranger task');
  });
  it('a count cut at 200 ids names exactly those 200, with the exact total and truncated unchanged', async () => {
    const rows = Array.from({ length: METRICS_IDS_CAP + 5 }, (_, i) => ({ id: generateId(), appId, title: `Bulk ${i}`, ownerWorkerId: w.ada, assigneeWorkerId: w.dev1, assignedAt: ago(HOUR), status: 'started', startedAt: ago(HOUR), source: `https://example.test/${i}`, createdAt: new Date(Date.now() - 10 * HOUR + i * 1000) }));
    await db.agentTask.createMany({ data: rows });
    const all = (await ok()).startedOwned.all as Cnt;
    expect(all.total).toBe(METRICS_IDS_CAP + 5);
    expect(all.truncated).toBe(true);
    expect(all.ids).toHaveLength(METRICS_IDS_CAP);
    expect(all.named).toHaveLength(METRICS_IDS_CAP);
    expect(all.named.map((n) => n.id)).toEqual(all.ids);
    expect(all.named[0].name).toBe('Bulk 0');
  });
});

describe('#4992 the name read is bound to the App', () => {
  it("an id of another App (a task or a worker) reads as a missing one: its name stays null, and a same-App id beside it is named", async () => {
    const stranger = await worker('Stranger Worker', { app: otherAppId });
    const foreign = await task({ owner: stranger, assignee: stranger, app: otherAppId, title: 'Stranger task' });
    const mine = await task({ owner: w.ada, assignee: w.dev1, title: 'Mine' });
    const mk = (ids: string[]): Cnt => ({ total: ids.length, ids, truncated: false, named: ids.map((id) => ({ id, name: null })) });
    const tasks = mk([foreign.id, mine.id]);
    const workers = mk([stranger, w.dev1]);
    await attachMetricNames(db, appId, { tasks: [tasks], workers: [workers] });
    expect(tasks.named).toEqual([{ id: foreign.id, name: null }, { id: mine.id, name: 'Mine' }]);
    expect(workers.named).toEqual([{ id: stranger, name: null }, { id: w.dev1, name: 'Dev1' }]);
  });
  it('a report that is not passed is never named, whatever ids it holds (the gate decides what is passed)', async () => {
    const t = await task({ owner: w.ada, assignee: w.dev1, title: 'Not passed' });
    const c: Cnt = { total: 1, ids: [t.id], truncated: false, named: [{ id: t.id, name: null }] };
    await attachMetricNames(db, appId, { workers: [] });
    expect(c.named[0].name).toBeNull();
  });
});

describe('#4992 one batch for the whole response, not one per count or per id', () => {
  it('the names add the same fixed number of statements for 3 and for 33 tasks, and at most two', async () => {
    const logged = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL, log: [{ emit: 'event', level: 'query' }] });
    const seen: string[] = [];
    logged.$on('query', (e: { query: string }) => { seen.push(e.query); });
    const measure = async () => {
      seen.length = 0;
      const barrier = `metrics-4992-${generateId()}`;
      const q = (resolvers.Query as any).teamMetrics;
      const data = await q({}, { appRef: appId }, { db: logged, userId: memberId, roles: ['READER'] } as Context);
      await logged.$queryRawUnsafe(`SELECT '${barrier}'`);
      await vi.waitFor(() => expect(seen.some((s) => s.includes(barrier))).toBe(true));
      return { data, count: seen.filter((s) => !s.includes(barrier) && !/^(BEGIN|COMMIT|SET|ROLLBACK)/i.test(s.trim())).length };
    };
    try {
      for (let i = 0; i < 3; i++) await task({ owner: w.ada, assignee: w.dev1, source: `https://example.test/a${i}`, title: `T${i}` });
      const small = await measure();
      for (let i = 0; i < 10; i++) {
        const id = await worker(`Extra${i}`);
        for (let j = 0; j < 3; j++) await task({ owner: id, assignee: id, source: `https://example.test/b${i}-${j}`, title: `U${i}-${j}` });
      }
      const big = await measure();
      expect(small.data.startedOwned.all.named.every((n: Named) => n.name)).toBe(true);
      expect(big.data.startedOwned.all.named.every((n: Named) => n.name)).toBe(true);
      expect(big.data.startedOwned.all.total).toBe(33);
      expect(big.count).toBe(small.count);
      // Names are read by one task statement and one worker statement at most, whatever the number of counts or ids.
      const namesStatements = seen.filter((s) => /agent_tasks|"workers"|\bworkers\b/.test(s) && /title|name/.test(s) && /= ANY\(/.test(s));
      expect(namesStatements.length).toBeLessThanOrEqual(2);
      expect(namesStatements.length).toBeGreaterThan(0);
    } finally { await logged.$disconnect(); }
  });
});

describe('#4992 SDL: additive', () => {
  const schema = buildASTSchema(typeof typeDefs === 'string' ? parse(typeDefs) : typeDefs);
  const count = assertObjectType(schema.getType('TeamMetricsCount'));
  it('ids keeps its type [ID!]! and a named list sits beside it', () => {
    const ids = count.getFields().ids;
    expect(String(ids.type)).toBe('[ID!]!');
    const named = count.getFields().named;
    expect(named, 'TeamMetricsCount.named').toBeDefined();
    expect(isNonNullType(named.type) && isListType((named.type as any).ofType)).toBe(true);
    const item = assertObjectType(getNamedType(named.type));
    expect(String(item.getFields().id.type)).toBe('ID!');
    expect(String(item.getFields().name.type)).toBe('String');
  });
  it('the SDL text states the cap and that a name follows the same gate as its id, and gives no reason for a missing name', () => {
    const desc = [count.description, count.getFields().named?.description].join(' ');
    expect(desc).toMatch(/200|METRICS_IDS_CAP/);
    expect(desc.toLowerCase()).toMatch(/same gate/);
    expect(desc.toLowerCase()).not.toMatch(/because|denied|forbidden|not permitted/);
  });
});
