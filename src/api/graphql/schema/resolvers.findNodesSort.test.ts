import { randomUUID } from 'node:crypto';
/**
 * Resolver-level behavior for the findNodes property-path sort (#719,
 * `sortProperty`): ordering by a properties/data JSON path across the no-query
 * browse, the lexical (keyword) path, and the vector re-sort — plus the cast
 * routing (text/number/datetime), NULLS-LAST for missing/unparseable values,
 * `sortProperty` overriding the `sort` enum, and the BAD_USER_INPUT surface.
 *
 * The ordered-list assertions use an UNSORTED extractor (the point is the order
 * the resolver returns, not set membership).
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, createDbOrgAndGraph } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import type { EmbeddingClient } from '../../../lib/embedding/index.js';
import { setEmbeddingClientForTests, resetEmbeddingClientForTests } from '../../../lib/embedding/index.js';
import { embedNode } from '../../../jobs/embedNodes.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

const admin = (): Context => ({ db, roles: ['ADMIN'], userId: 'admin-sort' } as Context);
const findNodes = (args: Record<string, unknown>) => (resolvers.Query as any).findNodes(null, args, admin());
/** Ordered (NOT sorted) loc list — order is what's under test. */
const order = (res: any): string[] => res.hits.map((h: any) => h.node.loc);

let graph: { id: string };
const mkNode = (fields: Record<string, unknown>) =>
  db.node.create({ data: { id: generateId(), memoryId: graph.id, ...fields } as any });

beforeEach(async () => {
  await cleanDb(db);
  const made = await createDbOrgAndGraph(db, { orgName: 'nsort-org', graphName: 'nsort/graph' });
  graph = made.graph;
  // stage (text), rank (number, one unparseable), at (datetime, one junk), one row missing every prop.
  await mkNode({ loc: 'n.a', name: 'insight a', properties: { stage: 'seed', rank: 9, at: '2026-03-01T00:00:00Z' } });
  await mkNode({ loc: 'n.b', name: 'insight b', properties: { stage: 'series-a', rank: 10, at: '2026-07-01T00:00:00Z' } });
  await mkNode({ loc: 'n.c', name: 'insight c', properties: { stage: 'series-a', rank: '2', at: 'not-a-date' } });
  await mkNode({ loc: 'n.d', name: 'plain note', properties: {} });
});

describe('findNodes sortProperty — no-query browse', () => {
  it('orders by a text property ascending; missing values last, loc breaks ties', async () => {
    const res = await findNodes({ sortProperty: { path: ['stage'] } });
    // seed < series-a; b & c tie on 'series-a' → loc order (n.b before n.c); n.d (missing) last.
    expect(order(res)).toEqual(['n.a', 'n.b', 'n.c', 'n.d']);
    expect(res.hits[0].score).toBeNull(); // unscored browse
  });

  it('number cast sorts numerically (not lexically), junk/missing last', async () => {
    const res = await findNodes({ sortProperty: { path: ['rank'], as: 'number', direction: 'desc' } });
    // numeric desc: 10 (b), 9 (a), 2 (c); n.d missing → last. Lexical would misorder '10'/'2'/'9'.
    expect(order(res)).toEqual(['n.b', 'n.a', 'n.c', 'n.d']);
  });

  it('datetime cast sorts chronologically; unparseable + missing last', async () => {
    const res = await findNodes({ sortProperty: { path: ['at'], as: 'datetime' } });
    // asc: a (03-01), b (07-01); c ('not-a-date') and d (missing) both NULL → loc tiebreak (c before d).
    expect(order(res)).toEqual(['n.a', 'n.b', 'n.c', 'n.d']);
  });

  it('intersects with the memoryIds scope', async () => {
    const other = await createDbOrgAndGraph(db, { orgName: 'nsort-other', graphName: 'nsort/other' });
    await db.node.create({ data: { id: generateId(), memoryId: other.graph.id, loc: 'z', name: 'z', properties: { stage: 'aaa' } } as any });
    const res = await findNodes({ filter: { memoryIds: [graph.id] }, sortProperty: { path: ['stage'] } });
    expect(order(res)).toEqual(['n.a', 'n.b', 'n.c', 'n.d']); // the other memory's node is out of scope
  });

  it('traverses an array-crossing path (SQL #>> parity)', async () => {
    await mkNode({ loc: 'arr.x', name: 'arr x', properties: { items: [{ rank: 7 }] } });
    await mkNode({ loc: 'arr.y', name: 'arr y', properties: { items: [{ rank: 3 }] } });
    const res = await findNodes({
      filter: { locPrefix: 'arr.' },
      sortProperty: { path: ['items', '0', 'rank'], as: 'number' },
    });
    expect(order(res)).toEqual(['arr.y', 'arr.x']); // 3 < 7, via SQL properties #>> {items,0,rank}
  });

  it('composes a where predicate with a property sort', async () => {
    const res = await findNodes({
      filter: { where: { path: ['stage'], eq: 'series-a' } },
      sortProperty: { path: ['rank'], as: 'number', direction: 'desc' },
    });
    // where keeps b (10) & c (2); sort desc → b, c.
    expect(order(res)).toEqual(['n.b', 'n.c']);
  });
});

