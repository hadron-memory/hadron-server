/**
 * sweepGrantLapse (#4178): ends the grants of agents whose installation lapsed with no write door (a licence that expired or was
 * revoked behind a derived install, a soft-deleted organization). The rule, the stamp time and the disclosed limits are in
 * src/lib/grants/lapseSweep.ts. Every five minutes, first pass after 90 seconds. The lag in which a lapsed agent's grant still derives
 * ACTIVE (nothing is exposed: the reach check refuses use) is one interval, plus the 90 s first pass after a boot; a run judges at most
 * 4000 pairs and the next run RESUMES after the last one (the cursor lives in this closure, so a restart starts over), so a larger candidate
 * set is covered over successive runs, not starved behind its healthy prefix. Steady-state cost: one candidate SELECT and up to 4000
 * `resolveAppInstallation` calls per run, in pages of 50. Like the other loops here (gcOauthClients), it returns the first timer and
 * keeps no handle on the interval (unref'd, not stoppable): tests drive `sweepLapsedAgentGrants` directly.
 *
 * Hand-run: `pnpm tsx src/jobs/sweepGrantLapse.ts`.
 */
import type { PrismaClient } from '../generated/prisma/index.js';
import { sweepLapsedAgentGrants, type LapseSweepCursor } from '../lib/grants/lapseSweep.js';
import { isProcessEntry } from './isProcessEntry.js';

export const GRANT_LAPSE_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

export function startGrantLapseSweepLoop(
  db: PrismaClient,
  options: { intervalMs?: number; initialDelayMs?: number } = {},
): NodeJS.Timeout {
  const intervalMs = options.intervalMs ?? GRANT_LAPSE_SWEEP_INTERVAL_MS;
  const initialDelayMs = options.initialDelayMs ?? 90 * 1000;
  let running = false;
  // The cursor persists ACROSS runs (in memory; a restart starts over): a run judges at most 4000 pairs, and without this a healthy prefix
  // longer than that would be re-judged every run while the pairs behind it were never reached (#4178 BLIND).
  let cursor: LapseSweepCursor | null = null;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      const out = await sweepLapsedAgentGrants(db, { after: cursor });
      cursor = out.cursor;
      if (out.grantsEnded > 0) {
        console.log(`[grant-lapse-sweep] ended ${out.grantsEnded} grants across ${out.pairsDeparted} (App, agent) pairs with no installation left`);
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
