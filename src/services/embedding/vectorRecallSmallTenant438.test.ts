/**
 * #438 — the shared HNSW index loses a small tenant's recall.
 *
 * There is one global HNSW index over every memory's vectors (post-push.sql). An ANN scan visits at most
 * `hnsw.ef_search` candidates (#1345 scales it with the window, capped at 1000) and only then applies
 * `memory_id IN (…)` and the role filter; iterative scans are not enabled. So when a large tenant's vectors
 * crowd the query's neighbourhood, a small tenant's eligible matches sit beyond the horizon and the scoped
 * search comes back short, or empty.
 *
 * The corpus: tenant BIG has 3,000 vectors a hair from the query; tenant SMALL has 5 nodes a little further
 * out. Exact ground truth comes from the exact plan; the production-at-scale plan is forced with
 * `enable_sort = off` (the #1970 pattern, `findings:vector-test-exact-assertion-hnsw-plan-flip`).
 *
 * This is an INVESTIGATION slice (no production change), so the recall regressions are `it.fails`: they are
 * red today and turn into a hard failure the moment a fix lands, which is the follow-up slice's cue to flip
 * them. The contract pins (scope, and a short result is never reported as exhausted) are plain and green.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb, createDbOrgAndGraph } from '../../test/helpers.js';
import { generateId } from '../../lib/id.js';
import type { EmbeddingClient } from '../../lib/embedding/index.js';
import { setEmbeddingClientForTests, resetEmbeddingClientForTests } from '../../lib/embedding/index.js';
import { getRetrievalProvider } from '../../lib/retrieval/postgres.js';
import { resolvers, type Context } from '../../api/graphql/schema/resolvers.js';

vi.mock('../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));

const DIM = 768;
const BIG_N = 3000;
/** The query: the unit vector on axis 1 (SQL index 2). Every stored vector leans on it. */
const qvec = () => { const q = new Array(DIM).fill(0); q[1] = 1; return q; };
const stub: EmbeddingClient = { provider: 'test', model: 'stub-model', dim: DIM, async embed(texts: string[]) { return texts.map(() => qvec()); } };

/** A db whose every interactive transaction first runs `sets` (the #1970 helper, as in findNodesVectorWindow1345). */
function withLocalSettings(base: typeof db, sets: string[]): typeof db {
  return new Proxy(base, {
    get(target, prop) {
      const v = Reflect.get(target, prop);
      if (prop !== '$transaction') return typeof v === 'function' ? v.bind(target) : v;
      return (arg: unknown, opts?: unknown) =>
        typeof arg !== 'function'
          ? (target.$transaction as any)(arg, opts)
          : (target.$transaction as any)(async (tx: any) => {
              for (const s of sets) await tx.$executeRawUnsafe(s);
              return (arg as (tx: unknown) => unknown)(tx);
            }, opts);
    },
  });
}
/** What a large production table gets: the ANN query served by the HNSW index. */
const PREFER_HNSW = ['SET LOCAL enable_sort = off'];
/** Ground truth: a scan plus a sort, never the index. */
const EXACT_PLAN = ['SET LOCAL enable_sort = on', 'SET LOCAL enable_indexscan = off'];

const findNodes = (handle: typeof db, args: Record<string, unknown>) =>
  (resolvers.Query as any).findNodes(null, args, { db: handle, roles: ['ADMIN'], userId: 'admin-438' } as Context);

let big: string;
let small: string;
let smallIds: string[];
let smallSpecIds: string[];

/**
 * Inserts one chunk vector per node of `memoryId`, in SQL: the query axis plus uniform noise of amplitude `noise`
 * on every other dimension, as real embeddings spread. BIG uses 0.02 (cosine distance about 0.013 from the query)
 * and SMALL 0.1 (about 0.2), so every BIG vector is nearer the query than every SMALL one; the fixture test checks.
 * `r.rn > 0` correlates the subquery with the row, so random() is drawn per row, not once.
 */
async function embed(memoryId: string, noise: number) {
  await db.$executeRawUnsafe(`
    INSERT INTO node_embeddings (id, node_id, memory_id, kind, provider, model, dim, chunk_index, char_start, char_end, chunk_text, embedding, created_at)
    SELECT md5(r.id), r.id, r.memory_id, 'chunk', 'test', 'stub-model', ${DIM}, 0, 0, 4, 'body',
      (SELECT array_agg(CASE WHEN g = 2 THEN 1 ELSE (random() - 0.5) * ${2 * noise} END ORDER BY g)
         FROM generate_series(1, ${DIM}) g WHERE r.rn > 0)::real[]::vector,
      now()
    FROM (SELECT id, memory_id, row_number() OVER (ORDER BY id) AS rn FROM nodes WHERE memory_id = '${memoryId}') r`);
}

beforeAll(async () => {
  await cleanDb(db);
  process.env.EMBEDDING_API_URL = 'http://stub.local/api/embed';
  setEmbeddingClientForTests(stub);
  const made = await createDbOrgAndGraph(db, { orgName: 'r438-org', graphName: 'r438/big' });
  big = made.graph.id;
  await db.memory.update({ where: { id: big }, data: { vectorIndexEnabled: true, embeddingSource: 'contentChunks' } });
  small = (await db.memory.create({
    data: { id: generateId(), organizationId: made.org.id, urn: 'r438-org:small', name: 'small', class: 'knowledge', visibility: 'ORGANIZATION', vectorIndexEnabled: true, embeddingSource: 'contentChunks' },
  })).id;
  await db.node.createMany({ data: Array.from({ length: BIG_N }, (_, i) => ({ id: generateId(), memoryId: big, loc: `b${i}`, name: `b${i}`, content: 'body', role: 'review' })) });
  const smallRows = Array.from({ length: 5 }, (_, i) => ({ id: generateId(), memoryId: small, loc: `s${i}`, name: `s${i}`, content: 'body', role: i < 2 ? 'spec' : 'review' }));
  await db.node.createMany({ data: smallRows });
  smallIds = smallRows.map((r) => r.id).sort();
  smallSpecIds = smallRows.filter((r) => r.role === 'spec').map((r) => r.id).sort();
  await embed(big, 0.02);
  await embed(small, 0.1);
}, 120_000);

