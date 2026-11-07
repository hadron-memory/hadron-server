/**
 * #3541 slice A3: the open-thread filter on the bounded exact fallback (#3054), under an INJECTED ANN shortfall.
 *
 * What this is: the real ANN statement runs against the private DB, and the production caller is then handed an empty
 * result, so vectorSearchNodes / vectorSearchChunks take their real fallback branch. The real eligible-count statement
 * and the real MATERIALIZED exact statement are forwarded to the DB unchanged. Tiny fixture (a dozen rows or fewer).
 *
 * What this is NOT: natural HNSW recall, a load or latency test, a guarantee for every fallback state, or coverage of the
 * COMMENTS-scope exact arm and its overflow races. #438 / #3054 keep their own pins; #2772 owns uncapped paging and the
 * work-budget policy and this file does not touch it. Production keeps ONE `eligibleFrom` per function.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../../lib/id.js';
import { postgresRetrievalProvider as provider } from '../../lib/retrieval/postgres.js';
import { resolvers, type Context } from '../../api/graphql/schema/resolvers.js';

vi.mock('../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
const M = resolvers.Mutation as any;
const DIM = 768;

let memoryId: string, foreignId: string, userId: string;
const ctx = (): Context => ({ db, userId, roles: [] });
type Fx = { e1: string; e2: string; w1: string; w2: string; dead: string; foreign: string };
let fx: Fx;
const nameOf = new Map<string, string>();

/** Distinct, ordered distances from the query (axis 1): the nearer the smaller `rank`. */
const vecLiteral = (rank: number) => `[${Array.from({ length: DIM }, (_, i) => (i === 1 ? 1 : i === 7 ? rank * 0.01 : 0)).join(',')}]`;
const QUERY = JSON.parse(vecLiteral(0)) as number[];

async function node(mem: string, loc: string, rank: number) {
  const id = generateId();
  await db.node.create({ data: { id, memoryId: mem, loc, name: loc, content: `body ${loc}` } });
  nameOf.set(id, loc);
  await db.$executeRawUnsafe(
    `INSERT INTO node_embeddings (id, node_id, memory_id, kind, provider, model, dim, chunk_index, char_start, char_end, chunk_text, embedding, created_at)
     VALUES ($1, $2, $3, 'chunk', 'test', 'fixture-3541', ${DIM}, 0, 0, 4, $4, '${vecLiteral(rank)}'::vector, now())`,
    `emb-${id}`, id, mem, `chunk-${loc}`,
  );
  return id;
}

beforeEach(async () => {
  await cleanDb(db);
  nameOf.clear();
  const org = await db.organization.create({ data: { id: generateId(), name: 'F3541', urn: `f3541-${generateId()}.test` } });
  userId = (await db.user.create({ data: { handle: `f3541-${generateId()}` } })).id;
  await db.orgMember.create({ data: { organizationId: org.id, userId, role: 'ADMIN' } });
  memoryId = (await M.createMemory(null, { orgId: org.id, name: 'f3541' }, ctx())).id;
  foreignId = (await M.createMemory(null, { orgId: org.id, name: 'f3541-foreign' }, ctx())).id;
  // Ranks (nearest first): w1 < w2 < e1 < dead < e2, interleaved so an unfiltered top-N never equals the expected set. e1/e2 carry a live open thread; w1/w2 none; `dead` has only a
  // soft-deleted root whose metadata still says OPEN (legal setup via deleteCommentThread); the foreign node is open.
  const ids = { e1: await node(memoryId, 'e1', 3), e2: await node(memoryId, 'e2', 5), w1: await node(memoryId, 'w1', 1), w2: await node(memoryId, 'w2', 2), dead: await node(memoryId, 'dead', 4), foreign: await node(foreignId, 'foreign', 0) };
  fx = ids;
  for (const id of [ids.e1, ids.e2, ids.foreign]) await M.createComment(null, { targetRef: id, body: 'open' }, ctx());
  const deadRoot = await M.createComment(null, { targetRef: ids.dead, body: 'to be deleted whole' }, ctx());
  await M.deleteCommentThread(null, { commentRef: deadRoot.id, reason: 'a3541 whole-thread deletion' }, ctx());
  const meta = await db.commentMeta.findUniqueOrThrow({ where: { nodeId: deadRoot.id }, include: { node: true } });
  expect(meta.threadState).toBe('OPEN'); expect(meta.retractedAt).toBeNull(); expect(meta.node.deletedAt).not.toBeNull();
});
afterEach(() => { vi.unstubAllEnvs(); });

