/**
 * #3541 slice A1, A2, A4, A5: tests-only hardening of the #3494 open-thread filter. No production change.
 * (A3, the forced ANN-shortfall fallback, lives in services/embedding/openThreadsFallback3541.test.ts.)
 *
 * Claims, and what they are not: these pin the filter and the summary field on small private-DB fixtures. They are not a
 * recall, load or latency test, and the filter, the `appNodes` refusal and `oldestOpenThreadAt` stay Proposed
 * (cor:api:090:02); a pin here does not make them Decided.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApolloServer } from '@apollo/server';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { postgresRetrievalProvider as provider } from '../../../lib/retrieval/postgres.js';
import { typeDefs } from './typeDefs.js';
import { resolvers, type Context } from './resolvers.js';
import { setEmbeddingClientForTests, resetEmbeddingClientForTests } from '../../../lib/embedding/index.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
const Q = resolvers.Query as any, M = resolvers.Mutation as any;
const server = new ApolloServer<Context>({ typeDefs, resolvers });

let orgId: string, memoryId: string;
let users: string[];
const ctx = (id: string): Context => ({ db, userId: id, roles: [] });
const author = () => users[0]!;
const mk = (loc: string, extra: Record<string, unknown> = {}) =>
  db.node.create({ data: { id: generateId(), memoryId, loc, name: `m3541 ${loc}`, content: 'sparsemark3541', ...extra } });
const comment = (targetRef: string, by = author()) => M.createComment(null, { targetRef, body: 'thread' }, ctx(by));

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), name: 'T3541', urn: `t3541-${generateId()}.test` } });
  orgId = org.id;
  users = await Promise.all([0, 1, 2].map(async (i) => (await db.user.create({ data: { handle: `t3541-${i}-${generateId()}` } })).id));
  await db.orgMember.createMany({ data: users.map((userId) => ({ organizationId: org.id, userId, role: 'ADMIN' as const })) });
  memoryId = (await M.createMemory(null, { orgId, name: 't3541' }, ctx(author()))).id;
});
afterEach(() => { resetEmbeddingClientForTests(); vi.unstubAllEnvs(); });

const AXIS = 1;
/** One unit vector on `AXIS`: every fixture vector is identical, so rank never decides a case (the filter does). */
const axisLiteral = () => `[${Array.from({ length: 768 }, (_, i) => (i === AXIS ? 1 : 0)).join(',')}]`;
/** One chunk vector per node, written in SQL, so a missing embedding can never make a refusal pass. */
async function embedAll(ids: string[]) {
  for (const id of ids) {
    await db.$executeRawUnsafe(
      `INSERT INTO node_embeddings (id, node_id, memory_id, kind, provider, model, dim, chunk_index, char_start, char_end, chunk_text, embedding, created_at)
       SELECT $1, n.id, n.memory_id, 'chunk', 'test', 'fixture-3541', 768, 0, 0, 4, 'body', '${axisLiteral()}'::vector, now() FROM nodes n WHERE n.id = $2`,
      `emb-${id}`, id,
    );
  }
}

