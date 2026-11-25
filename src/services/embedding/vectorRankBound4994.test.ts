/**
 * #4994 — the cost of the hybrid vector-rank lookup (`vectorRanksOf`) is bounded: a LARGE scope is no longer ranked
 * whole on every call (a small one, at most `vectorSmallScopeRows()`, still is). The lookup reads the page's own vector
 * ranking to a fixed depth (1000 nodes). A node found there has its
 * rank; a node that has an eligible vector but lies past the depth is only bounded, so the lookup reports it stopped early
 * (cor:api:090:04: never a certified page); a node with no eligible vector is still absent, a term of exactly zero.
 *
 * Parity is with `vectorSearchNodes` (distance, then node id) over the same eligibility. The fixture's large memory has
 * 1006 vectors with equidistant rows across the depth boundary.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb, createDbOrgAndGraph } from '../../test/helpers.js';
import { generateId } from '../../lib/id.js';
import { getRetrievalProvider } from '../../lib/retrieval/postgres.js';
import type { VectorSearchOpts } from '../../lib/retrieval/provider.js';
import { setVectorSmallScopeRowsForTests } from './vectors.js';
import { resolvers, type Context } from '../../api/graphql/schema/resolvers.js';

const DIM = 768;
const q = (() => { const v = new Array(DIM).fill(0); v[1] = 1; return v; })();
const provider = getRetrievalProvider();

const TOTAL = 1006;
/** 1-based vector position → node id. Positions 998..1003 are equidistant, so node id alone orders them. */
const at = (pos: number) => `r4994-${String(pos).padStart(5, '0')}`;
const TIED_FROM = 998;
const TIED_TO = 1003;
const NO_VECTOR = 'r4994-novector';

let big: string;
let comments: string;
const commentIds: string[] = [];

type Seen = string[];
/** A handle that records every tagged raw statement run inside a transaction, and can fail the ones `fail` picks. */
function recorder(fail?: (sql: string) => unknown) {
  const seen: Seen = [];
  const handle = new Proxy(db, { get(t, p) {
    const v = Reflect.get(t, p);
    if (p !== '$transaction') return typeof v === 'function' ? v.bind(t) : v;
    return (arg: unknown, o?: unknown) => typeof arg !== 'function' ? (t.$transaction as any)(arg, o)
      : (t.$transaction as any)(async (tx: any) => (arg as (x: unknown) => unknown)(new Proxy(tx, { get(tt, pp) {
          const vv = Reflect.get(tt, pp);
          if (pp !== '$queryRaw') return typeof vv === 'function' ? vv.bind(tt) : vv;
          return (s: TemplateStringsArray, ...a: unknown[]) => {
            if (!Array.isArray(s)) return (tt as any).$queryRaw(s, ...a); // the version probe passes a Prisma.Sql
            const sql = s.join('?');
            seen.push(sql);
            const err = fail?.(sql);
            return err ? Promise.reject(err) : (tt as any).$queryRaw(s, ...a);
          };
        } })), o);
  } }) as typeof db;
  return { handle, seen };
}

const opts = (extra: Partial<VectorSearchOpts> = {}) => ({ db, queryEmbedding: q, memoryIds: [big], ...extra });
const lookup = (nodeIds: string[], extra: Partial<VectorSearchOpts> = {}) => provider.vectorRanks({ ...opts(extra), nodeIds });
const page = (extra: Partial<VectorSearchOpts> = {}, limit = 1000) => provider.vectorSearch({ ...opts(extra), limit });

