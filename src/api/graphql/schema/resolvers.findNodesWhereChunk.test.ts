import { randomUUID } from 'node:crypto';
/**
 * #719 — `where` honored on chunk-granularity passages (Codex review on the
 * vector/hybrid PR). A `contentChunks` memory returns passages; a passage whose
 * PARENT node fails the predicate must not surface. Both nodes' chunks are
 * vector hits; `where` drops the non-matching parent's passages.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, createDbOrgAndGraph } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import type { EmbeddingClient } from '../../../lib/embedding/index.js';
import { setEmbeddingClientForTests, resetEmbeddingClientForTests } from '../../../lib/embedding/index.js';
import { embedNode } from '../../../jobs/embedNodes.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

const DIM = 768;
// Every chunk + the query embed to the same slot → all chunks are vector hits.
const stub: EmbeddingClient = {
  provider: 'test',
  model: 'stub-model',
  dim: DIM,
  async embed(texts: string[]) {
    return texts.map(() => {
      const v = new Array(DIM).fill(0);
      v[1] = 1;
      return v;
    });
  },
};

const admin = (): Context => ({ db, roles: ['ADMIN'], userId: 'admin-wc' } as Context);
const findNodes = (args: Record<string, unknown>) => (resolvers.Query as any).findNodes(null, args, admin());

let memId: string;
let aId: string;
let bId: string;
async function seedChunkNode(loc: string, content: string, properties: Record<string, unknown>) {
  const id = generateId();
  await db.node.create({
    data: { id, memoryId: memId, loc, name: loc, content, properties, embeddingWorkToken: randomUUID(), embeddingPendingAt: new Date() } as any,
  });
  expect(await embedNode(db, id)).toBe('embedded');
  return id;
}

beforeEach(async () => {
  await cleanDb(db);
  process.env.EMBEDDING_API_URL = 'http://stub.local/api/embed';
  setEmbeddingClientForTests(stub);
  const made = await createDbOrgAndGraph(db, { orgName: 'wc-org', graphName: 'wc/graph' });
  memId = made.graph.id;
  await db.memory.update({ where: { id: memId }, data: { vectorIndexEnabled: true, embeddingSource: 'contentChunks' } });
  aId = await seedChunkNode('chunk.a', 'alpha content body about memory', { sourceKind: 'substack' });
  bId = await seedChunkNode('chunk.b', 'beta content body about memory', { sourceKind: 'reddit' });
});

afterAll(() => {
  resetEmbeddingClientForTests();
  delete process.env.EMBEDDING_API_URL;
});

describe('findNodes where — chunk granularity', () => {
  it('passages come only from parents satisfying the predicate', async () => {
    const res = await findNodes({
      query: 'q',
      mode: 'vector',
      granularity: 'chunk',
      filter: { memoryIds: [memId], where: { path: ['sourceKind'], eq: 'substack' } },
    });
    expect(res.passages.length).toBeGreaterThan(0);
    // Every returned passage belongs to chunk.a (substack); none to chunk.b (reddit).
    expect(res.passages.every((p: any) => p.parentNodeId === aId)).toBe(true);
    expect(res.passages.some((p: any) => p.parentNodeId === bId)).toBe(false);
  });
});