// ───────────────────────── A1 ─────────────────────────
describe('A1: sparse lexical/regex admission happens before the page', () => {
  /** `eight` wrong-state rows sort BEFORE `three` eligible ones (loc a0..a7, then b0..b2). */
  async function fixture(prefix: string, wrongHasThread: boolean) {
    const wrong: string[] = [], right: string[] = [];
    for (let i = 0; i < 8; i++) { const n = await mk(`${prefix}:a${i}`); wrong.push(n.id); if (wrongHasThread) await comment(n.id); }
    for (let i = 0; i < 3; i++) { const n = await mk(`${prefix}:b${i}`); right.push(n.id); if (!wrongHasThread) await comment(n.id); }
    return { wrong, right };
  }
  const base = (prefix: string, value: boolean | null) => ({ hasOpenThreads: value, locPrefix: `${prefix}:` } as any);
  const hitsOf = (rows: Array<{ nodeId: string }>) => rows.map((h) => h.nodeId);

  for (const [value, prefix, wrongHasThread] of [[true, 't', false], [false, 'f', true]] as const) {
    it(`hasOpenThreads ${value}: limit 2, offset 1 returns the 2nd and 3rd eligible row, with every wrong-state row ahead of the page`, async () => {
      const { wrong, right } = await fixture(prefix, wrongHasThread);
      const common = { db, memoryIds: [memoryId], limit: 2, offset: 1, sort: 'loc' as const };
      // Precondition: unfiltered, the first eight rows in loc order ARE the wrong-state ones, so a page that is
      // cut before the predicate would be filled (or emptied) by them.
      const unfiltered = await provider.lexicalSearch({ ...common, limit: 8, offset: 0, filter: base(prefix, null), query: 'sparsemark3541' });
      expect(hitsOf(unfiltered)).toEqual(wrong);
      const unfilteredRx = await provider.regexSearch({ ...common, limit: 8, offset: 0, filter: base(prefix, null), pattern: 'sparsemark3541' });
      expect(hitsOf(unfilteredRx)).toEqual(wrong);

      const expected = right.slice(1);
      expect(hitsOf(await provider.lexicalSearch({ ...common, filter: base(prefix, value), query: 'sparsemark3541' }))).toEqual(expected);
      expect(hitsOf(await provider.regexSearch({ ...common, filter: base(prefix, value), pattern: 'sparsemark3541' }))).toEqual(expected);

      for (const mode of ['keyword', 'regex'] as const) {
        const out = await Q.findNodes(null, { query: 'sparsemark3541', mode, sort: 'LOC', limit: 2, offset: 1, includeTotal: true, filter: { memoryIds: [memoryId], locPrefix: `${prefix}:`, hasOpenThreads: value } }, ctx(author()));
        expect(out.hits.map((h: any) => h.node.id), mode).toEqual(expected);
        expect(out.total, `${mode} keeps total null`).toBeNull();
      }
    });
  }
});

describe('#3675: a soft-deleted whole thread and an offset past the end, on lexical and regex', () => {
  const sq = (prefix: string, value: boolean | null) => ({ hasOpenThreads: value, locPrefix: `${prefix}:` } as any);
  const idsOf = (rows: Array<{ nodeId: string }>) => rows.map((h) => h.nodeId);
  // Duplicated from A1 (its helpers are describe-local); same shape, wrong rows first in loc order.
  async function a1(prefix: string, wrongHasThread: boolean) {
    const wrong: string[] = [], right: string[] = [];
    for (let i = 0; i < 8; i++) { const n = await mk(`${prefix}:a${i}`); wrong.push(n.id); if (wrongHasThread) await comment(n.id); }
    for (let i = 0; i < 3; i++) { const n = await mk(`${prefix}:b${i}`); right.push(n.id); if (!wrongHasThread) await comment(n.id); }
    return { wrong, right };
  }
  async function withDeletedThread(prefix: string, wrongHasThread: boolean) {
    const { wrong, right } = await a1(prefix, wrongHasThread);
    // true: a wrong-state row ahead of the page (a8). false: eligible, inside the limit-2/offset-1 page (b0x).
    const dead = await mk(`${prefix}:${wrongHasThread ? 'b0x' : 'a8'}`);
    const root = await comment(dead.id);
    await M.deleteCommentThread(null, { commentRef: root.id, reason: 'a3675 whole-thread deletion' }, ctx(author()));
    const meta = await db.commentMeta.findUniqueOrThrow({ where: { nodeId: root.id }, include: { node: true } });
    expect(meta.threadState).toBe('OPEN'); expect(meta.retractedAt).toBeNull(); expect(meta.node.deletedAt).not.toBeNull();
    if (wrongHasThread) right.splice(1, 0, dead.id); else wrong.push(dead.id);
    return { wrong, right, dead: dead.id };
  }
  const page = async (prefix: string, value: boolean, limit: number, offset: number) => {
    const common = { db, memoryIds: [memoryId], limit, offset, sort: 'loc' as const, filter: sq(prefix, value) };
    const lexical = idsOf(await provider.lexicalSearch({ ...common, query: 'sparsemark3541' }));
    const regex = idsOf(await provider.regexSearch({ ...common, pattern: 'sparsemark3541' }));
    const modes: Record<string, { ids: string[]; total: unknown }> = {};
    for (const mode of ['keyword', 'regex'] as const) {
      const out = await Q.findNodes(null, { query: 'sparsemark3541', mode, sort: 'LOC', limit, offset, includeTotal: true, filter: { memoryIds: [memoryId], locPrefix: `${prefix}:`, hasOpenThreads: value } }, ctx(author()));
      modes[mode] = { ids: out.hits.map((h: any) => h.node.id), total: out.total };
    }
    return { lexical, regex, modes };
  };

  for (const [value, prefix, wrongHasThread] of [[true, 'dt', false], [false, 'df', true]] as const) {
    it(`item 1, hasOpenThreads ${value}: a deleted-root thread is "no open thread" on lexicalSearch and regexSearch`, async () => {
      const { wrong, right, dead } = await withDeletedThread(prefix, wrongHasThread);
      const common = { db, memoryIds: [memoryId], limit: wrong.length, offset: 0, sort: 'loc' as const, filter: sq(prefix, null) };
      // Precondition: unfiltered, the first rows in loc order ARE the wrong-state ones (the deleted one included for true).
      expect(idsOf(await provider.lexicalSearch({ ...common, query: 'sparsemark3541' }))).toEqual(wrong);
      expect(idsOf(await provider.regexSearch({ ...common, pattern: 'sparsemark3541' }))).toEqual(wrong);
      const expected = right.slice(1, 3);
      // false: the deleted-thread row IS on the page; true: it is not.
      expect(expected.includes(dead)).toBe(!value);
      const got = await page(prefix, value, 2, 1);
      expect(got.lexical, 'lexicalSearch').toEqual(expected);
      expect(got.regex, 'regexSearch').toEqual(expected);
      for (const mode of ['keyword', 'regex']) expect(got.modes[mode].ids, mode).toEqual(expected);
    });

    it(`item 2, hasOpenThreads ${value}: an offset past the end returns an empty page and total stays null`, async () => {
      const { right } = await a1(prefix, wrongHasThread);
      // Control: offset = last index returns exactly the last eligible row, so the fixture is not empty.
      const last = await page(prefix, value, 2, right.length - 1);
      expect(last.lexical).toEqual([right.at(-1)]); expect(last.regex).toEqual([right.at(-1)]);
      for (const mode of ['keyword', 'regex']) expect(last.modes[mode]).toEqual({ ids: [right.at(-1)], total: null });
      const past = await page(prefix, value, 2, right.length);
      expect(past.lexical, 'lexicalSearch').toEqual([]);
      expect(past.regex, 'regexSearch').toEqual([]);
      for (const mode of ['keyword', 'regex']) expect(past.modes[mode], mode).toEqual({ ids: [], total: null });
    });
  }
});

