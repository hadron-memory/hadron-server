/**
 * #2022 (S6) — which stop-signal notice each worker is due (cor:agt:090:04), and the switch that keeps the notice
 * lane DARK until the host consumer exists.
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
 * DARK (Xan, hadron-server#2022 issuecomment-6300950199): no host consumer types a STOP notice or interrupts yet, and
 * the current ticker-wake holds any wake carrying a reason it doesn't know. So notices are RECORDED always and OFFERED
 * only while `s6NoticesAvailable()` is true: false in production until the consumer slice ships (host owner Hugo;
 * Vera's fit #26462). Enforcement (matching, assignment, launches, ticks, stall time) does not depend on it.
 */

import { Prisma, type PrismaClient } from '../../generated/prisma/index.js';
import type { StopLevel } from './state.js';
import type { StopNoticeKind } from './notices.js';

type Db = PrismaClient | Prisma.TransactionClient;

let available = false;
/** Whether stop notices are offered in due wakes. False in production until the host consumer ships. */
export const s6NoticesAvailable = (): boolean => available;
/** Test seam only. */
export function setS6NoticesAvailableForTest(on: boolean): void {
  available = on;
}

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