afterAll(() => {
  resetEmbeddingClientForTests();
  delete process.env.EMBEDDING_API_URL;
});

const hnsw = () => withLocalSettings(db, PREFER_HNSW);
const exact = () => withLocalSettings(withLocalSettings(db, PREFER_HNSW), EXACT_PLAN);
const nodeIds = (res: any) => res.hits.map((h: any) => h.node.id).sort();
const passageIds = (res: any) => res.passages.map((p: any) => p.parentNodeId).sort();

describe('#438 the fixture means what it says', () => {
  it('the HNSW handle reaches the index and the exact handle does not; exact ground truth returns all of SMALL', async () => {
    const plan = async (h: typeof db) => (await h.$transaction((tx) => tx.$queryRawUnsafe<{ 'QUERY PLAN': string }[]>(
      `EXPLAIN SELECT ne.node_id FROM node_embeddings ne WHERE ne.memory_id = '${small}' ORDER BY ne.embedding <=> '[${qvec().join(',')}]'::vector LIMIT 50`,
    ))).map((r) => r['QUERY PLAN']).join('\n');
    expect(await plan(hnsw())).toContain('node_embeddings_embedding_hnsw');
    expect(await plan(exact())).not.toContain('node_embeddings_embedding_hnsw');
    // Every BIG vector is nearer the query than every SMALL vector: SMALL sits beyond the ANN horizon.
    const [d] = await db.$queryRawUnsafe<{ big_max: number; small_min: number }[]>(`
      SELECT max(embedding <=> '[${qvec().join(',')}]'::vector) FILTER (WHERE memory_id = '${big}') AS big_max,
             min(embedding <=> '[${qvec().join(',')}]'::vector) FILTER (WHERE memory_id = '${small}') AS small_min
      FROM node_embeddings`);
    expect(Number(d!.big_max)).toBeLessThan(Number(d!.small_min));
    expect(nodeIds(await findNodes(exact(), { query: 'q', mode: 'vector', limit: 5, filter: { memoryIds: [small] } }))).toEqual(smallIds);
  });
});

describe('#438 RED: on the HNSW plan the small tenant loses its eligible top-k (expected failures until the fix)', () => {
  it.fails('node, memory-scoped: mode vector returns all 5 of SMALL\'s eligible nodes', async () => {
    const res = await findNodes(hnsw(), { query: 'q', mode: 'vector', limit: 5, filter: { memoryIds: [small] } });
    expect(nodeIds(res)).toEqual(smallIds);
  });

  it.fails('chunk, memory-scoped: granularity chunk returns all 5 of SMALL\'s passages', async () => {
    const res = await findNodes(hnsw(), { query: 'q', mode: 'vector', granularity: 'chunk', limit: 5, filter: { memoryIds: [small] } });
    expect(passageIds(res)).toEqual(smallIds);
  });

  it.fails('node, role-filtered: the window widens to the cap (ef_search 1000) and still misses SMALL\'s spec nodes', async () => {
    const res = await findNodes(hnsw(), { query: 'q', mode: 'vector', limit: 5, filter: { memoryIds: [small], role: 'spec' } });
    expect(nodeIds(res)).toEqual(smallSpecIds);
  });

  it.fails('hybrid with no keyword match: the vector leg brings SMALL\'s nodes', async () => {
    const res = await findNodes(hnsw(), { query: 'zzzunmatchable', mode: 'hybrid', limit: 5, filter: { memoryIds: [small] } });
    expect(nodeIds(res)).toEqual(smallIds);
  });
});

describe('#438 contract today (green): scope holds and a short ANN result is never proven absence', () => {
  it('a SMALL-scoped search never returns a BIG node, on either plan and every path', async () => {
    for (const h of [hnsw(), exact()]) {
      for (const args of [
        { query: 'q', mode: 'vector', limit: 5 },
        { query: 'q', mode: 'vector', granularity: 'chunk', limit: 5 },
        { query: 'q', mode: 'vector', limit: 5, role: 'spec' },
        { query: 'zzzunmatchable', mode: 'hybrid', limit: 5 },
      ]) {
        const { role, ...rest } = args as any;
        const res = await findNodes(h, { ...rest, filter: { memoryIds: [small], ...(role ? { role } : {}) } });
        const got = [...res.hits.map((x: any) => x.node.id), ...(res.passages ?? []).map((p: any) => p.parentNodeId)];
        expect(got.filter((id: string) => !smallIds.includes(id)), JSON.stringify(args)).toEqual([]);
      }
    }
  });

  it('when the HNSW window comes back short of SMALL\'s eligible rows, the provider never reports it exhausted (node and chunk)', async () => {
    const provider = getRetrievalProvider();
    for (const kind of ['node', 'chunk'] as const) {
      let flag: boolean | null = null;
      const opts = { db: hnsw(), queryEmbedding: qvec(), memoryIds: [small], limit: 5, onWindow: (w: { exhausted: boolean }) => { flag = w.exhausted; } };
      const got = await (kind === 'node' ? provider.vectorSearch(opts) : provider.vectorSearchChunks(opts));
      expect(flag, kind).not.toBeNull();
      if (got.length < smallIds.length) expect(flag, kind).toBe(false);
    }
  });
});
