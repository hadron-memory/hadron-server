/** #4390 / cor:api:120:04 S2: admission charges a listPageArgs list at its OWN cap (100), so a huge `first` is clamped, never refused. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { buildSchema, parse } from 'graphql';
import { getComplexity, simpleEstimator } from 'graphql-query-complexity';
import { createServer } from '../../server.js';
import { mintUserApiKey } from '../../middleware/auth.js';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../../lib/id.js';
import { LIST_PAGE_CAP, listPageTake, validateListPageInput } from '../../lib/listPage.js';
import { typeDefs } from './schema/typeDefs.js';
import { hadronListEstimator } from './admissionComplexity.js';

const schema = buildSchema(typeDefs);
const cost = (query: string) => getComplexity({ schema, query: parse(query), variables: {}, estimators: [hadronListEstimator({ maxCost: 200000, listFactor: 10 }), simpleEstimator({ defaultComplexity: 1 })] });

const surfaces = [
  ['Query.webPollsPage', (f: string) => `{ webPollsPage(orgRef: "o", ${f}) { items { jobId } } }`],
  ['Query.webPolls', (f: string) => `{ webPolls(orgRef: "o", ${f}) { jobId } }`],
  ['Node.signingRequestsPage', (f: string) => `{ node(ref: "n") { signingRequestsPage(${f}) { items { id } } } }`],
  ['Node.signingRequests', (f: string) => `{ node(ref: "n") { signingRequests(${f}) { id } } }`],
] as const;

it('the shared constant is the resolver clamp', () => {
  expect(LIST_PAGE_CAP).toBe(100);
  expect(validateListPageInput({ first: 2147483647 }).take).toBe(LIST_PAGE_CAP);
  expect(listPageTake(2147483647)).toBe(validateListPageInput({ first: 2147483647 }).take);
  for (const n of [-5, 0, 1, 20, 99, 100, 101, 10000]) expect(listPageTake(n)).toBe(validateListPageInput({ first: n }).take);
  expect(listPageTake(null)).toBe(validateListPageInput({}).take);
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
  it.each(surfaces)('%s: first 2147483647 and 10000 are not refused as too complex', async (_k, q) => {
    for (const first of [10000, 2147483647]) {
      const body = await post(q(`first: ${first}`));
      expect(body.errors?.map(e => e.extensions?.code)).not.toContain('QUERY_TOO_COMPLEX');
    }
  });
});
