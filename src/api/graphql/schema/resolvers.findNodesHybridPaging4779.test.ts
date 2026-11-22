/**
 * #4779 — findNodes follow-ups from #4665 (#2772) at the resolver:
 * - P3-4 (Vera's FIT condition 4c; certified fusion accepted, team chat #140476): hybrid pages at different offsets are
 *   slices of ONE fused order. Main fused legs read to a depth that grows with offset + limit, so page 1 and page 2 came
 *   from different fusions and could repeat a node or skip one. When the order cannot be certified inside the vector budget
 *   or the keyword ceiling, the page says stopped_early.
 * - P3-1 (Byron on #4665): a page left short by hydration is re-ranked once, deeper; if still short it says stopped_early.
 *
 * The keyword leg is a controlled ranking (a spy on `lexicalSearch`, sliced to the depth asked), so the fusion's inputs are
 * exact; the vector leg is real (raw vectors at chosen distances).
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, createDbOrgAndGraph } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import type { EmbeddingClient } from '../../../lib/embedding/index.js';
import { setEmbeddingClientForTests, resetEmbeddingClientForTests } from '../../../lib/embedding/index.js';
import { getRetrievalProvider } from '../../../lib/retrieval/postgres.js';
import type { VectorSearchOpts } from '../../../lib/retrieval/provider.js';
import { reciprocalRankFusionScored } from '../../../lib/rrf.js';
import { certifiedHybridRanking } from '../../../lib/retrieval/hybrid.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));

const DIM = 768;
const q = () => { const v = new Array(DIM).fill(0); v[1] = 1; return v; };
const stub: EmbeddingClient = { provider: 'test', model: 'stub-model', dim: DIM, async embed(texts: string[]) { return texts.map(() => q()); } };
const provider = getRetrievalProvider();


let mem: string;
let savedUrl: string | undefined;
/** Node ids by name; the vector order is VEC (nearest first), the keyword order KW. */
const id: Record<string, string> = {};
const VEC = ['A', 'B', 'X', 'E', 'G', 'H', 'C', 'D', 'F', 'I', 'J', 'K'];
const KW = ['C', 'D', 'X', 'F', 'I', 'A'];

const findNodes = (args: Record<string, unknown>) =>
  (resolvers.Query as any).findNodes(null, { ...args, filter: { ...((args.filter as object) ?? {}), memoryIds: [mem] } }, { db, roles: ['ADMIN'], userId: 'admin-4779' } as Context);
const names = (hits: any[]) => hits.map((h) => Object.keys(id).find((k) => id[k] === h.node.id));
/** The keyword leg as a fixed ranking, sliced to the depth asked (exhausted when shorter). */
const keywordLeg = (order: string[]) => vi.spyOn(provider, 'lexicalSearch').mockImplementation(async (a: any) =>
  order.slice(a.offset ?? 0, (a.offset ?? 0) + a.limit).map((n, i) => ({ nodeId: id[n] ?? n, score: 1 / (i + 1) })));
/** The true fused order: RRF over the FULL legs (the scope's whole vector ranking, the whole keyword ranking). */
const trueOrder = () => reciprocalRankFusionScored([KW, VEC], (x) => x).map((e) => e.item);

beforeAll(async () => {
  await cleanDb(db);
  savedUrl = process.env.EMBEDDING_API_URL;
  process.env.EMBEDDING_API_URL = 'http://stub.local/api/embed';
  setEmbeddingClientForTests(stub);
  const made = await createDbOrgAndGraph(db, { orgName: 'r4779h-org', graphName: 'r4779h/mem' });
  mem = made.graph.id;
  await db.memory.update({ where: { id: mem }, data: { vectorIndexEnabled: true, embeddingSource: 'contentChunks' } });
  for (const [i, n] of VEC.entries()) {
    id[n] = generateId();
    await db.node.create({ data: { id: id[n]!, memoryId: mem, loc: `n-${n}`, name: n, content: 'body' } });
    const v = q(); v[3] = (i + 1) * 0.05; // strictly increasing distance in VEC order
    await db.$executeRawUnsafe(`
      INSERT INTO node_embeddings (id, node_id, memory_id, kind, provider, model, dim, chunk_index, char_start, char_end, chunk_text, embedding, created_at)
      VALUES ('${generateId()}', '${id[n]}', '${mem}', 'chunk', 'test', 'stub-model', ${DIM}, 0, 0, 4, 'body', '[${v.join(',')}]'::vector, now())`);
  }
}, 120_000);

