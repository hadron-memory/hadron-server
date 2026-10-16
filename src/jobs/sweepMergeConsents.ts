/**
 * sweepMergeConsents — the retention sweep for account-merge consent requests
 * (#1770, cor:api:010:02).
 *
 * A retired request (expired or consumed) is kept 30 days after the later of
 * its expiry and its consumption, then deleted. Each run drains in bounded
 * batches ({@link sweepRetiredMergeConsents}), stopping at a short batch or
 * after MAX_PASSES, so a long backlog spreads over several runs. A live proof
 * and a merge's sealed receipt (`user_merges`) are never touched.
 *
 * Run one sweep by hand:
 *   tsx src/jobs/sweepMergeConsents.ts
 */

import type { PrismaClient } from '../generated/prisma/index.js';
import { sweepRetiredMergeConsents } from '../lib/userMergeConsent.js';

const BATCH_SIZE = 500;
const MAX_PASSES = 20;

/** One run: bounded passes until a short batch. Returns the number deleted. */
export async function sweepMergeConsents(db: PrismaClient, now = new Date()): Promise<number> {
  let total = 0;
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const n = await sweepRetiredMergeConsents(db, { now, batchSize: BATCH_SIZE });
    total += n;
    if (n < BATCH_SIZE) break;
  }
  return total;
}

/** Start the recurring sweep (hourly, first run after 60s). Returns the initial timer. */
export function startMergeConsentSweepLoop(
  db: PrismaClient,
  options: { intervalMs?: number; initialDelayMs?: number } = {},
): NodeJS.Timeout {
  const intervalMs = options.intervalMs ?? 60 * 60 * 1000;
  const initialDelayMs = options.initialDelayMs ?? 60 * 1000;
  const run = async () => {
    try {
      const count = await sweepMergeConsents(db);
      if (count > 0) console.log(`[merge-consent-sweep] deleted ${count} retired consent requests`);
    } catch (err) {
      console.error('[merge-consent-sweep] failed:', err);
    }
  };
  return setTimeout(() => {
    void run();
    setInterval(run, intervalMs);
  }, initialDelayMs);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { db } = await import('../integrations/db/client.js');
  console.log(`deleted ${await sweepMergeConsents(db)}`);
  await db.$disconnect();
}
