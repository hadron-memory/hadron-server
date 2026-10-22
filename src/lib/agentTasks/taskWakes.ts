/**
 * #1708 (Task Management T5) — task events as the second relevance source of
 * the due-wake computation (design:agent-tasks §6; the Tickers plan's §2 and
 * §12 Q7 left room for exactly this, so the router contract is unchanged).
 *
 * A worker who must act on a task is due at once, as if mentioned, under the
 * same wake-rate ceiling and daily budget (cor:agt:080:13, :15). These events
 * make their subject due:
 *
 * | Event                                   | Subject                                   | Reason          |
 * |-----------------------------------------|-------------------------------------------|-----------------|
 * | task.assigned / .reassigned / assignment.matched | the new assignee (the task's LATEST assignment only) | ASSIGNED / REASSIGNED / MATCHED |
 * | a child's task.finished                 | the child's owner (050:16 r2)             | CHILD_FINISHED  |
 * | an unacknowledged alarm                 | its currently-woken chain position, a worker (050:19) | ALARM |
 * | task.session-end-requested (#1709), when someone else ended the task | the assignee, while that session is open and the request unresolved (050:10) | END_SESSION |
 *
 * A wake for an event stays due until a wake proof naming it is acknowledged
 * (`worker_delivery_task_events.delivered_at`), or until it no longer asks
 * anything of the worker: the task (or a child's parent) ended, the assignment
 * moved on, or the worker itself acted on the task since. That last condition
 * also makes the source self-bounding: a task a worker is already working on
 * does not wake it at deploy.
 *
 * ALARMS are re-checked before every delivery (Rook §10 P3-1 on #1720): the
 * episode is still current (`currentAlarmEpisodes`, the evaluator's own rule),
 * which also requires the task to be open and the App installed; the App and
 * its org are live; and the alarm is unacknowledged. The worker's CURRENT
 * standing (not retired; its holder still an App participant) is the caller's
 * (`computeDueWakes`), never the sealed chain. A person in the chain is never
 * delivered to: they are skipped, and T2's escalation timer keeps running.
 *
 * Delivery is never an alarm acknowledgement (cor:agt:050:20). Nothing here
 * writes the alarm; `acknowledgeAlarm` stays the only way to stop a climb.
 */

import { Prisma, type PrismaClient } from '../../generated/prisma/index.js';
import type { Context } from '../../api/graphql/schema/resolvers.helpers.js';
import { loadWorkersActivity } from '../../api/graphql/schema/resolvers.worker.js';
import { isWorkerDormant, toNaiveUtc } from '../sessionActivity.js';
import { ASSIGNED_EVENT_TYPES } from './events.js';
import { alarmEpisodeKey, currentAlarmEpisodes } from './stall.js';

type Db = PrismaClient | Prisma.TransactionClient;

export type TaskWakeEvent = 'ASSIGNED' | 'REASSIGNED' | 'MATCHED' | 'CHILD_FINISHED' | 'ALARM' | 'END_SESSION';

/** One event a worker is due a wake for. `chainIndex` is 0 except for an alarm's woken position. */
export type PendingTaskWake = {
  workerId: string;
  taskId: string;
  eventId: string;
  chainIndex: number;
  event: TaskWakeEvent;
  /** The team's own words for the task: what the nudge names (not event payload; cor:agt:050:11). */
  title: string;
  at: Date;
  /** S7 (R90): the held count the assignment raise stored on the event (assigned events only). */
  standbyHeld?: number;
};

const ASSIGNED_KIND: Record<(typeof ASSIGNED_EVENT_TYPES)[number], TaskWakeEvent> = {
  'task.assigned': 'ASSIGNED',
  'task.reassigned': 'REASSIGNED',
  'assignment.matched': 'MATCHED',
};

const OPEN = Prisma.sql`('pending', 'started')`;

/** The App row of `t` is live: not deleted, not uninstalled, its org (if any) not deleted. */
const liveApp = (t: string) => Prisma.sql`EXISTS (
  SELECT 1 FROM apps a LEFT JOIN organizations o ON o.id = a.organization_id
  WHERE a.id = ${Prisma.raw(t)}.app_id AND a.deleted_at IS NULL AND a.uninstalled_at IS NULL
    AND (a.organization_id IS NULL OR o.deleted_at IS NULL))`;

/** Not yet delivered to this worker at this position. */
const undelivered = (worker: string, event: string, chainIndex: string) => Prisma.sql`NOT EXISTS (
  SELECT 1 FROM worker_delivery_task_events d
  WHERE d.worker_id = ${Prisma.raw(worker)} AND d.event_id = ${Prisma.raw(event)}
    AND d.chain_index = ${Prisma.raw(chainIndex)} AND d.delivered_at IS NOT NULL)`;

/**
 * The task wakes each of `workerIds` is due, oldest first. Who may READ them
 * is the caller's to decide (cor:agt:050:21, :080:23): this only says what is
 * pending. Workers of another App never match (`w.app_id = t.app_id`).
 */