afterEach(() => { vi.restoreAllMocks(); });
afterAll(() => {
  resetEmbeddingClientForTests();
  if (savedUrl === undefined) delete process.env.EMBEDDING_API_URL; else process.env.EMBEDDING_API_URL = savedUrl;
});

describe('#4779 P3-4: certifiedHybridRanking (unit)', () => {
  it('legs read 2 deep cannot certify page 2 (X, 3rd in both, may outrank both 1st-rank nodes)', () => {
    const r = certifiedHybridRanking({ ids: ['C', 'D'], exhausted: false }, { ids: ['A', 'B'], exhausted: false }, 2);
    expect(r.certified).toBe(false);
    expect(r.kwUncertain).toBe(true);
    expect(r.vecLookup.sort()).toEqual(['C', 'D']);
  });
  it('fewer candidates than the page, with legs not exhausted, is never certified (an unseen node may fill the slot)', () => {
    // P (1st in both, 2/61) beats any unseen node (at most 1/62 + 1/62), but page slot 2 is unknown.
    const r = certifiedHybridRanking({ ids: ['P'], exhausted: false }, { ids: ['P'], exhausted: false }, 2);
    expect(r.certified).toBe(false);
    expect(certifiedHybridRanking({ ids: ['P'], exhausted: true }, { ids: ['P'], exhausted: true }, 2).certified).toBe(true);
  });
  it('LOCAL P3-1 (Bridget): a page row tied with a later inexact row\'s upper bound does not certify (the tie key could put that row first)', () => {
    // I: keyword rank 2 + vector rank 1 = 1/62 + 1/61 (exact). J: keyword rank 1, vector term unknown (vector leg 1 deep,
    // not exhausted): 1/61, at most 1/61 + 1/62 — EXACTLY I's score. If J's vector rank is 2 the two tie, and the
    // keyword-first tie key (J is keyword rank 1) puts J first: page 1 is not certain.
    const r = certifiedHybridRanking({ ids: ['J', 'I'], exhausted: true }, { ids: ['I'], exhausted: false }, 1);
    expect(r.ranked.map((x) => x.nodeId)).toEqual(['I', 'J']);
    expect(r.ranked[0]!.score).toBe(1 / 61 + 1 / 62); // the tie is exact in floating point, not approximate
    expect(r.certified).toBe(false);
    // Once J's vector rank is known, the order is exact and the page certifies.
    expect(certifiedHybridRanking({ ids: ['J', 'I'], exhausted: true }, { ids: ['I'], exhausted: false }, 1, new Map([['J', 5]]), new Set(['J'])).certified).toBe(true);
  });
  it('LOCAL P3-2 (Bridget): with every seen row exact, the UNSEEN-node bound alone refuses a page a not-exhausted leg could still change', () => {
    // Vector leg empty but not exhausted (e.g. stopped by the budget); keyword hits A, B looked up with NO eligible vector
    // (term exactly 0). Every seen row is exact, yet an unseen vector-only node at vector rank 1 scores 1/61 > B's 1/62.
    const r = certifiedHybridRanking({ ids: ['A', 'B'], exhausted: true }, { ids: [], exhausted: false }, 2, new Map(), new Set(['A', 'B']));
    expect(r.certified).toBe(false);
    // The vector leg exhausted (truly empty): nothing unseen, so the page is exact.
    expect(certifiedHybridRanking({ ids: ['A', 'B'], exhausted: true }, { ids: [], exhausted: true }, 2).certified).toBe(true);
  });
  it('exhausted legs are exact: certified, in RRF order with keyword-first ties', () => {
    const r = certifiedHybridRanking({ ids: KW, exhausted: true }, { ids: VEC, exhausted: true }, 5);
    expect(r.certified).toBe(true);
    expect(r.ranked.map((x) => x.nodeId)).toEqual(trueOrder());
  });
  it('a looked-up vector rank makes the keyword term-only node exact', () => {
    // K leg exhausted ['C']; V leg ['A','B'] (not exhausted). C's vector rank looked up as 7: score 1/61 + 1/67.
    const r = certifiedHybridRanking({ ids: ['C'], exhausted: true }, { ids: ['A', 'B'], exhausted: false }, 1, new Map([['C', 7]]), new Set(['C']));
    expect(r.ranked[0]).toMatchObject({ nodeId: 'C', score: 1 / 61 + 1 / 67 });
    expect(r.certified).toBe(true);
  });
  it('looked up and absent means no eligible vector: a term of exactly 0', () => {
    const r = certifiedHybridRanking({ ids: ['C'], exhausted: true }, { ids: ['A'], exhausted: false }, 1, new Map(), new Set(['C']));
    expect(r.ranked.find((x) => x.nodeId === 'C')!.score).toBe(1 / 61);
  });
});

