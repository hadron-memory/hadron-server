/**
 * #3642 — what the minScore-floor widening loop (`widenVectorWindow`, resolvers.query.node.ts) actually costs.
 *
 * AFTER #4665 (#2772): the loop is gone. Every scenario now runs ONE ranking window (the page), the floor and filters apply
 * inside/after it, and the page is full where the data allows (S14 no longer comes back short past row 2000). The
 * comments below on widening describe the BEFORE state this file first recorded (origin/main e42bb1897).
 *
 * INVESTIGATION ONLY: this file observes and pins behavior. It authorizes no optimization, budget or early
 * termination (gate: hadron-server#3642 comment 6702033100). The numbers describe the loop AS OF origin/main e42bb1897;
 * PR #4665 (#2772/#438) rewrites this loop and the provider, so a re-run after it merges gives the before/after.
 * The fixtures are parameterised only by data, so they re-run unchanged.
 *
 * Observer (no production code touched): the retrieval provider's vectorSearch / vectorSearchChunks are wrapped to record
 * each window's requested `limit`, the provider's own `exhausted` signal and the hit count; the `eligibleIds` calls are
 * the `node.findMany({ where: { id: { in } }, select: { id, loc } })` shape (nothing else selects exactly id+loc).
 * Scores are exact by construction: a node's stored vector is (0, s, sqrt(1-s^2), 0...), the query is (0, 1, 0...), so its
 * cosine similarity is s (pgvector stores float4, so a score can sit ~1e-7 either side of s; boundary cases say so).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, createDbOrgAndGraph } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resetEmbeddingClientForTests, setEmbeddingClientForTests, type EmbeddingClient } from '../../../lib/embedding/index.js';
import { getRetrievalProvider } from '../../../lib/retrieval/postgres.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));

const DIM = 768;
const queryClient: EmbeddingClient = {
  provider: 'test', model: 'stub-model', dim: DIM,
  async embed(texts: string[]) { return texts.map(() => { const v = new Array(DIM).fill(0); v[1] = 1; return v; }); },
};
const EXACT_PLAN = ['SET LOCAL enable_sort = on', 'SET LOCAL enable_indexscan = off'];
/** SQL observer: every raw SELECT the search issues (inside or outside a transaction); the SET LOCAL plan settings are not counted. */
const sqlSeen = { n: 0 };
const RAW_READS = new Set(['$queryRaw', '$queryRawUnsafe']);
function countingTx(tx: any): any {
  return new Proxy(tx, { get(t, prop) { const v = Reflect.get(t, prop); if (typeof v !== 'function') return v; return RAW_READS.has(String(prop)) ? (...a: unknown[]) => { sqlSeen.n++; return v.apply(t, a); } : v.bind(t); } });
}
function withLocalSettings(base: typeof db, sets: string[]): typeof db {
  return new Proxy(base, {
    get(target, prop) {
      const v = Reflect.get(target, prop);
      if (RAW_READS.has(String(prop))) return (...a: unknown[]) => { sqlSeen.n++; return (v as any).apply(target, a); };
      if (prop !== '$transaction') return typeof v === 'function' ? v.bind(target) : v;
      return (arg: unknown, opts?: unknown) => typeof arg !== 'function'
        ? (target.$transaction as any)(arg, opts)
        : (target.$transaction as any)(async (tx: any) => { for (const s of sets) await tx.$executeRawUnsafe(s); return (arg as (tx: unknown) => unknown)(countingTx(tx)); }, opts);
    },
  });
}
const searchDb = withLocalSettings(db, EXACT_PLAN);
const admin = (): Context => ({ db: searchDb, roles: ['ADMIN'], userId: 'admin-3642' } as Context);
const findNodes = (args: Record<string, unknown>) => (resolvers.Query as any).findNodes(null, args, admin());

type Fixture = { id: string; loc: string; score: number; role: string };
let memId: string;
let fixture: Fixture[] = [];

