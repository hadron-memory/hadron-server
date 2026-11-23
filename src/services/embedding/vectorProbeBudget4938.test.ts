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
import { describe, it, expect, afterEach } from 'vitest';
import { PrismaClient } from '../../generated/prisma/index.js';
import { setIterativeScanSupportForTests, vectorSearchNodes } from './vectors.js';

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