describe('#4779 BLIND F13 (Elena): certification agrees with RRF over the full legs (seeded brute force)', () => {
  it('whenever a truncated pair certifies, its first `page` rows equal the full-leg fused order', () => {
    let seed = 4779;
    const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    const shuffle = <T,>(xs: T[]) => { const a = xs.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j]!, a[i]!]; } return a; };
    let certifiedRuns = 0;
    for (let run = 0; run < 400; run++) {
      const universe = Array.from({ length: 4 + Math.floor(rnd() * 26) }, (_, i) => `n${i}`);
      const kwFull = shuffle(universe).slice(0, Math.floor(rnd() * universe.length));
      const vecFull = shuffle(universe).slice(0, Math.floor(rnd() * universe.length) + 1);
      const truth = certifiedHybridRanking({ ids: kwFull, exhausted: true }, { ids: vecFull, exhausted: true }, 1).ranked.map((r) => r.nodeId);
      const page = 1 + Math.floor(rnd() * 6);
      const dk = Math.floor(rnd() * (kwFull.length + 1));
      const dv = Math.floor(rnd() * (vecFull.length + 1));
      // Look up the exact vector rank of some keyword hits the vector leg did not reach.
      const looked = new Set(kwFull.slice(0, dk).filter((id) => !vecFull.slice(0, dv).includes(id) && rnd() < 0.5));
      const ranks = new Map([...looked].filter((id) => vecFull.includes(id)).map((id) => [id, vecFull.indexOf(id) + 1]));
      const r = certifiedHybridRanking({ ids: kwFull.slice(0, dk), exhausted: dk === kwFull.length }, { ids: vecFull.slice(0, dv), exhausted: dv === vecFull.length }, page, ranks, looked);
      if (!r.certified) continue;
      certifiedRuns++;
      expect(r.ranked.slice(0, page).map((x) => x.nodeId)).toEqual(truth.slice(0, page));
    }
    expect(certifiedRuns).toBeGreaterThan(50); // the property was exercised, not vacuous
  });
});

