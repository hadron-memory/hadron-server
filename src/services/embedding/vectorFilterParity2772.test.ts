/**
 * #2772 (BLIND P2-4b, P2-5) — every NodeSqlFilter field reaches the vector statement and filters INSIDE the ranking:
 * the nearest vectors are decoys that fail the filter, and a page of 3 must still be exactly the 3 matching targets
 * (a dropped field would return decoys; a post-filter would return a short page). Plus: a literal `$1` inside a bound
 * `where` value must not corrupt the placeholder re-parse in vectorFilterSql.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb, createDbOrgAndGraph } from '../../test/helpers.js';
import { generateId } from '../../lib/id.js';
import { getRetrievalProvider } from '../../lib/retrieval/postgres.js';

const DIM = 768;
const vec = (x: number) => { const v = new Array(DIM).fill(0); v[1] = 1; v[2] = x; return `'[${v.join(',')}]'::vector`; };
const query = () => { const v = new Array(DIM).fill(0); v[1] = 1; return v; };
let mem: string;
let decoys: string[] = [];
let targets: string[] = [];

beforeAll(async () => {
  await cleanDb(db);
  const made = await createDbOrgAndGraph(db, { orgName: 'r2772p-org', graphName: 'r2772p/mem' });
  mem = made.graph.id;
  await db.memory.update({ where: { id: mem }, data: { vectorIndexEnabled: true, embeddingSource: 'contentChunks' } });
  decoys = Array.from({ length: 4 }, () => generateId());
  targets = Array.from({ length: 3 }, () => generateId());
  await db.node.createMany({ data: decoys.map((id, i) => ({ id, memoryId: mem, loc: `dec${i}`, name: `d${i}`, content: 'body', role: 'review', createdBy: 'u-decoy', properties: { k: 'plain' } })) });
  await db.node.createMany({ data: targets.map((id, i) => ({
    id, memoryId: mem, loc: `tgt:c${i}`, name: `t${i}`, content: 'body', nodeType: 'task', objectType: 'widget', isRunnable: true,
    role: 'review.x', tags: ['t1'], createdBy: 'u-tgt', properties: { k: 'a$1b $2' },
  })) });
  await db.$executeRawUnsafe(`UPDATE nodes SET updated_at = '2020-01-01' WHERE id = ANY($1::text[])`, decoys);
  await db.$executeRawUnsafe(`UPDATE nodes SET updated_at = '2030-01-01' WHERE id = ANY($1::text[])`, targets);
  const rows: string[] = [];
  decoys.forEach((id) => rows.push(`('${id}', ${vec(0)})`));
  targets.forEach((id) => rows.push(`('${id}', ${vec(0.5)})`));
  await db.$executeRawUnsafe(`
    INSERT INTO node_embeddings (id, node_id, memory_id, kind, provider, model, dim, chunk_index, char_start, char_end, chunk_text, embedding, created_at)
    SELECT md5(n.id), n.id, n.memory_id, 'chunk', 'test', 'stub-model', ${DIM}, 0, 0, 4, 'body', v.e, now()
    FROM nodes n JOIN (VALUES ${rows.join(',')}) AS v(id, e) ON v.id = n.id`);
}, 120_000);

const search = (filter: Record<string, unknown>) =>
  getRetrievalProvider().vectorSearch({ db, memoryIds: [mem], queryEmbedding: query(), limit: 3, onWindow: () => {}, filter, ...{} } as any);

const CASES: Array<[string, Record<string, unknown>]> = [
  ['nodeType', { nodeType: 'task' }],
  ['nodeTypes', { nodeTypes: ['task'] }],
  ['objectType', { objectType: 'widget' }],
  ['isRunnable', { isRunnable: true }],
  ['role', { role: 'review.x' }],
  ['tags', { tags: ['t1'] }],
  ['locPrefix', { locPrefix: 'tgt:' }],
  ['childrenOf', { childrenOf: 'tgt' }],
  ['createdBy', { createdBy: 'u-tgt' }],
  ['updatedAfter', { updatedAfter: '2025-01-01T00:00:00Z' }],
  ['updatedBefore', { updatedBefore: '2025-01-01T00:00:00Z', _inverse: true }],
  ['where', { where: { path: ['k'], eq: 'a$1b $2' } }],
];

describe('#2772 each filter field is applied inside the vector ranking', () => {
  for (const [name, raw] of CASES) {
    const { _inverse, ...filter } = raw as Record<string, unknown>;
    it(`${name}: the page is full and holds only matching nodes though the nearest vectors fail the filter`, async () => {
      const hits = await search(filter);
      const want = _inverse ? decoys : targets;
      expect(hits).toHaveLength(_inverse ? 3 : 3);
      for (const h of hits) expect(want).toContain(h.nodeId);
    });
  }

  it('a literal $1 / $2 inside a bound where value neither shifts the bind list nor matches the wrong rows', async () => {
    const hits = await search({ where: { path: ['k'], eq: 'a$1b $2' } });
    expect(hits.map((h) => h.nodeId).sort()).toEqual([...targets].sort());
  });
});
