/**
 * #2772 — a deep page is the TRUE page, ties included. More than 1,000 vectors at exactly the same distance
 * (the page is deeper than the HNSW window, so the exact statement ranks it) must come back in node-id order,
 * equal to a brute-force reference that breaks ties the same way. Without the tie-break the order among equals
 * is whatever the hash aggregate emits, so the page is not reproducible.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, createDbOrgAndGraph } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import type { EmbeddingClient } from '../../../lib/embedding/index.js';
import { setEmbeddingClientForTests, resetEmbeddingClientForTests } from '../../../lib/embedding/index.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));

const DIM = 768;
const N = 1300;
const qvec = () => { const q = new Array(DIM).fill(0); q[1] = 1; return q; };
const stub: EmbeddingClient = { provider: 'test', model: 'stub-model', dim: DIM, async embed(texts: string[]) { return texts.map(() => qvec()); } };
let mem: string;
let savedUrl: string | undefined;

beforeAll(async () => {
  await cleanDb(db);
  savedUrl = process.env.EMBEDDING_API_URL;
  process.env.EMBEDDING_API_URL = 'http://stub.local/api/embed';
  setEmbeddingClientForTests(stub);
  const made = await createDbOrgAndGraph(db, { orgName: 'r2772t-org', graphName: 'r2772t/mem' });
  mem = made.graph.id;
  await db.memory.update({ where: { id: mem }, data: { vectorIndexEnabled: true, embeddingSource: 'contentChunks' } });
  await db.node.createMany({ data: Array.from({ length: N }, (_, i) => ({ id: generateId(), memoryId: mem, loc: `t${i}`, name: `t${i}`, content: 'body', role: 'review' })) });
  // Every vector IDENTICAL to the query: all N distances tie at 0.
  await db.$executeRawUnsafe(`
    INSERT INTO node_embeddings (id, node_id, memory_id, kind, provider, model, dim, chunk_index, char_start, char_end, chunk_text, embedding, created_at)
    SELECT md5(id), id, memory_id, 'chunk', 'test', 'stub-model', ${DIM}, 0, 0, 4, 'body',
      ('[' || array_to_string(array_fill(0::real, ARRAY[1]) || ARRAY[1::real] || array_fill(0::real, ARRAY[${DIM - 2}]), ',') || ']')::vector, now()
    FROM nodes WHERE memory_id = '${mem}'`);
}, 180_000);

afterAll(() => {
  resetEmbeddingClientForTests();
  if (savedUrl === undefined) delete process.env.EMBEDDING_API_URL; else process.env.EMBEDDING_API_URL = savedUrl;
});

describe('#2772 ties at depth', () => {
  it('a page past the HNSW window, in a field of exact ties, is the node-id order', async () => {
    const ctx = { db, roles: ['ADMIN'], userId: 'admin-2772t' } as unknown as Context;
    const res = await (resolvers.Query as any).findNodes(null, { query: 'q', mode: 'vector', limit: 20, offset: 1100, filter: { memoryRefs: [mem] } }, ctx);
    const want = (await db.node.findMany({ where: { memoryId: mem }, select: { id: true }, orderBy: { id: 'asc' }, skip: 1100, take: 20 })).map((r) => r.id);
    expect(res.hits.map((h: any) => h.node.id)).toEqual(want);
  }, 60_000);
});