describe('#4779 P3-4: hybrid pages are slices of one fused order (no repeat, no skip)', () => {
  it('pages of 2 at offsets 0..8 equal the true fused order', async () => {
    keywordLeg(KW);
    const want = trueOrder();
    const got: (string | undefined)[] = [];
    for (let off = 0; off < 10; off += 2) {
      const res = await findNodes({ query: 'q', mode: 'hybrid', limit: 2, offset: off });
      expect(res.degraded ?? '').not.toContain('stopped_early');
      got.push(...names(res.hits));
    }
    expect(got).toEqual(want.slice(0, 10));
    expect(new Set(got).size).toBe(got.length);
  }, 60_000);

  it('the first page is the fused order\'s first page, not a fusion of the two legs\' first ranks', async () => {
    keywordLeg(KW);
    const res = await findNodes({ query: 'q', mode: 'hybrid', limit: 2 });
    expect(names(res.hits)).toEqual(trueOrder().slice(0, 2)); // X (3rd in both) leads
    expect(names(res.hits)[0]).toBe('X');
  }, 60_000);

  it('a vector rank lookup that runs out of budget flags the page stopped_early', async () => {
    keywordLeg(KW);
    vi.spyOn(provider, 'vectorRanks').mockResolvedValue({ ranks: new Map(), stoppedEarly: true });
    const res = await findNodes({ query: 'q', mode: 'hybrid', limit: 2 });
    expect(res.degraded ?? '').toContain('stopped_early');
  }, 60_000);

  it('a keyword leg that is never exhausted is widened to its ceiling (2000), then the page says stopped_early', async () => {
    // An endless keyword ranking of non-nodes: every vector hit is vector-only, so its keyword term stays unknown, and
    // A (1/61) over B (1/62) is certain only once 1/61 - 1/62 > 1/(61 + depth), a depth past 3700: past the ceiling.
    const endless = Array.from({ length: 5000 }, (_, i) => `nohit-${i}`);
    const spy = keywordLeg(endless);
    const res = await findNodes({ query: 'q', mode: 'hybrid', limit: 2 });
    expect(Math.max(...spy.mock.calls.map((c: any) => c[0].limit))).toBe(2000);
    expect(res.degraded ?? '').toContain('stopped_early');
  }, 60_000);
});

describe('#4779 SEC10 P2-1 (Rook): the vector rank lookup ranks only the eligible set', () => {
  // Unfiltered vector order: A, B, X, E, ... A closer node that is excluded or filtered out must not shift a rank.
  const ranksOf = (extra: Partial<VectorSearchOpts>, nodeIds: string[]) => provider.vectorRanks({
    db, queryEmbedding: q(), memoryIds: [mem], nodeIds: nodeIds.map((n) => id[n]!), ...extra,
  }).then((r) => Object.fromEntries(nodeIds.map((n) => [n, r.ranks.get(id[n]!) ?? null])));

  it('unfiltered: the exact positions', async () => {
    expect(await ranksOf({}, ['A', 'X', 'E'])).toEqual({ A: 1, X: 3, E: 4 });
  }, 60_000);
  it('the caller\'s exclusions: excluded A and B are absent and do not count ahead of X', async () => {
    expect(await ranksOf({ excludeNodeIds: [id.A, id.B] }, ['A', 'B', 'X', 'E'])).toEqual({ A: null, B: null, X: 1, E: 2 });
  }, 60_000);
  it('the structured filter: only nodes it admits are ranked, among themselves', async () => {
    expect(await ranksOf({ filter: { locPrefix: 'n-E' } }, ['A', 'E'])).toEqual({ A: null, E: 1 });
  }, 60_000);
  it('the deleted rule: a soft-deleted closer node is absent and does not count ahead', async () => {
    await db.node.update({ where: { id: id.A! }, data: { deletedAt: new Date() } });
    try {
      expect(await ranksOf({ filter: { locPrefix: 'n-' } }, ['A', 'B'])).toEqual({ A: null, B: 1 });
    } finally { await db.node.update({ where: { id: id.A! }, data: { deletedAt: null } }); }
  }, 60_000);
});

describe('#4779 BLIND P2-3 (Bianca): the rank lookup and the page ranking share one eligibility', () => {
  for (const [name, extra] of [
    ['default scope', {}],
    ['ALL scope', { contentScope: 'ALL' }],
    ['filter + exclusions', { filter: { locPrefix: 'n-' }, excludeNodeIds: [] as string[], includeDeleted: false }],
  ] as const) {
    it(`${name}: every node's looked-up rank is its position in vectorSearch`, async () => {
      const opts = { db, queryEmbedding: q(), memoryIds: [mem], ...extra, ...(name === 'filter + exclusions' ? { excludeNodeIds: [id.B!] } : {}) };
      const page = await provider.vectorSearch({ ...opts, limit: 100 } as VectorSearchOpts);
      const { ranks } = await provider.vectorRanks({ ...opts, nodeIds: Object.values(id) } as Parameters<typeof provider.vectorRanks>[0]);
      expect(page.length).toBeGreaterThan(5);
      expect(Object.fromEntries(page.map((h, i) => [h.nodeId, i + 1]))).toEqual(Object.fromEntries(ranks));
    }, 60_000);
  }
});