/** `n` nodes, score descending from 0.99 by `step`; every `ruleEvery`-th node is a spec.rule, the rest are reviews. */
async function seed(n: number, step: number, ruleEvery: number, opts: { kind?: 'abstract' | 'chunk'; ruleFrom?: number } = {}) {
  fixture = Array.from({ length: n }, (_, i) => ({
    id: generateId(), loc: `n${String(i).padStart(5, '0')}`, score: Math.round((0.99 - i * step) * 1e6) / 1e6, role: (i >= (opts.ruleFrom ?? 0) && i % ruleEvery === ruleEvery - 1) ? 'spec.rule' : 'review',
  }));
  await db.node.createMany({ data: fixture.map((f) => ({ id: f.id, memoryId: memId, loc: f.loc, name: f.loc, content: `body ${f.loc}`, role: f.role })) });
  for (let i = 0; i < n; i += 100) {
    const batch = fixture.slice(i, i + 100);
    const values = batch.map((f) => {
      const v = new Array(DIM).fill(0); v[1] = f.score; v[2] = Math.sqrt(1 - f.score * f.score);
      return opts.kind === 'chunk'
        ? `('${generateId()}','${f.id}','${memId}','chunk','test','stub-model',${DIM},0,0,4,'body','[${v.join(',')}]'::vector, now())`
        : `('${generateId()}','${f.id}','${memId}','abstract','test','stub-model',${DIM},null,null,null,null,'[${v.join(',')}]'::vector, now())`;
    }).join(',');
    await db.$executeRawUnsafe(`INSERT INTO node_embeddings (id, node_id, memory_id, kind, provider, model, dim, chunk_index, char_start, char_end, chunk_text, embedding, created_at) VALUES ${values}`);
  }
}

type Window = { limit: number; exhausted: boolean; hits: number };
type Observation = { windows: Window[]; eligibleCalls: number[]; resultIds: string[]; rawSelects: number };
const provider = getRetrievalProvider();
async function observe(args: Record<string, unknown>, method: 'vectorSearch' | 'vectorSearchChunks' = 'vectorSearch'): Promise<Observation> {
  const windows: Window[] = [];
  const eligibleCalls: number[] = [];
  sqlSeen.n = 0;
  const real = (provider as any)[method].bind(provider);
  const spy = vi.spyOn(provider as any, method).mockImplementation(async (opts: any) => {
    let exhausted = false;
    const hits = await real({ ...opts, onWindow: (w: { exhausted: boolean }) => { exhausted = w.exhausted; opts.onWindow?.(w); } });
    windows.push({ limit: opts.limit, exhausted, hits: hits.length });
    return hits;
  });
  const realFind = db.node.findMany.bind(db.node);
  const findSpy = vi.spyOn(db.node as any, 'findMany').mockImplementation((async (a: any) => {
    const keys = a?.select ? Object.keys(a.select).sort().join(',') : '';
    if (keys === 'id,loc' && Array.isArray(a?.where?.id?.in)) eligibleCalls.push(a.where.id.in.length);
    return realFind(a);
  }) as any);
  try {
    const res = await findNodes({ query: 'q', mode: 'vector', ...args });
    // Prisma query events arrive asynchronously (see the #606 cost pin): nothing here reads them, only synchronous spies.
    return { windows, eligibleCalls, rawSelects: sqlSeen.n, resultIds: args.granularity === 'chunk' ? res.passages.map((p: any) => p.parentNodeId) : res.hits.map((h: any) => h.node.id) };
  } finally { spy.mockRestore(); findSpy.mockRestore(); }
}

/** Ground truth from the fixture's own scores: the top `page` eligible nodes at or above the floor, in rank order. */
function expected(opts: { floor?: number; roleFamily?: string; limit: number; offset?: number }): string[] {
  return fixture
    .filter((f) => (opts.floor == null || f.score >= opts.floor) && (opts.roleFamily == null || f.role.startsWith(opts.roleFamily)))
    .slice(opts.offset ?? 0, (opts.offset ?? 0) + opts.limit).map((f) => f.id);
}

const report: Record<string, unknown>[] = [];
function record(name: string, o: Observation, want: string[]) {
  report.push({
    scenario: name, windows: o.windows.map((w) => `${w.limit}${w.exhausted ? 'E' : ''}:${w.hits}`).join(' > '),
    rawSelects: o.rawSelects, eligibleIdsCalls: o.eligibleCalls.length, eligibleIdsArgSizes: o.eligibleCalls.join(','),
    returned: o.resultIds.length, expected: want.length, correct: JSON.stringify(o.resultIds) === JSON.stringify(want),
  });
}
afterAll(() => {
  resetEmbeddingClientForTests();
  delete process.env.EMBEDDING_API_URL;
  if (process.env.HADRON_OBSERVER_OUT) { mkdirSync(process.env.HADRON_OBSERVER_OUT, { recursive: true }); writeFileSync(`${process.env.HADRON_OBSERVER_OUT}/3642-report.json`, JSON.stringify(report, null, 2)); }
});
afterEach(() => vi.restoreAllMocks());
beforeEach(async () => {
  await cleanDb(db);
  process.env.EMBEDDING_API_URL = 'http://stub.local/api/embed';
  setEmbeddingClientForTests(queryClient);
  const made = await createDbOrgAndGraph(db, { orgName: 'vo-org', graphName: 'vo/graph' });
  memId = made.graph.id;
  await db.memory.update({ where: { id: memId }, data: { vectorIndexEnabled: true, embeddingSource: 'contentChunks' } });
});

