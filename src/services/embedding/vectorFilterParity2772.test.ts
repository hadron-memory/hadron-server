/**
 * #2772 (BLIND P2-4b, P2-5) — every NodeSqlFilter field reaches the vector statement and filters INSIDE the ranking:
 * the nearest vectors are decoys that fail the filter, and a page of 3 must still be exactly the 3 matching targets
 * (a dropped field would return decoys; a post-filter would return a short page). Plus: a literal `$1` inside a bound
 * `where` value must not corrupt the placeholder re-parse in vectorFilterSql.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb, createDbOrgAndGraph } from '../../test/helpers.js';
import { generateId } from '../../lib/id.js';
import { getRetrievalProvider } from '../../lib/retrieval/postgres.js';
import { setVectorSmallScopeRowsForTests, setVectorWindowRowsMaxForTests, vectorSearchNodes, vectorSearchChunks, vectorSearchTimeoutMs, VECTOR_ANN_MAX_K, VECTOR_INDEX_ORDER_WINDOW, VECTOR_TX_MAX_WAIT_MS } from './vectors.js';

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
  // #5412 section 5: a branch-only memory's prefix filters inside the ranking and the small-scope count, before the candidate cap.
  ['branches (#5412)', { branches: [{ memoryId: '$mem', prefixes: ['tgt'] }] }],
];

// BLIND P3 (#4665): the fixture is under the small-scope bound, so the default run only exercises the EXACT statement;
// the second pass forces the iterative ANN statement (scope bound 0) so the filter is proven inside that one too.
for (const [label, bound] of [['exact path', null], ['ANN path (small-scope bound 0)', 0]] as const) describe(`#2772 each filter field is applied inside the vector ranking: ${label}`, () => {
  beforeAll(() => setVectorSmallScopeRowsForTests(bound));
  afterAll(() => setVectorSmallScopeRowsForTests(null));
  for (const [name, raw] of CASES) {
    const { _inverse, ...filter } = raw as Record<string, unknown>;
    it(`${name}: the page is full and holds only matching nodes though the nearest vectors fail the filter`, async () => {
      // The memory id exists only after beforeAll; '$mem' stands for it.
      const resolved = filter.branches ? { ...filter, branches: [{ memoryId: mem, prefixes: ['tgt'] }] } : filter;
      const hits = await search(resolved);
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

describe('Celline survivor (#4665): the memory scope rides the node ranking statement', () => {
  it('a vector in ANOTHER memory, closer than every in-scope vector, is never ranked into the page', async () => {
    const other = (await createDbOrgAndGraph(db, { orgName: 'r2772p-org2', graphName: 'r2772p/other' })).graph.id;
    await db.memory.update({ where: { id: other }, data: { vectorIndexEnabled: true, embeddingSource: 'contentChunks' } });
    const foreign = generateId();
    await db.node.create({ data: { id: foreign, memoryId: other, loc: 'foreign', name: 'foreign', content: 'body', role: 'review', createdBy: 'u-x' } });
    await db.$executeRawUnsafe(`
      INSERT INTO node_embeddings (id, node_id, memory_id, kind, provider, model, dim, chunk_index, char_start, char_end, chunk_text, embedding, created_at)
      VALUES (md5('${foreign}'), '${foreign}', '${other}', 'chunk', 'test', 'stub-model', ${DIM}, 0, 0, 4, 'body', ${vec(0)}, now())`);
    // Called directly with NO filterSql: through the provider the filter fragment scopes by memory too, which would hide a
    // dropped `ne.memory_id IN (...)` in the ranking statement itself.
    const hits = await vectorSearchNodes(db, { memoryIds: [mem], queryEmbedding: query(), limit: 50 });
    expect(hits.map((h) => h.nodeId)).not.toContain(foreign);
    expect(hits.length).toBeGreaterThan(0);
  });
});

describe('BLIND P2-3 (#4665, Bridget P3-1): a vector transaction never waits longer than VECTOR_TX_MAX_WAIT_MS for a connection', () => {
  it('every transaction of a search asks Prisma for maxWait <= the cap and <= the budget left', async () => {
    const seen: number[] = [];
    const real = db.$transaction.bind(db);
    const spy = vi.spyOn(db, '$transaction').mockImplementation(((fn: unknown, o?: { maxWait?: number }) => { seen.push(o?.maxWait ?? Infinity); return (real as any)(fn, o); }) as any);
    try { await search({}); } finally { spy.mockRestore(); }
    expect(seen.length).toBeGreaterThan(0);
    for (const w of seen) expect(w).toBeLessThanOrEqual(VECTOR_TX_MAX_WAIT_MS);
  });
});

describe('Charles survivors (#4665): the budget is measured inside the transaction; the ANN walk has a ceiling', () => {
  afterAll(() => setVectorSmallScopeRowsForTests(null));
  /** Run a search with every `$transaction` wrapped: `lag` ms pass between the call and the callback (a pool wait),
   *  every raw statement's text is recorded, and the statement_timeout in force at the end of each callback is read. */
  const traced = async (lag: number, run: () => Promise<unknown>) => {
    const real = db.$transaction.bind(db);
    const sql: string[] = []; const timeouts: number[] = [];
    const spy = vi.spyOn(db, '$transaction').mockImplementation(((fn: (tx: any) => Promise<unknown>, o?: unknown) =>
      (real as any)(async (tx: any) => {
        await new Promise((r) => setTimeout(r, lag));
        const proxy = new Proxy(tx, { get: (t, k) => k === '$queryRaw'
          ? (strings: TemplateStringsArray, ...v: unknown[]) => { sql.push(Array.from(strings).join('?')); return t.$queryRaw(strings, ...v); }
          : (t as any)[k] });
        const out = await fn(proxy);
        timeouts.push(Number((await tx.$queryRawUnsafe(`SELECT setting FROM pg_settings WHERE name = 'statement_timeout'`))[0].setting));
        return out;
      }, o)) as any);
    try { await run(); } finally { spy.mockRestore(); }
    return { sql, timeouts };
  };
  it('M4: time spent waiting for a connection is taken off the statement budget', async () => {
    const { timeouts } = await traced(400, () => search({}));
    expect(timeouts.length).toBeGreaterThan(0);
    // the first transaction starts 400 ms after the search began, so it can never be handed the whole budget
    expect(timeouts[0]).toBeLessThanOrEqual(vectorSearchTimeoutMs() - 350);
  });
  it('M10: a first horizon past VECTOR_ANN_MAX_K goes straight to the exact statement (control: a normal horizon walks the index)', async () => {
    setVectorSmallScopeRowsForTests(0); // force the large-scope path
    const annSeen = (sql: string[]) => sql.some((q) => q.includes('ORDER BY ne.embedding <=>'));
    const run = (candidateFactor: number) => traced(0, () => vectorSearchNodes(db, { memoryIds: [mem], queryEmbedding: query(), limit: 3, candidateFactor }));
    expect(annSeen((await run(10)).sql)).toBe(true);
    expect(annSeen((await run(Math.ceil(VECTOR_ANN_MAX_K / 3) + 10)).sql)).toBe(false);
  });
  it('Byron P2-1: a page deeper than the index horizon issues NO ANN statement, only the exact one', async () => {
    setVectorSmallScopeRowsForTests(0);
    const annSeen = (sql: string[]) => sql.some((q) => q.includes('ORDER BY ne.embedding <=>'));
    const deep = await traced(0, () => vectorSearchNodes(db, { memoryIds: [mem], queryEmbedding: query(), limit: VECTOR_INDEX_ORDER_WINDOW + 1 }));
    expect(annSeen(deep.sql)).toBe(false);
    expect(deep.sql.some((q) => q.includes('MATERIALIZED'))).toBe(true);
    // ...and the page it returns IS the exact ranking (Charles M9): every eligible node, nearest first (4 decoys at distance 0, then the 3 targets).
    const ids = (await vectorSearchNodes(db, { memoryIds: [mem], queryEmbedding: query(), limit: VECTOR_INDEX_ORDER_WINDOW + 1 })).map((h) => h.nodeId);
    expect(ids).toHaveLength(7);
    expect(new Set(ids.slice(0, 4))).toEqual(new Set(decoys));
    expect(new Set(ids.slice(4))).toEqual(new Set(targets));
    const shallow = await traced(0, () => vectorSearchNodes(db, { memoryIds: [mem], queryEmbedding: query(), limit: 3 }));
    expect(annSeen(shallow.sql)).toBe(true); // control: the walk still serves a page inside the horizon
  });
  it('Bridget P3-1: the chunk path reports a complete result, not stopped_early, for a window past the cap over a smaller scope', async () => {
    setVectorWindowRowsMaxForTests(50);
    let w: any;
    const hits = await vectorSearchChunks(db, { memoryIds: [mem], queryEmbedding: query(), limit: 60, onWindow: (x) => { w = x; } });
    setVectorWindowRowsMaxForTests(null);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.length).toBeLessThan(50);
    expect(w.stoppedEarly).toBeFalsy();
    expect(w.exhausted).toBe(true);
  });
  it('Charles N2/N3: the comment-thread (COMMENTS) rankings report a complete result past the cap too, nodes and chunks', async () => {
    setVectorWindowRowsMaxForTests(50);
    const wn: any[] = []; const wc: any[] = [];
    await vectorSearchNodes(db, { memoryIds: [mem], queryEmbedding: query(), limit: 60, scope: 'COMMENTS', onWindow: (x) => wn.push(x) });
    await vectorSearchChunks(db, { memoryIds: [mem], queryEmbedding: query(), limit: 60, scope: 'COMMENTS', onWindow: (x) => wc.push(x) });
    setVectorWindowRowsMaxForTests(null);
    for (const w of [wn[0], wc[0]]) { expect(w.stoppedEarly).toBeFalsy(); expect(w.exhausted).toBe(true); }
  });
});
