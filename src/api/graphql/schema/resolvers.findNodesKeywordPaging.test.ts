import { randomUUID } from 'node:crypto';
/**
 * #2991 — keyword offset paging is total while a memory's vector index fills.
 *
 * Hybrid and vector pages promise no snapshot across calls while embeddings
 * are still landing (Holger's ruling (a) on #2991); callers who need complete,
 * duplicate-free paging use mode: keyword, whose order is `score DESC, loc ASC`
 * with a unique loc. This pins that guarantee: an embedding landing between
 * two keyword reads (the drain also touches the row) moves no hit across a
 * page boundary.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import type { EmbeddingClient } from '../../../lib/embedding/index.js';
import { resetEmbeddingClientForTests, setEmbeddingClientForTests } from '../../../lib/embedding/index.js';
import { embedNode } from '../../../jobs/embedNodes.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

const DIM = 768;
const stubClient: EmbeddingClient = {
  provider: 'test',
  model: 'stub-model',
  dim: DIM,
  async embed(texts: string[]) {
    return texts.map(() => { const v = new Array(DIM).fill(0); v[1] = 1; return v; });
  },
};

let admin: { id: string };
let memory: { id: string };
const as = (): Context => ({ db, userId: admin.id, roles: ['ADMIN'] });
const findNodes = (args: Record<string, unknown>) => (resolvers.Query as any).findNodes(null, args, as());

beforeEach(async () => {
  await cleanDb(db);
  process.env.EMBEDDING_API_URL = 'http://stub.local/api/embed';
  setEmbeddingClientForTests(stubClient);
  const org = await db.organization.create({ data: { id: generateId(), name: 'Paging Org', urn: 'paging.example' } });
  admin = await db.user.create({ data: { githubId: 299101, githubUsername: 'paging-admin', handle: 'paging-admin', roles: [] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  memory = await resolvers.Mutation.createMemory(null, { orgId: org.id, name: 'docs' }, as());
});

afterAll(() => {
  resetEmbeddingClientForTests();
  delete process.env.EMBEDDING_API_URL;
});

describe('findNodes keyword offset paging while the vector index fills (#2991)', () => {
  it('returns every match exactly once when an embedding lands between page reads', async () => {
    const mem = await db.memory.findUniqueOrThrow({ where: { id: memory.id } });
    expect(mem.vectorIndexEnabled).toBe(true); // the index is live, so embeddings land
    // Identical text, so every hit ties on score and loc alone orders them.
    const ids = Array.from({ length: 5 }, () => generateId());
    await db.node.createMany({
      data: ids.map((id, i) => ({
        id, memoryId: memory.id, loc: `doc:${i}`,
        name: 'Paging doc', abstract: 'paging policy', content: 'paging policy text',
        embeddingWorkToken: randomUUID(), embeddingPendingAt: new Date(),
      })),
    });
    const page = (offset: number) => findNodes({ query: 'paging', mode: 'keyword', filter: { memoryIds: [memory.id] }, limit: 2, offset });

    const seen = (await page(0)).hits.map((h: any) => h.node.id);
    // Two embeddings land between the reads, as the drain does it: the drain
    // rewrites each row, so an order that leans on row age or position (not
    // the unique loc) moves a hit across the page boundary.
    for (const id of [ids[0]!, ids[4]!]) {
      expect(await embedNode(db, id, { abstract: 'paging policy' })).toBe('embedded');
    }
    seen.push(...(await page(2)).hits.map((h: any) => h.node.id));
    seen.push(...(await page(4)).hits.map((h: any) => h.node.id));

    expect(seen).toHaveLength(ids.length);
    expect([...seen].sort()).toEqual([...ids].sort());
  });
});
