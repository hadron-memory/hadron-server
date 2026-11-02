/**
 * #3223 (#2212 A3, cor:api:120:04 S2): complexity admission sizes `Query.myChatsPage` by what its resolver reads
 * (`pageArgs`: default 20, max 200), as A2 did for `appNodesPage`. Over the REAL GraphQL HTTP boundary with a
 * caller who has 241 chats: a limit far over the cap answers HTTP 200 with a page of 200, never a refusal. Controls:
 * the old `myChats` keeps raw-size costing, and an expensive myChatsPage operation is still refused before
 * execution. Drift guard: the charged cost equals the cost of the resolver's own `pageArgs` take.
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

let agentId: string;
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
  const agent = await db.agent.create({ data: { name: 'Ag', urn: `${org.urn}:ag`, organizationId: org.id } });
  agentId = agent.id;
  const personal = await db.memory.create({
    data: {
      organizationId: org.id, class: 'knowledge', name: 'P', urn: `${org.urn}:p`, visibility: 'ORGANIZATION',
      userMemoryOfAgentId: agent.id, createdBy: user.id,
    },
  });
  await db.node.createMany({ data: Array.from({ length: 241 }, (_, i) => ({
    id: generateId(), memoryId: personal.id, loc: `chats:c${String(i).padStart(3, '0')}`, name: `c${i}`,
    nodeType: 'record', data: { scope: 'private' },
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
const PAGE_VAR = 'query($a: ID!, $l: Int) { myChatsPage(agentRef: $a, limit: $l) { total hasMore items { id } } }';

describe('myChatsPage serves the cap over real HTTP (cor:api:120:04 S2)', () => {
  it.each([201, 1000000, 2147483647])('limit %i answers a page of 200', async (limit) => {
    const r = await post(PAGE_VAR, { a: agentId, l: limit });
    expect(r.status).toBe(200);
    expect(r.body.errors).toBeUndefined();
    expect(r.body.data.myChatsPage).toMatchObject({ total: 241, hasMore: true });
    expect(r.body.data.myChatsPage.items).toHaveLength(200);
  });

  it('omitted pages at 20 and 0 is count-only', async () => {
    expect((await post(PAGE_VAR, { a: agentId })).body.data.myChatsPage.items).toHaveLength(20);
    expect((await post(PAGE_VAR, { a: agentId, l: 0 })).body.data.myChatsPage).toEqual({ total: 241, hasMore: true, items: [] });
  });
});

describe('controls: nothing else is loosened', () => {
  it('the old myChats keeps raw-size costing', async () => {
    const old = await post('query($a: ID!) { myChats(agentRef: $a, limit: 1000000) { id } }', { a: agentId });
    expect(old.status).toBe(400);
    expect(old.body.errors?.[0]?.extensions?.code).toBe('QUERY_TOO_COMPLEX');
  });

  it('an expensive myChatsPage operation is still refused before execution', async () => {
    const r = await post(`query($a: ID!) { myChatsPage(agentRef: $a, limit: 200) { items { servedPrompts(limit: 1000000) {
      items { id } } } } }`, { a: agentId });
    expect(r.status).toBe(400);
    expect(r.body.errors?.[0]?.extensions?.code).toBe('QUERY_TOO_COMPLEX');
  });
});

describe('drift guard: admission sizes myChatsPage by the resolver\'s pageArgs', () => {
  const schema = buildSchema(typeDefs);
  const est = hadronListEstimator({ maxCost: 200000, listFactor: 10 });
  const cost = (limit: string) => getComplexity({
    schema, query: parse(`{ myChatsPage(agentRef: "a"${limit}) { items { id } } }`), variables: {},
    estimators: [est, simpleEstimator({ defaultComplexity: 1 })],
  });
  // wrapper = 1 + max(1, size / listFactor) x items; items = 1 + listFactor x id
  const expected = (take: number) => 1 + Math.max(1, Math.max(1, take) / 10) * 11;

  it.each([undefined, null, 0, -5, 1, 20, 200, 201, 1000000])('stated %s costs what its pageArgs take costs', (v) => {
    const take = pageArgs({ limit: v as number | null | undefined }).take;
    expect(cost(v === undefined ? '' : `, limit: ${v}`)).toBe(expected(take));
  });
});