describe('#4779 BLIND P2-2 (Bianca): one work budget per request, across every vector call', () => {
  it('a hybrid page\'s vector leg and its rank lookup share ONE deadline: each later statement gets only what is left', async () => {
    keywordLeg(KW);
    const timeouts: number[] = [];
    const handle = new Proxy(db, { get(t, p) {
      const v = Reflect.get(t, p);
      if (p !== '$transaction') return typeof v === 'function' ? v.bind(t) : v;
      return (arg: unknown, o?: unknown) => typeof arg !== 'function' ? (t.$transaction as any)(arg, o)
        : (t.$transaction as any)(async (tx: any) => (arg as (x: unknown) => unknown)(new Proxy(tx, { get(tt, pp) {
            const vv = Reflect.get(tt, pp);
            if (pp === '$executeRawUnsafe') return (sql: string, ...a: unknown[]) => {
              const m = /SET LOCAL statement_timeout = (\d+)/.exec(sql);
              if (m) timeouts.push(Number(m[1]));
              return (vv as any).call(tt, sql, ...a);
            };
            if (pp === '$queryRaw') return async (st: TemplateStringsArray, ...a: unknown[]) => { const r = await (vv as any).call(tt, st, ...a); await new Promise((res) => setTimeout(res, 400)); return r; };
            return typeof vv === 'function' ? vv.bind(tt) : vv;
          } })), o);
    } }) as typeof db;
    const lookups = vi.spyOn(provider, 'vectorRanks');
    process.env.VECTOR_SEARCH_TIMEOUT_MS = '6000';
    try {
      await (resolvers.Query as any).findNodes(null, { query: 'q', mode: 'hybrid', limit: 2, filter: { memoryIds: [mem] } }, { db: handle, roles: ['ADMIN'], userId: 'admin-4779' } as Context);
    } finally { delete process.env.VECTOR_SEARCH_TIMEOUT_MS; }
    expect(lookups).toHaveBeenCalled(); // the request made more than one vector call
    expect(timeouts.length).toBeGreaterThanOrEqual(3);
    expect(timeouts[0]).toBeLessThanOrEqual(6000);
    for (let i = 1; i < timeouts.length; i++) expect(timeouts[i]!).toBeLessThanOrEqual(timeouts[i - 1]! - 350);
  }, 60_000);
});

describe('#4779 BLIND F2/F3 (Elena): hybrid hydration drops and the keyword widening budget', () => {
  it('F2: a node dropped at hydration never lets a hybrid page fill from past the certified depth: the page is the true fused page without it', async () => {
    keywordLeg(KW);
    const original = provider.vectorSearch.bind(provider);
    let calls = 0;
    vi.spyOn(provider, 'vectorSearch').mockImplementation(async (a) => {
      const hits = await original(a);
      if (calls++ === 0) await db.node.update({ where: { id: id.X! }, data: { deletedAt: new Date() } });
      return hits;
    });
    try {
      const res = await findNodes({ query: 'q', mode: 'hybrid', limit: 2, offset: 2 });
      const want = reciprocalRankFusionScored([KW.filter((n) => n !== 'X'), VEC.filter((n) => n !== 'X')], (x) => x).map((e) => e.item);
      expect(names(res.hits)).toEqual(want.slice(2, 4));
      expect(calls).toBe(2); // re-ranked deeper once
    } finally { await db.node.update({ where: { id: id.X! }, data: { deletedAt: null } }); }
  }, 60_000);

  it('F3: the keyword widening stops at the request deadline (never all the way to 2000 past it), and the page says stopped_early', async () => {
    const endless = Array.from({ length: 5000 }, (_, i) => `nohit-${i}`);
    const spy = vi.spyOn(provider, 'lexicalSearch').mockImplementation(async (a: any) => {
      await new Promise((r) => setTimeout(r, 300));
      return endless.slice(0, a.limit).map((n, i) => ({ nodeId: n, score: 1 / (i + 1) }));
    });
    // The rank lookup answers at once and never stops, so only the widening's own deadline check can end the loop early.
    vi.spyOn(provider, 'vectorRanks').mockResolvedValue({ ranks: new Map(), stoppedEarly: false });
    process.env.VECTOR_SEARCH_TIMEOUT_MS = '1000';
    try {
      const res = await findNodes({ query: 'q', mode: 'hybrid', limit: 2 });
      expect(Math.max(...spy.mock.calls.map((c: any) => c[0].limit))).toBeLessThan(2000);
      expect(res.degraded ?? '').toContain('stopped_early');
    } finally { delete process.env.VECTOR_SEARCH_TIMEOUT_MS; }
  }, 60_000);
});

