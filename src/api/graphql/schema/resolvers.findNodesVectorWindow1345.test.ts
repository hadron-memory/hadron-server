import { randomUUID } from 'node:crypto';
/**
 * #1345 review, round 2.
 *
 * @codex P2 — a vector candidate window is chosen without the structured
 * filters, so a fixed over-fetch left `limit: 1` empty when the nearest nodes
 * failed the filter and the match ranked just past the window. The window now
 * widens until the filtered page fills (or the cap). Ranking is controlled
 * here: non-matching nodes embed NEARER the query than the one match.
 *
 * @copilot — hydration re-asserts the caller's memory scope, so a candidate
 * that is outside scope by the time it is hydrated (a node moved between the
 * ranking query and the hydration query) never comes back.
 */
import { describe, it, expect, beforeEach, afterAll, afterEach, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, createDbOrgAndGraph } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import type { EmbeddingClient } from '../../../lib/embedding/index.js';
import { setEmbeddingClientForTests, resetEmbeddingClientForTests } from '../../../lib/embedding/index.js';
import { embedNode } from '../../../jobs/embedNodes.js';
import { getRetrievalProvider } from '../../../lib/retrieval/postgres.js';
import { hnswEfSearchFor, vectorSearchChunks, vectorSearchNodes, vectorWindowExhausted } from '../../../services/embedding/vectors.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

const DIM = 768;
// "near" text embeds exactly on the query's axis; "far" text is tilted off it.
const stub: EmbeddingClient = {
  provider: 'test',
  model: 'stub-model',
  dim: DIM,
  async embed(texts: string[]) {
    return texts.map((t) => {
      const v = new Array(DIM).fill(0);
      v[1] = 1;
      if (t.includes('far')) v[2] = 1;
      return v;
    });
  },
};

/**
 * A db whose every interactive transaction first runs `sets` (`SET LOCAL …`).
 * The vector queries run inside one (`withEfSearch`), so this is how a test
 * chooses the planner settings the ranking query sees.
 */
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

/**
 * #1970 — the planner may answer the ANN query from the HNSW index whenever its
 * statistics make that cheaper, which on CI depends on what earlier files left
 * in the shard's database. Disabling sort makes that choice deterministic.
 */
const PREFER_HNSW = ['SET LOCAL enable_sort = off'];

/**
 * The window tests assert EXACT ranking and exhaustion, which only an exact
 * plan gives: HNSW is approximate, and its results here are within the
 * production contract (a short page, never a wrong one; see the HNSW describe
 * below). HNSW serves only plain index scans, so with them off the query is a
 * scan plus a sort, whatever the statistics say. Applied last, it wins over
 * any ambient setting.
 */
const EXACT_PLAN = ['SET LOCAL enable_sort = on', 'SET LOCAL enable_indexscan = off'];

/** The handle the window tests search through, set per planner below. */
let searchDb: typeof db = db;
const admin = (): Context => ({ db: searchDb, roles: ['ADMIN'], userId: 'admin-vw' } as Context);
const findNodes = (args: Record<string, unknown>) => (resolvers.Query as any).findNodes(null, args, admin());

let memId: string;
let otherMemId: string;
let matchId: string;
async function seed(memoryId: string, loc: string, content: string, fields: Record<string, unknown> = {}) {
  const id = generateId();
  await db.node.create({ data: { id, memoryId, loc, name: loc, content, embeddingWorkToken: randomUUID(), embeddingPendingAt: new Date(), ...fields } as any });
  expect(await embedNode(db, id)).toBe('embedded');
  return id;
}

beforeEach(async () => {
  await cleanDb(db);
  process.env.EMBEDDING_API_URL = 'http://stub.local/api/embed';
  setEmbeddingClientForTests(stub);
  const made = await createDbOrgAndGraph(db, { orgName: 'vw-org', graphName: 'vw/graph' });
  memId = made.graph.id;
  await db.memory.update({ where: { id: memId }, data: { vectorIndexEnabled: true, embeddingSource: 'contentChunks' } });
  // Eight NEAR nodes with other roles: more than the old 5x window for limit 1.
  for (let i = 0; i < 8; i++) await seed(memId, `near${i}`, `near body ${i}`, { role: 'review' });
  matchId = await seed(memId, 'match', 'far body match', { role: 'spec.rule' });
  const other = await db.memory.create({
    data: { id: generateId(), organizationId: made.org.id, urn: 'vw-org:other', name: 'other', class: 'knowledge', visibility: 'ORGANIZATION', vectorIndexEnabled: true, embeddingSource: 'contentChunks' },
  });
  otherMemId = other.id;
});

