/**
 * #4938 N2 (Celine, QA on #4928 at 5ad0665b) — the pgvector-version probe runs under the request's budget.
 *
 * `rankUnderBudget` used to await `iterativeScanSupported(db)` before building the budget clock and OUTSIDE the
 * budgeted transaction. A cold probe (a fresh process, or a probe that failed, which is deliberately not cached) is then a
 * plain `$queryRaw`, which on a saturated pool waits Prisma's connection-acquire `pool_timeout` (default 10 s), not the
 * transaction's deadline-capped `maxWait`: the search came back `stoppedEarly`, honestly, but ~10 s late against a 400 ms
 * deadline. The probe now runs inside the budgeted transaction, so the deadline bounds its wait like every other vector
 * statement, and a request whose deadline already passed never takes a connection to probe.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { PrismaClient, Prisma } from '../../generated/prisma/index.js';
import { setIterativeScanSupportForTests, setIterativeScanProbeSqlForTests, vectorSearchNodes } from './vectors.js';

const DIM = 768;
const q = Array.from({ length: DIM }, (_, i) => (i === 1 ? 1 : 0));

/** A client whose ONE pooled connection a second transaction can hold. pool_timeout=3 keeps the unfixed (red) wait short. */
function onePool(): PrismaClient {
  const url = new URL(process.env.DATABASE_URL!);
  url.searchParams.set('connection_limit', '1');
  url.searchParams.set('pool_timeout', '3');
  return new PrismaClient({ datasourceUrl: url.toString() });
}

/**
 * Holds the client's only connection for `ms`; resolves once the hold has started. The end of the hold is returned WRAPPED:
 * an async function returning the promise itself would adopt it, and the caller would wait out the whole hold.
 */
async function hold(client: PrismaClient, ms: number): Promise<{ done: Promise<unknown> }> {
  let started!: () => void;
  const ready = new Promise<void>((r) => { started = r; });
  const held = client.$transaction(async (tx) => {
    started();
    await tx.$executeRawUnsafe(`SELECT pg_sleep(${ms / 1000})`);
  }, { timeout: ms + 10000, maxWait: 10000 }).catch(() => undefined);
  await ready;
  await new Promise((r) => setTimeout(r, 200)); // the hold's statement is on the wire
  return { done: held };
}

afterEach(() => { setIterativeScanSupportForTests(null); });

describe('#4938 N2 — the version probe waits under the request deadline, not pool_timeout', () => {
  it('a COLD probe on a saturated pool: the search stops early inside the deadline (red: ~pool_timeout late)', async () => {
    const client = onePool();
    try {
      await client.$queryRaw`SELECT 1`; // the pool's one connection exists
      setIterativeScanSupportForTests(null); // the real probe, and nothing cached: cold
      const { done: held } = await hold(client, 6000);
      let w: { exhausted: boolean; stoppedEarly?: boolean } | undefined;
      const t0 = Date.now();
      const hits = await vectorSearchNodes(client, {
        memoryIds: ['00000000000000000000000000000000'], queryEmbedding: q, limit: 10,
        deadlineAt: Date.now() + 400, onWindow: (x) => { w = x; },
      });
      const elapsed = Date.now() - t0;
      expect(hits).toEqual([]);
      expect(w).toEqual({ exhausted: false, stoppedEarly: true });
      // The deadline (400 ms) plus scheduling slack; the unfixed wait is pool_timeout (3000 ms).
      expect(elapsed).toBeLessThan(1500);
      await held;
    } finally {
      await client.$disconnect();
    }
  }, 20000);

  it('a request whose deadline already passed never takes a connection to probe', async () => {
    const client = onePool();
    try {
      await client.$queryRaw`SELECT 1`;
      setIterativeScanSupportForTests(null);
      const { done: held } = await hold(client, 6000);
      let w: { exhausted: boolean; stoppedEarly?: boolean } | undefined;
      const t0 = Date.now();
      const hits = await vectorSearchNodes(client, {
        memoryIds: ['00000000000000000000000000000000'], queryEmbedding: q, limit: 10,
        deadlineAt: Date.now() - 1, onWindow: (x) => { w = x; },
      });
      expect(hits).toEqual([]);
      expect(w).toEqual({ exhausted: false, stoppedEarly: true });
      expect(Date.now() - t0).toBeLessThan(200);
      await held;
    } finally {
      await client.$disconnect();
    }
  }, 20000);
});

/**
 * #4938 BLIND P2 (Billie, at 548c0cb9): the probe now runs INSIDE the budgeted transaction, and its failure is caught and
 * answered "exact scan". But a statement that fails inside a Postgres transaction aborts it (25P02): without a savepoint
 * the exact statement after the caught failure is refused, and the search throws instead of falling back.
 */
