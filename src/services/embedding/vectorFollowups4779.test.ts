/**
 * #4779 — vector search follow-ups from #4665 (#2772), at the vector-statement layer (`vectors.ts`):
 * - P2-2: one search opens ONE interactive transaction (one pooled connection, one `maxWait`), and a pool wait (P2028
 *   before the transaction starts) is told apart from the budget by phase, not by message text (Bridget P3-2 on #4665).
 * - P3-3: ANN-served pages are in the exact statement's total order among equal distances, chunk and node paths.
 * - P3-6: the COMMENTS scope runs under the work budget, and a deleted comment never ranks whatever the filter says.
 * - Bridget P3-2 (#4665): a result of exactly the window's size is complete, not `stopped_early`, in every branch.
 * - Riana P3-5 (#4665): the ANN widening ceiling's numeric boundary (k == ceiling is still walked).
 * - Byron round 4 (#4665): a deep page whose exact statement times out is an empty, flagged page.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { PrismaClient, Prisma } from '../../generated/prisma/index.js';
import { cleanDb, createDbOrgAndGraph } from '../../test/helpers.js';
import { generateId } from '../../lib/id.js';
import * as vectors from './vectors.js';
import { resolvers, type Context } from '../../api/graphql/schema/resolvers.js';
import {
  isStatementTimeout, setIterativeScanSupportForTests, setVectorSmallScopeRowsForTests, setVectorWindowRowsMaxForTests,
  vectorSearchChunks, vectorSearchNodes,
} from './vectors.js';

const DIM = 768;
const unit = (i: number) => { const v = new Array(DIM).fill(0); v[i] = 1; return v; };
const lit = (v: number[]) => `'[${v.join(',')}]'::vector`;
const q = unit(1);

type Seen = { sql: string; args: unknown[]; inTx: boolean };
/** A handle that records every raw statement (inside or outside a transaction), every transaction opened, and can fail one. */
function recorder(fail?: (sql: string) => unknown) {
  const seen: Seen[] = [];
  const sets: string[] = [];
  let txCount = 0;
  const wrapQuery = (target: any, inTx: boolean) => (s: TemplateStringsArray, ...a: unknown[]) => {
    const sql = s.join('?');
    seen.push({ sql, args: a, inTx });
    const err = fail?.(sql);
    if (err) return Promise.reject(err);
    return target.$queryRaw(s, ...a);
  };
  const handle = new Proxy(db, { get(t, p) {
    const v = Reflect.get(t, p);
    if (p === '$queryRaw') return wrapQuery(t, false);
    if (p !== '$transaction') return typeof v === 'function' ? v.bind(t) : v;
    return (arg: unknown, o?: unknown) => {
      if (typeof arg !== 'function') return (t.$transaction as any)(arg, o);
      txCount++;
      return (t.$transaction as any)(async (tx: any) => (arg as (x: unknown) => unknown)(new Proxy(tx, { get(tt, pp) {
        const vv = Reflect.get(tt, pp);
        if (pp === '$queryRaw') return wrapQuery(tt, true);
        if (pp === '$executeRawUnsafe') return (sql: string, ...a: unknown[]) => { sets.push(sql); return (vv as any).call(tt, sql, ...a); };
        return typeof vv === 'function' ? vv.bind(tt) : vv;
      } })), o);
    };
  } }) as typeof db;
  return { handle, seen, sets, tx: () => txCount };
}
const timeoutErr = () => Object.assign(new Error('canceling statement due to statement timeout'), { meta: { code: '57014' } });
const isAnn = (s: Seen) => !s.sql.includes('MATERIALIZED') && !s.sql.includes('count(*)::int AS n') && !s.sql.includes('GROUP BY ne.node_id');

let tieMem: string; // 60 content nodes, one chunk vector each, ALL on the query (every distance ties)
let tieIds: string[];
let wideMem: string; // node A: 200 chunks nearest the query; node B: one chunk further away
let winMem: string; // exactly 6 content nodes + 6 comments, distinct distances
let winCommentIds: string[];
let deletedCommentId: string;

