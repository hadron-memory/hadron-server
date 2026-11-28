/**
 * #5162 — above the #4994 bound the page's vector leg and the certification rank lookup are separate HNSW walks, which can
 * place the same nodes differently. A hybrid page is never certified on two walks that disagree: it says stopped_early
 * (cor:api:090:04, "never silent"). Small fixtures cannot make the real walk differ from the leg, so the second walk is
 * stood in for: the lookup is mocked as another ranking that answers for exactly the ids it is asked about.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, createDbOrgAndGraph } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import type { EmbeddingClient } from '../../../lib/embedding/index.js';
import { setEmbeddingClientForTests, resetEmbeddingClientForTests } from '../../../lib/embedding/index.js';
import { getRetrievalProvider } from '../../../lib/retrieval/postgres.js';
import { setVectorSmallScopeRowsForTests } from '../../../services/embedding/vectors.js';
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
const id: Record<string, string> = {};
/** The page's vector leg (nearest first) and the keyword order. A hybrid page of 2 reads both legs 2 deep. */
const VEC = ['A', 'B', 'X', 'E', 'G', 'H', 'C', 'D', 'F', 'I', 'J', 'K'];
const KW = ['C', 'D', 'X', 'F', 'I', 'A'];

const findNodes = (args: Record<string, unknown>) =>
  (resolvers.Query as any).findNodes(null, { ...args, filter: { memoryIds: [mem] } }, { db, roles: ['ADMIN'], userId: 'admin-5162' } as Context);
const names = (hits: any[]) => hits.map((h) => Object.keys(id).find((k) => id[k] === h.node.id));
const keywordLeg = () => vi.spyOn(provider, 'lexicalSearch').mockImplementation(async (a: any) =>
  KW.slice(a.offset ?? 0, (a.offset ?? 0) + a.limit).map((n, i) => ({ nodeId: id[n]!, score: 1 / (i + 1) })));
/** A lookup answered from `walk`: every asked id gets its position there; an id not in it has no rank. */
const secondWalk = (walk: string[]) => vi.spyOn(provider, 'vectorRanks').mockImplementation(async (a) => ({
  ranks: new Map(a.nodeIds.flatMap((n) => { const i = walk.findIndex((w) => id[w] === n); return i < 0 ? [] : [[n, i + 1] as const]; })),
  stoppedEarly: false,
}));
const swapped = (order: string[], x: string, y: string) => order.map((n) => (n === x ? y : n === y ? x : n));

beforeAll(async () => {
  await cleanDb(db);
  savedUrl = process.env.EMBEDDING_API_URL;
  process.env.EMBEDDING_API_URL = 'http://stub.local/api/embed';
  setEmbeddingClientForTests(stub);
  const made = await createDbOrgAndGraph(db, { orgName: 'r5162-org', graphName: 'r5162/mem' });
  mem = made.graph.id;
  await db.memory.update({ where: { id: mem }, data: { vectorIndexEnabled: true, embeddingSource: 'contentChunks' } });
  for (const [i, n] of VEC.entries()) {
    id[n] = generateId();
    await db.node.create({ data: { id: id[n]!, memoryId: mem, loc: `n-${n}`, name: n, content: 'body' } });
    const v = q(); v[3] = (i + 1) * 0.05;
    await db.$executeRawUnsafe(`
      INSERT INTO node_embeddings (id, node_id, memory_id, kind, provider, model, dim, chunk_index, char_start, char_end, chunk_text, embedding, created_at)
      VALUES ('${generateId()}', '${id[n]}', '${mem}', 'chunk', 'test', 'stub-model', ${DIM}, 0, 0, 4, 'body', '[${v.join(',')}]'::vector, now())`);
  }
}, 120_000);

afterEach(() => { vi.restoreAllMocks(); setVectorSmallScopeRowsForTests(null); });
afterAll(async () => {
  resetEmbeddingClientForTests();
  if (savedUrl === undefined) delete process.env.EMBEDDING_API_URL; else process.env.EMBEDDING_API_URL = savedUrl;
  await cleanDb(db);
});