describe('#4779 P3-1: a page left short by hydration', () => {
  it('vector: a ranked node dropped at hydration is replaced by one deeper re-ranking, not left as a short page', async () => {
    const original = provider.vectorSearch.bind(provider);
    let calls = 0;
    vi.spyOn(provider, 'vectorSearch').mockImplementation(async (a) => {
      const hits = await original(a);
      // After the FIRST ranking only, the top node is deleted: hydration drops it.
      if (calls++ === 0) await db.node.update({ where: { id: hits[0]!.nodeId }, data: { deletedAt: new Date() } });
      return hits;
    });
    try {
      const res = await findNodes({ query: 'q', mode: 'vector', limit: 3 });
      expect(names(res.hits)).toEqual(['B', 'X', 'E']);
      expect(res.degraded).toBeNull();
      expect(calls).toBe(2);
    } finally { await db.node.update({ where: { id: id.A! }, data: { deletedAt: null } }); }
  }, 60_000);

  it('vector: still short after the one re-ranking => stopped_early, never a silently short page', async () => {
    const original = provider.vectorSearch.bind(provider);
    const deleted: string[] = [];
    vi.spyOn(provider, 'vectorSearch').mockImplementation(async (a) => {
      const hits = await original(a);
      // After EVERY ranking all but its last hit are deleted, so even the deeper re-ranking cannot fill the page.
      for (const h of hits.slice(0, -1)) {
        await db.node.update({ where: { id: h.nodeId }, data: { deletedAt: new Date() } });
        deleted.push(h.nodeId);
      }
      return hits;
    });
    try {
      const res = await findNodes({ query: 'q', mode: 'vector', limit: 3 });
      expect(res.hits.length).toBeLessThan(3);
      expect(res.degraded ?? '').toContain('stopped_early');
    } finally { await db.node.updateMany({ where: { id: { in: deleted } }, data: { deletedAt: null } }); }
  }, 60_000);

  it('chunk: a passage whose parent hydration dropped leaves a short page that says stopped_early', async () => {
    const original = provider.vectorSearchChunks.bind(provider);
    let first: string | undefined;
    vi.spyOn(provider, 'vectorSearchChunks').mockImplementation(async (a) => {
      const hits = await original(a);
      first = hits[0]!.nodeId;
      await db.node.update({ where: { id: first }, data: { deletedAt: new Date() } });
      return hits;
    });
    try {
      const res = await findNodes({ query: 'q', mode: 'vector', granularity: 'chunk', limit: 3 });
      expect(res.passages).toHaveLength(2);
      expect(res.degraded ?? '').toContain('stopped_early');
    } finally { if (first) await db.node.update({ where: { id: first }, data: { deletedAt: null } }); }
  }, 60_000);

  it('hybrid: a dropped node is replaced by the re-ranking', async () => {
    keywordLeg(KW);
    const original = provider.vectorSearch.bind(provider);
    let calls = 0;
    vi.spyOn(provider, 'vectorSearch').mockImplementation(async (a) => {
      const hits = await original(a);
      // A (1st in the vector leg) is on the first fused page; it is deleted after the first ranking.
      if (calls++ === 0) await db.node.update({ where: { id: id.A! }, data: { deletedAt: new Date() } });
      return hits;
    });
    try {
      const res = await findNodes({ query: 'q', mode: 'hybrid', limit: 2 });
      expect(res.hits).toHaveLength(2);
      expect(names(res.hits)).not.toContain('A');
      expect(res.degraded ?? '').not.toContain('stopped_early');
    } finally { await db.node.update({ where: { id: id.A! }, data: { deletedAt: null } }); }
  }, 60_000);
});
