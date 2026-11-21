/**
 * #2772 (ruling 0150, cor:api:090:04) — vector and hybrid findNodes have NO candidate cap.
 *
 * Fixture: one memory with NEAR_N review nodes a hair from the query (more than the old 2,000 row cap AND
 * pgvector's ef_search maximum of 1000) and SPEC_N spec nodes further out. A selective filter (role: spec), or an
 * offset past the cap, must return the TRUE page of the filtered ranking, equal to a brute-force exact ordering.
 * On main these come back short or empty (the window stops at the cap, the exact fallback at its row bound).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, createDbOrgAndGraph } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import type { EmbeddingClient } from '../../../lib/embedding/index.js';
import { setEmbeddingClientForTests, resetEmbeddingClientForTests } from '../../../lib/embedding/index.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));

const DIM = 768;
const NEAR_N = 2600;
const SPEC_N = 8;
const qvec = () => { const q = new Array(DIM).fill(0); q[1] = 1; return q; };
const stub: EmbeddingClient = { provider: 'test', model: 'stub-model', dim: DIM, async embed(texts: string[]) { return texts.map(() => qvec()); } };
const QLIT = () => `[${qvec().join(',')}]`;

let mem: string;
let savedUrl: string | undefined;
let savedTimeout: string | undefined;

const findNodes = (args: Record<string, unknown>) =>
  (resolvers.Query as any).findNodes(null, args, { db, roles: ['ADMIN'], userId: 'admin-2772' } as Context);
const ids = (res: any) => res.hits.map((h: any) => h.node.id);

/** Brute-force reference: exact cosine order over the nodes passing `where` (SQL fragment on alias n). */
async function reference(where: string, offset: number, limit: number): Promise<string[]> {
  const rows = await db.$queryRawUnsafe<{ node_id: string }[]>(`
    SELECT ne.node_id FROM node_embeddings ne JOIN nodes n ON n.id = ne.node_id
    WHERE ne.memory_id = '${mem}' AND n.deleted_at IS NULL AND ${where}
    GROUP BY ne.node_id ORDER BY MIN(ne.embedding <=> '${QLIT()}'::vector) ASC, ne.node_id ASC
    OFFSET ${offset} LIMIT ${limit}`);
  return rows.map((r) => r.node_id);
}

async function embed(role: string, noise: number) {
  await db.$executeRawUnsafe(`
    INSERT INTO node_embeddings (id, node_id, memory_id, kind, provider, model, dim, chunk_index, char_start, char_end, chunk_text, embedding, created_at)
    SELECT md5(r.id), r.id, r.memory_id, 'chunk', 'test', 'stub-model', ${DIM}, 0, 0, 4, 'body',
      (SELECT array_agg(CASE WHEN g = 2 THEN 1 ELSE (random() - 0.5) * ${2 * noise} END ORDER BY g)
         FROM generate_series(1, ${DIM}) g WHERE r.rn > 0)::real[]::vector, now()
    FROM (SELECT id, memory_id, row_number() OVER (ORDER BY id) AS rn FROM nodes WHERE memory_id = '${mem}' AND role = '${role}') r`);
}

beforeAll(async () => {
  await cleanDb(db);
  savedUrl = process.env.EMBEDDING_API_URL;
  savedTimeout = process.env.VECTOR_SEARCH_TIMEOUT_MS;
  process.env.EMBEDDING_API_URL = 'http://stub.local/api/embed';
  setEmbeddingClientForTests(stub);
  const made = await createDbOrgAndGraph(db, { orgName: 'r2772-org', graphName: 'r2772/mem' });
  mem = made.graph.id;
  await db.memory.update({ where: { id: mem }, data: { vectorIndexEnabled: true, embeddingSource: 'contentChunks' } });
  await db.node.createMany({ data: Array.from({ length: NEAR_N }, (_, i) => ({ id: generateId(), memoryId: mem, loc: `n${i}`, name: `n${i}`, content: 'body', role: 'review' })) });
  await db.node.createMany({ data: Array.from({ length: SPEC_N }, (_, i) => ({ id: generateId(), memoryId: mem, loc: `s${i}`, name: `s${i}`, content: 'body', role: 'spec' })) });
  await embed('review', 0.02);
  await embed('spec', 0.1);
}, 180_000);

afterAll(() => {
  resetEmbeddingClientForTests();
  if (savedUrl === undefined) delete process.env.EMBEDDING_API_URL; else process.env.EMBEDDING_API_URL = savedUrl;
  if (savedTimeout === undefined) delete process.env.VECTOR_SEARCH_TIMEOUT_MS; else process.env.VECTOR_SEARCH_TIMEOUT_MS = savedTimeout;
});

