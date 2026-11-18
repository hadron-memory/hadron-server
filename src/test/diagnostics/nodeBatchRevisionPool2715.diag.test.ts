/**
 * #2715 Slice 1 — DIAGNOSTIC probe, not a regression test. Skipped unless HADRON_DIAG_2715=1.
 *
 * Runs `nodeBatch(memory, locPrefix)` through the real GraphQL executor (fields resolve concurrently, as in
 * production) against a private per-worker test database, selecting `id` alone and `id revision`, at N nodes.
 * Pool size P is set the production way: DB_POOL_CONNECTION_LIMIT at process start (poolDatasourceUrl), and is
 * MEASURED here by counting distinct backends under a 2P burst. Every `$transaction` start is instrumented: the wait
 * between the call and the callback starting (Prisma's maxWait window), its duration, and its error code.
 *
 * Bounded variant (HADRON_DIAG_2715_BOUND=K): the same request with at most K transactions in flight, queued
 * app-side — a diagnostic of whether bounding the fan-out removes the start-wait failures. Product code unchanged.
 *
 * Run: HADRON_DIAG_2715=1 DB_POOL_CONNECTION_LIMIT=<P> [HADRON_DIAG_2715_N=130,170,200] [HADRON_DIAG_2715_BOUND=K]
 *        pnpm -s vitest run src/test/diagnostics/nodeBatchRevisionPool2715.diag.test.ts
 */
import { appendFileSync } from 'node:fs';
import { describe, it } from 'vitest';
import { buildSchema, defaultFieldResolver, graphql } from 'graphql';
import { db } from '../../integrations/db/client.js';
import { cleanDb, createDbOrgAndGraph } from '../helpers.js';
import { resolvers, type Context } from '../../api/graphql/schema/resolvers.js';
import { typeDefs } from '../../api/graphql/schema/typeDefs.js';

const ENABLED = process.env.HADRON_DIAG_2715 === '1';
const NS = (process.env.HADRON_DIAG_2715_N ?? '130,170,200').split(',').map(Number);
const BOUND = process.env.HADRON_DIAG_2715_BOUND ? Number(process.env.HADRON_DIAG_2715_BOUND) : null;
const REPEATS = Number(process.env.HADRON_DIAG_2715_REPEATS ?? '3');
/** Identical nodeBatch requests issued at once, sharing the one pool (a burst). */
const CONCURRENT = Number(process.env.HADRON_DIAG_2715_CONCURRENT ?? '1');

type TxRecord = { waitMs: number; durMs: number; error: string | null; maxWait: number | undefined };

/** A ctx.db whose `$transaction` records start wait and duration; optionally bounded to K in flight app-side. */
function instrument(records: TxRecord[], bound: number | null) {
  let inFlight = 0;
  const queue: Array<() => void> = [];
  const acquire = () => new Promise<void>((resolve) => {
    if (bound === null || inFlight < bound) { inFlight++; resolve(); } else queue.push(() => { inFlight++; resolve(); });
  });
  const release = () => { inFlight--; queue.shift()?.(); };
  const tx = async (fn: unknown, opts?: { maxWait?: number }) => {
    if (typeof fn !== 'function') return (db.$transaction as any)(fn, opts);
    await acquire();
    const called = performance.now();
    let started = 0;
    try {
      const out = await (db.$transaction as any)(async (t: unknown) => { started = performance.now(); return (fn as any)(t); }, opts);
      records.push({ waitMs: started - called, durMs: performance.now() - started, error: null, maxWait: opts?.maxWait });
      return out;
    } catch (err) {
      const code = (err as { code?: string }).code ?? (err as Error).name;
      records.push({ waitMs: (started || performance.now()) - called, durMs: started ? performance.now() - started : 0, error: code, maxWait: opts?.maxWait });
      throw err;
    } finally { release(); }
  };
  return new Proxy(db, {
    get(target, prop) {
      if (prop === '$transaction') return tx;
      const v = Reflect.get(target, prop, target);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  }) as typeof db;
}

const schema = buildSchema(typeDefs);
const fieldResolver = (parent: any, args: any, context: any, info: any) => {
  const fields = resolvers[info.parentType.name as keyof typeof resolvers] as Record<string, Function> | undefined;
  const fn = fields?.[info.fieldName];
  return typeof fn === 'function' ? fn(parent, args, context, info) : defaultFieldResolver(parent, args, context, info);
};

const pct = (xs: number[], p: number) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]!; };
const r1 = (x: number) => Math.round(x * 10) / 10;

