/**
 * #2022 (S6) — stop signals (cor:agt:090): what a signal is, which workers it covers, and the App's stop fence.
 *
 * Coverage is LIVE (cor:agt:090:02, Holger R95): it is worked out each time it is checked, from the reporting lines and
 * the host registrations as they are then, so a worker who joins a paused team is covered from that moment and one who
 * leaves it is not. Every enforcement point (the matcher, manual assignment, launches, ticks, stall raises) calls
 * `coveringSignals` for the workers it is deciding about. The coverage LEDGER (`team_stop_coverage`,
 * `./coverage.ts`) is history for the stall clocks and the notices, never an enforcement input.
 *
 * A signal is live while it has not ended and its until (when given) has not passed (090:05, Proposed): an expiry is in
 * effect at `until` even before the sweep records it, so no reader depends on the sweep.
 *
 * Lock order (the stop fence, `lockStopFence`): authority anchors (and, under `withAuthorizedTx`, the anchors' own
 * org / user / App rows FOR SHARE) → STOP FENCE → the reportsTo graph lock → the host-lapse lock → every other row.
 * A path that takes no authority anchors takes the fence before ANY row, the App row included (`retireWorker`, a
 * bind that sets reportsTo): an App-row writer holds the fence shared before it updates its App row, so a fence
 * taken after an App row lock deadlocks against it (Diego #2166 P2-2, a real 40P01). Writers that change a signal or the topology coverage is computed from take it EXCLUSIVE
 * (set, lift, expiry, `setWorkerReportsTo`, `retireWorker`, a bind that sets reportsTo, `registerHost`); deciders take it
 * SHARED (task writes, the matcher's assignment, a launch, a stall raise), so a decision and a signal change are
 * ordered. Never upgraded from shared to exclusive in one transaction.
 */

import { Prisma, type PrismaClient } from '../../generated/prisma/index.js';
import { toNaiveUtc } from '../sessionActivity.js';

type Db = PrismaClient | Prisma.TransactionClient;

/** cor:agt:090:01 — the three levels, weakest first. Each stops everything the one before it stops (R68). */
export const STOP_LEVELS = ['pause-dispatch', 'pause', 'halt'] as const;
export type StopLevel = (typeof STOP_LEVELS)[number];
/** cor:agt:090:01 — the three scopes. A team is named by its head (D-2026-10-16-004). */
export const STOP_SCOPES = ['worker', 'team', 'host'] as const;
export type StopScope = (typeof STOP_SCOPES)[number];

export const levelRank = (l: StopLevel): number => STOP_LEVELS.indexOf(l);

/** R68: `pause` and `halt` also stop ticks and stall time; `pause-dispatch` stops assignment only. */
export const stopsTime = (l: StopLevel): boolean => l === 'pause' || l === 'halt';

/** One stop signal row, as every reader sees it. Ids and times only (no text, cor:agt:050:11). */
export type StopSignal = {
  id: string;
  appId: string;
  level: StopLevel;
  scope: StopScope;
  targetWorkerId: string | null;
  targetHostRegistrationId: string | null;
  setAt: Date;
  until: Date | null;
  setByUserId: string | null;
  setByAppKeyId: string | null;
  endedAt: Date | null;
  endKind: 'lifted' | 'expired' | null;
  endedByUserId: string | null;
  endedByAppKeyId: string | null;
};

export const SIGNAL_COLUMNS = Prisma.sql`s.id, s.app_id AS "appId", s.level, s.scope, s.target_worker_id AS "targetWorkerId",
  s.target_host_registration_id AS "targetHostRegistrationId", s.set_at AS "setAt", s.until,
  s.set_by_user_id AS "setByUserId", s.set_by_app_key_id AS "setByAppKeyId", s.ended_at AS "endedAt",
  s.end_kind AS "endKind", s.ended_by_user_id AS "endedByUserId", s.ended_by_app_key_id AS "endedByAppKeyId"`;

/** Live at `now` (090:05): not ended, and its until, when given, still ahead. `until == now` has ended. */
export function isLive(s: Pick<StopSignal, 'endedAt' | 'until'>, now: Date): boolean {
  return s.endedAt === null && (s.until === null || s.until.getTime() > now.getTime());
}

/** The SQL form of `isLive` over alias `s`. */
export const liveSql = (now: Date) => Prisma.sql`s.ended_at IS NULL AND (s.until IS NULL OR s.until > ${toNaiveUtc(now)}::timestamp)`;

/**
 * The App's stop fence (see the file header for its place in the lock order). `$executeRaw`: the lock functions
 * return void, which `$queryRaw` cannot deserialize.
 */