async function indexed(name: string): Promise<string> {
  const made = await createDbOrgAndGraph(db, { orgName: `r4779-${name}`, graphName: `r4779/${name}` });
  await db.memory.update({ where: { id: made.graph.id }, data: { vectorIndexEnabled: true, embeddingSource: 'contentChunks' } });
  return made.graph.id;
}
async function vec(mem: string, nodeId: string, idx: number, v: string): Promise<void> {
  await db.$executeRawUnsafe(`
    INSERT INTO node_embeddings (id, node_id, memory_id, kind, provider, model, dim, chunk_index, char_start, char_end, chunk_text, embedding, created_at)
    VALUES ('${generateId()}', '${nodeId}', '${mem}', 'chunk', 'test', 'stub', ${DIM}, ${idx}, 0, 4, 'body', ${v}, now())`);
}

beforeAll(async () => {
  await cleanDb(db);
  // Ties: ids inserted in REVERSE order, so physical (and any scan) order is not the id order the exact statement uses.
  tieMem = await indexed('ties');
  tieIds = Array.from({ length: 60 }, () => generateId()).sort();
  for (const id of tieIds.slice().reverse()) {
    await db.node.create({ data: { id, memoryId: tieMem, loc: `t-${id}`, name: 't', content: 'body' } });
    await vec(tieMem, id, 0, lit(q));
  }
  wideMem = await indexed('wide');
  const a = generateId(); const b = generateId();
  await db.node.createMany({ data: [{ id: a, memoryId: wideMem, loc: 'a', name: 'a', content: 'body' }, { id: b, memoryId: wideMem, loc: 'b', name: 'b', content: 'body' }] });
  await db.$executeRawUnsafe(`
    INSERT INTO node_embeddings (id, node_id, memory_id, kind, provider, model, dim, chunk_index, char_start, char_end, chunk_text, embedding, created_at)
    SELECT md5('${a}' || g), '${a}', '${wideMem}', 'chunk', 'test', 'stub', ${DIM}, g, 0, 4, 'body', ${lit(q)}, now() FROM generate_series(0, 199) g`);
  const far = q.slice(); far[2] = 1; // further than every A chunk
  await vec(wideMem, b, 0, lit(far));
  // Window: distinct distances (cos to q decreasing with i) for 6 content nodes and 6 comments (made by the comment
  // path, which the comment invariants require), plus one deleted comment whose vector is the nearest of all.
  const M = resolvers.Mutation as any;
  const org = await db.organization.create({ data: { id: generateId(), name: 'R4779', urn: `r4779-${generateId()}.test` } });
  const userId = (await db.user.create({ data: { handle: `r4779-${generateId()}` } })).id;
  await db.orgMember.create({ data: { organizationId: org.id, userId, role: 'ADMIN' } });
  const ctx = (): Context => ({ db, userId, roles: [] });
  winMem = (await M.createMemory(null, { orgRef: org.id, name: 'r4779-win' }, ctx())).id;
  const at = (i: number) => { const v = q.slice(); v[3] = i * 0.1; return lit(v); };
  const content: string[] = [];
  for (let i = 0; i < 6; i++) {
    const id = generateId();
    content.push(id);
    await db.node.create({ data: { id, memoryId: winMem, loc: `w${i}`, name: 'w', content: 'body' } });
    await vec(winMem, id, 0, at(i + 1));
  }
  winCommentIds = [];
  for (let i = 0; i < 6; i++) {
    const c = await M.createComment(null, { targetRef: content[i], body: `comment ${i}` }, ctx());
    winCommentIds.push(c.id);
    await db.$executeRawUnsafe(`DELETE FROM node_embeddings WHERE node_id = '${c.id}'`);
    await vec(winMem, c.id, 0, at(i + 1));
  }
  // Its own target (one open thread per author per node), with no vector, so the content set stays 6.
  const deadTarget = generateId();
  await db.node.create({ data: { id: deadTarget, memoryId: winMem, loc: 'w-dead', name: 'w', content: 'body' } });
  await db.$executeRawUnsafe(`DELETE FROM node_embeddings WHERE node_id = '${deadTarget}'`);
  const dead = await M.createComment(null, { targetRef: deadTarget, body: 'to be deleted' }, ctx());
  deletedCommentId = dead.id;
  await M.deleteCommentThread(null, { commentRef: dead.id, reason: 'r4779 deleted comment' }, ctx());
  expect((await db.node.findUniqueOrThrow({ where: { id: dead.id } })).deletedAt).not.toBeNull();
  await db.$executeRawUnsafe(`DELETE FROM node_embeddings WHERE node_id = '${dead.id}'`);
  await vec(winMem, dead.id, 0, lit(q));
}, 180_000);