// ───────────────────────── A2 ─────────────────────────
describe('A2: a soft-deleted root never counts as an open thread, on the Prisma and the vector paths', () => {
  it('a whole-thread deletion leaves OPEN, unretracted metadata behind a deleted root, and every path still says "no open thread"', async () => {
    const dead = await mk('del:dead');
    const live = await mk('del:live');
    const none = await mk('del:none');
    const deadRoot = await comment(dead.id);
    await M.deleteCommentThread(null, { commentRef: deadRoot.id, reason: 'a3541 whole-thread deletion' }, ctx(author()));
    await comment(live.id);
    // The legal setup, verified before anything is read: the thread's metadata still says OPEN and unretracted,
    // and only the root node is deleted (a single-comment deletion would retract the root and mask the predicate).
    const meta = await db.commentMeta.findUniqueOrThrow({ where: { nodeId: deadRoot.id }, include: { node: true } });
    expect(meta.threadState).toBe('OPEN'); expect(meta.retractedAt).toBeNull(); expect(meta.node.deletedAt).not.toBeNull();
    await embedAll([dead.id, live.id, none.id]);

    const f = (value: boolean) => ({ memoryIds: [memoryId], locPrefix: 'del:', hasOpenThreads: value });
    const locs = (out: any) => out.hits.map((h: any) => h.node.loc).sort();
    // Prisma browse (no query, no SQL-only filter).
    expect(locs(await Q.findNodes(null, { filter: f(true) }, ctx(author())))).toEqual(['del:live']);
    expect(locs(await Q.findNodes(null, { filter: f(false) }, ctx(author())))).toEqual(['del:dead', 'del:none']);
    // Direct vector providers: node and chunk.
    const opts = (value: boolean) => ({ db, memoryIds: [memoryId], queryEmbedding: JSON.parse(axisLiteral()), limit: 50, hasOpenThreads: value });
    const nodeIds = async (value: boolean) => new Set((await provider.vectorSearch(opts(value))).map((h) => h.nodeId));
    const chunkIds = async (value: boolean) => new Set((await provider.vectorSearchChunks(opts(value))).map((h) => h.nodeId));
    expect(await nodeIds(true)).toEqual(new Set([live.id]));
    expect(await nodeIds(false)).toEqual(new Set([dead.id, none.id]));
    expect(await chunkIds(true)).toEqual(new Set([live.id]));
    expect(await chunkIds(false)).toEqual(new Set([dead.id, none.id]));
  });
});

