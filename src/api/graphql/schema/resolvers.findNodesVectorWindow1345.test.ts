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

const admin = (): Context => ({ db, roles: ['ADMIN'], userId: 'admin-vw' } as Context);
const findNodes = (args: Record<string, unknown>) => (resolvers.Query as any).findNodes(null, args, admin());

let memId: string;
let otherMemId: string;
let matchId: string;
async function seed(memoryId: string, loc: string, content: string, fields: Record<string, unknown> = {}) {
  const id = generateId();
  await db.node.create({ data: { id, memoryId, loc, name: loc, content, embeddingPendingAt: new Date(), ...fields } as any });
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

describe('@codex P2 — the vector window widens until the filtered page fills', () => {
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
      const opts = { db, queryEmbedding: q, memoryIds: [memId], limit, onWindow: (w: { exhausted: boolean }) => { flag = w.exhausted; } };
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