afterEach(() => {
  setIterativeScanSupportForTests(null);
  setVectorSmallScopeRowsForTests(null);
  setVectorWindowRowsMaxForTests(null);
  (vectors as any).setVectorAnnMaxKForTests?.(null);
  delete process.env.VECTOR_SEARCH_TIMEOUT_MS;
});
afterAll(() => { setIterativeScanSupportForTests(null); });

describe('#4779 P2-2: one interactive transaction per search', () => {
  it('a large-scope search (count, ANN widenings, exact) opens exactly ONE transaction', async () => {
    setIterativeScanSupportForTests(true);
    setVectorSmallScopeRowsForTests(1); // the 2 nodes / 201 vectors are a LARGE scope: count, then the walk
    const r = recorder();
    const hits = await vectorSearchNodes(r.handle, { memoryIds: [wideMem], queryEmbedding: q, limit: 2, candidateFactor: 1 });
    expect(hits).toHaveLength(2);
    expect(r.seen.filter(isAnn).length).toBeGreaterThanOrEqual(2); // it widened at least once
    expect(r.seen.every((s) => s.inTx)).toBe(true);
    expect(r.tx()).toBe(1);
    // statement_timeout is re-issued before every statement of the shared transaction.
    expect(r.sets.filter((s) => s.startsWith('SET LOCAL statement_timeout')).length).toBe(r.seen.length);
  }, 60_000);

  it('a small-scope search (count, exact) opens exactly ONE transaction', async () => {
    setIterativeScanSupportForTests(true);
    const r = recorder();
    await vectorSearchNodes(r.handle, { memoryIds: [winMem], queryEmbedding: q, limit: 3 });
    expect(r.seen).toHaveLength(2);
    expect(r.tx()).toBe(1);
  }, 60_000);

  it('P2028 is classified by phase, not message text: before the callback ran = pool wait (error), inside = the budget', () => {
    const poolWait = { code: 'P2028', message: 'Transaction API error: Transaction already closed: could not acquire' };
    const clock = { code: 'P2028', message: 'Transaction API error: Unable to start a transaction in the given time.' };
    expect(isStatementTimeout(poolWait, 'waiting')).toBe(false);
    expect(isStatementTimeout(clock, 'running')).toBe(true);
  });

  it('a pool wait that expires before the transaction starts is an error, never stopped_early', async () => {
    setIterativeScanSupportForTests(true);
    const fake = new Proxy(db, { get(t, p) {
      if (p === '$transaction') return () => Promise.reject(Object.assign(new Error('Transaction API error: Transaction already closed'), { code: 'P2028' }));
      const v = Reflect.get(t, p);
      return typeof v === 'function' ? v.bind(t) : v;
    } }) as typeof db;
    const windows: unknown[] = [];
    await expect(vectorSearchNodes(fake, { memoryIds: [winMem], queryEmbedding: q, limit: 3, onWindow: (w) => windows.push(w) })).rejects.toMatchObject({ code: 'P2028' });
    expect(windows).toEqual([]);
  });

  it('load: concurrent shallow and deep searches on a 2-connection pool all complete (no P2028)', async () => {
    setIterativeScanSupportForTests(true);
    setVectorSmallScopeRowsForTests(10); // tieMem (60 vectors) is a large scope: shallow pages walk, deep ones rank exactly
    const url = new URL(process.env.DATABASE_URL!);
    url.searchParams.set('connection_limit', '2');
    const small = new PrismaClient({ datasources: { db: { url: url.toString() } } });
    try {
      const runs = Array.from({ length: 24 }, (_, i) => i % 2
        ? vectorSearchNodes(small, { memoryIds: [tieMem], queryEmbedding: q, limit: 1100 }) // deep: past the order window
        : vectorSearchNodes(small, { memoryIds: [tieMem], queryEmbedding: q, limit: 10 }));
      const res = await Promise.allSettled(runs);
      expect(res.filter((r) => r.status === 'rejected')).toEqual([]);
      for (const [i, r] of res.entries()) expect((r as PromiseFulfilledResult<unknown[]>).value).toHaveLength(i % 2 ? 60 : 10);
    } finally { await small.$disconnect(); }
  }, 120_000);
});

