/**
 * #5267 — `App.viewerAppUserMemoryClasses` is priced by admission, not batched (decided in the issue: the licence step is the
 * door's own judgement, `cor:dmo:060:20`, and is not copied). The weight is the statements one member App costs in the worst
 * shape priced here: three installed Agents, none licensed, so the licence loop runs to its end.
 */
import { readFileSync } from 'node:fs';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { ApolloServer } from '@apollo/server';
import { buildSchema, parse } from 'graphql';
import { getComplexity, simpleEstimator } from 'graphql-query-complexity';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, createDbAppWithKey, createDbAppAgent, createDbAppMember } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';
import { typeDefs } from './typeDefs.js';
import { hadronListEstimator, FIXED_FIELD_COST, APP_VIEWER_USER_MEMORY_CLASSES_COST } from '../admissionComplexity.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({ syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }) }));

const server = new ApolloServer({ typeDefs, resolvers });
const PER_SHAPE = 10;
let viewer: string;
const apps: Record<'A' | 'B' | 'C', string[]> = { A: [], B: [], C: [] };
let logged: import('../../../generated/prisma/index.js').PrismaClient;
/**
 * #5397: the measurement. Every statement the logging client sends is recorded, in the order its query event arrives, and a
 * counted window is the events between two BARRIER statements: a unique `SELECT <n> AS barrier` sent before the work and one
 * after it, each awaited until its own event has arrived. Prisma emits query events asynchronously, so under load a statement
 * that belongs to one run can arrive after its call has returned and be counted in the NEXT run's window (seen: an
 * `agent_org_grants` read and an `org_members` read crossing from one pair into the next). A barrier is ordered with the work
 * around it, so none crosses. THE ASSUMPTION, named: query events arrive in the order the engine logs them, across the client's
 * pooled connections too (so an event for a statement sent before the closing barrier has arrived when the barrier's own has). It
 * is not proven; it was checked locally by repeated pairs under CPU load (six busy loops): 0 deviations in 3600 pairs with barriers
 * AND the ping filter, where 4 in 1200 (no fix), 3 in 3600 (ping filter alone) and 22 in 3600 (barriers alone: 27 `SELECT 1` seen)
 * had been seen, so each of the two is needed. Every CI run re-checks it: the shape pin below measures 90 pairs. If the assumption
 * ever fails, the symptom is a per-App variance in that pin, never a silent pass.
 *
 * And the one statement the count must not see: under CPU load a bare `SELECT 1` shows up on this client now and then (seen +1
 * in 4 of 1200 repeated runs; the failing CI run read 12 where 14 is the shape's cost). It is not a query the app or the field
 * writes. What it is was not proven (the pool's own connection check is the likely source; only its text and that it appears under
 * load were observed). It is excluded BY TEXT, exactly: any other statement,
 * however it arrives, is counted, and the per-App equality and the [7,14,24] pins stay exact (no tolerance). THE LIMIT of an
 * exact-text filter: a bare `SELECT 1` issued by app code would be invisible here; the only one in src is the /health probe,
 * and a pin below keeps the field's own files free of one.
 */
const events: string[] = [];
let barrierSeq = 0;
const isPoolPing = (query: string): boolean => query.trim() === 'SELECT 1';

async function barrier(): Promise<number> {
  const text = `SELECT ${900_000 + ++barrierSeq} AS barrier`;
  // The text is a constant plus a counter, never input: $queryRawUnsafe only because a template tag cannot name a literal.
  await logged.$queryRawUnsafe(text);
  // The event of a query that has already completed arrives within milliseconds; the deadline only turns a lost event into a clear
  // failure instead of a hang, and is wide for a loaded runner.
  const deadline = Date.now() + 30_000;
  while (!events.includes(text)) {
    if (Date.now() > deadline) throw new Error(`the query event of ${text} never arrived (the barrier's ordering assumption, see the header)`);
    await new Promise((r) => setTimeout(r, 5));
  }
  return events.indexOf(text);
}
/** The statements `fn` sent, between two barriers, without the pool's own ping. */
async function counted(fn: () => Promise<unknown>): Promise<number> {
  const from = await barrier();
  await fn();
  const to = await barrier();
  return events.slice(from + 1, to).filter((q) => !isPoolPing(q)).length;
}