describe('#4938 BLIND P2 — a probe that fails inside the transaction leaves it usable', () => {
  afterEach(() => { setIterativeScanProbeSqlForTests(null); });

  it('a probe raising a SQL error falls back to the exact scan in the same transaction (red: 25P02, the search throws)', async () => {
    const client = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL! });
    try {
      setIterativeScanSupportForTests(null); // the real probe path, uncached
      setIterativeScanProbeSqlForTests(Prisma.sql`SELECT (1 / 0)::text AS extversion`); // a real SQL error (22012)
      let w: { exhausted: boolean; stoppedEarly?: boolean } | undefined;
      const hits = await vectorSearchNodes(client, {
        memoryIds: ['00000000000000000000000000000000'], queryEmbedding: q, limit: 10,
        onWindow: (x) => { w = x; },
      });
      expect(hits).toEqual([]);
      expect(w).toEqual({ exhausted: true, stoppedEarly: false });
    } finally {
      await client.$disconnect();
    }
  }, 20000);

  it('a failed probe is not cached: the next search probes again (and a healthy probe still answers)', async () => {
    // #5002: a failure wrongly cached as `false` would still return the same empty page (the exact scan), so the pin counts
    // the probes the searches actually run. ONE probe statement does both: its first run fails (a real SQL error, 22012) and
    // every later run answers the real version, and a sequence counts the runs (a sequence does not roll back with the
    // probe's savepoint). No seam is touched between the two searches: resetting the probe SQL also drops the cached answer,
    // which would hide exactly the caching this pin is for.
    const client = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL! });
    const seq = `probe5002_${process.pid}_${Date.now()}`;
    const probes = async () => Number((await client.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT CASE WHEN is_called THEN last_value ELSE 0 END AS n FROM ${seq}`))[0].n);
    try {
      await client.$executeRawUnsafe(`CREATE SEQUENCE ${seq}`);
      setIterativeScanSupportForTests(null);
      // The divisor is not a constant, so the planner cannot fold the error into every run.
      setIterativeScanProbeSqlForTests(Prisma.sql([`SELECT CASE WHEN nextval('${seq}') = 1 THEN (1 / (currval('${seq}') - 1))::text
        ELSE extversion END AS extversion FROM pg_extension WHERE extname = 'vector'`]));
      await vectorSearchNodes(client, { memoryIds: ['00000000000000000000000000000000'], queryEmbedding: q, limit: 10 });
      expect(await probes()).toBe(1);
      let w: { exhausted: boolean; stoppedEarly?: boolean } | undefined;
      const hits = await vectorSearchNodes(client, {
        memoryIds: ['00000000000000000000000000000000'], queryEmbedding: q, limit: 10, onWindow: (x) => { w = x; },
      });
      expect(hits).toEqual([]);
      expect(w?.stoppedEarly ?? false).toBe(false);
      expect(await probes()).toBe(2); // the second search probed again (red: a cached failure never probes)
      await vectorSearchNodes(client, { memoryIds: ['00000000000000000000000000000000'], queryEmbedding: q, limit: 10 });
      expect(await probes()).toBe(2); // and a healthy answer IS cached
    } finally {
      setIterativeScanProbeSqlForTests(null);
      await client.$executeRawUnsafe(`DROP SEQUENCE IF EXISTS ${seq}`).catch(() => undefined);
      await client.$disconnect();
    }
  }, 20000);
});

/**
 * #4938 LOCAL P3-1 (Beryl, at 548c0cb9): the probe must run on the TRANSACTION's client. Probed on the pool instead, from
 * inside the transaction, it waits for a second connection: on a one-connection pool that is the one the transaction
 * holds, so the probe waits pool_timeout (3 s here) and fails. The held-pool pins above cannot see this (the transaction
 * itself never gets a connection there, so the probe never runs).
 */
describe('#4938 LOCAL P3-1 — the probe runs on the transaction client', () => {
  it('a cold probe on a free one-connection pool answers inside the transaction, without a second connection (red: ~pool_timeout)', async () => {
    const client = onePool();
    const errors: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((m: unknown) => { errors.push(String(m)); });
    try {
      await client.$queryRaw`SELECT 1`;
      setIterativeScanSupportForTests(null); // cold: the real probe runs in this search
      const t0 = Date.now();
      const hits = await vectorSearchNodes(client, {
        memoryIds: ['00000000000000000000000000000000'], queryEmbedding: q, limit: 10, deadlineAt: Date.now() + 10_000,
      });
      expect(hits).toEqual([]);
      expect(Date.now() - t0).toBeLessThan(2000); // pool_timeout is 3000
      expect(errors.filter((e) => e.includes('iterative_scan_probe_failed'))).toEqual([]);
    } finally {
      spy.mockRestore();
      await client.$disconnect();
    }
  }, 20000);
});
