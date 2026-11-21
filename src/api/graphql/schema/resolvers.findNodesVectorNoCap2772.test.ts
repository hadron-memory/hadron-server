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
import { setIterativeScanSupportForTests, resetIterativeScanLogForTests } from '../../../services/embedding/vectors.js';
import { getRetrievalProvider } from '../../../lib/retrieval/postgres.js';
import { createTestableMcpServer } from '../../../mcp/server.js';
import { resolvers, type Context } from './resolvers.js';
import { setVectorSmallScopeRowsForTests as __smallScope } from '../../../services/embedding/vectors.js';
import { beforeEach as __be, afterEach as __ae } from 'vitest';
// #2772: these pins are about the ITERATIVE index scan; their small fixtures would otherwise be ranked exactly
// (a scope under the small-scope bound never walks the global HNSW index, BLIND/SEC findings at b07e0311).
__be(() => {
  __smallScope(0);
  // These pins are about WHICH page comes back, not the budget: a loaded CI shard must not turn a slow walk into an
  // early stop. The early-stop pin below sets its own value.
  process.env.VECTOR_SEARCH_TIMEOUT_MS = '60000';
});
__ae(() => __smallScope(null));

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));

const DIM = 768;
const NEAR_N = 2600;
const SPEC_N = 8;
const qvec = () => { const q = new Array(DIM).fill(0); q[1] = 1; return q; };
const stub: EmbeddingClient = { provider: 'test', model: 'stub-model', dim: DIM, async embed(texts: string[]) { return texts.map(() => qvec()); } };
const QLIT = () => `[${qvec().join(',')}]`;

let mem: string;
let memberId: string;
let foreignSpecIds: string[] = [];
let savedUrl: string | undefined;
let savedTimeout: string | undefined;

// The admin sees every memory (including the other org's, see the access pin), so the pins run scoped to `mem`.
const findNodes = (args: Record<string, unknown>) =>
  (resolvers.Query as any).findNodes(null, { ...args, filter: { ...((args.filter as object) ?? {}), memoryIds: [mem] } }, { db, roles: ['ADMIN'], userId: 'admin-2772' } as Context);
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
  // Access: a plain member of the first org, and a memory of ANOTHER org (unreadable to them) whose spec nodes
  // rank AHEAD of every readable spec node.
  memberId = (await db.user.create({ data: { id: generateId(), handle: 'm2772', roles: [] } })).id;
  await db.orgMember.create({ data: { organizationId: made.org.id, userId: memberId, role: 'READER' } });
  await db.memory.update({ where: { id: mem }, data: { visibility: 'ORGANIZATION' } });
  const other = await db.organization.create({ data: { id: generateId(), name: 'r2772-other', urn: 'r2772-other' } });
  const foreign = await db.memory.create({ data: { id: generateId(), organizationId: other.id, urn: 'r2772-other:f', name: 'f', class: 'knowledge', visibility: 'ORGANIZATION', vectorIndexEnabled: true, embeddingSource: 'contentChunks' } });
  const fr = Array.from({ length: 4 }, (_, i) => ({ id: generateId(), memoryId: foreign.id, loc: `f${i}`, name: `f${i}`, content: 'body', role: 'spec' }));
  await db.node.createMany({ data: fr });
  foreignSpecIds = fr.map((r) => r.id);
  await db.$executeRawUnsafe(`
    INSERT INTO node_embeddings (id, node_id, memory_id, kind, provider, model, dim, chunk_index, char_start, char_end, chunk_text, embedding, created_at)
    SELECT md5(id), id, memory_id, 'chunk', 'test', 'stub-model', ${DIM}, 0, 0, 4, 'body', ('[' || array_to_string(array_fill(0::real, ARRAY[1]) || ARRAY[1::real] || array_fill(0::real, ARRAY[${DIM - 2}]), ',') || ']')::vector, now()
    FROM nodes WHERE memory_id = '${foreign.id}'`);
}, 180_000);

afterAll(() => {
  resetEmbeddingClientForTests();
  if (savedUrl === undefined) delete process.env.EMBEDDING_API_URL; else process.env.EMBEDDING_API_URL = savedUrl;
  if (savedTimeout === undefined) delete process.env.VECTOR_SEARCH_TIMEOUT_MS; else process.env.VECTOR_SEARCH_TIMEOUT_MS = savedTimeout;
});