describe('#4779 P3-3: ANN pages are in total order among ties', () => {
  it('node path: every walked page equals the exact order (distance, node_id)', async () => {
    setIterativeScanSupportForTests(true);
    setVectorSmallScopeRowsForTests(5);
    for (const limit of [5, 10, 25]) {
      const r = recorder();
      const hits = await vectorSearchNodes(r.handle, { memoryIds: [tieMem], queryEmbedding: q, limit, candidateFactor: 1 });
      expect(r.seen.some(isAnn)).toBe(true); // served by the walk, not the exact statement
      expect(hits.map((h) => h.nodeId)).toEqual(tieIds.slice(0, limit));
    }
  }, 60_000);

  it('chunk path: every walked page equals the exact order (distance, node_id, chunk_index)', async () => {
    setIterativeScanSupportForTests(true);
    setVectorSmallScopeRowsForTests(5);
    for (const limit of [5, 10, 25]) {
      const hits = await vectorSearchChunks(db, { memoryIds: [tieMem], queryEmbedding: q, limit });
      expect(hits.map((h) => h.nodeId)).toEqual(tieIds.slice(0, limit));
    }
  }, 60_000);
});

describe('#4779 Riana P3-5: the ANN ceiling boundary', () => {
  it('k equal to the ceiling is still walked; only k past it hands over to the exact statement', async () => {
    setIterativeScanSupportForTests(true);
    setVectorSmallScopeRowsForTests(1);
    (vectors as any).setVectorAnnMaxKForTests(32);
    const r = recorder();
    // need 2 distinct nodes, k0 = 2: k = 2, 8, 32 (== ceiling, walked), then 128 > ceiling => exact.
    const hits = await vectorSearchNodes(r.handle, { memoryIds: [wideMem], queryEmbedding: q, limit: 2, candidateFactor: 1 });
    expect(hits).toHaveLength(2);
    expect(r.seen.filter(isAnn).map((s) => Number(s.args.at(-1)))).toEqual([2, 8, 32]);
    expect(r.seen.some((s) => s.sql.includes('MATERIALIZED'))).toBe(true);
  }, 60_000);
});

