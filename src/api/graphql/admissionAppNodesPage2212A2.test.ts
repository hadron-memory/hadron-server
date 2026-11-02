/**
 * #2212 A2 fix head — complexity admission for `Query.appNodesPage` serves the cap (cor:api:120:04 S2: a limit
 * over the cap gets a page of the cap, never a refusal). Xylon's gate disposition on #3200: admission must size
 * the NEW field by what its resolver actually does (`pageArgs`: default 20, max 200, non-positive count-only),
 * and nothing else changes.
 *
 * Over the REAL GraphQL HTTP boundary (Express + Apollo + the admission plugin) with a seeded App of 241 nodes:
 *   - a valid Int of 1000000 and Int max, as literal and as variable, answer HTTP 200 with 200 items, total 241,
 *     hasMore true (the page-of-the-cap contract)
 *   - zero, negative, null and omitted agree with pageArgs
 *   - controls: the old `appNodes` and an unrelated paged field keep their raw-size costing (still refused at
 *     1000000), and a genuinely expensive appNodesPage operation is still refused before execution
 *   - drift guard: the cost admission charges equals the cost derived from the resolver's own `pageArgs` for every
 *     stated size, and the effective cap and default are pinned as literals so a shared constant cannot drift both.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { buildSchema, parse } from 'graphql';
import { getComplexity, simpleEstimator } from 'graphql-query-complexity';
import { createServer } from '../../server.js';
import { mintUserApiKey } from '../../middleware/auth.js';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../../lib/id.js';
import { typeDefs } from './schema/typeDefs.js';
import { pageArgs } from './schema/resolvers.helpers.js';
import { hadronListEstimator } from './admissionComplexity.js';

let appId: string;
let key: string;
let server: Server;
let baseUrl: string;

beforeAll(async () => {
  server = createHttpServer(await createServer());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); });

beforeEach(async () => {
  await cleanDb(db);
  const sfx = generateId().slice(-8);
  const org = await db.organization.create({ data: { name: 'adm', urn: `adm-${sfx}.example` } });
  const user = await db.user.create({ data: { handle: `adm-${sfx}`, roles: ['READER'] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: user.id, role: 'READER' } });
  const mem = await db.memory.create({ data: { organizationId: org.id, class: 'knowledge', name: 'M', urn: `${org.urn}:m` } });
  const app = await db.app.create({ data: { name: 'App', urn: `${org.urn}:app`, organizationId: org.id } });
  appId = app.id;
  const agent = await db.agent.create({ data: { name: 'Ag', urn: `${org.urn}:ag`, organizationId: org.id } });
  await db.appAgent.create({ data: { appId, agentId: agent.id } });
  await db.agentMemoryItem.create({ data: { agentId: agent.id, memoryId: mem.id, role: 'read-write' } });
  await db.node.createMany({ data: Array.from({ length: 241 }, (_, i) => ({
    id: generateId(), memoryId: mem.id, loc: `n${String(i).padStart(3, '0')}`, name: `n${i}`, content: 'x',
  })) });
  key = (await mintUserApiKey(db, { userId: user.id, label: null, createdBy: user.id, issuedVia: 'test' })).rawKey;
});

const post = async (query: string, variables: Record<string, unknown> = {}) => {
  const response = await fetch(`${baseUrl}/graphql`, {
    method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  return { status: response.status, body: await response.json() as { data?: any; errors?: Array<{ extensions?: { code?: string } }> } };
};
const PAGE_VAR = 'query($a: ID!, $l: Int) { appNodesPage(appRef: $a, limit: $l) { total hasMore items { id } } }';
const pageLiteral = (l: string) => `query($a: ID!) { appNodesPage(appRef: $a${l}) { total hasMore items { id } } }`;

describe('appNodesPage serves the cap over real HTTP (cor:api:120:04 S2)', () => {
  it.each([1000000, 2147483647])('limit %i, as a variable and as a literal, answers a page of 200', async (limit) => {
    for (const r of [await post(PAGE_VAR, { a: appId, l: limit }), await post(pageLiteral(`, limit: ${limit}`), { a: appId })]) {
      expect(r.status).toBe(200);
      expect(r.body.errors).toBeUndefined();
      expect(r.body.data.appNodesPage).toMatchObject({ total: 241, hasMore: true });
      expect(r.body.data.appNodesPage.items).toHaveLength(200);
    }
  });

  it('zero, negative, null and omitted agree with pageArgs', async () => {
    const count = async (v: Record<string, unknown>, q = PAGE_VAR) => (await post(q, { a: appId, ...v })).body.data.appNodesPage;
    expect((await count({ l: 0 }))).toMatchObject({ total: 241, hasMore: true, items: [] });
    expect((await count({ l: -5 }))).toMatchObject({ total: 241, items: [] });
    expect((await count({ l: null })).items).toHaveLength(20);
    expect((await count({}, pageLiteral(''))).items).toHaveLength(20);
  });
});

describe('controls: nothing else is loosened', () => {
  it('the old appNodes and an unrelated paged field keep raw-size costing', async () => {
    const old = await post('query($a: ID!) { appNodes(appRef: $a, limit: 1000000) { id } }', { a: appId });
    expect(old.status).toBe(400);
    expect(old.body.errors?.[0]?.extensions?.code).toBe('QUERY_TOO_COMPLEX');
    const sessions = await post('{ sessionsPage(limit: 1000000) { items { id } } }');
    expect(sessions.status).toBe(400);
    expect(sessions.body.errors?.[0]?.extensions?.code).toBe('QUERY_TOO_COMPLEX');
  });

  it('a genuinely expensive appNodesPage operation is still refused before execution', async () => {
    const r = await post(`query($a: ID!) { appNodesPage(appRef: $a, limit: 1000000) { items { outgoingEdges { target {
      outgoingEdges { target { outgoingEdges { target { id } } } } } } } } }`, { a: appId });
    expect(r.status).toBe(400);
    expect(r.body.errors?.[0]?.extensions?.code).toBe('QUERY_TOO_COMPLEX');
  });
});

describe('drift guard: admission sizes appNodesPage by the resolver\'s pageArgs', () => {
  const schema = buildSchema(typeDefs);
  const est = hadronListEstimator({ maxCost: 200000, listFactor: 10 });
  const cost = (limit: string) => getComplexity({
    schema, query: parse(`{ appNodesPage(appRef: "a"${limit}) { items { id } } }`), variables: {},
    estimators: [est, simpleEstimator({ defaultComplexity: 1 })],
  });
  // wrapper = 1 + max(1, size / listFactor) x items; items = 1 + listFactor x id
  const expected = (take: number) => 1 + Math.max(1, Math.max(1, take) / 10) * 11;

  it.each([undefined, null, 0, -5, 1, 7, 20, 200, 201, 1000, 1000000, 2147483647])('stated %s costs what its pageArgs take costs', (v) => {
    const take = pageArgs({ limit: v as number | null | undefined }).take;
    expect(cost(v === undefined ? '' : `, limit: ${v}`)).toBe(expected(take));
  });

  it('the effective cap and default are pinned as literals', () => {
    expect(pageArgs({ limit: 1000000 }).take).toBe(200);
    expect(pageArgs({}).take).toBe(20);
    expect(cost(', limit: 1000000')).toBe(expected(200));
    expect(cost('')).toBe(expected(20));
    expect(cost(', limit: 0')).toBe(expected(1)); // count-only still carries a nonzero minimum
  });
});
