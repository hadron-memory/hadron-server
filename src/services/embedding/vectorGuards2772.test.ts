/**
 * #2772 — guards a mutant could drop unnoticed (LOCAL P3 at b07e0311): excludeNodeIds and the default deleted rule act
 * INSIDE the ranking (a page is filled with eligible rows, not trimmed afterwards), a budget of 0 never means "no
 * timeout", and the pgvector 0.8.0 boundary.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb, createDbOrgAndGraph } from '../../test/helpers.js';
import { generateId } from '../../lib/id.js';
import { getRetrievalProvider } from '../../lib/retrieval/postgres.js';
import { pgvectorSupportsIterativeScan, vectorSearchTimeoutMs } from './vectors.js';

const DIM = 768;
const q = () => { const v = new Array(DIM).fill(0); v[1] = 1; return v; };
const VEC = `'[${q().join(',')}]'::vector`;
let mem: string;
let ids: string[] = [];
let deadId: string;

beforeAll(async () => {
  await cleanDb(db);
  const made = await createDbOrgAndGraph(db, { orgName: 'r2772g-org', graphName: 'r2772g/mem' });
  mem = made.graph.id;
  await db.memory.update({ where: { id: mem }, data: { vectorIndexEnabled: true, embeddingSource: 'contentChunks' } });
  ids = Array.from({ length: 6 }, () => generateId());
  deadId = generateId();
  await db.node.createMany({ data: [...ids, deadId].map((id, i) => ({ id, memoryId: mem, loc: `n${i}`, name: `n${i}`, content: 'body', role: 'review' })) });
  await db.node.update({ where: { id: deadId }, data: { deletedAt: new Date() } });
  await db.$executeRawUnsafe(`
    INSERT INTO node_embeddings (id, node_id, memory_id, kind, provider, model, dim, chunk_index, char_start, char_end, chunk_text, embedding, created_at)
    SELECT md5(id), id, memory_id, 'chunk', 'test', 'stub-model', ${DIM}, 0, 0, 4, 'body', ${VEC}, now() FROM nodes WHERE memory_id = '${mem}'`);
}, 120_000);

const search = (extra: Record<string, unknown>) =>
  getRetrievalProvider().vectorSearch({ db, memoryIds: [mem], queryEmbedding: q(), limit: 4, onWindow: () => {}, ...extra } as any);

describe('#2772 guards inside the ranking', () => {
  it('excludeNodeIds are removed before the page is cut: the page is still full, and none is returned', async () => {
    const excluded = ids.slice(0, 2);
    const hits = await search({ excludeNodeIds: excluded });
    expect(hits).toHaveLength(4);
    for (const h of hits) expect(excluded).not.toContain(h.nodeId);
  });

  it('with only an exclusion list (no structured filter) a soft-deleted node is still never a hit', async () => {
    const hits = await search({ excludeNodeIds: [ids[0]!], limit: 10 });
    expect(hits.map((h) => h.nodeId)).not.toContain(deadId);
    expect(hits).toHaveLength(5); // 6 live - 1 excluded; the tombstone is not counted
  });

  it('with NO filter and NO exclusions the ranking itself still never returns a soft-deleted node', async () => {
    const hits = await search({ limit: 10 });
    expect(hits.map((h) => h.nodeId)).not.toContain(deadId);
    expect(hits).toHaveLength(6);
  });

  it('includeDeleted keeps the tombstone when the caller asks for it', async () => {
    const hits = await search({ excludeNodeIds: [ids[0]!], includeDeleted: true, limit: 10 });
    expect(hits.map((h) => h.nodeId)).toContain(deadId);
  });
});

describe('#2772 budget and version edges', () => {
  const saved = process.env.VECTOR_SEARCH_TIMEOUT_MS;
  afterEach(() => { if (saved === undefined) delete process.env.VECTOR_SEARCH_TIMEOUT_MS; else process.env.VECTOR_SEARCH_TIMEOUT_MS = saved; });

  it('0, negatives, fractions and junk fall back to the default; a positive integer is taken', () => {
    delete process.env.VECTOR_SEARCH_TIMEOUT_MS;
    const dflt = vectorSearchTimeoutMs();
    for (const bad of ['0', '-5', '1.5', 'abc', '', '9999999999']) {
      process.env.VECTOR_SEARCH_TIMEOUT_MS = bad;
      expect(vectorSearchTimeoutMs()).toBe(dflt);
    }
    process.env.VECTOR_SEARCH_TIMEOUT_MS = '7000';
    expect(vectorSearchTimeoutMs()).toBe(7000);
  });

  it('pgvector 0.8.0 is the first version with the iterative scan', () => {
    expect([
      pgvectorSupportsIterativeScan('0.7.4'), pgvectorSupportsIterativeScan('0.7.99'), pgvectorSupportsIterativeScan('0.8.0'),
      pgvectorSupportsIterativeScan('0.10.1'), pgvectorSupportsIterativeScan('1.0.0'), pgvectorSupportsIterativeScan(null), pgvectorSupportsIterativeScan('x'),
    ]).toEqual([false, false, true, true, true, false, false]);
  });
});