/** A db whose transactions run on the HNSW plan and record every in-transaction vector statement and SET LOCAL. */
function spyHandle() {
  const seen: string[] = [];
  const sets: string[] = [];
  const handle = new Proxy(db, {
      get(target, prop) {
        const v = Reflect.get(target, prop);
        if (prop !== '$transaction') return typeof v === 'function' ? v.bind(target) : v;
        return (arg: unknown, opts?: unknown) => typeof arg !== 'function' ? (target.$transaction as any)(arg, opts)
          : (target.$transaction as any)(async (tx: any) => {
              await tx.$executeRawUnsafe('SET LOCAL plan_cache_mode = force_custom_plan');
              await tx.$executeRawUnsafe('SET LOCAL enable_sort = off'); // the production-at-scale plan: HNSW serves the ranking
              const t = new Proxy(tx, { get(tt, pp) {
                const vv = Reflect.get(tt, pp);
                if (pp === '$queryRaw') return (strings: TemplateStringsArray, ...vals: unknown[]) => { seen.push(strings.join('?')); return (vv as any).call(tt, strings, ...vals); };
                if (pp === '$executeRawUnsafe') return (sql: string) => { sets.push(sql); return (vv as any).call(tt, sql); };
                return typeof vv === 'function' ? vv.bind(tt) : vv;
              } });
              return (arg as (t: unknown) => unknown)(t);
            }, opts);
      },
    }) as typeof db;
  return { handle, seen, sets };
}

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

  it('hybrid: the KEYWORD leg\'s over-fetch keeps main\'s 2000 ceiling (BLIND P2-1); the vector leg has none', async () => {
    const provider = getRetrievalProvider();
    const spy = vi.spyOn(provider, 'lexicalSearch');
    try {
      await findNodes({ query: 'body', mode: 'hybrid', limit: 10, offset: 500, filter: { role: 'spec' } }); // page 510 x 5 = 2550
      const limits = spy.mock.calls.map((c) => (c[0] as { limit: number }).limit);
      expect(limits.length).toBeGreaterThan(0);
      expect(Math.max(...limits)).toBe(2000);
    } finally { spy.mockRestore(); }
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

describe('#2772 access before page', () => {
  it('a caller who cannot read a memory gets pages made only of readable nodes, offset counting only readable hits', async () => {
    const ctx = { db, roles: [], userId: memberId } as unknown as Context;
    const mine = await (resolvers.Query as any).findNodes(null, { query: 'q', mode: 'vector', limit: 3, offset: 3, filter: { role: 'spec' } }, ctx);
    expect(ids(mine)).toEqual(await reference(`n.role = 'spec'`, 3, 3));
    const first = await (resolvers.Query as any).findNodes(null, { query: 'q', mode: 'vector', limit: 8, filter: { role: 'spec' } }, ctx);
    expect(ids(first).filter((id: string) => foreignSpecIds.includes(id))).toEqual([]);
    expect(first.hits).toHaveLength(SPEC_N);
  }, 60_000);
});

describe('#2772 the memory scope is a guard of the ranking statement itself', () => {
  it('the provider, called with NO structured filter, never ranks a node of a memory outside memoryIds (node and chunk)', async () => {
    const provider = getRetrievalProvider();
    for (const kind of ['node', 'chunk'] as const) {
      const o = { db, queryEmbedding: qvec(), memoryIds: [mem], limit: 12 };
      const got = await (kind === 'node' ? provider.vectorSearch(o) : provider.vectorSearchChunks(o));
      expect(got.length, kind).toBe(12);
      expect(got.filter((h) => foreignSpecIds.includes(h.nodeId)), kind).toEqual([]);
    }
  }, 60_000);
});

describe('#2772 an older pgvector (the exact scan) still gives the true page and never refuses', () => {
  it('with the version stubbed to 0.7.x: one log line, the deep filtered page is the true page, flagged only if it stops', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    resetIterativeScanLogForTests();
    setIterativeScanSupportForTests(false);
    try {
      const { handle, seen, sets } = spyHandle();
      const res = await (resolvers.Query as any).findNodes(null, { query: 'q', mode: 'vector', limit: 3, offset: 3, filter: { role: 'spec', memoryIds: [mem] } }, { db: handle, roles: ['ADMIN'], userId: 'admin-2772' } as Context);
      await findNodes({ query: 'q', mode: 'vector', limit: 3, offset: 0, filter: { role: 'spec' } });
      expect(ids(res)).toEqual(await reference(`n.role = 'spec'`, 3, 3));
      // The exact scan served it: no iterative-scan setting was issued, and the exact statement ran.
      expect(sets.filter((x) => x.includes('iterative_scan'))).toEqual([]);
      expect(seen.some((q) => q.includes('MATERIALIZED'))).toBe(true);
      expect(res.degraded ?? null).toBeNull();
      const lines = log.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith('vector.iterative_scan_unsupported'));
      expect(lines).toHaveLength(1);
    } finally {
      setIterativeScanSupportForTests(null);
      resetIterativeScanLogForTests();
      log.mockRestore();
    }
  }, 60_000);
});

describe('#2772 both surfaces give the same answer', () => {
  it('GraphQL and MCP hadron_find_nodes return the same deep filtered page', async () => {
    const mcp = createTestableMcpServer({ userId: 'admin-2772', roles: ['ADMIN'], clientId: 'user:admin-2772' });
    const want = await reference(`n.role = 'spec'`, 3, 3);
    const gql = await findNodes({ query: 'q', mode: 'vector', limit: 3, offset: 3, filter: { role: 'spec' } });
    expect(ids(gql)).toEqual(want);
    const out = await mcp.callToolText('hadron_find_nodes', { query: 'q', mode: 'vector', limit: 3, offset: 3, role: 'spec', memoryUrn: 'hrn:mem:r2772-org:r2772/mem' });
    expect(out).not.toContain('[internal_server_error]');
    expect((out.match(/^- \*\*/gm) ?? []).length).toBe(3);
  }, 60_000);
});

describe('#2772 the iterative index scan, not the exact fallback, serves the deep filtered page', () => {
  it('on pgvector >= 0.8 with the HNSW plan, the deep role page takes the strict-order iterative scan and no exact statement', async () => {
    const { handle, seen, sets } = spyHandle();
    const res = await (resolvers.Query as any).findNodes(null, { query: 'q', mode: 'vector', limit: 3, offset: 3, filter: { role: 'spec', memoryIds: [mem] } }, { db: handle, roles: ['ADMIN'], userId: 'admin-2772' } as Context);
    expect(ids(res)).toEqual(await reference(`n.role = 'spec'`, 3, 3));
    expect(sets).toContain('SET LOCAL hnsw.iterative_scan = strict_order');
    expect(seen.filter((q) => q.includes('MATERIALIZED')), 'the iterative scan finished the page: no exact statement').toEqual([]);
  }, 60_000);
});