// ───────────────────────── A4 ─────────────────────────
describe('A4: Node.commentSummary through a real GraphQL execution', () => {
  const QUERY = `query($f: NodeFilter) { findNodes(filter: $f, limit: 50) { hits { node { loc commentSummary { openThreads resolvedThreads comments oldestOpenThreadAt viewerOpenThreadId } } } } }`;
  const run = async (contextValue: Context) => {
    const res = await server.executeOperation({ query: QUERY, variables: { f: { memoryIds: [memoryId], locPrefix: 'sum:' } } }, { contextValue });
    if (res.body.kind !== 'single') throw new Error('unexpected incremental result');
    expect(res.body.singleResult.errors).toBeUndefined();
    const out = new Map<string, any>();
    for (const h of (res.body.singleResult.data as any).findNodes.hits) out.set(h.node.loc, h.node.commentSummary);
    return out;
  };
  /** SQL the summary resolvers emit: the grouped count/min query and the viewer-thread query. */
  function tagged() {
    const spy = vi.spyOn(db, '$queryRaw');
    const read = () => {
      {
        const sqls = spy.mock.calls.map((c) => (Array.isArray(c[0]) ? (c[0] as string[]).join('?') : ''));
        const mine = sqls.filter((s) => s.includes('FROM comment_meta cm JOIN nodes cn'));
        return { summary: mine.filter((s) => s.includes('count(*) FILTER')).length, viewer: mine.filter((s) => s.includes('cm.author_key')).length };
      }
    };
    /** Reads the counts, then restores the spy (a restore clears the recorded calls). */
    return { done: () => { const seen = read(); spy.mockRestore(); return seen; }, abort: () => spy.mockRestore() };
  }

  it('eight targets resolve in one grouped summary query and one viewer query per request, with exact per-target results', async () => {
    const t1 = new Date('2026-01-01T00:00:00.123Z'), t2 = new Date('2026-02-02T00:00:00.456Z'), t3 = new Date('2026-03-03T00:00:00.789Z');
    const T: Record<string, { id: string }> = {};
    for (const k of ['two', 'resolved', 'other', 'none', 'p4', 'p5', 'p6', 'p7']) T[k] = await mk(`sum:${k}`);
    // 'two': two live open roots by two authors (one root per author), unequally dated; the earlier is the second author's.
    const rootA = await comment(T.two!.id, users[0]); const rootB = await comment(T.two!.id, users[1]);
    await db.node.update({ where: { id: rootA.id }, data: { createdAt: t2 } });
    await db.node.update({ where: { id: rootB.id }, data: { createdAt: t1 } });
    // Edits and replies must not move the minimum: a reply at a LATER time and a reply by the first author.
    await M.replyToComment(null, { commentRef: rootB.id, body: 'later reply' }, ctx(users[2]!));
    // 'resolved': an earlier resolved root (never open) beside nothing open.
    const resolved = await comment(T.resolved!.id, users[0]); await M.resolveCommentThread(null, { commentRef: resolved.id, expectedRevision: 1 }, ctx(users[0]!));
    await db.node.update({ where: { id: resolved.id }, data: { createdAt: new Date('2025-01-01T00:00:00Z') } });
    // 'other': a different minimum from 'two'.
    const other = await comment(T.other!.id, users[0]); await db.node.update({ where: { id: other.id }, data: { createdAt: t3 } });
    // p4..p7 carry one open root each at distinct times, so a shared aggregate cannot pass.
    for (const [i, k] of ['p4', 'p5', 'p6', 'p7'].entries()) {
      const r = await comment(T[k]!.id, users[0]); await db.node.update({ where: { id: r.id }, data: { createdAt: new Date(Date.UTC(2026, 3 + i, 1, 0, 0, 0, i + 1)) } });
    }
    const first = tagged();
    let out: Map<string, any>;
    try { out = await run(ctx(users[0]!)); } catch (e) { first.abort(); throw e; }
    expect(first.done()).toEqual({ summary: 1, viewer: 1 });
    expect(out.size).toBe(8);
    expect(out.get('sum:two')).toEqual({ openThreads: 2, resolvedThreads: 0, comments: 3, oldestOpenThreadAt: t1.toISOString(), viewerOpenThreadId: rootA.id });
    expect(out.get('sum:resolved')).toEqual({ openThreads: 0, resolvedThreads: 1, comments: 1, oldestOpenThreadAt: null, viewerOpenThreadId: null });
    expect(out.get('sum:other')).toEqual({ openThreads: 1, resolvedThreads: 0, comments: 1, oldestOpenThreadAt: t3.toISOString(), viewerOpenThreadId: other.id });
    expect(out.get('sum:none')).toEqual({ openThreads: 0, resolvedThreads: 0, comments: 0, oldestOpenThreadAt: null, viewerOpenThreadId: null });
    const times = ['p4', 'p5', 'p6', 'p7'].map((k) => out.get(`sum:${k}`).oldestOpenThreadAt);
    expect(times).toEqual([0, 1, 2, 3].map((i) => new Date(Date.UTC(2026, 3 + i, 1, 0, 0, 0, i + 1)).toISOString()));
    expect(new Set(times).size).toBe(4);

    // A second request with a FRESH Context re-queries (no accidental cross-request cache) and agrees.
    const second = tagged();
    try { const again = await run(ctx(users[0]!)); expect([...again.entries()]).toEqual([...out.entries()]); } catch (e) { second.abort(); throw e; }
    expect(second.done()).toEqual({ summary: 1, viewer: 1 });
    // A different viewer sees the same counts and times but their own viewerOpenThreadId.
    const asB = await run(ctx(users[1]!));
    expect(asB.get('sum:two')).toEqual({ openThreads: 2, resolvedThreads: 0, comments: 3, oldestOpenThreadAt: t1.toISOString(), viewerOpenThreadId: rootB.id });
    expect(asB.get('sum:other').viewerOpenThreadId).toBeNull();
  });
});