beforeAll(async () => {
  await cleanDb(db);
  const made = await createDbOrgAndGraph(db, { orgName: 'r4994-org', graphName: 'r4994/big' });
  big = made.graph.id;
  await db.memory.update({ where: { id: big }, data: { vectorIndexEnabled: true, embeddingSource: 'contentChunks' } });
  const positions = Array.from({ length: TOTAL }, (_, i) => i + 1);
  // Inserted in REVERSE, so scan order is never the node-id order the tie-break uses.
  await db.node.createMany({ data: [...positions].reverse().map((p) => ({ id: at(p), memoryId: big, loc: `n-${String(p).padStart(5, '0')}`, name: 'n', content: 'body' })) });
  await db.node.create({ data: { id: NO_VECTOR, memoryId: big, loc: 'no-vector', name: 'n', content: 'body' } });
  const rows = [...positions].reverse().map((p) => {
    const v = [...q];
    v[3] = (p >= TIED_FROM && p <= TIED_TO ? TIED_FROM : p) * 0.001;
    return `('${generateId()}', '${at(p)}', '${big}', 'chunk', 'test', 'stub', ${DIM}, 0, 0, 4, 'body', '[${v.join(',')}]'::vector, now())`;
  });
  await db.$executeRawUnsafe(`INSERT INTO node_embeddings (id, node_id, memory_id, kind, provider, model, dim, chunk_index, char_start, char_end, chunk_text, embedding, created_at) VALUES ${rows.join(',')}`);
  await db.$executeRawUnsafe('ANALYZE node_embeddings');

  // Four content nodes, each with one comment made through the comment path (which the comment invariants require);
  // distances alternate, content and comment.
  const org = await db.organization.create({ data: { id: generateId(), name: 'R4994C', urn: `r4994-${generateId()}.test` } });
  const userId = (await db.user.create({ data: { handle: `r4994-${generateId()}` } })).id;
  await db.orgMember.create({ data: { organizationId: org.id, userId, role: 'ADMIN' } });
  const ctx = { db, userId, roles: [] } as Context;
  comments = (await (resolvers.Mutation as any).createMemory(null, { orgRef: org.id, name: 'r4994-com' }, ctx)).id;
  await db.memory.update({ where: { id: comments }, data: { vectorIndexEnabled: true, embeddingSource: 'contentChunks' } });
  const vecAt = async (nodeId: string, rank: number) => {
    const v = [...q]; v[3] = rank * 0.05;
    await db.$executeRawUnsafe(`DELETE FROM node_embeddings WHERE node_id = '${nodeId}'`);
    await db.$executeRawUnsafe(`INSERT INTO node_embeddings (id, node_id, memory_id, kind, provider, model, dim, chunk_index, char_start, char_end, chunk_text, embedding, created_at)
      VALUES ('${generateId()}', '${nodeId}', '${comments}', 'chunk', 'test', 'stub', ${DIM}, 0, 0, 4, 'body', '[${v.join(',')}]'::vector, now())`);
  };
  for (let i = 0; i < 4; i++) {
    const id = generateId();
    await db.node.create({ data: { id, memoryId: comments, loc: `c-${i}`, name: 'c', content: 'body' } });
    await vecAt(id, 2 * i + 1);
    const c = await (resolvers.Mutation as any).createComment(null, { targetRef: id, body: `comment ${i}` }, ctx);
    commentIds.push(c.id);
    await vecAt(c.id, 2 * i + 2);
  }
}, 120_000);

afterEach(() => { setVectorSmallScopeRowsForTests(null); delete process.env.VECTOR_SEARCH_TIMEOUT_MS; });
afterAll(async () => { await cleanDb(db); });