describe('#5162: certifiedHybridRanking never certifies on a lookup that contradicts the vector leg (unit)', () => {
  const kw = { ids: ['C'], exhausted: true };
  const leg = { ids: ['A', 'B'], exhausted: false };
  const run = (ranks: Array<[string, number]>, looked: string[]) => certifiedHybridRanking(kw, leg, 1, new Map(ranks), new Set(looked));

  it('a node the leg did not return, ranked INSIDE the leg\'s depth (its last position)', () => {
    const r = run([['C', 2]], ['C']);
    expect(r.certified).toBe(false);
    expect(r).toMatchObject({ vecLookup: [], kwUncertain: false });
  });
  it('with the order settled there is nothing more to read, even on a keyword leg that goes on', () => {
    // C (1/61 + 1/61) leads whatever lies deeper, D (never looked up) included; only the contradiction withholds certification.
    const r = certifiedHybridRanking({ ids: ['C', 'D'], exhausted: false }, leg, 1, new Map([['C', 1]]), new Set(['C']));
    expect(r.ranked[0]!.nodeId).toBe('C');
    expect(r).toMatchObject({ certified: false, vecLookup: [], kwUncertain: false });
  });
  it('a contradiction does not stop the reading: what the order still needs is asked for', () => {
    // C contradicts the leg (rank 1 outside it); D is not looked up yet and the keyword leg goes on.
    const r = certifiedHybridRanking({ ids: ['C', 'D'], exhausted: false }, leg, 2, new Map([['C', 1]]), new Set(['C']));
    expect(r).toMatchObject({ certified: false, vecLookup: ['D'], kwUncertain: true });
  });
  it('a leg node the lookup places elsewhere', () => {
    expect(run([['C', 7], ['A', 1], ['B', 3]], ['C', 'A', 'B']).certified).toBe(false);
  });
  it('a leg node the lookup does not rank at all', () => {
    expect(run([['C', 7], ['A', 1]], ['C', 'A', 'B']).certified).toBe(false);
  });
  it('control: leg nodes at their positions and the other node just past the depth certify', () => {
    const r = run([['C', 3], ['A', 1], ['B', 2]], ['C', 'A', 'B']);
    expect(r.certified).toBe(true);
    expect(r.ranked[0]!.nodeId).toBe('C');
  });
  it('an exact lookup (a scope within the bound) is not a second walk: the same answer certifies', () => {
    expect(certifiedHybridRanking(kw, leg, 1, new Map([['C', 2]]), new Set(['C']), true).certified).toBe(true);
  });
});

describe('#5162: vectorRanks says when its ranks are exact', () => {
  const ranksOf = () => provider.vectorRanks({ db, queryEmbedding: q(), memoryIds: [mem], nodeIds: [id.A!, id.C!] });
  it('within the bound: exact', async () => {
    expect((await ranksOf()).exact).toBe(true);
  }, 60_000);
  it('above the bound (read from the walk): not marked exact', async () => {
    setVectorSmallScopeRowsForTests(5);
    const res = await ranksOf();
    expect(res.stoppedEarly).toBe(false);
    expect(res.exact).toBeUndefined();
  }, 60_000);
});

