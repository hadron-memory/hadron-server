/**
 * #2022 (S6, cor:agt:090:05) — the expiry sweep: record every stop signal whose until has passed, with its notices.
 *
 * An expiry is in effect at its until whether or not this has run (every reader checks `until`), so the sweep is
 * bookkeeping: the `stop.expired` event, the coverage intervals closed at the until, the resume notices. It runs at
 * the start of the matcher's minute (src/jobs/taskMatcher.ts), before matching, so a worker a signal no longer covers
 * is matched in the same pass. Each App is its own transaction: authority anchor shared, then the stop fence
 * exclusive, then `reconcileStopCoverage`, which records each expiry once however many sweeps race it.
 */

import { Prisma, type PrismaClient } from '../../generated/prisma/index.js';
import { lockAuthorityAnchors } from '../auth/authorityAnchors.js';
import { toNaiveUtc } from '../sessionActivity.js';
import { reconcileStopCoverage } from './lifecycle.js';
import { afterWaits, anchorNow, lockStopFence } from './state.js';

/** One sweep at `now`. Returns the ids of the signals it recorded as expired. A failure in one App is logged. */
export async function sweepExpiredStopSignals(db: PrismaClient, now: Date, anchor: number = anchorNow()): Promise<string[]> {
  const apps = await db.$queryRaw<{ appId: string }[]>(Prisma.sql`
    SELECT DISTINCT s.app_id AS "appId" FROM team_stop_signals s
    JOIN apps a ON a.id = s.app_id AND a.deleted_at IS NULL
    WHERE s.ended_at IS NULL AND s.until IS NOT NULL AND s.until <= ${toNaiveUtc(now)}::timestamp`);
  const out: string[] = [];
  for (const { appId } of apps) {
    try {
      const r = await db.$transaction(async (tx) => {
        await lockAuthorityAnchors(tx, [{ kind: 'app', id: appId }], 'shared');
        await lockStopFence(tx, appId, 'exclusive');
        return reconcileStopCoverage(tx, appId, afterWaits(now, anchor));
      });
      out.push(...r.expired);
    } catch (err) {
      console.error(`[stop-signals] expiry sweep of App ${appId} failed:`, err);
    }
  }
  return out;
}
