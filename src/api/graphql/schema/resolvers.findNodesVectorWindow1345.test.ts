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

  it('node granularity keeps widening when dedup makes a batch SHORT without exhausting the index (@codex round 3)', async () => {
    // Two near review nodes with many small chunks each fill the whole ANN
    // window, which dedupes to 2 node hits (< the 5 asked): "short batch" is
    // duplicates, not exhaustion, and the farther spec match must still be found.
    await db.memory.update({ where: { id: memId }, data: { chunkTokens: 8, chunkOverlap: 0 } });
    await db.node.deleteMany({ where: { memoryId: memId } });
    const words = Array.from({ length: 400 }, (_, i) => `near${i}`).join(' ');
    await seed(memId, 'bulk1', words, { role: 'review' });
    await seed(memId, 'bulk2', words, { role: 'review' });
    const match = await seed(memId, 'match2', 'far body match', { role: 'spec' });
    const chunkCount = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM node_embeddings WHERE memory_id = ${memId} AND kind = 'chunk'`;
    expect(Number(chunkCount[0].n)).toBeGreaterThan(50); // more near vectors than the first window (10 x 5)
    const res = await findNodes({ query: 'q', mode: 'vector', limit: 1, filter: { memoryIds: [memId], role: 'spec' } });
    expect(res.hits.map((h: any) => h.node.id)).toEqual([match]);
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