export async function lockStopFence(tx: Prisma.TransactionClient, appId: string, mode: 'exclusive' | 'shared'): Promise<void> {
  if (mode === 'exclusive') await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'stop-signals:' + appId}))`;
  else await tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(hashtext(${'stop-signals:' + appId}))`;
}

/**
 * The live signals covering each of `workerIds` in `appId` at `now` (cor:agt:090:02), worked out from the reporting
 * lines and host registrations as they are now:
 *
 * - worker scope: the target worker;
 * - team scope: the head and every worker in its reporting tree, at any depth (never the worker the head reports to);
 * - host scope: every worker the registration lists, whether or not it has a live session there (R84).
 *
 * A retired worker is covered by nothing (it is never assigned, ticked or stalled). `workerIds` null means every worker
 * of the App. Workers of another App never match. A worker no live signal covers is absent from the map. The order
 * within a worker is (setAt, id).
 */
export async function coveringSignals(db: Db, appId: string, workerIds: string[] | null, now: Date): Promise<Map<string, StopSignal[]>> {
  const out = new Map<string, StopSignal[]>();
  if (workerIds !== null && workerIds.length === 0) return out;
  // No live signal in the App: nothing to walk (the common case on every enforcement point).
  const [{ n }] = await db.$queryRaw<{ n: bigint }[]>(Prisma.sql`
    SELECT count(*)::bigint AS n FROM team_stop_signals s WHERE s.app_id = ${appId} AND ${liveSql(now)}`);
  if (Number(n) === 0) return out;
  const only = workerIds === null ? Prisma.empty : Prisma.sql`AND w.id IN (${Prisma.join(workerIds)})`;
  const rows = await db.$queryRaw<(StopSignal & { workerId: string })[]>(Prisma.sql`
    WITH RECURSIVE ws AS (
      SELECT w.id FROM workers w WHERE w.app_id = ${appId} AND w.retired_at IS NULL ${only}
    ), chain AS (
      SELECT ws.id AS worker_id, ws.id AS anc_id, 0 AS depth FROM ws
      UNION ALL
      SELECT c.worker_id, w.reports_to_worker_id, c.depth + 1
      FROM chain c JOIN workers w ON w.id = c.anc_id
      WHERE w.reports_to_worker_id IS NOT NULL AND c.depth < 1000
    )
    SELECT ws.id AS "workerId", ${SIGNAL_COLUMNS}
    FROM ws JOIN team_stop_signals s ON s.app_id = ${appId} AND ${liveSql(now)} AND (
      (s.scope = 'worker' AND s.target_worker_id = ws.id)
      OR (s.scope = 'team' AND EXISTS (SELECT 1 FROM chain c WHERE c.worker_id = ws.id AND c.anc_id = s.target_worker_id))
      OR (s.scope = 'host' AND EXISTS (SELECT 1 FROM host_registration_workers h
                                       WHERE h.registration_id = s.target_host_registration_id AND h.worker_id = ws.id)))
    ORDER BY ws.id, s.set_at, s.id`);
  for (const { workerId, ...s } of rows) {
    const list = out.get(workerId) ?? [];
    list.push(s);
    out.set(workerId, list);
  }
  return out;
}

/**
 * The deciding moment after a transaction's lock waits (Xan #2166 LOCAL-1): `now` advanced by the monotonic time
 * elapsed since `anchor`, where `anchor` is the `performance.now()` sampled TOGETHER with `now` (Xan's delta: pairing an
 * old pass `now` with a later function-entry anchor lost the pass's earlier latency). So a pass hands its decider both
 * halves of one sample, `anchorNow()`; a caller that samples `now` itself passes no anchor and gets one taken at entry,
 * next to that sample. A signal whose until passed in the meantime is ended for the decider, and one set is seen. `now`
 * stays the clock seam, so an injected `now` keeps its meaning (the #2102 `freshAfterWait` pattern, acknowledge.ts).
 */
export function afterWaits(now: Date, anchor: number): Date {
  return new Date(now.getTime() + Math.max(0, performance.now() - anchor));
}

/** The monotonic half of a clock sample, taken where its `now` is taken (see `afterWaits`). */
export const anchorNow = (): number => performance.now();

/** The strongest level among `signals` (R69: every live one applies, so the worker is stopped as the highest says). */
export function strongestLevel(signals: Pick<StopSignal, 'level'>[]): StopLevel | null {
  let best: StopLevel | null = null;
  for (const s of signals) if (best === null || levelRank(s.level) > levelRank(best)) best = s.level;
  return best;
}

/** The workers of `covering` under a `pause` or `halt` (ticks and stall time stop, R68; R71's creator). */
export function timeStoppedWorkers(covering: Map<string, StopSignal[]>): Set<string> {
  const out = new Set<string>();
  for (const [w, list] of covering) if (list.some((s) => stopsTime(s.level))) out.add(w);
  return out;
}