describe('#4994: the rank lookup is bounded', () => {
  it('a LARGE scope is never ranked whole: no unbounded ROW_NUMBER over the eligible set', async () => {
    setVectorSmallScopeRowsForTests(5);
    const r = recorder();
    const res = await provider.vectorRanks({ ...opts(), db: r.handle, nodeIds: [at(1), at(40)] });
    expect(Object.fromEntries(res.ranks)).toEqual({ [at(1)]: 1, [at(40)]: 40 });
    expect(res.stoppedEarly).toBe(false);
    expect(r.seen.filter((s) => s.includes('count(*)::int AS n'))).toHaveLength(1); // the large-scope path, counted once
    expect(r.seen.filter((s) => /ROW_NUMBER|MATERIALIZED/.test(s))).toEqual([]);
  }, 60_000);

  it('a node past the depth is only bounded: no rank, stoppedEarly, and the ranks inside the depth stand', async () => {
    setVectorSmallScopeRowsForTests(5);
    const res = await lookup([at(3), at(1006)]);
    expect(Object.fromEntries(res.ranks)).toEqual({ [at(3)]: 3 });
    expect(res.stoppedEarly).toBe(true);
  }, 60_000);

  it('equidistant nodes across the depth boundary rank by node id, as the page does', async () => {
    setVectorSmallScopeRowsForTests(5);
    const hits = await page();
    expect(hits.map((h) => h.nodeId).slice(TIED_FROM - 1)).toEqual([at(998), at(999), at(1000)]);
    const inside = await lookup([at(998), at(999), at(1000)]);
    expect(Object.fromEntries(inside.ranks)).toEqual({ [at(998)]: 998, [at(999)]: 999, [at(1000)]: 1000 });
    expect(inside.stoppedEarly).toBe(false);
    // Same distance, larger id: rank 1001, one past the depth.
    const past = await lookup([at(1001)]);
    expect(past.ranks.size).toBe(0);
    expect(past.stoppedEarly).toBe(true);
  }, 60_000);

  it('a node with NO eligible vector is absent, and that is not an early stop even in a scope past the depth', async () => {
    setVectorSmallScopeRowsForTests(5);
    const res = await lookup([at(2), NO_VECTOR, 'r4994-not-a-node']);
    expect(Object.fromEntries(res.ranks)).toEqual({ [at(2)]: 2 });
    expect(res.stoppedEarly).toBe(false);
  }, 60_000);

  it('a SMALL scope keeps the exact whole ranking: no depth, every rank exact however deep', async () => {
    const res = await lookup([at(3), at(1001), at(1006), NO_VECTOR]);
    expect(Object.fromEntries(res.ranks)).toEqual({ [at(3)]: 3, [at(1001)]: 1001, [at(1006)]: 1006 });
    expect(res.stoppedEarly).toBe(false);
  }, 60_000);

  it('the threshold is inclusive: exactly that many vectors is exact; one more is read to the depth', async () => {
    setVectorSmallScopeRowsForTests(TOTAL);
    const atThreshold = await lookup([at(1006)]);
    expect(Object.fromEntries(atThreshold.ranks)).toEqual({ [at(1006)]: 1006 });
    expect(atThreshold.stoppedEarly).toBe(false);
    setVectorSmallScopeRowsForTests(TOTAL - 1);
    const r = recorder();
    const over = await provider.vectorRanks({ ...opts(), db: r.handle, nodeIds: [at(1006)] });
    expect(over).toEqual({ ranks: new Map(), stoppedEarly: true });
    expect(r.seen.filter((s) => /ROW_NUMBER|MATERIALIZED/.test(s))).toEqual([]);
  }, 60_000);

  it('the small scope\'s exact ranking cut by the budget is stoppedEarly, and is not kept', async () => {
    const memo = {};
    const r = recorder((s) => (s.includes('ROW_NUMBER') ? Object.assign(new Error('canceling statement due to statement timeout'), { meta: { code: '57014' } }) : undefined));
    expect(await provider.vectorRanks({ ...opts(), db: r.handle, nodeIds: [at(1)], memo })).toEqual({ ranks: new Map(), stoppedEarly: true });
    expect(memo).toEqual({});
  }, 60_000);

  it('the size count runs under the budget too: a timeout there is stoppedEarly with no ranks', async () => {
    const r = recorder((s) => (s.includes('count(*)::int AS n') ? Object.assign(new Error('canceling statement due to statement timeout'), { meta: { code: '57014' } }) : undefined));
    expect(await provider.vectorRanks({ ...opts(), db: r.handle, nodeIds: [at(1)] })).toEqual({ ranks: new Map(), stoppedEarly: true });
  }, 60_000);

  for (const [name, smallScope] of [['large', 5], ['small', null]] as const) {
    it(`${name} scope: the lookups of one ranking share one computed ranking, and answer as unshared ones do`, async () => {
      if (smallScope !== null) setVectorSmallScopeRowsForTests(smallScope);
      const r = recorder();
      const memo = {};
      const ask = (nodeIds: string[]) => provider.vectorRanks({ ...opts(), db: r.handle, nodeIds, memo });
      const first = await ask([at(1), at(2)]);
      const statements = r.seen.length;
      expect(statements).toBeGreaterThan(0);
      const second = await ask([at(30), at(998)]);
      expect(r.seen.length).toBe(statements); // nothing more to run: every id is in the computed ranking
      expect(Object.fromEntries(first.ranks)).toEqual({ [at(1)]: 1, [at(2)]: 2 });
      expect(Object.fromEntries(second.ranks)).toEqual({ [at(30)]: 30, [at(998)]: 998 });
      const third = await ask([at(3), NO_VECTOR]);
      expect(Object.fromEntries(third.ranks)).toEqual({ [at(3)]: 3 });
      expect(third.stoppedEarly).toBe(false);
      expect(r.seen.length - statements).toBe(smallScope === null ? 0 : 1); // the large scope probes the missing node only
    }, 60_000);
  }

  it('a cut ranking is not kept: the next lookup computes it', async () => {
    setVectorSmallScopeRowsForTests(5);
    const memo = {};
    const r = recorder((s) => (s.includes('count(*)::int AS n') ? Object.assign(new Error('canceling statement due to statement timeout'), { meta: { code: '57014' } }) : undefined));
    expect((await provider.vectorRanks({ ...opts(), db: r.handle, nodeIds: [at(1)], memo })).stoppedEarly).toBe(true);
    const after = await provider.vectorRanks({ ...opts(), nodeIds: [at(1)], memo });
    expect(Object.fromEntries(after.ranks)).toEqual({ [at(1)]: 1 });
    expect(after.stoppedEarly).toBe(false);
  }, 60_000);

  it('a node the caller excluded, or the filter does not admit, is not "past the depth": it is absent', async () => {
    setVectorSmallScopeRowsForTests(5);
    const excluded = await lookup([at(1), at(2)], { excludeNodeIds: [at(1)] });
    expect(Object.fromEntries(excluded.ranks)).toEqual({ [at(2)]: 1 });
    expect(excluded.stoppedEarly).toBe(false);
    const candidates = await lookup([at(5), at(1006)], { candidateNodeIds: Array.from({ length: 1005 }, (_, i) => at(i + 1)) });
    expect(Object.fromEntries(candidates.ranks)).toEqual({ [at(5)]: 5 });
    expect(candidates.stoppedEarly).toBe(false);
  }, 60_000);

  it('a lookup the budget ends returns no rank at all', async () => {
    setVectorSmallScopeRowsForTests(5);
    const r = recorder((s) => (s.includes('LIMIT') && !s.includes('count(*)::int AS n') && s.includes('<=>') ? Object.assign(new Error('canceling statement due to statement timeout'), { meta: { code: '57014' } }) : undefined));
    const res = await provider.vectorRanks({ ...opts(), db: r.handle, nodeIds: [at(1)] });
    expect(res).toEqual({ ranks: new Map(), stoppedEarly: true });
  }, 60_000);

  it('the existence probe for a missing node runs under the budget too: a timeout there is stoppedEarly', async () => {
    setVectorSmallScopeRowsForTests(5);
    const r = recorder((s) => (s.includes('SELECT 1 AS present') ? Object.assign(new Error('canceling statement due to statement timeout'), { meta: { code: '57014' } }) : undefined));
    const res = await provider.vectorRanks({ ...opts(), db: r.handle, nodeIds: [at(2), NO_VECTOR] });
    expect(res.stoppedEarly).toBe(true);
    expect(Object.fromEntries(res.ranks)).toEqual({ [at(2)]: 2 });
  }, 60_000);
});