type Seen = { annIntercepted: number; annKind: 'node' | 'chunk' | null; annRealRows: number; counts: number[]; exactCalls: number };
/** A db handle that runs the real ANN statement, then returns an empty result to the caller when `shortfall` is on. */
function probe(shortfall: boolean) {
  const seen: Seen = { annIntercepted: 0, annKind: null, annRealRows: -1, counts: [], exactCalls: 0 };
  const txProxy = (tx: any) => new Proxy(tx, {
    get(t, prop) {
      const v = Reflect.get(t, prop);
      if (prop !== '$queryRaw') return typeof v === 'function' ? v.bind(t) : v;
      return async (strings: TemplateStringsArray, ...vals: unknown[]) => {
        const sql = Array.isArray(strings) ? strings.join('?') : '';
        const real = await (v as any).call(t, strings, ...vals);
        if (!shortfall) return real;
        seen.annIntercepted++;
        seen.annKind = sql.includes('ann_rows') ? 'node' : 'chunk';
        seen.annRealRows = (real as unknown[]).length;
        return [];
      };
    },
  });
  const handle = new Proxy(db, {
    get(target, prop) {
      const v = Reflect.get(target, prop);
      if (prop === '$transaction') {
        return (arg: unknown, opts?: unknown) => typeof arg !== 'function'
          ? (target.$transaction as any)(arg, opts)
          : (target.$transaction as any)((tx: any) => (arg as any)(txProxy(tx)), opts);
      }
      if (prop === '$queryRaw') {
        return async (strings: TemplateStringsArray, ...vals: unknown[]) => {
          const sql = Array.isArray(strings) ? strings.join('?') : '';
          const out = await (v as any).call(target, strings, ...vals);
          if (sql.includes('MATERIALIZED')) seen.exactCalls++;
          else if (sql.includes('count(*)::int AS n')) seen.counts.push(Number((out as any[])[0]?.n));
          return out;
        };
      }
      return typeof v === 'function' ? v.bind(target) : v;
    },
  }) as typeof db;
  return { handle, seen };
}

const names = (ids: string[]) => ids.map((id) => nameOf.get(id));

for (const [value, expectedNames, limit] of [[true, ['e1', 'e2'], 2], [false, ['w1', 'w2', 'dead'], 3]] as const) {
  for (const kind of ['node', 'chunk'] as const) {
    describe(`hasOpenThreads ${value}, ${kind}: the injected shortfall reaches the real exact fallback`, () => {
      const call = (handle: typeof db) => {
        const o = { db: handle, memoryIds: [memoryId], queryEmbedding: QUERY, limit, hasOpenThreads: value, onWindow: () => {} } as any;
        return kind === 'node' ? provider.vectorSearch(o) : provider.vectorSearchChunks(o);
      };
      const eligible = expectedNames.length;

      it('control: with no interception the normal full ANN page takes NO fallback (so the branch-entry oracle is real)', async () => {
        vi.stubEnv('VECTOR_EXACT_FALLBACK_MAX_ROWS', String(eligible));
        const { handle, seen } = probe(false);
        const hits = await call(handle);
        expect(names(hits.map((h) => h.nodeId))).toEqual(expectedNames);
        expect(seen.exactCalls).toBe(0);
        expect(seen.annIntercepted).toBe(0);
      });

      it('interception: real ANN returned a full page, the real count and MATERIALIZED statements ran once, and the final result is exact', async () => {
        vi.stubEnv('VECTOR_EXACT_FALLBACK_MAX_ROWS', String(eligible)); // the per-call bound equals the known eligible count
        const { handle, seen } = probe(true);
        const hits = await call(handle);
        // Exactly the intended ANN arm, once; the real statement had returned a full requested page.
        expect(seen.annIntercepted).toBe(1);
        expect(seen.annKind).toBe(kind);
        expect(seen.annRealRows).toBeGreaterThanOrEqual(limit);
        // The real eligible-count statement ran once and matched the fixture's independently known count.
        expect(seen.counts).toEqual([eligible]);
        // The MATERIALIZED exact statement ran exactly once.
        expect(seen.exactCalls).toBe(1);
        // Exact final identities, in rank order; foreign and wrong-state rows are absent.
        expect(names(hits.map((h) => h.nodeId))).toEqual(expectedNames);
        expect(hits.map((h) => h.nodeId)).not.toContain(fx.foreign);
        const wrong = value ? [fx.w1, fx.w2, fx.dead] : [fx.e1, fx.e2];
        for (const id of wrong) expect(hits.map((h) => h.nodeId)).not.toContain(id);
        if (kind === 'chunk') {
          expect((hits as any[]).map((h) => [nameOf.get(h.nodeId), h.chunkIndex, h.charStart, h.charEnd, h.chunkText])).toEqual(
            expectedNames.map((n) => [n, 0, 0, 4, `chunk-${n}`]),
          );
        }
      });
    });
  }
}
