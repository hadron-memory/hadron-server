/**
 * #5267 — `App.viewerAppUserMemoryClasses` is priced by admission, not batched (decided in the issue: the licence step is the
 * door's own judgement, `cor:dmo:060:20`, and is not copied). The weight is the statements one member App costs in the worst
 * shape priced here: three installed Agents, none licensed, so the licence loop runs to its end.
 */
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
let statements = 0;

async function select(ref: string, withField: boolean): Promise<number> {
  statements = 0;
  const ctx = { db: logged, userId: viewer, roles: ['READER'] } as unknown as Context;
  const res = await server.executeOperation(
    { query: `query ($ref: ID!) { app(ref: $ref) { id ${withField ? 'viewerAppUserMemoryClasses' : ''} } }`, variables: { ref } },
    { contextValue: ctx });
  if (res.body.kind !== 'single') throw new Error('unexpected incremental response');
  expect(res.body.singleResult.errors).toBeUndefined();
  return statements;
}
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
  (logged as any).$on('query', () => { statements += 1; });
});
afterAll(async () => { await logged?.$disconnect(); });

describe('#5267 the weight is what the field costs', () => {
  it('the fixture is the shapes the issue names: A none, B one licensed, C three unlicensed', async () => {
    const answer = async (id: string) => (await (resolvers.App as Record<string, any>).viewerAppUserMemoryClasses({ id }, {}, { db, userId: viewer, roles: ['READER'] })) as string[];
    expect(await answer(apps.A[0]!)).toEqual([]); // no Agent: nothing to create through
    expect(await answer(apps.B[0]!)).toEqual(['personal', 'private']);
    expect(await answer(apps.C[0]!)).toEqual([]); // installed, none licensed
  });

  it('each shape stays within the constant, and the constant is the worst shape (C)', async () => {
    const per = { A: [] as number[], B: [] as number[], C: [] as number[] };
    for (const shape of ['A', 'B', 'C'] as const) for (const id of apps[shape]) per[shape].push(await fieldStatements(id));
    const worst = (s: 'A' | 'B' | 'C') => Math.max(...per[s]);
    // Every App of a shape costs the same: the count has no per-App variance, so the max over 10 samples is the shape's cost.
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
