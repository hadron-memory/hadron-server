/**
 * #4938 N3 (Elena, BLIND delta on #4928 at 04c80fa6) — the hybrid keyword widening's statement runs under what is LEFT of
 * the request's vector budget. The widening checked the deadline before it started, but the `lexicalSearch` it then issued
 * (up to depth 2000) had no statement budget of its own, so a widening started just before the deadline ran unbounded.
 * Now it gets the remaining budget as a transaction-local `statement_timeout`, and a cut is the early stop: the page keeps
 * the ranking it had and says `stopped_early` (cor:api:090:04), never a short page.
 *
 * The widening's statement is the REAL lexical statement, made slow on purpose (a per-row `pg_sleep` over the matching
 * nodes), so the pin exercises Postgres cancelling it, not a mock that pretends to.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, createDbOrgAndGraph } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import type { EmbeddingClient } from '../../../lib/embedding/index.js';
import { setEmbeddingClientForTests, resetEmbeddingClientForTests } from '../../../lib/embedding/index.js';
import { getRetrievalProvider } from '../../../lib/retrieval/postgres.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));

const DIM = 768;
const q = () => { const v = new Array(DIM).fill(0); v[1] = 1; return v; };
const stub: EmbeddingClient = { provider: 'test', model: 'stub-model', dim: DIM, async embed(texts: string[]) { return texts.map(() => q()); } };
const provider = getRetrievalProvider();
const realLexical = provider.lexicalSearch.bind(provider);

let mem: string;
let savedUrl: string | undefined;
const ids: string[] = []; // in vector order (nearest first)
const N = 12; // matching nodes; 12 x 0.3 s of pg_sleep = 3.6 s per slowed statement

/** The real client, except that the lexical ranking statement sleeps 0.3 s per matching row. */
const slowDb = new Proxy(db, {
  get(t, p) {
    const v = Reflect.get(t, p);
    if (p === '$queryRawUnsafe') {
      return (sql: string, ...a: unknown[]) => (t.$queryRawUnsafe as any)(
        sql.includes('ts_rank_cd') ? sql.replace(/ORDER BY/, "AND pg_sleep(0.3)::text = '' ORDER BY") : sql, ...a);
    }
    return typeof v === 'function' ? v.bind(t) : v;
  },
}) as typeof db;

const findNodes = (args: Record<string, unknown>) =>
  (resolvers.Query as any).findNodes(null, { ...args, filter: { memoryIds: [mem] } }, { db, roles: ['ADMIN'], userId: 'admin-4938' } as Context);

beforeAll(async () => {
  await cleanDb(db);
  savedUrl = process.env.EMBEDDING_API_URL;
  process.env.EMBEDDING_API_URL = 'http://stub.local/api/embed';
  setEmbeddingClientForTests(stub);
  const made = await createDbOrgAndGraph(db, { orgName: 'r4938l-org', graphName: 'r4938l/mem' });
  mem = made.graph.id;
  await db.memory.update({ where: { id: mem }, data: { vectorIndexEnabled: true, embeddingSource: 'contentChunks' } });
  for (let i = 0; i < N; i++) {
    const nid = generateId();
    ids.push(nid);
    await db.node.create({ data: { id: nid, memoryId: mem, loc: `n-${i}`, name: `n${i}`, content: 'body' } });
    const v = q(); v[3] = (i + 1) * 0.05;
    await db.$executeRawUnsafe(`
      INSERT INTO node_embeddings (id, node_id, memory_id, kind, provider, model, dim, chunk_index, char_start, char_end, chunk_text, embedding, created_at)
      VALUES ('${generateId()}', '${nid}', '${mem}', 'chunk', 'test', 'stub-model', ${DIM}, 0, 0, 4, 'body', '[${v.join(',')}]'::vector, now())`);
  }
}, 120_000);

afterEach(() => { vi.restoreAllMocks(); delete process.env.VECTOR_SEARCH_TIMEOUT_MS; });
afterAll(() => {
  resetEmbeddingClientForTests();
  if (savedUrl === undefined) delete process.env.EMBEDDING_API_URL; else process.env.EMBEDDING_API_URL = savedUrl;
});

describe('#4938 N3 — the keyword widening runs under the remaining vector budget', () => {
  it('a slow widening statement is cut at the deadline: a full page, flagged stopped_early, within the budget (red: it ran to the end)', async () => {
    // The keyword leg ranks the real nodes in REVERSE vector order and then never ends, so it is not exhausted and the
    // page (both rows real, nothing dropped at hydration) can only be certified by widening it. Each widening runs the
    // REAL lexical statement, slowed; the first leg (depth 2) is not a widening and is answered at once.
    const endless = [...ids.slice().reverse(), ...Array.from({ length: 5000 }, (_, i) => `nohit-${i}`)];
    const budgets: Array<number | undefined> = [];
    vi.spyOn(provider, 'lexicalSearch').mockImplementation(async (a: any) => {
      if (a.limit > 2) {
        budgets.push(a.statementTimeoutMs);
        await realLexical({ ...a, db: slowDb, query: 'body' }); // throws when Postgres cancels it
      }
      return endless.slice(0, a.limit).map((n, i) => ({ nodeId: n, score: 1 / (i + 1) }));
    });
    vi.spyOn(provider, 'vectorRanks').mockResolvedValue({ ranks: new Map(), stoppedEarly: false });
    process.env.VECTOR_SEARCH_TIMEOUT_MS = '1000';
    const t0 = Date.now();
    const res = await findNodes({ query: 'q', mode: 'hybrid', limit: 2 });
    const elapsed = Date.now() - t0;
    expect(res.degraded ?? '').toContain('stopped_early');
    expect(res.hits).toHaveLength(2); // the ranking it had, never a short page
    expect(budgets.length).toBeGreaterThan(0);
    for (const b of budgets) { expect(b).toBeGreaterThan(0); expect(b).toBeLessThanOrEqual(1000); }
    // The 1000 ms budget plus slack; unbounded, the one slowed statement alone takes 3.6 s.
    expect(elapsed).toBeLessThan(2500);
  }, 60_000);

  it('the lexical budget is the statement\'s own: a fast widening under it completes and is not flagged by the budget', async () => {
    // With a generous budget and the real (unslowed) statement, the widening returns normally: the budget only cuts.
    const rows = await realLexical({ db, memoryIds: [mem], query: 'body', sort: 'relevance', offset: 0, limit: 50, statementTimeoutMs: 5000 });
    expect(rows).toHaveLength(N);
    await expect(realLexical({ db: slowDb, memoryIds: [mem], query: 'body', sort: 'relevance', offset: 0, limit: 50, statementTimeoutMs: 200 }))
      .rejects.toMatchObject({ meta: expect.objectContaining({ code: '57014' }) });
  }, 60_000);
});