afterEach(() => vi.restoreAllMocks());
afterAll(() => {
  resetEmbeddingClientForTests();
  delete process.env.EMBEDDING_API_URL;
});

describe.each([
  ['the default planner', [] as string[]],
  ['a planner that prefers the HNSW index (#1970)', PREFER_HNSW],
])('@codex P2 — the vector window widens until the filtered page fills, under %s', (_planner, ambient) => {
  beforeEach(() => { searchDb = withLocalSettings(withLocalSettings(db, ambient), EXACT_PLAN); });
  afterEach(() => { searchDb = db; });

  it('node granularity: limit 1 finds the only spec-family node ranked past the old window', async () => {
    const res = await findNodes({ query: 'q', mode: 'vector', limit: 1, filter: { memoryIds: [memId], role: 'spec' } });
    expect(res.hits.map((h: any) => h.node.id)).toEqual([matchId]);
  });

  it('chunk granularity: the same', async () => {
    const res = await findNodes({ query: 'q', mode: 'vector', granularity: 'chunk', limit: 1, filter: { memoryIds: [memId], role: 'spec' } });
    expect(res.passages.map((p: any) => p.parentNodeId)).toEqual([matchId]);
  });

  it('hybrid: the widened vector leg is not truncated away', async () => {
    const res = await findNodes({ query: 'zzzunmatchable', mode: 'hybrid', limit: 1, filter: { memoryIds: [memId], role: 'spec' } });
    expect(res.hits.map((h: any) => h.node.id)).toEqual([matchId]);
  });

  it('node granularity keeps widening across windows that dedupe to the SAME hits (@codex/@copilot rounds 3-4)', async () => {
    // ONE near review node owns enough small chunks to fill two consecutive ANN
    // windows (50, then 200 vectors for limit 1): both dedupe to the same single
    // hit, which is neither a short-batch nor a no-progress exhaustion signal.
    // Only the provider's raw window says the index is spent; the spec match lies
    // beyond both windows and must still be found.
    await db.memory.update({ where: { id: memId }, data: { chunkTokens: 8, chunkOverlap: 0 } });
    await db.node.deleteMany({ where: { memoryId: memId } });
    await seed(memId, 'bulk', Array.from({ length: 2600 }, (_, i) => `near${i}`).join(' '), { role: 'review' });
    const match = await seed(memId, 'match2', 'far body match', { role: 'spec' });
    const [{ n }] = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM node_embeddings WHERE memory_id = ${memId} AND kind = 'chunk'`;
    expect(Number(n)).toBeGreaterThan(200); // one node fills windows 1 (50) and 2 (200)
    const res = await findNodes({ query: 'q', mode: 'vector', limit: 1, filter: { memoryIds: [memId], role: 'spec' } });
    expect(res.hits.map((h: any) => h.node.id)).toEqual([match]);
  });

  it('the provider reports exhaustion only when the window held everything AND nothing was truncated', async () => {
    const provider = getRetrievalProvider();
    const q = new Array(768).fill(0); q[1] = 1;
    const exhausted = async (kind: 'node' | 'chunk', limit: number) => {
      let flag: boolean | null = null;
      const opts = { db: searchDb, queryEmbedding: q, memoryIds: [memId], limit, onWindow: (w: { exhausted: boolean }) => { flag = w.exhausted; } };
      await (kind === 'node' ? provider.vectorSearch(opts) : provider.vectorSearchChunks(opts));
      return flag;
    };
    // 9 one-chunk nodes. limit 20: the window holds all 9, nothing is cut.
    expect([await exhausted('node', 20), await exhausted('chunk', 20)]).toEqual([true, true]);
    // limit 1: the window (10) still holds all 9, but LIMIT 1 truncates: NOT exhausted.
    expect([await exhausted('node', 1), await exhausted('chunk', 1)]).toEqual([false, false]);
    // One node whose chunks outnumber the window: node search dedupes to few hits, yet NOT exhausted.
    await db.memory.update({ where: { id: memId }, data: { chunkTokens: 8, chunkOverlap: 0 } });
    await db.node.deleteMany({ where: { memoryId: memId } });
    await seed(memId, 'many', Array.from({ length: 400 }, (_, i) => `near${i}`).join(' '));
    expect(await exhausted('node', 5)).toBe(false);
  });

  it('exhaustion is judged against an INDEPENDENT eligible count, never a short scan (@codex round 6)', () => {
    // The HNSW case the tiny test DB cannot produce (it seq-scans): a filtered
    // index scan visits ef_search candidates, returns 40 of a 50-row window,
    // while 1000 eligible rows exist. Short is not exhausted.
    expect(vectorWindowExhausted({ windowRows: 40, eligibleRows: 1000, truncated: false })).toBe(false);
    expect(vectorWindowExhausted({ windowRows: 9, eligibleRows: 9, truncated: false })).toBe(true);
    // Everything fetched but the final LIMIT cut some: not exhausted.
    expect(vectorWindowExhausted({ windowRows: 9, eligibleRows: 9, truncated: true })).toBe(false);
  });

  it('CONTROL: with no filter the nearest node wins and nothing widens', async () => {
    const spy = vi.spyOn(getRetrievalProvider(), 'vectorSearch');
    const res = await findNodes({ query: 'q', mode: 'vector', limit: 1, filter: { memoryIds: [memId] } });
    expect(res.hits[0].node.id).not.toBe(matchId);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe('@copilot — hydration re-asserts the memory scope', () => {
  it('a ranked candidate that is outside scope at hydration is dropped (node and chunk)', async () => {
    const outside = await seed(otherMemId, 'outside', 'near outside');
    const provider = getRetrievalProvider();
    // Simulate the race: ranking (scoped) returned a node that has since moved out of scope.
    vi.spyOn(provider, 'vectorSearch').mockResolvedValue([{ nodeId: outside, score: 1 }]);
    vi.spyOn(provider, 'vectorSearchChunks').mockResolvedValue([
      { nodeId: outside, chunkIndex: 0, charStart: 0, charEnd: 5, chunkText: 'near', score: 1 },
    ]);
    const node = await findNodes({ query: 'q', mode: 'vector', filter: { memoryIds: [memId] } });
    const chunk = await findNodes({ query: 'q', mode: 'vector', granularity: 'chunk', filter: { memoryIds: [memId] } });
    expect(node.hits).toEqual([]);
    expect(chunk.passages).toEqual([]);
  });
});

describe('@codex round 7 — a wider window is a deeper HNSW scan', () => {
  it('ef_search tracks the window, never below the default 40, capped at 1000', () => {
    expect([hnswEfSearchFor(10), hnswEfSearchFor(50), hnswEfSearchFor(200), hnswEfSearchFor(20000)]).toEqual([40, 50, 200, 1000]);
  });

  it('each vector query sets it for its own window, in its own transaction', async () => {
    const sets: string[] = [];
    const tx = { $executeRawUnsafe: async (sql: string) => { sets.push(sql); return 0; }, $queryRaw: async () => [] };
    const fake = { $transaction: async (fn: (t: typeof tx) => unknown) => fn(tx), $queryRaw: async () => [{ n: 0 }] } as any;
    const q = new Array(768).fill(0); q[1] = 1;
    await vectorSearchNodes(fake, { memoryIds: ['m'], queryEmbedding: q, limit: 5 }); // candidateK 50
    await vectorSearchChunks(fake, { memoryIds: ['m'], queryEmbedding: q, limit: 20 }); // candidateK 200
    expect(sets).toEqual(['SET LOCAL hnsw.ef_search = 50', 'SET LOCAL hnsw.ef_search = 200']);
  });
});

describe('@copilot round 7 — lexical/regex hydration re-asserts scope and filters', () => {
  it('a ranked node whose role no longer matches, or that left scope, is not returned', async () => {
    const provider = getRetrievalProvider();
    const reviewNode = await db.node.findFirstOrThrow({ where: { memoryId: memId, loc: 'near0' } }); // role review
    const outside = await seed(otherMemId, 'lex-outside', 'near outside', { role: 'spec' });
    // Simulate the race: ranking (scoped + filtered in SQL) returned rows that
    // have since changed role / moved out of scope.
    vi.spyOn(provider, 'lexicalSearch').mockResolvedValue([
      { nodeId: reviewNode.id, score: 1 } as any,
      { nodeId: outside, score: 0.9 } as any,
      { nodeId: matchId, score: 0.8 } as any,
    ]);
    const res = await findNodes({ query: 'body', mode: 'keyword', filter: { memoryIds: [memId], role: 'spec' } });
    expect(res.hits.map((h: any) => h.node.id)).toEqual([matchId]);
  });
});

describe('#1970 — each handle gives the plan it names, and the HNSW plan keeps the production contract', () => {
  const qvec = () => { const q = new Array(DIM).fill(0); q[1] = 1; return q; };
  // Shaped like the provider's ANN query: the nodes join is what lets the
  // planner drive from either side.
  const planOf = async (handle: typeof db) => {
    const rows = await handle.$transaction((tx) => tx.$queryRawUnsafe<{ 'QUERY PLAN': string }[]>(
      `EXPLAIN SELECT ne.node_id FROM node_embeddings ne JOIN nodes n ON n.id = ne.node_id
       WHERE ne.memory_id = '${memId}' ORDER BY ne.embedding <=> '[${qvec().join(',')}]'::vector LIMIT 10`));
    return rows.map((r) => r['QUERY PLAN']).join('\n');
  };

  it('PREFER_HNSW reaches the HNSW index, and EXACT_PLAN keeps it out even then', async () => {
    // If either stops holding (a Postgres or pgvector upgrade), the window
    // tests above silently stop testing what their names say.
    expect(await planOf(withLocalSettings(db, PREFER_HNSW))).toContain('node_embeddings_embedding_hnsw');
    expect(await planOf(withLocalSettings(withLocalSettings(db, PREFER_HNSW), EXACT_PLAN))).not.toContain('node_embeddings_embedding_hnsw');
  });

  it('on the HNSW plan, a filtered page may come back short but never wrong', async () => {
    // The approximate scan can miss a match behind hundreds of nearer chunks;
    // the resolver's contract is "past the cap a page can be short; it is
    // never wrong".
    await db.memory.update({ where: { id: memId }, data: { chunkTokens: 8, chunkOverlap: 0 } });
    await db.node.deleteMany({ where: { memoryId: memId } });
    await seed(memId, 'bulk', Array.from({ length: 2600 }, (_, i) => `near${i}`).join(' '), { role: 'review' });
    const match = await seed(memId, 'match2', 'far body match', { role: 'spec' });
    searchDb = withLocalSettings(db, PREFER_HNSW);
    try {
      const res = await findNodes({ query: 'q', mode: 'vector', limit: 1, filter: { memoryIds: [memId], role: 'spec' } });
      expect(res.hits.map((h: any) => h.node.id).filter((id: string) => id !== match)).toEqual([]);
    } finally {
      searchDb = db;
    }
  });

  it('on the HNSW plan, exhaustion is never claimed for a window that missed eligible rows', async () => {
    // Dead index entries from a deleted bulk node take ef_search slots: the
    // CI condition in which the scan returned 8 of the 9 live nodes.
    await db.memory.update({ where: { id: memId }, data: { chunkTokens: 8, chunkOverlap: 0 } });
    await seed(memId, 'churn', Array.from({ length: 2600 }, (_, i) => `near${i}`).join(' '));
    await db.node.deleteMany({ where: { memoryId: memId, loc: 'churn' } });
    const provider = getRetrievalProvider();
    const handle = withLocalSettings(db, PREFER_HNSW);
    for (const kind of ['node', 'chunk'] as const) {
      let flag: boolean | null = null;
      const opts = { db: handle, queryEmbedding: qvec(), memoryIds: [memId], limit: 20, onWindow: (w: { exhausted: boolean }) => { flag = w.exhausted; } };
      const got = await (kind === 'node' ? provider.vectorSearch(opts) : provider.vectorSearchChunks(opts));
      expect(flag, kind).not.toBeNull();
      if (flag) expect(got.length, kind).toBe(9);
    }
  });
});
