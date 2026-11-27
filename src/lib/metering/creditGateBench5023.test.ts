/**
 * #5023 (Billing A3) measurement, not a CI check. Runs only with CREDIT_GATE_BENCH=1:
 *
 *   CREDIT_GATE_BENCH=1 CREDIT_GATE_BENCH_OUT=/path/to/out.txt pnpm vitest run src/lib/metering/creditGateBench5023.test.ts
 *
 * One organization with 100,000 ledger entries (one permanent grant and debits, so the sum reads all of them), a stored
 * balance above zero. Times `requireCreditHeadroom` (the database clock, the month's grant check, the settle probe and the
 * stored sum, in one REPEATABLE READ snapshot) over 300 calls and prints the p50, p95 and p99. The gate ruling 7 threshold is
 * 5 ms at p95: above it the build stops and asks Holger.
 */
import { appendFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../id.js';
import { requireCreditHeadroom } from './gate.js';
import { creditBalance } from './index.js';
import { databaseNow, hasUnsettledExpiredGrant } from './settleExpiredGrants.js';

const ENTRIES = 100_000;
const CALLS = 300;
const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))];

describe('#5023 gate measurement: requireCreditHeadroom over 100,000 entries', () => {
  it.runIf(process.env.CREDIT_GATE_BENCH === '1')('p50, p95 and p99 of the gate', async () => {
    await cleanDb(db);
    const orgId = (await db.organization.create({ data: { id: generateId(), name: 'gate-bench', urn: 'gate-bench' } })).id;
    const t0 = Date.UTC(2020, 0, 1);
    const rows = [{
      id: generateId(), organizationId: orgId, kind: 'grant', amountMicroCents: 10_000_000_000n, expiresAt: null,
      sourceType: 'bench-grant', sourceId: generateId(), createdAt: new Date(t0),
    }];
    for (let i = 1; i < ENTRIES; i++) {
      rows.push({
        id: generateId(), organizationId: orgId, kind: 'debit', amountMicroCents: -BigInt(500 + (i % 900)), expiresAt: null,
        sourceType: 'usage-event', sourceId: generateId(), createdAt: new Date(t0 + i * 1000),
      });
    }
    for (let i = 0; i < rows.length; i += 5_000) await db.creditLedgerEntry.createMany({ data: rows.slice(i, i + 5_000) });
    await db.$executeRawUnsafe('ANALYZE credit_ledger_entries');
    for (let i = 0; i < 20; i++) await requireCreditHeadroom(db, { organizationId: orgId }); // warm
    const ms: number[] = [];
    for (let i = 0; i < CALLS; i++) {
      const t = performance.now();
      await requireCreditHeadroom(db, { organizationId: orgId });
      ms.push(performance.now() - t);
    }
    // the parts, each over the same 300 calls: the stored sum alone, and the clock plus the settle probe
    const sumMs: number[] = [];
    const restMs: number[] = [];
    for (let i = 0; i < CALLS; i++) {
      let t = performance.now();
      await creditBalance(db, { organizationId: orgId });
      sumMs.push(performance.now() - t);
      t = performance.now();
      const now = await databaseNow(db);
      await hasUnsettledExpiredGrant(db, { organizationId: orgId }, now);
      restMs.push(performance.now() - t);
    }
    const parts = ` sum_p95=${pct(sumMs, 0.95).toFixed(2)}ms clock_probe_p95=${pct(restMs, 0.95).toFixed(2)}ms`;
    // ruling 7, first option: a covering index (organization_id) INCLUDE (amount_micro_cents) WHERE deleted_at IS NULL, then the same calls
    await db.$executeRawUnsafe('CREATE INDEX bench_cover_org ON credit_ledger_entries (organization_id) INCLUDE (amount_micro_cents) WHERE deleted_at IS NULL');
    await db.$executeRawUnsafe('VACUUM (ANALYZE) credit_ledger_entries');
    const coverMs: number[] = [];
    for (let i = 0; i < 20; i++) await requireCreditHeadroom(db, { organizationId: orgId });
    for (let i = 0; i < CALLS; i++) {
      const t = performance.now();
      await requireCreditHeadroom(db, { organizationId: orgId });
      coverMs.push(performance.now() - t);
    }
    await db.$executeRawUnsafe('DROP INDEX IF EXISTS bench_cover_org');
    const cover = ` with_covering_index_p50=${pct(coverMs, 0.5).toFixed(2)}ms p95=${pct(coverMs, 0.95).toFixed(2)}ms p99=${pct(coverMs, 0.99).toFixed(2)}ms`;
    const line = `gate_bench entries=${ENTRIES} calls=${CALLS} p50=${pct(ms, 0.5).toFixed(2)}ms p95=${pct(ms, 0.95).toFixed(2)}ms p99=${pct(ms, 0.99).toFixed(2)}ms max=${Math.max(...ms).toFixed(2)}ms${parts}${cover}`;
    console.log(line);
    if (process.env.CREDIT_GATE_BENCH_OUT) appendFileSync(process.env.CREDIT_GATE_BENCH_OUT, `${line}\n`);
    expect(ms).toHaveLength(CALLS);
  }, 600_000);
});
