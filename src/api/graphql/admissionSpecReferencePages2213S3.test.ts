/**
 * #3222 (#2213 S3, cor:api:120:04) — complexity admission sizes `Query.specBacklinksPage` and
 * `Query.specUnresolvedReferencesPage` by what their resolvers read (`pageArgs`: default 20, max 200, over the cap
 * served as the cap), the way #2212 A2 does for `appNodesPage` (admissionAppNodesPage2212A2.test.ts).
 *
 * Over the REAL GraphQL HTTP boundary with a corpus of 241 backlinks and 241 unresolved references:
 *   - a limit of 1000000 and Int max, as literal and as variable, answers HTTP 200 with 200 items and the full total
 *   - zero, null and omitted agree with pageArgs
 *   - drift guard: the cost admission charges equals the cost derived from the resolver's own `pageArgs`
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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
import { resolvers } from './schema/resolvers.js';

vi.mock('../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

let draftId: string;
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
  const org = await db.organization.create({ data: { id: generateId(), name: 'Adm', urn: 'adm3222.example' } });
  const user = await db.user.create({ data: { githubId: 322211, githubUsername: 'adm3222', roles: [] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: user.id, role: 'ADMIN' } });
  const ctx = { db, userId: user.id, roles: [] };
  const draft = await resolvers.Mutation.createMemory(null, { orgId: org.id, name: 'specs-draft', draftCorpus: true }, ctx);
  draftId = draft.id;
  const cite = (loc: string) => Array.from({ length: 241 }, () => `hrn:node:${draft.urn}:${loc}`).join(' ');
  for (const loc of ['pas:010', 'pas:020']) {
    await db.node.create({ data: {
      id: generateId(), memoryId: draft.id, loc, name: loc, role: 'spec', nodeType: 'info',
      content: loc === 'pas:020' ? `${cite('pas:010')} ${cite('pas:099')}` : 'target',
    } });
  }
  key = (await mintUserApiKey(db, { userId: user.id, label: null, createdBy: user.id, issuedVia: 'test' })).rawKey;
});

const post = async (query: string, variables: Record<string, unknown> = {}) => {
  const response = await fetch(`${baseUrl}/graphql`, {
    method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  return { status: response.status, body: await response.json() as { data?: any; errors?: Array<{ extensions?: { code?: string } }> } };
};

const FIELDS = [
  ['specBacklinksPage', 'memoryRef: $m, loc: "pas:010"'],
  ['specUnresolvedReferencesPage', 'memoryRef: $m'],
] as const;

describe.each(FIELDS)('%s serves the cap over real HTTP (cor:api:120:04)', (field, args) => {
  const asVar = `query($m: ID!, $l: Int) { ${field}(${args}, limit: $l) { total hasMore items { kind sourceLoc targetLoc } } }`;
  const asLiteral = (l: string) => `query($m: ID!) { ${field}(${args}${l}) { total hasMore items { kind sourceLoc targetLoc } } }`;

  it.each([1000000, 2147483647])('limit %i, as a variable and as a literal, answers a page of 200', async (limit) => {
    for (const r of [await post(asVar, { m: draftId, l: limit }), await post(asLiteral(`, limit: ${limit}`), { m: draftId })]) {
      expect(r.status).toBe(200);
      expect(r.body.errors).toBeUndefined();
      expect(r.body.data[field]).toMatchObject({ total: 241, hasMore: true });
      expect(r.body.data[field].items).toHaveLength(200);
    }
  });

  it('zero, null and omitted agree with pageArgs', async () => {
    expect((await post(asVar, { m: draftId, l: 0 })).body.data[field]).toMatchObject({ total: 241, hasMore: true, items: [] });
    expect((await post(asVar, { m: draftId, l: null })).body.data[field].items).toHaveLength(20);
    expect((await post(asLiteral(''), { m: draftId })).body.data[field].items).toHaveLength(20);
  });
});

describe.each(FIELDS)('drift guard: admission sizes %s by the resolver\'s pageArgs', (field, args) => {
  const schema = buildSchema(typeDefs);
  const est = hadronListEstimator({ maxCost: 200000, listFactor: 10 });
  const literalArgs = args.replace('$m', '"m"');
  const cost = (limit: string) => getComplexity({
    schema, query: parse(`{ ${field}(${literalArgs}${limit}) { items { kind } } }`), variables: {},
    estimators: [est, simpleEstimator({ defaultComplexity: 1 })],
  });
  // wrapper = 1 + max(1, size / listFactor) x items; items = 1 + listFactor x kind
  const expected = (take: number) => 1 + Math.max(1, Math.max(1, take) / 10) * 11;

  it.each([undefined, null, 0, -5, 1, 20, 200, 201, 1000000, 2147483647])('stated %s costs what its pageArgs take costs', (v) => {
    const take = pageArgs({ limit: v as number | null | undefined }).take;
    expect(cost(v === undefined ? '' : `, limit: ${v}`)).toBe(expected(take));
  });

  it('the effective cap and default are pinned as literals', () => {
    expect(cost(', limit: 1000000')).toBe(expected(200));
    expect(cost('')).toBe(expected(20));
  });
});