describe('#5162: findNodes hybrid, two walks', () => {
  it('control: a lookup that agrees with the leg certifies the true fused page', async () => {
    keywordLeg();
    const spy = secondWalk(VEC);
    const res = await findNodes({ query: 'q', mode: 'hybrid', limit: 2 });
    expect(spy).toHaveBeenCalled();
    expect(res.degraded ?? '').not.toContain('stopped_early');
    expect(names(res.hits)).toEqual(reciprocalRankFusionScored([KW, VEC], (x) => x).map((e) => e.item).slice(0, 2));
  }, 60_000);

  it('the second walk puts a keyword hit the leg did not return inside the leg\'s depth: stopped_early', async () => {
    keywordLeg();
    secondWalk(swapped(VEC, 'B', 'C')); // C at 2, which the page's leg gave to B
    const res = await findNodes({ query: 'q', mode: 'hybrid', limit: 2 });
    expect(res.degraded ?? '').toContain('stopped_early');
  }, 60_000);

  it('the walks disagree only on the leg\'s own nodes: the lookup is asked about them, and the page says stopped_early', async () => {
    keywordLeg();
    const spy = secondWalk(swapped(VEC, 'A', 'B')); // every keyword hit outside the leg keeps its rank
    const res = await findNodes({ query: 'q', mode: 'hybrid', limit: 2 });
    expect(spy.mock.calls.flatMap((c) => c[0].nodeIds)).toEqual(expect.arrayContaining([id.A, id.B]));
    expect(res.degraded ?? '').toContain('stopped_early');
    // Only the certification is withheld: the keyword leg is still widened, so the rows are the ones the full reading gives
    // (X, 3rd in both legs, leads; a reading stopped at the first lookup would not have X's keyword rank settled).
    expect(names(res.hits)).toEqual(reciprocalRankFusionScored([KW, VEC], (x) => x).map((e) => e.item).slice(0, 2));
  }, 60_000);

  it('a leg node past the lookup\'s depth (the lookup says so) withholds certification only: the reading goes on as before', async () => {
    keywordLeg();
    const walk = VEC.filter((n) => n !== 'A'); // A is past what the lookup read; a call naming it reports the early stop
    vi.spyOn(provider, 'vectorRanks').mockImplementation(async (a) => ({
      ranks: new Map(a.nodeIds.flatMap((n) => { const i = VEC.findIndex((w) => id[w] === n); return i < 0 || !walk.includes(VEC[i]!) ? [] : [[n, i + 1] as const]; })),
      stoppedEarly: a.nodeIds.includes(id.A!),
    }));
    const res = await findNodes({ query: 'q', mode: 'hybrid', limit: 2 });
    expect(res.degraded ?? '').toContain('stopped_early');
    expect(names(res.hits)).toEqual(reciprocalRankFusionScored([KW, VEC], (x) => x).map((e) => e.item).slice(0, 2));
  }, 60_000);

  // The real lookup: a write between the leg and the lookup moves a leg node to the far end, so the two statements rank
  // differently. Above the bound that reads as two disagreeing walks; within it the exact path is unchanged.
  for (const [branch, smallScope, flagged] of [['above the bound', 5, true], ['within the bound', null, false]] as const) {
    it(`real lookup, a vector moved between the leg and the lookup, ${branch}: ${flagged ? 'stopped_early' : 'certified as before'}`, async () => {
      if (smallScope !== null) setVectorSmallScopeRowsForTests(smallScope);
      keywordLeg();
      const original = provider.vectorSearch.bind(provider);
      const setDistance = (n: string, x: number) => { const v = q(); v[3] = x; return db.$executeRawUnsafe(`UPDATE node_embeddings SET embedding = '[${v.join(',')}]'::vector WHERE node_id = '${id[n]}'`); };
      vi.spyOn(provider, 'vectorSearch').mockImplementation(async (a) => {
        const hits = await original(a);
        await setDistance('A', 5);
        return hits;
      });
      try {
        const res = await findNodes({ query: 'q', mode: 'hybrid', limit: 2 });
        expect((res.degraded ?? '').includes('stopped_early')).toBe(flagged);
      } finally { await setDistance('A', 0.05); }
    }, 60_000);
  }

  for (const [branch, smallScope] of [['exact (at or below the bound)', null], ['walked (above the bound)', 5]] as const) {
    it(`control, real lookup, ${branch}: agreeing walks still certify every page`, async () => {
      if (smallScope !== null) setVectorSmallScopeRowsForTests(smallScope);
      keywordLeg();
      const got: (string | undefined)[] = [];
      for (let offset = 0; offset < 10; offset += 2) {
        const res = await findNodes({ query: 'q', mode: 'hybrid', limit: 2, offset });
        expect(res.degraded ?? '').not.toContain('stopped_early');
        got.push(...names(res.hits));
      }
      expect(got).toEqual(reciprocalRankFusionScored([KW, VEC], (x) => x).map((e) => e.item).slice(0, 10));
    }, 60_000);
  }
});
