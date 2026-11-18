/** #4390 / cor:api:120:04 S2: admission charges a listPageArgs list at its OWN cap (100), so a huge `first` is clamped, never refused. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readdirSync, readFileSync } from 'node:fs';
import { buildSchema, getNullableType, isListType, parse, type GraphQLObjectType } from 'graphql';
import { getComplexity, simpleEstimator } from 'graphql-query-complexity';
import { createServer } from '../../server.js';
import { mintUserApiKey } from '../../middleware/auth.js';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../../lib/id.js';
import { LIST_PAGE_CAP, listPageTake, validateListPageInput } from '../../lib/listPage.js';
import { typeDefs } from './schema/typeDefs.js';
import { hadronListEstimator, LIST_PAGE_FIELDS, PAGE_ARGS_FIELDS } from './admissionComplexity.js';

const schema = buildSchema(typeDefs);
const cost = (query: string) => getComplexity({ schema, query: parse(query), variables: {}, estimators: [hadronListEstimator({ maxCost: 200000, listFactor: 10 }), simpleEstimator({ defaultComplexity: 1 })] });

const surfaces = [
  ['Query.webPollsPage', (f: string) => `{ webPollsPage(orgRef: "o", ${f}) { items { jobId } } }`],
  ['Query.webPolls', (f: string) => `{ webPolls(orgRef: "o", ${f}) { jobId } }`],
  ['Node.signingRequestsPage', (f: string) => `{ node(ref: "n") { signingRequestsPage(${f}) { items { id } } } }`],
  ['Node.signingRequests', (f: string) => `{ node(ref: "n") { signingRequests(${f}) { id } } }`],
] as const;

it('the shared constant is the resolver clamp', () => {
  expect(validateListPageInput({ first: 2147483647 }).take).toBe(LIST_PAGE_CAP);
  expect(listPageTake(2147483647)).toBe(validateListPageInput({ first: 2147483647 }).take);
  for (const n of [-5, 0, 1, 20, 99, 100, 101, 10000]) expect(listPageTake(n)).toBe(validateListPageInput({ first: n }).take);
  expect(listPageTake(null)).toBe(validateListPageInput({}).take);
});

describe('LIST_PAGE_FIELDS cannot drift from the resolvers (#4390 blind P2-1)', () => {
  it('every key is a real list-or-page field with a page argument, and no key is also a pageArgs field', () => {
    for (const key of LIST_PAGE_FIELDS) {
      const [type, name] = key.split('.');
      const field = (schema.getType(type) as GraphQLObjectType).getFields()[name];
      expect(field, key).toBeDefined();
      expect(field.args.some(a => a.name === 'first'), key).toBe(true);
      expect(isListType(getNullableType(field.type)) || /Page$/.test(name), key).toBe(true);
      expect(PAGE_ARGS_FIELDS.has(key), key).toBe(false);
    }
  });
  it('the resolver files that clamp through listPageArgs/validateListPageInput are exactly the audited set: a new one fails here until its fields are registered', () => {
    const dir = new URL('./schema/', import.meta.url);
    const users = readdirSync(dir)
      .filter(f => f.endsWith('.ts') && !f.endsWith('.test.ts'))
      .filter(f => /\b(listPageArgs|validateListPageInput)\(/.test(readFileSync(new URL(f, dir), 'utf8')))
      .sort();
    expect(users).toEqual(['installMemory.ts', 'resolvers.inheritedNode.ts', 'resolvers.signing.ts', 'resolvers.webPoll.ts']);
  });
});

describe.each(surfaces)('%s admission cost', (_key, q) => {
  const base = cost(q('first: 100'));
  it.each([101, 10000, 2147483647])('first %i costs exactly the capped page', first => { expect(cost(q(`first: ${first}`))).toBe(base); });
  it('a smaller first is charged as stated, omitted as the default 20, never below 1', () => {
    expect(cost(q('first: 1'))).toBeLessThan(cost(q('first: 20')));
    expect(cost(q('first: 20'))).toBeLessThan(base);
    expect(cost(q('first: 0'))).toBe(cost(q('first: 1')));
    expect(cost(q('first: null'))).toBe(cost(q('first: 20')));
  });
});

describe('over real HTTP at the production ceiling', () => {
  let server: Server, url: string, key: string;
  beforeAll(async () => {
    server = createHttpServer(await createServer());
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/graphql`;
    await cleanDb(db);
    const user = await db.user.create({ data: { handle: `adm4390-${generateId()}`, roles: ['READER'] } });
    key = (await mintUserApiKey(db, { userId: user.id, label: null, createdBy: user.id, issuedVia: 'test' })).rawKey;
  });
  afterAll(async () => { await new Promise<void>(resolve => server.close(() => resolve())); });
  const post = async (query: string) => {
    const r = await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify({ query }) });
    return await r.json() as { errors?: Array<{ extensions?: { code?: string } }> };
  };
  it('control: admission is wired into this server (a face-value list over the ceiling IS refused)', async () => {
    const body = await post('{ appNodes(appRef: "a", limit: 1000000) { id } }');
    expect((body.errors ?? []).map(e => e.extensions?.code)).toContain('QUERY_TOO_COMPLEX');
  });
  it.each(surfaces)('%s: first 2147483647 and 10000 are not refused as too complex', async (_k, q) => {
    for (const first of [10000, 2147483647]) {
      const body = await post(q(`first: ${first}`));
      expect((body.errors ?? []).map(e => e.extensions?.code)).not.toContain('QUERY_TOO_COMPLEX');
    }
  });
});
