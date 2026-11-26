/**
 * #5011 (Billing A4) M1: a measurement, not a CI check. Runs only with CREDIT_REPLAY_BENCH=1:
 *
 *   CREDIT_REPLAY_BENCH=1 CREDIT_REPLAY_BENCH_OUT=/path/to/m1.txt pnpm vitest run src/lib/metering/expiryBench5011.test.ts
 *
 * The result line goes to the console and, when CREDIT_REPLAY_BENCH_OUT names a file, is appended to it.
 *
 * One organization with 100,000 ledger entries in the shape of review-rev11 ledger L6 (a grant each month that
 * expires 45 days later, so grants overlap, with debits in between), none settled, so the replay window opens at the
 * first entry and every entry is replayed. Times the probe, the window reads and `replayLedger` separately and prints
 * the median of five runs of each. The plan sets no threshold for A4.
 */
import { appendFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../id.js';
import { replayLedger } from './expiry.js';
import { hasUnsettledExpiredGrant, readReplayWindow } from './settleExpiredGrants.js';

const ENTRIES = 100_000;
const GRANTS = 100;
const DAY = 86_400_000;
const RUNS = 5;

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

async function time<T>(fn: () => Promise<T> | T): Promise<{ ms: number; value: T }> {
  const t0 = performance.now();
  const value = await fn();
  return { ms: performance.now() - t0, value };
}

describe('#5011 M1: one replay over 100,000 entries', () => {
  it.runIf(process.env.CREDIT_REPLAY_BENCH === '1')(
    'times the probe, the reads and the replay (median of five)',
    async () => {
      await cleanDb(db);
      const orgId = (await db.organization.create({ data: { id: generateId(), name: 'm1-org', urn: 'm1-org' } })).id;
      const t0 = Date.UTC(2020, 0, 1);
      const debitsPerMonth = (ENTRIES - GRANTS) / GRANTS;
      const rows = [];
      for (let m = 0; m < GRANTS; m++) {
        const at = t0 + m * 30 * DAY;
        rows.push({
          id: generateId(),
          organizationId: orgId,
          kind: 'grant',
          amountMicroCents: 1_000_000n,
          expiresAt: new Date(at + 45 * DAY),
          sourceType: 'bench-grant',
          sourceId: generateId(),
          createdAt: new Date(at),
        });
        for (let k = 0; k < debitsPerMonth; k++) {
          rows.push({
            id: generateId(),
            organizationId: orgId,
            kind: 'debit',
            amountMicroCents: -BigInt(500 + ((m * 7 + k) % 900)),
            expiresAt: null,
            sourceType: 'usage-event',
            sourceId: generateId(),
            createdAt: new Date(at + 1 + Math.floor(((k + 1) * 30 * DAY) / (debitsPerMonth + 1))),
          });
        }
      }
      expect(rows).toHaveLength(ENTRIES);
      for (let i = 0; i < rows.length; i += 5_000) {
        await db.creditLedgerEntry.createMany({ data: rows.slice(i, i + 5_000) });
      }
      await db.$executeRawUnsafe('ANALYZE credit_ledger_entries');
      const now = new Date(t0 + GRANTS * 30 * DAY + 60 * DAY);

      const probe: number[] = [];
      const reads: number[] = [];
      const replay: number[] = [];
      for (let r = 0; r < RUNS; r++) {
        const p = await time(() => hasUnsettledExpiredGrant(db, { organizationId: orgId }, now));
        expect(p.value).toBe(true);
        probe.push(p.ms);
        const w = await time(() => readReplayWindow(db, { organizationId: orgId }, now));
        expect(w.value?.entries).toHaveLength(ENTRIES);
        reads.push(w.ms);
        const window = w.value!;
        const x = await time(() => replayLedger(window.entries, now, { opening: window.opening, settled: window.settled }));
        expect(x.value.toSettle).toHaveLength(GRANTS);
        replay.push(x.ms);
      }
      const [pg] = await db.$queryRaw<{ version: string }[]>`SELECT version() AS version`;
      const line =
        `M1 #5011 entries=${ENTRIES} grants=${GRANTS} runs=${RUNS} ` +
          `probe_ms=${median(probe).toFixed(2)} reads_ms=${median(reads).toFixed(1)} replay_ms=${median(replay).toFixed(1)} ` +
          `all=${JSON.stringify({ probe, reads, replay }, (_, v) => (typeof v === 'number' ? Math.round(v * 100) / 100 : v))} ` +
          `node=${process.version} db=${pg.version.split(',')[0]}`;
      console.log(line);
      if (process.env.CREDIT_REPLAY_BENCH_OUT) appendFileSync(process.env.CREDIT_REPLAY_BENCH_OUT, `${line}\n`);
    },
    600_000,
  );
});
