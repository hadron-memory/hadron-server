/**
 * #2772 — request-level bounds on vector search (BLIND P1/P2 at b07e0311). Offset has no ceiling by design (#437), so
 * the work is bounded by ONE budget for the whole request, a ceiling on the ANN widening, and a transaction clock
 * that cannot beat the statement budget. Also: the default node-type exclusion rides inside the vector statement.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, createDbOrgAndGraph } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import type { EmbeddingClient } from '../../../lib/embedding/index.js';
import { setEmbeddingClientForTests, resetEmbeddingClientForTests } from '../../../lib/embedding/index.js';
import {
  VECTOR_ANN_MAX_K, VECTOR_TX_MARGIN_MS, isStatementTimeout, iterativeScanSupported, setIterativeScanSupportForTests, vectorSearchNodes,
} from '../../../services/embedding/vectors.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));

const DIM = 768;
const qvec = () => { const q = new Array(DIM).fill(0); q[1] = 1; return q; };
const stub: EmbeddingClient = { provider: 'test', model: 'stub-model', dim: DIM, async embed(texts: string[]) { return texts.map(() => qvec()); } };
const VEC = `'[${qvec().join(',')}]'::vector`;
let mem: string;
let chatIds: string[] = [];
let savedUrl: string | undefined;

const findNodes = (args: Record<string, unknown>) =>
  (resolvers.Query as any).findNodes(null, { ...args, filter: { ...((args.filter as object) ?? {}), memoryIds: [mem] } }, { db, roles: ['ADMIN'], userId: 'admin-2772b' } as Context);

beforeAll(async () => {
  await cleanDb(db);
  savedUrl = process.env.EMBEDDING_API_URL;
  process.env.EMBEDDING_API_URL = 'http://stub.local/api/embed';
  setEmbeddingClientForTests(stub);
  const made = await createDbOrgAndGraph(db, { orgName: 'r2772b-org', graphName: 'r2772b/mem' });
  mem = made.graph.id;
  await db.memory.update({ where: { id: mem }, data: { vectorIndexEnabled: true, embeddingSource: 'contentChunks' } });
  chatIds = Array.from({ length: 40 }, () => generateId());
  await db.node.createMany({ data: chatIds.map((id, i) => ({ id, memoryId: mem, loc: `c${i}`, name: `c${i}`, content: 'body', nodeType: 'chat-message' })) });
  await db.node.createMany({ data: Array.from({ length: 30 }, (_, i) => ({ id: generateId(), memoryId: mem, loc: `i${i}`, name: `i${i}`, content: 'body', role: 'review' })) });
  // Every vector sits exactly on the query: the 40 chat messages tie with, and by id may rank ahead of, the 30 real nodes.
  await db.$executeRawUnsafe(`
    INSERT INTO node_embeddings (id, node_id, memory_id, kind, provider, model, dim, chunk_index, char_start, char_end, chunk_text, embedding, created_at)
    SELECT md5(id), id, memory_id, 'chunk', 'test', 'stub-model', ${DIM}, 0, 0, 4, 'body', ${VEC}, now() FROM nodes WHERE memory_id = '${mem}'`);
}, 120_000);

afterAll(() => {
  resetEmbeddingClientForTests();
  setIterativeScanSupportForTests(null);
  if (savedUrl === undefined) delete process.env.EMBEDDING_API_URL; else process.env.EMBEDDING_API_URL = savedUrl;
});

describe('#2772 default exclusion rides inside the vector statement (BLIND P2-4)', () => {
  it('an unfiltered search where the nearest vectors are chat messages still fills the page with real nodes', async () => {
    const res = await findNodes({ query: 'q', mode: 'vector', limit: 20 });
    const got = res.hits.map((h: any) => h.node.id);
    expect(got).toHaveLength(20);
    expect(got.filter((id: string) => chatIds.includes(id))).toEqual([]);
  }, 60_000);
});

describe('#2772 request-level bounds (BLIND P1)', () => {
  it('a huge offset is one exact statement under the budget: the whole ranking, never an error or a widening loop', async () => {
    const seen: string[] = [];
    const handle = new Proxy(db, { get(t, p) {
      const v = Reflect.get(t, p);
      if (p !== '$transaction') return typeof v === 'function' ? v.bind(t) : v;
      return (arg: unknown, opts?: unknown) => typeof arg !== 'function' ? (t.$transaction as any)(arg, opts)
        : (t.$transaction as any)(async (tx: any) => {
            const w = new Proxy(tx, { get(tt, pp) {
              const vv = Reflect.get(tt, pp);
              if (pp === '$queryRaw') return (s: TemplateStringsArray, ...a: unknown[]) => { seen.push(s.join('?')); return (vv as any).call(tt, s, ...a); };
              return typeof vv === 'function' ? vv.bind(tt) : vv;
            } });
            return (arg as (x: unknown) => unknown)(w);
          }, opts);
    } }) as typeof db;
    const hits = await vectorSearchNodes(handle, { memoryIds: [mem], queryEmbedding: qvec(), limit: 5_000_000 });
    // `limit` is the number of ranked rows WANTED: asking for millions returns the whole ranking (70 vectors), in ONE
    // exact statement (a small scope: the capped count of the caller's own vectors, then the exact scan; no ANN
    // widening) rather than a loop of ever wider scans.
    expect(hits).toHaveLength(70);
    expect(seen).toHaveLength(2);
    expect(seen[0]).toContain('count(*)::int AS n');
    expect(seen[1]).toContain('MATERIALIZED');
  }, 60_000);

  it('SEC P2 (Riana): a small scope never walks the global HNSW index, so other tenants\' vectors cannot shape its work', async () => {
    const other = await createDbOrgAndGraph(db, { orgName: 'r2772b-foreign', graphName: 'r2772b/foreign' });
    const fm = other.graph.id;
    await db.memory.update({ where: { id: fm }, data: { vectorIndexEnabled: true, embeddingSource: 'contentChunks' } });
    await db.node.createMany({ data: Array.from({ length: 30 }, (_, i) => ({ id: generateId(), memoryId: fm, loc: `f${i}`, name: `f${i}`, content: 'body', role: 'review' })) });
    await db.$executeRawUnsafe(`
      INSERT INTO node_embeddings (id, node_id, memory_id, kind, provider, model, dim, chunk_index, char_start, char_end, chunk_text, embedding, created_at)
      SELECT md5(id), id, memory_id, 'chunk', 'test', 'stub-model', ${DIM}, 0, 0, 4, 'body', ${VEC}, now() FROM nodes WHERE memory_id = '${fm}'`);
    const seen: string[] = [];
    const handle = new Proxy(db, { get(t, p) {
      const v = Reflect.get(t, p);
      if (p !== '$transaction') return typeof v === 'function' ? v.bind(t) : v;
      return (arg: unknown, opts?: unknown) => typeof arg !== 'function' ? (t.$transaction as any)(arg, opts)
        : (t.$transaction as any)(async (tx: any) => (arg as (x: unknown) => unknown)(new Proxy(tx, { get(tt, pp) {
            const vv = Reflect.get(tt, pp);
            if (pp === '$queryRaw') return (s: TemplateStringsArray, ...a: unknown[]) => { seen.push(s.join('?')); return (vv as any).call(tt, s, ...a); };
            return typeof vv === 'function' ? vv.bind(tt) : vv;
          } })), opts);
    } }) as typeof db;
    const hits = await vectorSearchNodes(handle, { memoryIds: [mem], queryEmbedding: qvec(), limit: 5 });
    expect(hits).toHaveLength(5);
    expect(seen.some((q) => !q.includes('MATERIALIZED') && !q.includes('count(*)::int AS n'))).toBe(false);
  }, 60_000);

  it('every vector transaction carries a Prisma clock past the statement budget', async () => {
    const opts: any[] = [];
    const handle = new Proxy(db, { get(t, p) {
      const v = Reflect.get(t, p);
      if (p !== '$transaction') return typeof v === 'function' ? v.bind(t) : v;
      return (arg: unknown, o?: unknown) => { opts.push(o); return (t.$transaction as any)(arg, o); };
    } }) as typeof db;
    process.env.VECTOR_SEARCH_TIMEOUT_MS = '7000';
    try {
      await vectorSearchNodes(handle, { memoryIds: [mem], queryEmbedding: qvec(), limit: 5 });
    } finally { delete process.env.VECTOR_SEARCH_TIMEOUT_MS; }
    expect(opts.length).toBeGreaterThan(0);
    for (const o of opts) {
      expect(o.timeout).toBeGreaterThan(0);
      expect(o.timeout).toBeLessThanOrEqual(7000 + VECTOR_TX_MARGIN_MS);
      expect(o.timeout).toBeGreaterThanOrEqual(VECTOR_TX_MARGIN_MS + 1);
    }
  }, 60_000);

  it('a statement slower than a budget ABOVE the 5000 ms Prisma default is the early stop, never an internal error', async () => {
    const handle = new Proxy(db, { get(t, p) {
      const v = Reflect.get(t, p);
      if (p !== '$transaction') return typeof v === 'function' ? v.bind(t) : v;
      return (arg: unknown, o?: unknown) => typeof arg !== 'function' ? (t.$transaction as any)(arg, o)
        : (t.$transaction as any)(async (tx: any) => (arg as (x: unknown) => unknown)(new Proxy(tx, { get(tt, pp) {
            const vv = Reflect.get(tt, pp);
            // After the real query, a 30 s statement: Postgres cancels it at statement_timeout (57014) inside the budgeted transaction.
            if (pp === '$queryRaw') return async (s: TemplateStringsArray, ...a: unknown[]) => { const r = await (vv as any).call(tt, s, ...a); await (tt as any).$executeRawUnsafe('SELECT pg_sleep(30)'); return r; };
            return typeof vv === 'function' ? vv.bind(tt) : vv;
          } })), o);
    } }) as typeof db;
    process.env.VECTOR_SEARCH_TIMEOUT_MS = '6000';
    const windows: any[] = [];
    try {
      const hits = await vectorSearchNodes(handle, { memoryIds: [mem], queryEmbedding: qvec(), limit: 5, onWindow: (w: unknown) => windows.push(w) } as any);
      expect(hits).toEqual([]);
    } finally { delete process.env.VECTOR_SEARCH_TIMEOUT_MS; }
    expect(windows.at(-1)?.stoppedEarly).toBe(true);
  }, 60_000);

  it('the budget is ONE per request: each later statement is given only what the earlier ones left', async () => {
    const timeouts: number[] = [];
    const handle = new Proxy(db, { get(t, p) {
      const v = Reflect.get(t, p);
      if (p !== '$transaction') return typeof v === 'function' ? v.bind(t) : v;
      return (arg: unknown, o?: unknown) => typeof arg !== 'function' ? (t.$transaction as any)(arg, o)
        : (t.$transaction as any)(async (tx: any) => (arg as (x: unknown) => unknown)(new Proxy(tx, { get(tt, pp) {
            const vv = Reflect.get(tt, pp);
            if (pp === '$executeRawUnsafe') return (sql: string, ...a: unknown[]) => {
              const m = /SET LOCAL statement_timeout = (\d+)/.exec(sql);
              if (m) timeouts.push(Number(m[1]));
              return (vv as any).call(tt, sql, ...a);
            };
            if (pp === '$queryRaw') return async (s: TemplateStringsArray, ...a: unknown[]) => { const r = await (vv as any).call(tt, s, ...a); await new Promise((res) => setTimeout(res, 400)); return r; };
            return typeof vv === 'function' ? vv.bind(tt) : vv;
          } })), o);
    } }) as typeof db;
    process.env.VECTOR_SEARCH_TIMEOUT_MS = '6000';
    try {
      await vectorSearchNodes(handle, { memoryIds: [mem], queryEmbedding: qvec(), limit: 5 });
    } finally { delete process.env.VECTOR_SEARCH_TIMEOUT_MS; }
    expect(timeouts.length).toBeGreaterThanOrEqual(2);
    expect(timeouts[0]).toBeLessThanOrEqual(6000);
    for (let i = 1; i < timeouts.length; i++) expect(timeouts[i]!).toBeLessThanOrEqual(timeouts[i - 1]! - 350);
  }, 60_000);

  it('the widening has a hard ceiling', () => {
    expect(VECTOR_ANN_MAX_K).toBeGreaterThan(1000);
    expect(VECTOR_ANN_MAX_K).toBeLessThan(1_000_000);
  });
});

describe('#2772 timeout classification (BLIND P2-2, P3-10)', () => {
  it('Postgres statement timeout and Prisma transaction expiry are the early stop; a user cancel is not', () => {
    expect(isStatementTimeout({ meta: { code: '57014' }, message: 'canceling statement due to statement timeout' })).toBe(true);
    expect(isStatementTimeout({ code: 'P2028', message: 'Transaction already closed' })).toBe(true);
    // Pool pressure (maxWait expired before a connection was acquired) is an error, never an early stop.
    expect(isStatementTimeout({ code: 'P2028', message: 'Transaction API error: Unable to start a transaction in the given time.' })).toBe(false);
    expect(isStatementTimeout({ meta: { code: '57014' }, message: 'canceling statement due to user request' })).toBe(false);
    expect(isStatementTimeout(new Error('boom'))).toBe(false);
  });
});

describe('#2772 a failed boot probe is not remembered (BLIND P2-5)', () => {
  it('the probe retries after a read error instead of caching "unsupported" for the process', async () => {
    setIterativeScanSupportForTests(null);
    let calls = 0;
    const fake = { $queryRaw: async () => { calls++; if (calls === 1) throw new Error('connection refused'); return [{ extversion: '0.8.0' }]; } } as unknown as typeof db;
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect(await iterativeScanSupported(fake)).toBe(false);
      expect(await iterativeScanSupported(fake)).toBe(true);
      expect(calls).toBe(2);
    } finally { err.mockRestore(); setIterativeScanSupportForTests(null); }
  });
});
