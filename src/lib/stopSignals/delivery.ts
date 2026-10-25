/**
 * #2022 (S6), #2169 (S6b) — which stop-signal notice each worker is due (cor:agt:090:04), and which serving lanes can
 * tell a worker about one (R95).
 *
 * The notices are `stop.notice` events (./notices.ts). A worker is due at most ONE: its newest notice not yet
 * delivered, since each notice says what applies to it NOW (reconcile sends one per change). An older undelivered
 * notice is superseded and never offered. One exception (Vera's receipt §4, Proposed): a `resume` whose worker was never
 * told it was stopped (its latest DELIVERED notice is a resume, or there is none) is not offered either: the
 * never-delivered stop and its resume are dropped together, so no stale interrupt and no puzzling resume reach it.
 *
 * Delivery rides the per-event receipt (`worker_delivery_task_events`, chain position 0), so acknowledging a notice
 * moves no chat mark (R53) and a repeat acknowledgement is a no-op.
 *
 * TWO KEYS, replacing the process-wide DARK switch (#2169, Ella's delta A): the OFFER keys on the CALL (`dueWakes`
 * with `accepts: [STOP]`; an undeclared call is never handed a STOP reason and records nothing), and the SET keys on the
 * SERVING LANE of every worker the new signal would cover. A lane is a live host registration that lists the worker, or
 * `unhosted` for a worker no live registration lists. A declaring call upserts one `stop_consumer_declarations` row per
 * lane it serves, and a declaration is fresh for `STOP_CONSUMER_FRESH_SECONDS`, so a consumer that stops (a rollback, a
 * crash, a redeploy) stops serving within that window with nothing to clean up. Enforcement (matching, assignment,
 * launches, ticks, stall time) never depends on either key.
 */

import { Prisma, type PrismaClient } from '../../generated/prisma/index.js';
import { toNaiveUtc } from '../sessionActivity.js';
import type { StopLevel } from './state.js';
import type { StopNoticeKind } from './notices.js';

type Db = PrismaClient | Prisma.TransactionClient;

export type PendingStopNotice = {
  workerId: string;
  eventId: string;
  signalId: string;
  level: StopLevel;
  notice: StopNoticeKind;
  interrupt: boolean;
  at: Date;
};

/** The one notice each of `workerIds` is due now (see the file header), keyed by worker. Workers of no App mix. */
export async function pendingStopNotices(db: Db, appId: string, workerIds: string[]): Promise<Map<string, PendingStopNotice>> {
  const out = new Map<string, PendingStopNotice>();
  if (workerIds.length === 0) return out;
  const rows = await db.$queryRaw<Array<PendingStopNotice & { lastDelivered: string | null }>>(Prisma.sql`
    WITH newest AS (
      SELECT DISTINCT ON (e.subject_worker_id) e.subject_worker_id AS "workerId", e.id AS "eventId",
             e.payload ->> 'signalId' AS "signalId", e.payload ->> 'level' AS level, e.payload ->> 'notice' AS notice,
             (e.payload ->> 'interrupt')::boolean AS interrupt, e.created_at AS at
      FROM agent_team_events e
      WHERE e.app_id = ${appId} AND e.type = 'stop.notice' AND e.subject_worker_id IN (${Prisma.join(workerIds)})
      ORDER BY e.subject_worker_id, e.created_at DESC, e.id DESC
    )
    SELECT n.*, (
      SELECT x.payload ->> 'notice' FROM agent_team_events x
      JOIN worker_delivery_task_events d ON d.event_id = x.id AND d.worker_id = n."workerId" AND d.chain_index = 0 AND d.delivered_at IS NOT NULL
      WHERE x.app_id = ${appId} AND x.type = 'stop.notice' AND x.subject_worker_id = n."workerId"
      ORDER BY x.created_at DESC, x.id DESC LIMIT 1
    ) AS "lastDelivered"
    FROM newest n
    WHERE NOT EXISTS (SELECT 1 FROM worker_delivery_task_events d
                      WHERE d.worker_id = n."workerId" AND d.event_id = n."eventId" AND d.chain_index = 0 AND d.delivered_at IS NOT NULL)`);
  for (const { lastDelivered, ...n } of rows) {
    if (n.notice === 'resume' && (lastDelivered === null || lastDelivered === 'resume')) continue;
    out.set(n.workerId, n);
  }
  return out;
}