export async function pendingTaskWakes(db: Db, workerIds: string[], now: Date): Promise<Map<string, PendingTaskWake[]>> {
  const out = new Map<string, PendingTaskWake[]>();
  if (workerIds.length === 0) return out;
  const ids = Prisma.join(workerIds);
  const assignedTypes = Prisma.join([...ASSIGNED_EVENT_TYPES]);

  type Row = { workerId: string; taskId: string; eventId: string; type: string; title: string; at: Date; standbyHeld?: number };
  const [assigned, finished, alarms, endSession] = await Promise.all([
    // The task's LATEST assignment event, to its current worker assignee, who has not acted on the task since
    // (an assignment the worker made itself counts as acting: `>=` includes the event).
    db.$queryRaw<Row[]>(Prisma.sql`
      WITH latest AS (
        SELECT DISTINCT ON (e.task_id) e.id, e.task_id, e.type, e.subject_worker_id, e.created_at, e.payload
        FROM agent_team_events e
        JOIN agent_tasks t ON t.id = e.task_id
        WHERE t.assignee_worker_id IN (${ids}) AND t.status IN ${OPEN} AND e.type IN (${assignedTypes})
        ORDER BY e.task_id, e.created_at DESC, e.id DESC
      )
      SELECT l.subject_worker_id AS "workerId", t.id AS "taskId", l.id AS "eventId", l.type, t.title, l.created_at AS at,
             COALESCE((l.payload ->> 'standbyHeld')::int, 0) AS "standbyHeld"
      FROM latest l
      JOIN agent_tasks t ON t.id = l.task_id
      JOIN workers w ON w.id = l.subject_worker_id AND w.app_id = t.app_id
      WHERE l.subject_worker_id = t.assignee_worker_id
        AND ${liveApp('t')}
        AND NOT EXISTS (SELECT 1 FROM agent_team_events x
                        WHERE x.task_id = t.id AND x.actor_worker_id = l.subject_worker_id AND x.created_at >= l.created_at)
        AND ${undelivered('l.subject_worker_id', 'l.id', '0')}`),
    // A child's finish, for its owner, while the parent is open and the owner has not acted on the parent since.
    // An owner who finished the child itself already knows.
    db.$queryRaw<Row[]>(Prisma.sql`
      SELECT c.owner_worker_id AS "workerId", c.id AS "taskId", e.id AS "eventId", e.type, c.title, e.created_at AS at
      FROM agent_team_events e
      JOIN agent_tasks c ON c.id = e.task_id
      JOIN agent_tasks p ON p.id = c.parent_task_id
      JOIN workers w ON w.id = c.owner_worker_id AND w.app_id = c.app_id
      WHERE e.type = 'task.finished' AND c.owner_worker_id IN (${ids}) AND p.status IN ${OPEN}
        AND e.actor_worker_id IS DISTINCT FROM c.owner_worker_id
        AND ${liveApp('c')}
        AND NOT EXISTS (SELECT 1 FROM agent_team_events x
                        WHERE x.task_id = p.id AND x.actor_worker_id = c.owner_worker_id AND x.created_at >= e.created_at)
        AND ${undelivered('c.owner_worker_id', 'e.id', '0')}`),
    // An unacknowledged alarm's highest woken chain position, when that position names one of these workers.
    db.$queryRaw<(Row & { chainIndex: number; episodeStart: Date | null })[]>(Prisma.sql`
      SELECT (e.chain -> s.idx ->> 'workerId') AS "workerId", t.id AS "taskId", e.id AS "eventId", e.type, t.title,
             e.created_at AS at, s.idx AS "chainIndex", e.episode_start AS "episodeStart"
      FROM agent_team_events e
      JOIN agent_tasks t ON t.id = e.task_id
      JOIN LATERAL (SELECT max(chain_index) AS idx FROM agent_team_alarm_schedule
                    WHERE event_id = e.id AND woken_at IS NOT NULL) s ON s.idx IS NOT NULL
      JOIN workers w ON w.id = (e.chain -> s.idx ->> 'workerId') AND w.app_id = e.app_id
      WHERE e.severity = 'alarm' AND e.acknowledged_at IS NULL AND t.status IN ${OPEN}
        AND (e.chain -> s.idx ->> 'workerId') IN (${ids})
        AND ${liveApp('t')}
        AND ${undelivered("(e.chain -> s.idx ->> 'workerId')", 'e.id', 's.idx')}`),
    // #1709 (cor:agt:050:10): a request that the assignee end its session, while the request is open and that
    // session still is. Only when someone else ended the task (a cancellation): a worker that finished its own task
    // reads the request on the task it just finished.
    db.$queryRaw<Row[]>(Prisma.sql`
      SELECT q.worker_id AS "workerId", t.id AS "taskId", q.event_id AS "eventId", 'task.session-end-requested' AS type,
             t.title, q.requested_at AS at
      FROM task_session_end_requests q
      JOIN agent_tasks t ON t.id = q.task_id
      JOIN sessions s ON s.id = q.session_id AND s.ended_at IS NULL AND s.deleted_at IS NULL
      JOIN workers w ON w.id = q.worker_id AND w.app_id = t.app_id
      WHERE q.worker_id IN (${ids}) AND q.resolved_at IS NULL
        AND q.requested_by_worker_id IS DISTINCT FROM q.worker_id
        AND ${liveApp('t')}
        AND ${undelivered('q.worker_id', 'q.event_id', '0')}`),
  ]);

  const current = await currentAlarmEpisodes(db, alarms, now);
  const push = (w: PendingTaskWake) => out.set(w.workerId, [...(out.get(w.workerId) ?? []), w]);
  for (const r of assigned) {
    push({ workerId: r.workerId, taskId: r.taskId, eventId: r.eventId, title: r.title, at: r.at, chainIndex: 0,
      event: ASSIGNED_KIND[r.type as keyof typeof ASSIGNED_KIND], ...(r.standbyHeld ? { standbyHeld: r.standbyHeld } : {}) });
  }
  for (const r of finished) push({ ...r, chainIndex: 0, event: 'CHILD_FINISHED' });
  for (const r of endSession) push({ ...r, chainIndex: 0, event: 'END_SESSION' });
  for (const r of alarms) {
    if (!r.episodeStart || !current.has(alarmEpisodeKey(r.taskId, r.type, r.episodeStart))) continue;
    push({ workerId: r.workerId, taskId: r.taskId, eventId: r.eventId, title: r.title, at: r.at, chainIndex: r.chainIndex, event: 'ALARM' });
  }
  for (const list of out.values()) {
    list.sort((a, b) => a.at.getTime() - b.at.getTime() || a.eventId.localeCompare(b.eventId) || a.chainIndex - b.chainIndex);
  }
  return out;
}