describe('findNodes sortProperty — lexical (keyword)', () => {
  it('overrides relevance ranking with the property order', async () => {
    const res = await findNodes({ query: 'insight', mode: 'keyword', sortProperty: { path: ['stage'] } });
    // 'insight' matches a, b, c (not d 'plain note'); ordered by stage: a (seed), then b, c (series-a, loc tiebreak).
    expect(order(res)).toEqual(['n.a', 'n.b', 'n.c']);
  });

  it('sortProperty takes precedence over the sort enum', async () => {
    const res = await findNodes({ query: 'insight', mode: 'keyword', sort: 'loc', sortProperty: { path: ['rank'], as: 'number', direction: 'desc' } });
    // enum 'loc' would give a,b,c; property rank desc gives b(10), a(9), c(2).
    expect(order(res)).toEqual(['n.b', 'n.a', 'n.c']);
  });
});

describe('findNodes sortProperty — vector re-sort', () => {
  const DIM = 768;
  const oneHot = (slot: number): number[] => { const v = new Array(DIM).fill(0); v[slot % DIM] = 1; return v; };
  const stub = (map: Record<string, number[]>): EmbeddingClient => ({
    provider: 'test', model: 'stub-model', dim: DIM,
    async embed(texts: string[]) { return texts.map((t) => map[t] ?? oneHot(0)); },
  });

  afterAll(() => { resetEmbeddingClientForTests(); delete process.env.EMBEDDING_API_URL; });

  it('re-orders the vector-ranked candidate window by the property', async () => {
    process.env.EMBEDDING_API_URL = 'http://stub.local/api/embed';
    setEmbeddingClientForTests(stub({ q: oneHot(1), va: oneHot(1), vb: oneHot(1), vc: oneHot(1) }));
    const made = await createDbOrgAndGraph(db, { orgName: 'nsort-vec', graphName: 'nsort/vec' });
    const memId = made.graph.id;
    await db.memory.update({ where: { id: memId }, data: { vectorIndexEnabled: true } });
    const seed = async (loc: string, abstract: string, properties: Record<string, unknown>) => {
      const id = generateId();
      await db.node.create({ data: { id, memoryId: memId, loc, name: loc, abstract, properties, embeddingWorkToken: randomUUID(), embeddingPendingAt: new Date() } as any });
      expect(await embedNode(db, id, { abstract })).toBe('embedded');
    };
    // all three embed to the same slot as the query → all are vector hits, then re-sorted by rank.
    await seed('v.a', 'va', { rank: 9 });
    await seed('v.b', 'vb', { rank: 10 });
    await seed('v.c', 'vc', { rank: 2 });

    const res = await findNodes({ query: 'q', mode: 'vector', filter: { memoryIds: [memId] }, sortProperty: { path: ['rank'], as: 'number', direction: 'desc' } });
    expect(order(res)).toEqual(['v.b', 'v.a', 'v.c']); // 10, 9, 2 — not similarity order
  });
});

describe('findNodes sortProperty — BAD_USER_INPUT', () => {
  it('rejects an injection attempt in the sort path', async () => {
    await expect(findNodes({ sortProperty: { path: [`x') --`] } })).rejects.toMatchObject({
      extensions: { code: 'BAD_USER_INPUT' },
    });
  });

  it('rejects an empty sort path', async () => {
    await expect(findNodes({ sortProperty: { path: [] } })).rejects.toMatchObject({
      extensions: { code: 'BAD_USER_INPUT' },
    });
  });
});
