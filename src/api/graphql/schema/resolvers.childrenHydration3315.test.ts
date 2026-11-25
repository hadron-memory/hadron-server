/** #3315: move a real SQL/vector candidate before each resolver hydration read. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, createDbOrgAndGraph } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { getRetrievalProvider } from '../../../lib/retrieval/postgres.js';
import { setEmbeddingClientForTests, resetEmbeddingClientForTests } from '../../../lib/embedding/index.js';
import { embedNode } from '../../../jobs/embedNodes.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
const provider = getRetrievalProvider();
let memoryId: string;
let nodeId: string;
let priorUrl: string | undefined;
const ctx: Context = { db, userId: 'admin-3315', roles: ['ADMIN'] } as Context;
const read = (args: Record<string, unknown>) =>
  (resolvers.Query as any).findNodes(null, { filter: { memoryRefs: [memoryId], childrenOf: 'parent' }, limit: 1, ...args }, ctx);

beforeEach(async () => {
  priorUrl = process.env.EMBEDDING_API_URL;
  await cleanDb(db);
  const { graph } = await createDbOrgAndGraph(db, { orgName: 'hydration-3315', graphName: 'hydration-3315' });
  memoryId = graph.id;
  nodeId = generateId();
  await db.node.create({ data: { id: nodeId, memoryId, loc: 'parent:child', name: 'zebra', content: 'zebra body' } });
});
afterEach(() => {
  vi.restoreAllMocks();
  resetEmbeddingClientForTests();
  if (priorUrl === undefined) delete process.env.EMBEDDING_API_URL;
  else process.env.EMBEDDING_API_URL = priorUrl;
});
async function vectors() {
  process.env.EMBEDDING_API_URL = 'http://stub.invalid/3315';
  setEmbeddingClientForTests({ provider: 'test', model: 'stub-model', dim: 768,
    async embed(texts) { return texts.map(() => [1, ...new Array<number>(767).fill(0)]); } });
  await db.memory.update({ where: { id: memoryId }, data: { vectorIndexEnabled: true, embeddingSource: 'contentChunks' } });
  await db.node.update({ where: { id: nodeId }, data: { embeddingWorkToken: generateId(), embeddingPendingAt: new Date() } });
  expect(await embedNode(db, nodeId)).toBe('embedded');
}
const move = () => db.node.update({ where: { id: nodeId }, data: { loc: 'elsewhere:child' } });

describe('#3315 actual candidate selection then a controlled move', () => {
  it('filtered browse drops a child moved after filterSearch', async () => {
    const original = provider.filterSearch.bind(provider);
    const select = vi.spyOn(provider, 'filterSearch').mockImplementation(async args => {
      const ids = await original(args);
      expect(ids).toEqual([nodeId]);
      await move();
      return ids;
    });
    expect((await read({})).hits).toEqual([]);
    expect(select).toHaveBeenCalledOnce();
  });
  it.each(['keyword', 'regex'] as const)('%s drops a child moved after ranking', async mode => {
    const method = mode === 'keyword' ? 'lexicalSearch' : 'regexSearch';
    const original = provider[method].bind(provider);
    // Both provider signatures differ only in the query/pattern field; each call still executes its real SQL.
    const select = vi.spyOn(provider, method).mockImplementation(async (args: any) => {
      const hits = await original(args);
      expect(hits.map(h => h.nodeId)).toEqual([nodeId]);
      await move();
      return hits;
    });
    expect((await read({ query: 'zebra', mode })).hits).toEqual([]);
    expect(select).toHaveBeenCalledOnce();
  });
  // #4779 (P3-1): a node hydration drops from a ranking that was NOT exhausted triggers ONE deeper re-ranking. Vector mode
  // reads exactly the page (limit 1, one node: not provably exhausted), so it re-ranks once; that ranking no longer sees the
  // moved child and is exhausted, so the page is empty and NOT flagged. Hybrid reads both legs five deep here (childrenOf is a
  // structured filter), so its first ranking is already exhausted and nothing is re-ranked.
  it.each([['vector', 2], ['hybrid', 1]] as const)('%s rechecks hydrated nodes, and re-ranks once only when the ranking was not exhausted', async (mode, calls) => {
    await vectors();
    const original = provider.vectorSearch.bind(provider);
    let call = 0;
    const select = vi.spyOn(provider, 'vectorSearch').mockImplementation(async args => {
      const hits = await original(args);
      if (call++ === 0) {
        expect(hits.map(h => h.nodeId)).toEqual([nodeId]);
        await move();
      } else expect(hits).toEqual([]); // the re-ranking runs after the move: the child is no longer a candidate
      return hits;
    });
    const res = await read({ query: 'zebra', mode });
    expect(res.hits).toEqual([]);
    expect(res.degraded).toBeNull();
    expect(select).toHaveBeenCalledTimes(calls);
  });
  it('chunk mode rechecks parent loc before returning passage text', async () => {
    await vectors();
    const original = provider.vectorSearchChunks.bind(provider);
    const select = vi.spyOn(provider, 'vectorSearchChunks').mockImplementation(async args => {
      const hits = await original(args);
      expect(hits.length).toBeGreaterThan(0);
      expect(new Set(hits.map(h => h.nodeId))).toEqual(new Set([nodeId]));
      await move();
      return hits;
    });
    expect((await read({ query: 'zebra', mode: 'vector', granularity: 'chunk' })).passages).toEqual([]);
    expect(select).toHaveBeenCalledOnce();
  });
  it('#2772: the vector ranking already applies childrenOf inside its statement, and hydration still drops a child moved after it', async () => {
    await vectors();
    const original = provider.vectorSearch.bind(provider);
    let call = 0;
    const select = vi.spyOn(provider, 'vectorSearch').mockImplementation(async args => {
      const hits = await original(args);
      if (call++ === 0) {
        // The filter ran inside the ranking statement: the child is a candidate. (There is no widening window any more.)
        expect(hits.map(h => h.nodeId)).toEqual([nodeId]);
        await move();
      } else expect(hits).toEqual([]); // #4779 P3-1: the one re-ranking, after the move
      return hits;
    });
    expect((await read({ query: 'zebra', mode: 'vector' })).hits).toEqual([]);
    expect(select).toHaveBeenCalledTimes(2);
  });
});
