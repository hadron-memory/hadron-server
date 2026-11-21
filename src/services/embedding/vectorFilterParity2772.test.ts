/**
 * #2772 (BLIND P2-4b, P2-5) — every NodeSqlFilter field reaches the vector statement and filters INSIDE the ranking:
 * the nearest vectors are decoys that fail the filter, and a page of 3 must still be exactly the 3 matching targets
 * (a dropped field would return decoys; a post-filter would return a short page). Plus: a literal `$1` inside a bound
 * `where` value must not corrupt the placeholder re-parse in vectorFilterSql.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb, createDbOrgAndGraph } from '../../test/helpers.js';
import { generateId } from '../../lib/id.js';
import { getRetrievalProvider } from '../../lib/retrieval/postgres.js';
import { setVectorSmallScopeRowsForTests, setVectorWindowRowsMaxForTests } from './vectors.js';

const DIM = 768;
const vec = (x: number) => { const v = new Array(DIM).fill(0); v[1] = 1; v[2] = x; return `'[${v.join(',')}]'::vector`; };
const query = () => { const v = new Array(DIM).fill(0); v[1] = 1; return v; };
let mem: string;
let decoys: string[] = [];
let targets: string[] = [];
let deletedId = '';

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
  await db.$executeRawUnsafe(`UPDATE nodes SET minted_at = now(), minted_by_info = 'test', approved_at = now(), approved_by_info = 'test', approval_hash = 'h', approved_rev_no = 999 WHERE id = ANY($1::text[])`, targets);
  deletedId = generateId();
  await db.node.create({ data: { id: deletedId, memoryId: mem, loc: 'gone', name: 'gone', content: 'body', role: 'review', createdBy: 'u-decoy' } });
  await db.$executeRawUnsafe(`UPDATE nodes SET deleted_at = now() WHERE id = $1`, deletedId);
  const rows: string[] = [];
  rows.push(`('${deletedId}', ${vec(0)})`);
  decoys.forEach((id) => rows.push(`('${id}', ${vec(0)})`));
  targets.forEach((id) => rows.push(`('${id}', ${vec(0.5)})`));
  await db.$executeRawUnsafe(`
    INSERT INTO node_embeddings (id, node_id, memory_id, kind, provider, model, dim, chunk_index, char_start, char_end, chunk_text, embedding, created_at)
    SELECT md5(n.id), n.id, n.memory_id, 'chunk', 'test', 'stub-model', ${DIM}, 0, 0, 4, 'body', v.e, now()
    FROM nodes n JOIN (VALUES ${rows.join(',')}) AS v(id, e) ON v.id = n.id`);
}, 120_000);

const search = (filter: Record<string, unknown>, limit = 3, onWindow: (w: any) => void = () => {}) =>
  getRetrievalProvider().vectorSearch({ db, memoryIds: [mem], queryEmbedding: query(), limit, onWindow, filter, ...{} } as any);

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
  ['minted', { minted: true }],
  ['approvalState', { approvalState: 'APPROVED' }],
  ['where', { where: { path: ['k'], eq: 'a$1b $2' } }],
];

// BLIND P3 (#4665): the fixture is under the small-scope bound, so the default run only exercises the EXACT statement;
// the second pass forces the iterative ANN statement (scope bound 0) so the filter is proven inside that one too.
for (const [label, bound] of [['exact path', null], ['ANN path (small-scope bound 0)', 0]] as const) describe(`#2772 each filter field is applied inside the vector ranking: ${label}`, () => {
  beforeAll(() => setVectorSmallScopeRowsForTests(bound));
  afterAll(() => setVectorSmallScopeRowsForTests(null));
  for (const [name, raw] of CASES) {
    const { _inverse, ...filter } = raw as Record<string, unknown>;
    it(`${name}: the page is full and holds only matching nodes though the nearest vectors fail the filter`, async () => {
      const hits = await search(filter);
      const want = _inverse ? decoys : targets;
      expect(hits).toHaveLength(3);
      for (const h of hits) expect(want).toContain(h.nodeId);
    });
  }

  it('a literal $1 / $2 inside a bound where value neither shifts the bind list nor matches the wrong rows', async () => {
    const hits = await search({ where: { path: ['k'], eq: 'a$1b $2' } });
    expect(hits.map((h) => h.nodeId).sort()).toEqual([...targets].sort());
  });
});

describe('BLIND P1 (#4665): the offset+limit window is cut at the cap and says stopped_early', () => {
  afterAll(() => setVectorWindowRowsMaxForTests(null));
  for (const bound of [null, 0]) {
    it(`a window past the cap returns at most the cap rows, stoppedEarly, never exhausted (small-scope bound ${bound})`, async () => {
      setVectorSmallScopeRowsForTests(bound);
      setVectorWindowRowsMaxForTests(2);
      let w: any;
      const hits = await search({}, 5, (x) => { w = x; });
      setVectorWindowRowsMaxForTests(null); setVectorSmallScopeRowsForTests(null);
      expect(hits).toHaveLength(2);
      expect(w.stoppedEarly).toBe(true);
      expect(w.exhausted).toBe(false);
    });
  }
  it('a window at the cap is not cut', async () => {
    setVectorWindowRowsMaxForTests(5);
    let w: any;
    await search({}, 5, (x) => { w = x; });
    setVectorWindowRowsMaxForTests(null);
    expect(w.stoppedEarly).toBeFalsy();
  });
});

describe('BLIND P2 (#4665): the cut is a loss only when the window was filled; tombstones follow the recoverable memories', () => {
  afterAll(() => setVectorWindowRowsMaxForTests(null));
  it('a window past the cap over a scope smaller than the cap reports a complete result, not stopped_early', async () => {
    setVectorWindowRowsMaxForTests(50);
    let w: any;
    const hits = await search({}, 60, (x) => { w = x; });
    setVectorWindowRowsMaxForTests(null);
    expect(hits).toHaveLength(7); // 4 decoys + 3 targets; the tombstone is not a hit
    expect(w.stoppedEarly).toBeFalsy();
    expect(w.exhausted).toBe(true);
  });
  const withDeleted = (tombstoneMemoryIds: string[]) =>
    getRetrievalProvider().vectorSearch({ db, memoryIds: [mem], queryEmbedding: query(), limit: 20, onWindow: () => {}, includeDeleted: true, filter: { tombstoneMemoryIds }, ...{} } as any);
  it('includeDeleted ranks the tombstone only in a recoverable memory', async () => {
    expect((await withDeleted([])).map((h: any) => h.nodeId)).not.toContain(deletedId);
    expect((await withDeleted([mem])).map((h: any) => h.nodeId)).toContain(deletedId);
  });
});