/**
 * The stall-evaluator tick's half of T5: record, once, each task wake whose
 * subject is DORMANT (cor:agt:080:11 — never due, so it cannot be delivered).
 * It launches nothing: launch is T6's, and an undeliverable owner wake's launch
 * is an open ruling (#1708). A later delivery still sets `delivered_at`.
 * Returns how many events it newly recorded.
 */
export async function recordUndeliverableTaskWakes(db: PrismaClient, now = new Date()): Promise<number> {
  // Workers a task event could be pending for: assignees of open tasks, owners of finished children under an open
  // parent, and worker positions of unacknowledged alarms. Retired workers and dead Apps are never due.
  const candidates = await db.$queryRaw<{ id: string; dormancyDays: number }[]>(Prisma.sql`
    SELECT w.id, a.session_dormancy_days AS "dormancyDays"
    FROM workers w JOIN apps a ON a.id = w.app_id
    LEFT JOIN organizations o ON o.id = a.organization_id
    WHERE w.retired_at IS NULL AND a.deleted_at IS NULL AND a.uninstalled_at IS NULL
      AND (a.organization_id IS NULL OR o.deleted_at IS NULL)
      AND (
        w.id IN (SELECT assignee_worker_id FROM agent_tasks WHERE status IN ${OPEN} AND assignee_worker_id IS NOT NULL)
        OR w.id IN (SELECT c.owner_worker_id FROM agent_tasks c JOIN agent_tasks p ON p.id = c.parent_task_id
                    WHERE c.status = 'finished' AND p.status IN ${OPEN} AND c.owner_worker_id IS NOT NULL)
        OR w.id IN (SELECT jsonb_array_elements(e.chain) ->> 'workerId' FROM agent_team_events e
                    WHERE e.severity = 'alarm' AND e.acknowledged_at IS NULL AND e.chain IS NOT NULL)
      )`);
  if (candidates.length === 0) return 0;
  const activity = await loadWorkersActivity({ db } as Context, candidates.map((c) => c.id), now);
  const dormant = candidates
    .filter((c) => isWorkerDormant(activity.get(c.id)?.lastActiveAt, c.dormancyDays, now))
    .map((c) => c.id);
  if (dormant.length === 0) return 0;
  const pending = await pendingTaskWakes(db, dormant, now);
  const at = toNaiveUtc(now);
  let recorded = 0;
  for (const list of pending.values()) {
    for (const p of list) {
      recorded += await db.$executeRaw(Prisma.sql`
        INSERT INTO worker_delivery_task_events (worker_id, event_id, chain_index, undeliverable_at, undeliverable_reason)
        VALUES (${p.workerId}, ${p.eventId}, ${p.chainIndex}, ${at}::timestamp, 'dormant')
        ON CONFLICT (worker_id, event_id, chain_index) DO UPDATE
          SET undeliverable_at = EXCLUDED.undeliverable_at, undeliverable_reason = EXCLUDED.undeliverable_reason
          WHERE worker_delivery_task_events.undeliverable_at IS NULL AND worker_delivery_task_events.delivered_at IS NULL`);
    }
  }
  return recorded;
}
