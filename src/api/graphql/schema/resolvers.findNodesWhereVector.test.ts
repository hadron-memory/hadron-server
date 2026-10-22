import { randomUUID } from 'node:crypto';
/**
 * #719 — the `where` predicate composed with vector / hybrid ranking. Uses the
 * hermetic stub embedder (033 pattern): both seed nodes embed near the query, so
 * vector ranking returns both; the `where` predicate must then drop the one that
 * doesn't match — proving the buildResult post-filter intersection (and that the
 * former where + vector/hybrid rejection is gone).
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
const oneHot = (slot: number): number[] => {
  const v = new Array(DIM).fill(0);
  v[slot % DIM] = 1;
  return v;
};
const stubClient = (map: Record<string, number[]>): EmbeddingClient => ({
  provider: 'test',
  model: 'stub-model',
  dim: DIM,
  async embed(texts: string[]) {
    return texts.map((t) => map[t] ?? oneHot(0));
  },
});

const admin = (): Context => ({ db, roles: ['ADMIN'], userId: 'admin-wv' } as Context);
const findNodes = (args: Record<string, unknown>) => (resolvers.Query as any).findNodes(null, args, admin());
const locs = (res: any): string[] => res.hits.map((h: any) => h.node.loc).sort();

let memId: string;
async function seedNode(loc: string, abstract: string, properties: Record<string, unknown>) {
  const id = generateId();
  await db.node.create({
    data: { id, memoryId: memId, loc, name: loc, abstract, properties, embeddingWorkToken: randomUUID(), embeddingPendingAt: new Date() } as any,
  });
  expect(await embedNode(db, id, { abstract })).toBe('embedded');
}

beforeEach(async () => {
  await cleanDb(db);
  process.env.EMBEDDING_API_URL = 'http://stub.local/api/embed';
  // query 'q' and both abstracts embed to the same slot → both are vector hits.
  setEmbeddingClientForTests(stubClient({ q: oneHot(1), alpha: oneHot(1), beta: oneHot(1) }));
  const made = await createDbOrgAndGraph(db, { orgName: 'wv-org', graphName: 'wv/graph' });
  memId = made.graph.id;
  await db.memory.update({ where: { id: memId }, data: { vectorIndexEnabled: true } });
  await seedNode('vec.a', 'alpha', { sourceKind: 'substack' });
  await seedNode('vec.b', 'beta', { sourceKind: 'reddit' });
});

afterAll(() => {
  resetEmbeddingClientForTests();
  delete process.env.EMBEDDING_API_URL;
});

describe('findNodes where + vector/hybrid', () => {
  it('mode vector: where filters the ranked candidate set', async () => {
    const res = await findNodes({
      query: 'q',
      mode: 'vector',
      filter: { memoryIds: [memId], where: { path: ['sourceKind'], eq: 'substack' } },
    });
    expect(locs(res)).toEqual(['vec.a']); // vec.b (reddit) is a vector hit but dropped by where
    expect(res.hits[0].vector?.similarity).toBeGreaterThan(0);
  });

  it('mode hybrid: where filters the fused set', async () => {
    const res = await findNodes({
      query: 'q',
      mode: 'hybrid',
      filter: { memoryIds: [memId], where: { path: ['sourceKind'], eq: 'substack' } },
    });
    expect(locs(res)).toEqual(['vec.a']);
  });

  it('where + vector no longer rejects (former BAD_USER_INPUT is gone)', async () => {
    await expect(
      findNodes({ query: 'q', mode: 'vector', filter: { memoryIds: [memId], where: { path: ['sourceKind'], eq: 'reddit' } } }),
    ).resolves.toMatchObject({ hits: [{ node: { loc: 'vec.b' } }] });
  });
});
