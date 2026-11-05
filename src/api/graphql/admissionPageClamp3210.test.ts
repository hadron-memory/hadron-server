/** #3210 / cor:api:120:04 S2: admission charges the resolver's capped page, not an over-cap request. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync, readdirSync } from 'node:fs';
import ts from 'typescript';
import { buildSchema, parse, type GraphQLObjectType } from 'graphql';
import { getComplexity, simpleEstimator } from 'graphql-query-complexity';
import { createServer } from '../../server.js';
import { mintUserApiKey } from '../../middleware/auth.js';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../../lib/id.js';
import { typeDefs } from './schema/typeDefs.js';
import { pageTake } from './pageBounds.js';
import { hadronListEstimator, PAGE_ARGS_FIELDS } from './admissionComplexity.js';

const schema = buildSchema(typeDefs);
let appId: string, nodeId: string, key: string;
const servers: Server[] = [];
let ordinary: string, strict: string;
const boot = async () => {
  const server = createHttpServer(await createServer());
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/graphql`;
};
beforeAll(async () => {
  ordinary = await boot(); // Real production-default ceiling (200000), unchanged by this issue.
  // Flat scalar-only rows cannot exceed that ceiling before L3's selection cap. Exercise the SAME L4 guard at a
  // tighter configured ceiling without changing production defaults, selection/depth bounds, or resolver page sizes.
  const prior = process.env.GRAPHQL_MAX_COST;
  process.env.GRAPHQL_MAX_COST = '1000';
  try { strict = await boot(); } finally {
    if (prior === undefined) delete process.env.GRAPHQL_MAX_COST; else process.env.GRAPHQL_MAX_COST = prior;
  }
  await cleanDb(db);
  const suffix = generateId();
  const org = await db.organization.create({ data: { name: 'Admission', urn: `adm3210-${suffix}.test` } });
  const user = await db.user.create({ data: { handle: `adm3210-${suffix}`, roles: ['READER'] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: user.id, role: 'READER' } });
  const memory = await db.memory.create({ data: { organizationId: org.id, class: 'knowledge', name: 'M', urn: `${org.urn}:m` } });
  const app = await db.app.create({ data: { name: 'App', urn: `${org.urn}:app`, organizationId: org.id } });
  appId = app.id;
  const agent = await db.agent.create({ data: { name: 'Agent', urn: `${org.urn}:agent`, organizationId: org.id } });
  await db.appAgent.create({ data: { appId, agentId: agent.id } });
  await db.agentMemoryItem.create({ data: { agentId: agent.id, memoryId: memory.id, role: 'read-write' } });
  const nodes = Array.from({ length: 241 }, (_, i) => ({ id: generateId(), memoryId: memory.id, loc: `n${i}`, name: `n${i}` }));
  nodeId = nodes[0].id;
  await db.node.createMany({ data: nodes });
  await db.session.createMany({ data: Array.from({ length: 241 }, () => ({ id: generateId(), userId: user.id, type: 'DEVELOPER' })) });
  await db.usageEvent.createMany({ data: Array.from({ length: 241 }, () => ({ id: generateId(), memoryId: memory.id, type: 'fixture3210', nodeLoc: 'n0' })) });
  await db.nodeRevision.createMany({ data: Array.from({ length: 241 }, (_, revNo) => ({
    id: generateId(), nodeId, memoryId: memory.id, loc: 'n0', name: 'n0', tags: [], changes: [], revNo,
  })) });
  key = (await mintUserApiKey(db, { userId: user.id, label: null, createdBy: user.id, issuedVia: 'test' })).rawKey;
});
afterAll(async () => { await Promise.all(servers.map(server => new Promise<void>(resolve => server.close(() => resolve())))); });

const fields = [
  ['appNodesPage', () => `appRef: "${appId}"`],
  ['sessionsPage', () => ''],
  ['nodeRevisionsPage', () => `nodeRef: "${nodeId}"`],
  ['usageEventsPage', () => 'type: "fixture3210"'],
] as const;
const args = (base: string, limit: string) => [base, `limit: ${limit}`].filter(Boolean).join(', ');
const post = async (query: string, variables: Record<string, unknown> = {}, url = ordinary) => {
  const response = await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify({ query, variables }) });
  return { status: response.status, body: await response.json() as { data?: Record<string, any>; errors?: Array<{ extensions?: { code?: string } }> } };
};

describe.each(fields)('%s S2 over real GraphQL HTTP', (field, base) => {
  it.each([200, 201, 1000, 1000000])('limit %i, literal and variable, returns the cap and correct envelope', async limit => {
    const literal = `{ ${field}(${args(base(), String(limit))}) { items { id } total hasMore } }`;
    const variable = `query($n: Int) { ${field}(${args(base(), '$n')}) { items { id } total hasMore } }`;
    for (const r of [await post(literal), await post(variable, { n: limit })]) {
      expect(r.status).toBe(200);
      expect(r.body.errors).toBeUndefined();
      expect(r.body.data![field]).toMatchObject({ total: 241, hasMore: true });
      expect(r.body.data![field].items).toHaveLength(200);
    }
  });
  it('still refuses excessive cost at the CLAMPED size', async () => {
    // Ten scalar aliases => 2021 cost at 200 rows, greater than this server's configured 1000. Minimal id-only is 221.
    const minimal = `{ ${field}(${args(base(), '1000000')}) { items { id } } }`;
    expect((await post(minimal, {}, strict)).status).toBe(200);
    const selection = Array.from({ length: 10 }, (_, i) => `v${i}: id`).join(' ');
    const r = await post(`{ ${field}(${args(base(), '1000000')}) { items { ${selection} } } }`, {}, strict);
    expect(r.status).toBe(400);
    expect(r.body.errors?.[0]?.extensions?.code).toBe('QUERY_TOO_COMPLEX');
  });
});

it.each(['omitted', 'null'])('legacy appNodes %s limit reads exactly its real default of 20 over HTTP', async spelling => {
  const limit = spelling === 'omitted' ? '' : ', limit: null';
  const r = await post(`{ appNodes(appRef: "${appId}"${limit}) { id } }`);
  expect(r.status).toBe(200);
  expect(r.body.errors).toBeUndefined();
  expect(r.body.data!.appNodes).toHaveLength(20);
});

const cost = (query: string) => getComplexity({ schema, query: parse(query), variables: {}, estimators: [hadronListEstimator({ maxCost: 200000, listFactor: 10 }), simpleEstimator({ defaultComplexity: 1 })] });
it('legacy appNodes omitted/null costs its real 20 default, but stated sizes remain raw', () => {
  expect(cost('{ appNodes(appRef:"a") { id } }')).toBe(21);
  expect(cost('{ appNodes(appRef:"a", limit:null) { id } }')).toBe(21);
  expect(cost('{ appNodes(appRef:"a", limit:500) { id } }')).toBe(501);
  expect(cost('{ appNodes(appRef:"a", limit:1000000) { id } }')).toBe(200001);
  expect(PAGE_ARGS_FIELDS.has('Query.appNodes')).toBe(false);
});

it('current Query/AgentTask/AgentTaskResult direct or local-helper pageArgs resolvers are registered', () => {
  const folder = new URL('./schema/', import.meta.url);
  const types = ['Query', 'AgentTask', 'AgentTaskResult'].map(name => [name, (schema.getType(name) as GraphQLObjectType).getFields()] as const);
  const discovered = new Set<string>();
  for (const file of readdirSync(folder).filter(f => f.startsWith('resolvers.') && f.endsWith('.ts') && !f.endsWith('.test.ts'))) {
    const source = ts.createSourceFile(file, readFileSync(new URL(file, folder), 'utf8'), ts.ScriptTarget.Latest, true);
    const functions = new Map<string, ts.Node>();
    const candidates: Array<[string, ts.Node]> = [];
    const scan = (n: ts.Node) => {
      if (ts.isFunctionDeclaration(n) && n.name && n.body) functions.set(n.name.text, n.body);
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) functions.set(n.name.text, n.initializer);
      if (ts.isPropertyAssignment(n) && (ts.isIdentifier(n.name) || ts.isStringLiteral(n.name))) {
        const name = n.name.text;
        for (const [type, fields] of types) if (fields[name]) candidates.push([`${type}.${name}`, n.initializer]);
      }
      ts.forEachChild(n, scan);
    };
    scan(source);
    const reachesPageArgs = (n: ts.Node, seen = new Set<string>()): boolean => {
      let found = false;
      const visit = (x: ts.Node) => {
        if (ts.isCallExpression(x)) {
          const name = ts.isIdentifier(x.expression) ? x.expression.text : ts.isPropertyAccessExpression(x.expression) ? x.expression.name.text : '';
          if (name === 'pageArgs') found = true;
          else if (!seen.has(name) && functions.has(name)) {
            seen.add(name);
            if (reachesPageArgs(functions.get(name)!, seen)) found = true;
          }
        }
        ts.forEachChild(x, visit);
      };
      visit(n); return found;
    };
    for (const [name, body] of candidates) if (reachesPageArgs(body)) discovered.add(name);
  }
  expect(discovered.size).toBeGreaterThan(10);
  expect([...discovered].filter(key => !PAGE_ARGS_FIELDS.has(key)).sort()).toEqual([]);
});

it.each([...PAGE_ARGS_FIELDS])('%s cost follows the shared pageTake for every stated edge', key => {
  const [typeName, name] = key.split('.');
  const field = (schema.getType(typeName) as any).getFields()[name];
  const estimator = hadronListEstimator({ maxCost: 200000, listFactor: 10 });
  for (const limit of [undefined, null, -5, 0, 1, 20, 200, 201, 1000, 1000000]) {
    // A non-list Page wrapper scales its children; actual schema types/args are used, with fixed child cost 11.
    expect(estimator({ type: schema.getType(typeName) as never, field, args: limit === undefined ? {} : { limit }, childComplexity: 11 } as never))
      .toBe(1 + Math.max(1, Math.max(1, pageTake(limit)) / 10) * 11);
  }
});