const F = (extra: Record<string, unknown> = {}) => ({ memoryIds: [memId], ...extra });

describe('#3642 observer — 400 nodes, score 0.99 down by 0.002, every 25th a spec.rule', () => {
  beforeEach(async () => { await seed(400, 0.002, 25); });

  it('S1 minScore ABSENT, no filter, limit 20: the first window fills the page', async () => {
    const o = await observe({ filter: F(), limit: 20 });
    const want = expected({ limit: 20 }); record('S1 no floor, no filter, limit 20', o, want);
    expect(o.resultIds).toEqual(want);
    expect(o.windows.map((w) => w.limit)).toEqual([20]);
    expect(o.eligibleCalls).toHaveLength(0); // after #4665 there is no per-window eligibleIds round trip
  });

  it('S2 minScore BELOW every score: same cost as absent', async () => {
    const o = await observe({ filter: F(), limit: 20, minScore: 0.01 });
    const want = expected({ limit: 20, floor: 0.01 }); record('S2 floor 0.01 (below all)', o, want);
    expect(o.resultIds).toEqual(want);
    expect(o.windows.map((w) => w.limit)).toEqual([20]);
  });

  it('S3 floor excludes most nodes (0.80: only 96 pass): window 20 is still full of passers', async () => {
    const o = await observe({ filter: F(), limit: 20, minScore: 0.8 });
    const want = expected({ limit: 20, floor: 0.8 }); record('S3 floor 0.80, 96 pass, limit 20', o, want);
    expect(o.resultIds).toEqual(want);
  });

  it('S4 floor leaves fewer passers than the page (0.90: 45 pass, limit 50): the loop widens, then stops on exhaustion', async () => {
    const o = await observe({ filter: F(), limit: 50, minScore: 0.9 });
    const want = expected({ limit: 50, floor: 0.9 }); record('S4 floor 0.90, 45 pass, limit 50', o, want);
    expect(o.resultIds).toEqual(want);
    expect(o.windows.map((w) => w.limit)).toEqual([50]); // after #4665: one window, no widening
  });

  it('S5 floor above EVERY score (0.995): nothing can pass; cost until the provider reports exhaustion', async () => {
    const o = await observe({ filter: F(), limit: 20, minScore: 0.995 });
    record('S5 floor 0.995 (above all)', o, []);
    expect(o.resultIds).toEqual([]);
    expect(o.windows.map((w) => w.limit)).toEqual([20]); // after #4665: one window
  });

  it('S6 floor equal to a stored score (boundary): the node at the floor is judged on its float4 score', async () => {
    const at = fixture[100]!; // score 0.79
    const o = await observe({ filter: F(), limit: 200, minScore: at.score });
    const want = expected({ limit: 200, floor: at.score }); record(`S6 floor == score of node 100 (${at.score})`, o, want);
    // Either the boundary node is in (score >= floor) or one float4 ulp under; nothing ABOVE it may be missing, nothing below it present.
    const got = new Set(o.resultIds);
    for (const f of fixture.slice(0, 100)) expect(got.has(f.id), f.loc).toBe(true);
    for (const f of fixture.slice(101)) expect(got.has(f.id), f.loc).toBe(false);
  });

  it('S7 floor just below / just above a stored score (±0.0005) is exact', async () => {
    const at = fixture[100]!;
    const below = await observe({ filter: F(), limit: 200, minScore: at.score - 0.0005 });
    record('S7a floor 0.0005 below node 100', below, expected({ limit: 200, floor: at.score - 0.0005 }));
    expect(below.resultIds).toEqual(expected({ limit: 200, floor: at.score - 0.0005 }));
    const above = await observe({ filter: F(), limit: 200, minScore: at.score + 0.0005 });
    record('S7b floor 0.0005 above node 100', above, expected({ limit: 200, floor: at.score + 0.0005 }));
    expect(above.resultIds).toEqual(expected({ limit: 200, floor: at.score + 0.0005 }));
  });

  it('S8 a rare structured filter (role spec, 16 of 400) with no floor: limit 5 widens past the 25-row over-fetch', async () => {
    const o = await observe({ filter: F({ role: 'spec' }), limit: 5 });
    const want = expected({ limit: 5, roleFamily: 'spec' }); record('S8 role=spec (16/400), limit 5, no floor', o, want);
    expect(o.resultIds).toEqual(want);
  });

  it('S9 rare filter AND a floor: windows widen on BOTH the filter and the floor', async () => {
    const o = await observe({ filter: F({ role: 'spec' }), limit: 5, minScore: 0.6 });
    const want = expected({ limit: 5, roleFamily: 'spec', floor: 0.6 }); record('S9 role=spec, floor 0.60, limit 5', o, want);
    expect(o.resultIds).toEqual(want);
  });

  it('S10 SHORT result: fewer eligible-and-passing nodes than the page ends on exhaustion, never a wrong hit', async () => {
    const o = await observe({ filter: F({ role: 'spec' }), limit: 50, minScore: 0.9 });
    const want = expected({ limit: 50, roleFamily: 'spec', floor: 0.9 }); record('S10 role=spec, floor 0.90, limit 50 (short)', o, want);
    expect(o.resultIds).toEqual(want);
    expect(o.resultIds.length).toBeLessThan(50);
  });

  it('S11 offset: page = offset + limit drives the first window (offset 30, limit 20)', async () => {
    const o = await observe({ filter: F(), limit: 20, offset: 30 });
    const want = expected({ limit: 20, offset: 30 }); record('S11 offset 30, limit 20, no floor', o, want);
    expect(o.resultIds).toEqual(want);
    expect(o.windows[0]!.limit).toBe(50);
  });

}); 