describe('#4994: parity with vectorSearchNodes across scopes, filters and exclusions', () => {
  for (const [name, extra] of [
    ['default (CONTENT)', {}],
    ['ALL', { contentScope: 'ALL' }],
    ['COMMENTS', { contentScope: 'COMMENTS' }],
    ['ALL + filter + exclusions', { contentScope: 'ALL', filter: { nodeTypes: ['comment', 'info'] } }],
  ] as const) {
    for (const [branch, smallScope] of [['exact', null], ['walked', 1]] as const)
    it(`${name}, ${branch}: every looked-up rank is the node's position in the search`, async () => {
      if (smallScope !== null) setVectorSmallScopeRowsForTests(smallScope);
      const base = { ...(extra as Partial<VectorSearchOpts>), memoryIds: [comments], ...(name.includes('exclusions') ? { excludeNodeIds: [commentIds[3]!] } : {}) };
      const hits = await page(base, 100);
      const all = (await db.node.findMany({ where: { memoryId: comments }, select: { id: true } })).map((n) => n.id);
      const res = await lookup(all, base);
      expect(hits.length).toBeGreaterThan(2);
      expect(Object.fromEntries(res.ranks)).toEqual(Object.fromEntries(hits.map((h, i) => [h.nodeId, i + 1])));
      expect(res.stoppedEarly).toBe(false);
    }, 60_000);
  }
});