describe('#4779 P3-6: the COMMENTS scope', () => {
  for (const [name, run] of [
    ['node', (h: typeof db, w: (x: any) => void) => vectorSearchNodes(h, { memoryIds: [winMem], queryEmbedding: q, limit: 3, scope: 'COMMENTS', onWindow: w })],
    ['chunk', (h: typeof db, w: (x: any) => void) => vectorSearchChunks(h, { memoryIds: [winMem], queryEmbedding: q, limit: 3, scope: 'COMMENTS', onWindow: w })],
  ] as const) {
    it(`${name}: the statement runs inside a budgeted transaction`, async () => {
      const r = recorder();
      process.env.VECTOR_SEARCH_TIMEOUT_MS = '4321';
      const hits = await run(r.handle, () => undefined);
      expect(hits).toHaveLength(3);
      expect(r.seen.every((s) => s.inTx)).toBe(true);
      expect(Number(/statement_timeout = (\d+)/.exec(r.sets.find((s) => s.includes('statement_timeout')) ?? '')?.[1])).toBeLessThanOrEqual(4321);
    }, 60_000);

    it(`${name}: a timeout is the early stop, never an error`, async () => {
      const r = recorder(() => timeoutErr());
      const windows: any[] = [];
      expect(await run(r.handle, (w) => windows.push(w))).toEqual([]);
      expect(windows.at(-1)).toMatchObject({ stoppedEarly: true, exhausted: false });
    }, 60_000);
  }

  it('a deleted comment never ranks, even when the filter fragment carries no deleted predicate (includeDeleted)', async () => {
    const noDeletedRule = Prisma.sql`AND ne.node_id IN (SELECT id FROM nodes WHERE memory_id IN (${winMem}))`;
    const nodes = await vectorSearchNodes(db, { memoryIds: [winMem], queryEmbedding: q, limit: 20, scope: 'COMMENTS', filterSql: noDeletedRule });
    const chunks = await vectorSearchChunks(db, { memoryIds: [winMem], queryEmbedding: q, limit: 20, scope: 'COMMENTS', filterSql: noDeletedRule });
    expect(nodes.map((h) => h.nodeId)).toEqual(winCommentIds);
    expect(chunks.map((h) => h.nodeId)).toEqual(winCommentIds);
  }, 60_000);
});

describe('#4779 Bridget P3-2: a result of exactly the window size is complete', () => {
  const cases = [
    ['node content', (w: (x: any) => void, limit: number) => vectorSearchNodes(db, { memoryIds: [winMem], queryEmbedding: q, limit, scope: 'CONTENT', onWindow: w })],
    ['chunk content', (w: (x: any) => void, limit: number) => vectorSearchChunks(db, { memoryIds: [winMem], queryEmbedding: q, limit, scope: 'CONTENT', onWindow: w })],
    ['node comments', (w: (x: any) => void, limit: number) => vectorSearchNodes(db, { memoryIds: [winMem], queryEmbedding: q, limit, scope: 'COMMENTS', onWindow: w })],
    ['chunk comments', (w: (x: any) => void, limit: number) => vectorSearchChunks(db, { memoryIds: [winMem], queryEmbedding: q, limit, scope: 'COMMENTS', onWindow: w })],
  ] as const;
  for (const [name, run] of cases) {
    it(`${name}: 6 eligible, window 6, limit 50 => 6 hits, complete, not stopped_early`, async () => {
      setVectorWindowRowsMaxForTests(6);
      const windows: any[] = [];
      expect(await run((w) => windows.push(w), 50)).toHaveLength(6);
      expect(windows.at(-1)).toMatchObject({ exhausted: true, stoppedEarly: false });
    }, 60_000);
    it(`${name}: 6 eligible, window 5, limit 50 => 5 hits, stopped_early (a row past the window exists)`, async () => {
      setVectorWindowRowsMaxForTests(5);
      const windows: any[] = [];
      expect(await run((w) => windows.push(w), 50)).toHaveLength(5);
      expect(windows.at(-1)).toMatchObject({ exhausted: false, stoppedEarly: true });
    }, 60_000);
  }
});

describe('#4779 Byron round 4: a deep page whose exact statement times out', () => {
  it('returns an empty page flagged stopped_early, and never walks the index first', async () => {
    setIterativeScanSupportForTests(true);
    setVectorSmallScopeRowsForTests(5);
    const r = recorder((sql) => (sql.includes('MATERIALIZED') ? timeoutErr() : undefined));
    const windows: any[] = [];
    const hits = await vectorSearchNodes(r.handle, { memoryIds: [tieMem], queryEmbedding: q, limit: 1100, onWindow: (w) => windows.push(w) });
    expect(hits).toEqual([]);
    expect(windows.at(-1)).toMatchObject({ stoppedEarly: true, exhausted: false });
    expect(r.seen.some(isAnn)).toBe(false);
  }, 60_000);
});