describe('#3642 observer — the cap (2100 nodes, score 0.99 down by 0.0004, every 25th a spec.rule)', () => {
  beforeEach(async () => { await seed(2100, 0.0004, 25); }, 120_000);

  it('S13 floor above all with more eligible rows than the cap: windows climb x4 to 2000 and stop at the cap, not on exhaustion', async () => {
    const o = await observe({ filter: F(), limit: 20, minScore: 0.995 });
    record('S13 2100 nodes, floor 0.995 (above all), limit 20', o, []);
    expect(o.resultIds).toEqual([]);
    expect(o.windows.map((w) => w.limit)).toEqual([20]); // after #4665: no widening to a cap
  }, 120_000);

  it('S14 PAST THE CAP a page is short, never wrong: every spec.rule ranks beyond row 2000 (rules only in the last 100 nodes)', async () => {
    await cleanDb(db);
    const made = await createDbOrgAndGraph(db, { orgName: 'vo-org-2', graphName: 'vo/graph2' });
    memId = made.graph.id;
    await db.memory.update({ where: { id: memId }, data: { vectorIndexEnabled: true, embeddingSource: 'contentChunks' } });
    await seed(2100, 0.0004, 5, { ruleFrom: 2000 }); // 20 rules, all past the cap
    const o = await observe({ filter: F({ role: 'spec' }), limit: 5 });
    const want = expected({ limit: 5, roleFamily: 'spec' }); record('S14 2100 nodes, 20 spec rules all ranked past row 2000, limit 5', o, want);
    expect(want).toHaveLength(5);
    expect(o.windows.map((w) => w.limit)).toEqual([5]);
    expect(o.resultIds).toEqual(want); // after #4665 (ruling 0150: no candidate cap): the FULL true page, not a short one
  }, 120_000);
});

describe('#3642 observer — chunk granularity (400 chunk-kind vectors only)', () => {
  beforeEach(async () => { await seed(400, 0.002, 25, { kind: 'chunk' }); });
  it('S12 chunk granularity goes through the same loop: floor above all widens until the provider reports exhaustion', async () => {
    const o = await observe({ filter: F(), limit: 20, minScore: 0.995, granularity: 'chunk' }, 'vectorSearchChunks');
    record('S12 chunk granularity, floor 0.995 (above all)', o, []);
    expect(o.resultIds).toEqual([]);
    expect(o.windows.map((w) => w.limit)).toEqual([20]); // after #4665: one window
  });
  it('S12b chunk granularity, no floor: first window fills', async () => {
    const o = await observe({ filter: F(), limit: 20, granularity: 'chunk' }, 'vectorSearchChunks');
    record('S12b chunk granularity, no floor, limit 20', o, fixture.slice(0, 20).map((f) => f.id));
    expect(o.resultIds).toEqual(fixture.slice(0, 20).map((f) => f.id));
  });
});