/** The lane a person who manages the App, or an App key without a host, serves. */
export const UNHOSTED_LANE = 'unhosted';

/**
 * How long a declaration counts as serving (#2169). The consumer polls far more often than this, so a healthy one is
 * always fresh; a stopped one lapses inside it. Read per call so a test or an operator can move it.
 */
export const STOP_CONSUMER_FRESH_SECONDS_DEFAULT = 600;
export function stopConsumerFreshSeconds(): number {
  const n = Number(process.env.STOP_CONSUMER_FRESH_SECONDS);
  return Number.isSafeInteger(n) && n >= 1 && n <= 86_400 ? n : STOP_CONSUMER_FRESH_SECONDS_DEFAULT;
}

/** Record that `lane` of `appId` has a consumer that takes stop notices, as of `now`. One row per lane, upserted. */
export async function recordStopConsumerDeclaration(db: Db, appId: string, lane: string, now: Date): Promise<void> {
  await db.$executeRaw`
    INSERT INTO stop_consumer_declarations (app_id, lane, declared_at) VALUES (${appId}, ${lane}, ${toNaiveUtc(now)}::timestamp)
    ON CONFLICT (app_id, lane) DO UPDATE SET declared_at = EXCLUDED.declared_at`;
}

export type UnservedStopLanes = { workers: number; lanes: string[] };

/**
 * The workers of `workerIds` that no fresh declaration serves (R95), and the lanes they are on, named by host id (or
 * `unhosted`). A worker's lanes are the live host registrations that list it; when it has registrations and none is live
 * (its host was lost) they are those registrations, which no consumer can serve until the host returns, so a set that
 * would stop it is refused (a non-host key's read scope excludes such a worker, so the shared `unhosted` lane must not
 * stand in for it, #2432 LOCAL); `unhosted` only for a worker no registration lists. A worker is served when ANY of its
 * lanes is fresh. Returns null when every one is served, and for an empty list. Names counts and lanes, never worker text.
 */
export async function unservedStopLanes(db: Db, appId: string, workerIds: string[], now: Date): Promise<UnservedStopLanes | null> {
  if (workerIds.length === 0) return null;
  const cutoff = toNaiveUtc(new Date(now.getTime() - stopConsumerFreshSeconds() * 1000));
  const rows = await db.$queryRaw<Array<{ workerId: string; label: string; fresh: boolean }>>(Prisma.sql`
    WITH reg AS (
      SELECT h.worker_id, r.id AS reg_id, r.host_id, (r.lost_at IS NULL) AS live
      FROM host_registration_workers h JOIN host_registrations r ON r.id = h.registration_id
      WHERE h.worker_id IN (${Prisma.join(workerIds)})
    ), lanes AS (
      SELECT worker_id, reg_id AS lane, host_id AS label FROM reg WHERE live
      UNION ALL
      SELECT r.worker_id, r.reg_id, r.host_id FROM reg r
      WHERE NOT r.live AND NOT EXISTS (SELECT 1 FROM reg x WHERE x.worker_id = r.worker_id AND x.live)
      UNION ALL
      SELECT w.id, ${UNHOSTED_LANE}::text, ${UNHOSTED_LANE}::text FROM workers w
      WHERE w.id IN (${Prisma.join(workerIds)}) AND NOT EXISTS (SELECT 1 FROM reg x WHERE x.worker_id = w.id)
    )
    SELECT l.worker_id AS "workerId", l.label,
           EXISTS (SELECT 1 FROM stop_consumer_declarations d WHERE d.app_id = ${appId} AND d.lane = l.lane
                   AND d.declared_at > ${cutoff}::timestamp) AS fresh
    FROM lanes l`);
  const served = new Set(rows.filter((r) => r.fresh).map((r) => r.workerId));
  const unserved = new Set(rows.filter((r) => !served.has(r.workerId)).map((r) => r.workerId));
  if (unserved.size === 0) return null;
  const lanes = [...new Set(rows.filter((r) => unserved.has(r.workerId)).map((r) => r.label))].sort();
  return { workers: unserved.size, lanes };
}
