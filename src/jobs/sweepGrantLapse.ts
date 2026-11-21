/**
 * sweepGrantLapse (#4178): ends the grants of agents whose installation lapsed with no write door (a licence that expired or was
 * revoked behind a derived install, a soft-deleted organization). The rule, the stamp time and the disclosed limits are in
 * src/lib/grants/lapseSweep.ts. Every five minutes, first pass after 90 seconds. An agent with no installation has gone for its
 * grants at the first pass after the lapse, so the lag in which a grant still derives ACTIVE (nothing is exposed: the reach check
 * refuses use) is at most one interval plus one run.
 *
 * Hand-run: `pnpm tsx src/jobs/sweepGrantLapse.ts`.
 */
import type { PrismaClient } from '../generated/prisma/index.js';
import { sweepLapsedAgentGrants } from '../lib/grants/lapseSweep.js';
import { isProcessEntry } from './isProcessEntry.js';

export const GRANT_LAPSE_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

export function startGrantLapseSweepLoop(
  db: PrismaClient,
  options: { intervalMs?: number; initialDelayMs?: number } = {},
): NodeJS.Timeout {
  const intervalMs = options.intervalMs ?? GRANT_LAPSE_SWEEP_INTERVAL_MS;
  const initialDelayMs = options.initialDelayMs ?? 90 * 1000;
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      const out = await sweepLapsedAgentGrants(db);
      if (out.grantsEnded > 0) {
        console.log(`[grant-lapse-sweep] ended ${out.grantsEnded} grants of ${out.pairsDeparted} agents with no installation left`);
      }
    } catch (err) {
      console.error('[grant-lapse-sweep] failed:', err);
    } finally {
      running = false;
    }
  };
  const timer = setTimeout(() => {
    void run();
    setInterval(run, intervalMs).unref();
  }, initialDelayMs);
  timer.unref();
  return timer;
}

if (isProcessEntry(import.meta.url)) {
  const { db } = await import('../integrations/db/client.js');
  console.log(JSON.stringify(await sweepLapsedAgentGrants(db)));
  await db.$disconnect();
}