describe.runIf(ENABLED)('#2715 nodeBatch revision pool diagnostic', () => {
  it('measures transaction starts, waits and field errors', { timeout: 900_000 }, async () => {
    // Measured pool: distinct backends serving a 2P burst of 300ms sleeps.
    const declared = Number(process.env.HADRON_DIAG_2715_P ?? NaN);
    const burst = Number.isFinite(declared) ? declared * 2 : 40;
    const pids = await Promise.all(Array.from({ length: burst }, () =>
      db.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid, pg_sleep(0.3)::text AS s`.then((r) => r[0]!.pid)));
    const measuredP = new Set(pids).size;

    const out: string[] = [];
    out.push(`P(URL connection_limit)=${process.env.HADRON_DIAG_2715_P ?? "(unset)"} measuredP=${measuredP} bound=${BOUND ?? 'none'} concurrent=${CONCURRENT} repeats=${REPEATS}`);
    for (const n of NS) {
      await cleanDb(db);
      const { org, graph } = await createDbOrgAndGraph(db, { orgName: 'diag2715', graphName: 'diagmem' });
      const user = await db.user.create({ data: { handle: 'diag2715' } });
      await db.orgMember.create({ data: { organizationId: org.id, userId: user.id, role: 'ADMIN' } });
      await db.node.createMany({ data: Array.from({ length: n }, (_, i) => ({
        memoryId: graph.id, loc: `batch:n${String(i).padStart(3, '0')}`, name: `n${i}`, nodeType: 'record', content: `body ${i}`,
      })) as never });
      const ctx = (records: TxRecord[]) => ({ db: instrument(records, BOUND), roles: [], userId: user.id }) as unknown as Context;
      const run = async (sel: string) => {
        const records: TxRecord[] = [];
        const t0 = performance.now();
        const all = await Promise.all(Array.from({ length: CONCURRENT }, () => graphql({ schema, fieldResolver, contextValue: ctx(records),
          source: `query($m: ID!) { nodeBatch(memory: $m, locPrefix: "batch") { nodes { ${sel} } } }`, variableValues: { m: graph.id } })));
        const total = performance.now() - t0;
        const nodes = all.flatMap((res) => (res.data?.nodeBatch as any)?.nodes ?? []);
        const errs = all.flatMap((res) => res.errors ?? []);
        const codes = new Map<string, number>();
        for (const e of errs) { const c = String((e.originalError as any)?.code ?? e.extensions?.code ?? e.message.slice(0, 40)); codes.set(c, (codes.get(c) ?? 0) + 1); }
        const pre = records.filter((r) => r.maxWait === 15_000);
        const field = records.filter((r) => r.maxWait === 2_000);
        const fieldErr = field.filter((r) => r.error);
        return `  sel=[${sel}] totalMs=${r1(total)} nodes=${nodes.length} nullRevision=${nodes.filter((x: any) => sel.includes('revision') && x?.revision == null).length} errors=${errs.length} ${[...codes].map(([c, k]) => `${c}x${k}`).join(',')} firstPaths=${errs.slice(0, 3).map((e) => e.path?.join('.')).join(' ')}\n` +
          `    preReconcile tx=${pre.length} wait p50/p95/max=${r1(pct(pre.map((r) => r.waitMs), .5))}/${r1(pct(pre.map((r) => r.waitMs), .95))}/${r1(Math.max(0, ...pre.map((r) => r.waitMs)))} dur p50=${r1(pct(pre.map((r) => r.durMs), .5))}\n` +
          `    fieldRevision tx=${field.length} failed=${fieldErr.length} (${[...new Set(fieldErr.map((r) => r.error))].join(',')}) wait p50/p95/max=${r1(pct(field.map((r) => r.waitMs), .5))}/${r1(pct(field.map((r) => r.waitMs), .95))}/${r1(Math.max(0, ...field.map((r) => r.waitMs)))} dur p50/max=${r1(pct(field.map((r) => r.durMs), .5))}/${r1(Math.max(0, ...field.map((r) => r.durMs)))}\n` +
          `    other tx=${records.length - pre.length - field.length}`;
      };
      // Warm: the first read reconciles nodes created without a fingerprint; measured runs are then unchanged batches.
      await run('id revision');
      const revBefore = await db.nodeRevision.count({ where: { node: { memoryId: graph.id } } });
      out.push(`N=${n}`);
      for (let i = 0; i < REPEATS; i++) {
        out.push(await run('id'));
        out.push(await run('id revision'));
      }
      out.push(`  reconcileWritesDuringMeasuredRuns=${(await db.nodeRevision.count({ where: { node: { memoryId: graph.id } } })) - revBefore}`);
    }
    // The test config mutes console output; the report goes to a file the runner names.
    appendFileSync(process.env.HADRON_DIAG_2715_OUT ?? '/dev/stderr', `\n#2715 DIAG\n${out.join('\n')}\n`);
  });
});