/** One selection of an App, with or without the field (not counted: `select` counts it). */
async function run(ref: string, withField: boolean): Promise<void> {
  const ctx = { db: logged, userId: viewer, roles: ['READER'] } as unknown as Context;
  const res = await server.executeOperation(
    { query: `query ($ref: ID!) { app(ref: $ref) { id ${withField ? 'viewerAppUserMemoryClasses' : ''} } }`, variables: { ref } },
    { contextValue: ctx });
  if (res.body.kind !== 'single') throw new Error('unexpected incremental response');
  expect(res.body.singleResult.errors).toBeUndefined();
}
const select = (ref: string, withField: boolean): Promise<number> => counted(() => run(ref, withField));
/** The statements the field itself adds for one App: the same selection with and without it. */
const fieldStatements = async (ref: string) => (await select(ref, true)) - (await select(ref, false));

beforeAll(async () => {
  await cleanDb(db);
  viewer = (await db.user.create({ data: { id: generateId(), handle: 'vic5267', name: 'vic', roles: ['READER'] } })).id;
  const org = await db.organization.create({ data: { id: generateId(), name: 'Org', urn: 'org5267.test' } });
  const foreign = await db.organization.create({ data: { id: generateId(), name: 'Foreign', urn: 'foreign5267.test' } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: viewer, role: 'READER' } });
  const agent = async (name: string, licensed: boolean) => (await db.agent.create({ data: licensed
    ? { id: generateId(), name, urn: `org5267.test:${name}`, organizationId: org.id }
    // Another organization's private Agent: installed by row, but it has no licence here (#1526).
    : { id: generateId(), name, urn: `foreign5267.test:${name}`, organizationId: foreign.id, visibility: 'PERSONAL' } })).id;
  const licensedAgent = await agent('licensed', true);
  const unlicensed = [await agent('u1', false), await agent('u2', false), await agent('u3', false)];
  for (const shape of ['A', 'B', 'C'] as const) {
    for (let i = 0; i < PER_SHAPE; i++) {
      const id = (await createDbAppWithKey(db, `app${shape}${i}-5267`, org.id)).app.id;
      await createDbAppMember(db, id, viewer, 'eater');
      if (shape === 'B') await createDbAppAgent(db, id, licensedAgent);
      if (shape === 'C') for (const a of unlicensed) await createDbAppAgent(db, id, a);
      apps[shape].push(id);
    }
  }
  const { PrismaClient } = await import('../../../generated/prisma/index.js');
  expect(process.env.DATABASE_URL, 'the counting client must use the same database as db').toBeTruthy();
  logged = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL, log: [{ emit: 'event', level: 'query' }] });
  (logged as any).$on('query', (e: { query: string }) => { events.push(e.query.trim()); });
});
afterAll(async () => { await logged?.$disconnect(); });

describe('#5397 the statement counter counts the field\'s statements and only those', () => {
  const count = counted;

  it('a ping inside a counted window is not counted: before, after and between real statements (each awaited inside the window)', async () => {
    expect(await count(() => logged.$queryRaw`SELECT 1`)).toBe(0);
    expect(await count(async () => { await logged.$queryRaw`SELECT 1`; await logged.$queryRaw`SELECT 2`; })).toBe(1);
    expect(await count(async () => { await logged.$queryRaw`SELECT 2`; await logged.$queryRaw`SELECT 1`; })).toBe(1);
    expect(await count(async () => { await logged.$queryRaw`SELECT 1`; await logged.$queryRaw`SELECT 2`; await logged.$queryRaw`SELECT 1`; await logged.$queryRaw`SELECT 3`; })).toBe(2);
    // A real selection counts the same with a ping awaited around it: the ping is inside the window, so a broken filter would add 2.
    const plain = await select(apps.A[0]!, true);
    expect(await count(async () => { await logged.$queryRaw`SELECT 1`; await run(apps.A[0]!, true); await logged.$queryRaw`SELECT 1`; })).toBe(plain);
  });

  it('the limit of an exact-text filter: nothing on the field\'s path issues a bare SELECT 1 of its own, so none is hidden', () => {
    // A bare `SELECT 1` from app code would be invisible to this counter. The only one in src is the /health probe
    // (src/api/health.ts); the field's own files must not issue one. Larger statements that contain "SELECT 1 FROM" are counted.
    const files = ['./appUserMemoryEligibility.ts', '../../../lib/appAgent.ts', '../../../lib/appInstallations.ts']
      .map((f) => readFileSync(new URL(f, import.meta.url), 'utf8').replace(/\/\/.*$/gm, ''));
    for (const text of files) expect(text).not.toMatch(/`\s*SELECT 1\s*`/);
  });

  it('every other statement is still counted, so a real extra statement is not hidden', async () => {
    expect(await count(() => logged.$queryRaw`SELECT 2`)).toBe(1);
    expect(await count(() => logged.$queryRaw`SELECT 1 AS one`)).toBe(1);
    expect(await count(async () => { await logged.$queryRaw`SELECT 1`; await logged.$queryRaw`SELECT 2`; })).toBe(1);
  });
});