// ───────────────────────── A5 ─────────────────────────
describe('A5: vector-mode expansion keeps eligible context and drops wrong-thread context', () => {
  const QV = JSON.parse(axisLiteral()) as number[];
  it('a real vector seed expands to eligible neighbours that fail the candidate-only role and prefix, and not to a wrong-thread one', async () => {
    vi.stubEnv('EMBEDDING_API_URL', 'http://synthetic.invalid');
    setEmbeddingClientForTests({ provider: 'test', model: 'fixture-3541', dim: 768, async embed(texts: string[]) { return texts.map(() => QV); } });
    await db.memory.update({ where: { id: memoryId }, data: { vectorIndexEnabled: true, embeddingSource: 'contentChunks' } });
    const out: Record<string, string> = {};
    // Group v: the seed has an open thread (flag true). Group w: the seed has none (flag false).
    for (const [g, seedThread] of [['v', true], ['w', false]] as const) {
      const seed = await mk(`${g}:seed`, { role: 'spec', content: 'nothing lexical here', name: 'seed' });
      const keep = await mk(`zz:${g}-keep`, { role: 'other', content: 'ctx', name: 'keep' });   // fails candidate role + prefix
      const drop = await mk(`zz:${g}-drop`, { role: 'other', content: 'ctx', name: 'drop' });   // wrong thread state
      if (seedThread) { await comment(seed.id); await comment(keep.id); } else { await comment(drop.id); }
      for (const t of [keep, drop]) await db.edge.create({ data: { memoryId, sourceId: seed.id, targetId: t.id, name: 'near', loc: `edge:${g}:${t.loc}` } });
      await embedAll([seed.id, keep.id, drop.id]);
      out[`${g}-seed`] = seed.id; out[`${g}-keep`] = keep.id; out[`${g}-drop`] = drop.id;
    }
    for (const [g, value] of [['v', true], ['w', false]] as const) {
      const res = await Q.findNodes(null, { query: 'xyzzy-no-lexical-match', mode: 'vector', expand: 1, includeTotal: true, filter: { memoryIds: [memoryId], locPrefix: `${g}:`, role: 'spec', hasOpenThreads: value } }, ctx(author()));
      const seedHit = res.hits.find((h: any) => h.node.id === out[`${g}-seed`]);
      expect(seedHit, `${g}: the seed is a real vector hit`).toBeTruthy();
      expect(seedHit.vector?.similarity, `${g}: non-null vector similarity`).toBeGreaterThan(0.99);
      expect(seedHit.score).not.toBeNull();
      expect(res.hits.map((h: any) => h.node.id).sort(), g).toEqual([out[`${g}-seed`], out[`${g}-keep`]].sort());
      const ctxHit = res.hits.find((h: any) => h.node.id === out[`${g}-keep`]);
      expect(ctxHit.score, `${g}: context carries no score`).toBeNull(); expect(ctxHit.vector).toBeNull();
      expect(res.total, `${g}: expansion keeps total null`).toBeNull();
    }
  });
});