describe('#2772 fixture', () => {
  it('every spec vector ranks behind more than 2,000 and 1,000 review vectors', async () => {
    const [d] = await db.$queryRawUnsafe<{ review_max: number; spec_min: number }[]>(`
      SELECT max(embedding <=> '${QLIT()}'::vector) FILTER (WHERE n.role = 'review') AS review_max,
             min(embedding <=> '${QLIT()}'::vector) FILTER (WHERE n.role = 'spec') AS spec_min
      FROM node_embeddings ne JOIN nodes n ON n.id = ne.node_id WHERE ne.memory_id = '${mem}'`);
    expect(Number(d!.review_max)).toBeLessThan(Number(d!.spec_min));
  });
});

describe('#2772 deep filtered page is the true page', () => {
  it('vector, role filter, offset 3: equals the brute-force ranking of the filtered set', async () => {
    const want = await reference(`n.role = 'spec'`, 3, 3);
    expect(want).toHaveLength(3);
    const res = await findNodes({ query: 'q', mode: 'vector', limit: 3, offset: 3, filter: { role: 'spec' } });
    expect(ids(res)).toEqual(want);
    expect(res.reason).toBeNull();
  }, 60_000);

  it('vector, role filter, offset 0 and a page that ends exactly at the set\'s end', async () => {
    const res = await findNodes({ query: 'q', mode: 'vector', limit: 10, offset: 0, filter: { role: 'spec' } });
    expect(ids(res)).toEqual(await reference(`n.role = 'spec'`, 0, 10));
    expect(res.hits).toHaveLength(SPEC_N);
  }, 60_000);

  it('hybrid with no keyword match: the filtered vector leg gives the true page', async () => {
    const res = await findNodes({ query: 'zzzunmatchable', mode: 'hybrid', limit: 3, offset: 3, filter: { role: 'spec' } });
    expect(ids(res)).toEqual(await reference(`n.role = 'spec'`, 3, 3));
  }, 60_000);

  it('chunk granularity with a role filter returns the true passages', async () => {
    const want = await reference(`n.role = 'spec'`, 3, 3);
    const res = await findNodes({ query: 'q', mode: 'vector', granularity: 'chunk', limit: 3, offset: 3, filter: { role: 'spec' } });
    expect(res.passages.map((p: any) => p.parentNodeId)).toEqual(want);
  }, 60_000);

  it('a locPrefix filter (structured filter inside the query) also reaches past the cap', async () => {
    const want = await reference(`n.loc LIKE 's%'`, 0, 4);
    const res = await findNodes({ query: 'q', mode: 'vector', limit: 4, filter: { locPrefix: 's' } });
    expect(ids(res)).toEqual(want);
  }, 60_000);
});

describe('#2772 unfiltered deep offset', () => {
  it('offset past 2,000 with no filter returns the correct page', async () => {
    const want = await reference('TRUE', 2300, 5);
    const res = await findNodes({ query: 'q', mode: 'vector', limit: 5, offset: 2300 });
    expect(ids(res)).toEqual(want);
  }, 60_000);
});

describe('#2772 an early stop is flagged, never a silent short page', () => {
  it('VECTOR_SEARCH_TIMEOUT_MS=1: degraded carries stopped_early, and reason when the page is empty', async () => {
    process.env.VECTOR_SEARCH_TIMEOUT_MS = '1';
    try {
      const res = await findNodes({ query: 'q', mode: 'vector', limit: 3, offset: 3, filter: { role: 'spec' } });
      expect(String(res.degraded ?? '').split(',')).toContain('stopped_early');
      if (res.hits.length === 0) expect(res.reason).toBe('stopped_early');
    } finally {
      delete process.env.VECTOR_SEARCH_TIMEOUT_MS;
    }
    // The setting does not leak: the next call (default budget) is whole.
    const ok = await findNodes({ query: 'q', mode: 'vector', limit: 3, offset: 3, filter: { role: 'spec' } });
    expect(ids(ok)).toEqual(await reference(`n.role = 'spec'`, 3, 3));
    expect(ok.degraded ?? null).toBeNull();
  }, 60_000);
});

describe('#2772 sort is page-local (option B)', () => {
  it('sortProperty orders only the relevance page: page 2 holds relevance ranks offset+1..offset+limit', async () => {
    const want = new Set(await reference(`n.role = 'spec'`, 3, 3));
    const res = await findNodes({ query: 'q', mode: 'vector', limit: 3, offset: 3, sort: 'loc', filter: { role: 'spec' } });
    expect(new Set(ids(res))).toEqual(want);
    const locs = res.hits.map((h: any) => h.node.loc);
    expect(locs).toEqual([...locs].sort());
  }, 60_000);
});
