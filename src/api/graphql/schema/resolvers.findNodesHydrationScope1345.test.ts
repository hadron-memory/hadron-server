/**
 * #1345 review, round 8 (@copilot) — every findNodes hydration re-asserts what
 * the ranking/filter query established, because the two are separate queries:
 *   - the no-query SQL browse re-applies scope AND the structured filters;
 *   - graph neighbours (`expand`) stay deliberately UNFILTERED, but never
 *     leave the caller's memory scope.
 * The race is simulated by having the first query return rows that no longer
 * qualify (a changed role; a node now outside scope).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, createDbOrgAndGraph } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { getRetrievalProvider } from '../../../lib/retrieval/postgres.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));

const neighbours: { extra: string[] } = { extra: [] };
vi.mock('../../../lib/search.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../lib/search.js')>();
  return {
    ...real,
    // Simulate the race: the scoped neighbour query returned an id that has since left scope.
    expandWithNeighbors: vi.fn(async (...args: Parameters<typeof real.expandWithNeighbors>) => [
      ...(await real.expandWithNeighbors(...args)),
      ...neighbours.extra,
    ]),
  };
});

const admin = (): Context => ({ db, roles: ['ADMIN'], userId: 'admin-hs' } as Context);
const findNodes = (args: Record<string, unknown>) => (resolvers.Query as any).findNodes(null, args, admin());

let memId: string;
let spec: string;
let review: string;
let outside: string;

beforeEach(async () => {
  await cleanDb(db);
  const made = await createDbOrgAndGraph(db, { orgName: 'hs-org', graphName: 'hs/graph' });
  memId = made.graph.id;
  const other = await db.memory.create({
    data: { id: generateId(), organizationId: made.org.id, urn: 'hs-org:other', name: 'other', class: 'knowledge', visibility: 'ORGANIZATION' },
  });
  const mk = async (memoryId: string, loc: string, role: string | null) =>
    (await db.node.create({ data: { id: generateId(), memoryId, loc, name: loc, role, content: `${loc} zebracontent`, properties: { k: 'v' } } })).id;
  spec = await mk(memId, 'a-spec', 'spec');
  review = await mk(memId, 'b-review', 'review');
  outside = await mk(other.id, 'c-outside', 'spec');
  await db.edge.create({ data: { id: generateId(), memoryId: memId, sourceId: spec, targetId: review, loc: 'a-spec:next:b-review', name: 'next' } });
});

afterEach(() => {
  neighbours.extra = [];
  vi.restoreAllMocks();
});

describe('SQL browse (no query, with where) re-applies scope and filters at hydration', () => {
  it('a filtered id that no longer matches the role, or left scope, is not returned', async () => {
    vi.spyOn(getRetrievalProvider(), 'filterSearch').mockResolvedValue([review, outside, spec]);
    const res = await findNodes({ filter: { memoryIds: [memId], role: 'spec', where: { path: ['k'], eq: 'v' } } });
    expect(res.hits.map((h: any) => h.node.id)).toEqual([spec]);
  });
});

describe('expand neighbours stay in scope', () => {
  it('a neighbour id outside the caller\'s scope is never hydrated; in-scope neighbours still are', async () => {
    neighbours.extra = [outside];
    // expand runs on the RANKED paths (buildResult / hydrateInOrder), so query.
    const res = await findNodes({ query: 'zebracontent', mode: 'keyword', filter: { memoryIds: [memId], role: 'spec' }, expand: 1 });
    const ids = res.hits.map((h: any) => h.node.id);
    expect(ids).toContain(spec);
    expect(ids).toContain(review); // unfiltered by role, by design
    expect(ids).not.toContain(outside);
  });

  it('the same through buildResult (hybrid on an unindexed memory degrades to keyword there)', async () => {
    neighbours.extra = [outside];
    const res = await findNodes({ query: 'zebracontent', mode: 'hybrid', filter: { memoryIds: [memId], role: 'spec' }, expand: 1 });
    expect(res.degraded ?? res.reason ?? '').toMatch(/no_vector_index/); // proves the buildResult path ran
    const ids = res.hits.map((h: any) => h.node.id);
    expect(ids).toContain(spec);
    expect(ids).toContain(review);
    expect(ids).not.toContain(outside);
  });
});