describe('#5267 the weight is what the field costs', () => {
  it('the fixture is the shapes the issue names: A none, B one licensed, C three unlicensed', async () => {
    const answer = async (id: string) => (await (resolvers.App as Record<string, any>).viewerAppUserMemoryClasses({ id }, {}, { db, userId: viewer, roles: ['READER'] })) as string[];
    expect(await answer(apps.A[0]!)).toEqual([]); // no Agent: nothing to create through
    expect(await answer(apps.B[0]!)).toEqual(['personal', 'private']);
    expect(await answer(apps.C[0]!)).toEqual([]); // installed, none licensed
  });

  it('each shape stays within the constant, and the constant is the worst shape (C)', async () => {
    const per = { A: [] as number[], B: [] as number[], C: [] as number[] };
    // THREE passes over the 30 Apps (90 with/without pairs): every CI run of this file is a small soak of the barrier's ordering
    // assumption (see the header), and a per-App variance has three chances to show.
    for (let pass = 0; pass < 3; pass++) for (const shape of ['A', 'B', 'C'] as const) for (const id of apps[shape]) per[shape].push(await fieldStatements(id));
    const worst = (s: 'A' | 'B' | 'C') => Math.max(...per[s]);
    // Every App of a shape costs the same: the count has no per-App variance, so the max over the 30 samples is the shape's cost.
    for (const s of ['A', 'B', 'C'] as const) expect(new Set(per[s]).size, `shape ${s} statements per App: ${per[s]}`).toBe(1);
    // The doc comment's figures are pinned too, so it cannot drift from what the field issues.
    expect([worst('A'), worst('B'), worst('C')]).toEqual([7, 14, 24]);
    for (const s of ['A', 'B', 'C'] as const) expect(worst(s)).toBeLessThanOrEqual(APP_VIEWER_USER_MEMORY_CLASSES_COST);
    expect(worst('C')).toBe(APP_VIEWER_USER_MEMORY_CLASSES_COST);
  });
});

describe('#5267 admission sees the field', () => {
  const schema = buildSchema(typeDefs);
  const cost = (selection: string, maxCost = 10_000_000) => getComplexity({
    schema, variables: {}, query: parse(`{ apps(limit: 30) { items { id ${selection} } } }`),
    estimators: [hadronListEstimator({ maxCost, listFactor: 10 }), simpleEstimator({ defaultComplexity: 1 })],
  });

  it('carries an entry for the field, equal to the constant', () => {
    expect(FIXED_FIELD_COST['App.viewerAppUserMemoryClasses']).toBe(APP_VIEWER_USER_MEMORY_CLASSES_COST);
  });

  it('prices 30 Apps at 30 times the constant more than the same list without the field', () => {
    expect(cost('viewerAppUserMemoryClasses') - cost('')).toBe(30 * APP_VIEWER_USER_MEMORY_CLASSES_COST);
  });

  it('first-party selections stay far under the real default ceiling (GRAPHQL_MAX_COST 200000)', async () => {
    const { GRAPHQL_ADMISSION_DEFAULTS } = await import('../admission.js');
    const ceiling = GRAPHQL_ADMISSION_DEFAULTS.maxCost;
    const one = getComplexity({ schema, variables: {}, query: parse('{ app(ref: "x") { id viewerAppUserMemoryClasses } }'),
      estimators: [hadronListEstimator({ maxCost: ceiling, listFactor: 10 }), simpleEstimator({ defaultComplexity: 1 })] });
    // The portal's create form asks for one App (hadron-portal#2634): the weight is all it adds.
    expect(one).toBeLessThan(APP_VIEWER_USER_MEMORY_CLASSES_COST + 20);
    // A full default page of Apps with the field is admitted, with a wide margin.
    const page = getComplexity({ schema, variables: {}, query: parse('{ apps(limit: 100) { items { id viewerAppUserMemoryClasses } } }'),
      estimators: [hadronListEstimator({ maxCost: ceiling, listFactor: 10 }), simpleEstimator({ defaultComplexity: 1 })] });
    expect(page).toBeLessThan(ceiling / 10);
  });

  it('puts a list over the ceiling that the same list without the field is under', () => {
    const ceiling = cost('') + 30 * APP_VIEWER_USER_MEMORY_CLASSES_COST - 1;
    expect(cost('', ceiling)).toBeLessThanOrEqual(ceiling);
    expect(cost('viewerAppUserMemoryClasses', ceiling)).toBeGreaterThan(ceiling);
  });
});
