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
  (resolvers.Query as any).findNodes(null, { filter: { memoryIds: [memoryId], childrenOf: 'parent' }, limit: 1, ...args }, ctx);

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
  it.each(['vector', 'hybrid'] as const)('%s rechecks hydrated nodes even after an exhausted vector window', async mode => {
    await vectors();
    const original = provider.vectorSearch.bind(provider);
    const select = vi.spyOn(provider, 'vectorSearch').mockImplementation(async args => {
      const hits = await original(args);
      expect(hits.map(h => h.nodeId)).toEqual([nodeId]);
      await move();
      return hits;
    });
    expect((await read({ query: 'zebra', mode })).hits).toEqual([]);
    expect(select).toHaveBeenCalledOnce();
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
  it('eligibility rechecks loc before deciding a vector window is full', async () => {
    await vectors();
    const original = provider.vectorSearch.bind(provider);
    let calls = 0;
    const select = vi.spyOn(provider, 'vectorSearch').mockImplementation(async args => {
      calls++;
      if (calls === 2) await db.node.update({ where: { id: nodeId }, data: { loc: 'parent:child' } });
      const hits = await original({ ...args, onWindow: undefined });
      expect(hits.map(h => h.nodeId)).toEqual([nodeId]);
      // First window deliberately reports more candidates available: eligibility must reject the moved row.
      args.onWindow?.({ exhausted: calls > 1 });
      if (calls === 1) await move();
      return hits;
    });
    expect((await read({ query: 'zebra', mode: 'vector' })).hits.map((h: any) => h.node.id)).toEqual([nodeId]);
    expect(select).toHaveBeenCalledTimes(2);
  });
});
