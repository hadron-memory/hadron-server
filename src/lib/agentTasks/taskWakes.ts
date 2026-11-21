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
 * | a child's task.finished / .cancelled    | the child's owner (050:16 r2) AND the parent's assignee (#4234, G7) | CHILD_FINISHED / CHILD_CANCELLED |
 * | an unacknowledged alarm                 | its currently-woken chain position, a worker (050:19) | ALARM |
 * | question.answered (#4431), on a task the question blocks | the task's CURRENT assignee (cor:agt:050:35) | ANSWERED |
 * | task.session-end-requested (#1709), when someone else ended the task, or (#4223) the task was reassigned away from the asked worker, or (#4265) that worker handed it back | the asked worker, while that session is open and the request unresolved (050:10) | END_SESSION |
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
import { ASSIGNED_EVENT_TYPES, PASSIVE_EVENT_TYPES } from './events.js';
import { alarmEpisodeKey, currentAlarmEpisodes } from './stall.js';

type Db = PrismaClient | Prisma.TransactionClient;

export type TaskWakeEvent = 'ASSIGNED' | 'REASSIGNED' | 'MATCHED' | 'CHILD_FINISHED' | 'CHILD_CANCELLED' | 'ALARM' | 'END_SESSION' | 'ANSWERED';

/** One event a worker is due a wake for. `chainIndex` is 0 except for an alarm's woken position. */
export type PendingTaskWake = {
  workerId: string;
  taskId: string;
  eventId: string;
  chainIndex: number;
  event: TaskWakeEvent;
  /** The team's own words for the task: what the nudge names (not event payload; cor:agt:050:11). */
  title: string;
  /** #2553: the task's handle (`AT3.405`), printed first in the nudge. */
  handle: string;
  at: Date;
  /** #4431: for ANSWERED, the code of the question answered (from the event; never the answer). Absent otherwise. */
  questionCode?: string | null;
  /** S7 (R90): the held count the assignment raise stored on the event (assigned events only). */
};

const ASSIGNED_KIND: Record<(typeof ASSIGNED_EVENT_TYPES)[number], TaskWakeEvent> = {
  'task.assigned': 'ASSIGNED',
  'task.reassigned': 'REASSIGNED',
  'assignment.matched': 'MATCHED',
};

/**
 * The task-less alarm types (#2755, #2014): how each one's nudge title and handle are built (words only, never evidence),
 * and whether delivery needs an open episode. Only the dark-worker alarm's episode is a condition (it ends when the worker
 * is no longer dark); the post-limit alarm is delivered and escalated until acknowledged, like any alarm.
 */
const TASKLESS_ALARMS = [
  { type: 'alarm.dark-worker', handle: 'DARK', openEpisodeRequired: 'd',
    title: Prisma.sql`sw.name || ' has gone dark (' || COALESCE(e.payload ->> 'reason', 'dark') || ')'` },
  // #2763: stops with its episode, which ends at the coordinator's next counted assignment.
  { type: 'alarm.coordinator-cadence', handle: 'CADENCE', openEpisodeRequired: 'c',
    title: Prisma.sql`sw.name || ' has stopped assigning work'` },
  { type: 'alarm.post-limit', handle: 'LIMIT', openEpisodeRequired: false,
    title: Prisma.sql`sw.name || '''s team-chat post was refused by the post limit' || CASE WHEN e.payload ->> 'limit' IS NULL THEN '' ELSE ' (' || (e.payload ->> 'limit') || ')' END` },
  // #4231: delivered and escalated until acknowledged; its episode only de-duplicates.
  { type: 'alarm.start-failing', handle: 'START', openEpisodeRequired: false,
    title: Prisma.sql`sw.name || '''s platform starts keep failing'` },
] as const;

const OPEN = Prisma.sql`('pending', 'started')`;

/** #4234 (G7): a child's end, finished or cancelled, and the wake event each one is. */
const CHILD_END_KIND = { 'task.finished': 'CHILD_FINISHED', 'task.cancelled': 'CHILD_CANCELLED' } as const;
const CHILD_END_TYPES = Object.keys(CHILD_END_KIND) as Array<keyof typeof CHILD_END_KIND>;

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
 * pending. Workers of another App never match (`w.app_id = t.app_id`). #4202: nor does an event of another App
 * naming the task (`e.app_id = t.app_id`; `agent_team_events.task_id` has no foreign key): it wakes nobody, carries no
 * task metadata and suppresses no wake (cor:agt:050:01, :19, :21).
 */
export async function pendingTaskWakes(db: Db, workerIds: string[], now: Date): Promise<Map<string, PendingTaskWake[]>> {
  const out = new Map<string, PendingTaskWake[]>();
  if (workerIds.length === 0) return out;
  const ids = Prisma.join(workerIds);
  const assignedTypes = Prisma.join([...ASSIGNED_EVENT_TYPES]);

  type Row = { workerId: string; taskId: string; eventId: string; type: string; title: string; handle: string; at: Date };
  const [assigned, finished, alarms, endSession, darkAlarms, answered] = await Promise.all([
    // The task's LATEST assignment event, to its current worker assignee, who has not acted on the task since
    // (an assignment the worker made itself counts as acting: `>=` includes the event).
    db.$queryRaw<Row[]>(Prisma.sql`
      WITH latest AS (
        SELECT DISTINCT ON (e.task_id) e.id, e.task_id, e.type, e.subject_worker_id, e.created_at, e.payload
        FROM agent_team_events e
        JOIN agent_tasks t ON t.id = e.task_id AND t.app_id = e.app_id
        WHERE t.assignee_worker_id IN (${ids}) AND t.status IN ${OPEN} AND e.type IN (${assignedTypes})
        ORDER BY e.task_id, e.created_at DESC, e.id DESC
      )
      SELECT l.subject_worker_id AS "workerId", t.id AS "taskId", l.id AS "eventId", l.type, t.title, t.handle, l.created_at AS at
      FROM latest l
      JOIN agent_tasks t ON t.id = l.task_id
      JOIN workers w ON w.id = l.subject_worker_id AND w.app_id = t.app_id
      WHERE l.subject_worker_id = t.assignee_worker_id
        AND ${liveApp('t')}
        AND NOT EXISTS (SELECT 1 FROM agent_team_events x
                        WHERE x.task_id = t.id AND x.app_id = t.app_id AND x.actor_worker_id = l.subject_worker_id AND x.created_at >= l.created_at AND x.type NOT LIKE 'app.%' AND x.type NOT IN (${Prisma.join([...PASSIVE_EVENT_TYPES])}))
        AND ${undelivered('l.subject_worker_id', 'l.id', '0')}`),
    // A child's end (finished or cancelled), for each of two subjects: the child's owner (cor:agt:050:16 r2) and the
    // parent's CURRENT assignee (#4234, Holger's G7 ruling: a running implementer waiting on its review, QA and merge
    // tasks is woken by each one's end, so it never polls). The UNION makes one subject of the usual case, where the
    // parent's assignee made the child and owns it. Each subject's wake holds while the parent is open and that
    // subject has not acted on the parent since; a subject who ended the child itself already knows.
    db.$queryRaw<Row[]>(Prisma.sql`
      SELECT s.wid AS "workerId", c.id AS "taskId", e.id AS "eventId", e.type, c.title, c.handle, e.created_at AS at
      FROM agent_team_events e
      JOIN agent_tasks c ON c.id = e.task_id AND c.app_id = e.app_id
      JOIN agent_tasks p ON p.id = c.parent_task_id
      CROSS JOIN LATERAL (SELECT c.owner_worker_id AS wid UNION SELECT p.assignee_worker_id) s
      JOIN workers w ON w.id = s.wid AND w.app_id = c.app_id
      WHERE e.type IN (${Prisma.join([...CHILD_END_TYPES])}) AND s.wid IN (${ids}) AND p.status IN ${OPEN}
        AND e.actor_worker_id IS DISTINCT FROM s.wid
        AND ${liveApp('c')}
        AND NOT EXISTS (SELECT 1 FROM agent_team_events x
                        WHERE x.task_id = p.id AND x.app_id = p.app_id AND x.actor_worker_id = s.wid AND x.created_at >= e.created_at AND x.type NOT LIKE 'app.%' AND x.type NOT IN (${Prisma.join([...PASSIVE_EVENT_TYPES])}))
        AND ${undelivered('s.wid', 'e.id', '0')}`),
    // An unacknowledged alarm's highest woken chain position, when that position names one of these workers.
    db.$queryRaw<(Row & { chainIndex: number; episodeStart: Date | null })[]>(Prisma.sql`
      SELECT (e.chain -> s.idx ->> 'workerId') AS "workerId", t.id AS "taskId", e.id AS "eventId", e.type, t.title, t.handle,
             e.created_at AS at, s.idx AS "chainIndex", e.episode_start AS "episodeStart"
      FROM agent_team_events e
      JOIN agent_tasks t ON t.id = e.task_id AND t.app_id = e.app_id
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
             t.title, t.handle, q.requested_at AS at
      FROM task_session_end_requests q
      JOIN agent_tasks t ON t.id = q.task_id
      JOIN sessions s ON s.id = q.session_id AND s.ended_at IS NULL AND s.deleted_at IS NULL
      JOIN workers w ON w.id = q.worker_id AND w.app_id = t.app_id
      WHERE q.worker_id IN (${ids}) AND q.resolved_at IS NULL
        -- #4223: or the task is no longer the asked worker's (reassigned away from a short-lived worker, even by that
        -- worker itself): it has no task to read the request on, so it is always woken. #4265: a hand-back too, which
        -- the asked worker always makes itself and which leaves the task with no assignee (NULL is distinct).
        AND (q.requested_by_worker_id IS DISTINCT FROM q.worker_id OR t.assignee_worker_id IS DISTINCT FROM q.worker_id)
        AND ${liveApp('t')}
        AND ${undelivered('q.worker_id', 'q.event_id', '0')}`),
    // #2755, #2014: a task-less alarm (dark worker, post limit). Its nudge is built from the worker's name and words only,
    // never evidence; `taskId` carries the ALARM's id. What differs per type is the table above: how the title and handle
    // are built, and whether delivery needs an open episode (a dark-worker alarm stops with its episode; a post-limit
    // alarm stays open until acknowledged, its episode only de-duplicates it).
    db.$queryRaw<(Row & { chainIndex: number })[]>(Prisma.sql`
      SELECT (e.chain -> s.idx ->> 'workerId') AS "workerId", e.id AS "taskId", e.id AS "eventId", e.type,
             CASE e.type ${Prisma.join(TASKLESS_ALARMS.map((t) => Prisma.sql`WHEN ${t.type}::text THEN ${t.title}`), ' ')} END AS title,
             CASE e.type ${Prisma.join(TASKLESS_ALARMS.map((t) => Prisma.sql`WHEN ${t.type}::text THEN ${t.handle}::text`), ' ')} END AS handle,
             e.created_at AS at, s.idx AS "chainIndex"
      FROM agent_team_events e
      LEFT JOIN dark_worker_episodes d ON d.event_id = e.id
      LEFT JOIN coordinator_cadence_episodes c ON c.event_id = e.id
      JOIN workers sw ON sw.id = e.subject_worker_id
      JOIN LATERAL (SELECT max(chain_index) AS idx FROM agent_team_alarm_schedule
                    WHERE event_id = e.id AND woken_at IS NOT NULL) s ON s.idx IS NOT NULL
      JOIN workers w ON w.id = (e.chain -> s.idx ->> 'workerId') AND w.app_id = e.app_id
      WHERE e.type IN (${Prisma.join(TASKLESS_ALARMS.map((t) => Prisma.sql`${t.type}::text`))}) AND e.severity = 'alarm' AND e.acknowledged_at IS NULL
        AND (${Prisma.join(TASKLESS_ALARMS.map((t) => t.openEpisodeRequired === 'd' ? Prisma.sql`(e.type = ${t.type}::text AND d.ended_at IS NULL AND d.id IS NOT NULL)` : t.openEpisodeRequired === 'c' ? Prisma.sql`(e.type = ${t.type}::text AND c.ended_at IS NULL AND c.id IS NOT NULL)` : Prisma.sql`e.type = ${t.type}::text`), ' OR ')})
        AND (e.chain -> s.idx ->> 'workerId') IN (${ids})
        AND ${liveApp('e')}
        AND ${undelivered("(e.chain -> s.idx ->> 'workerId')", 'e.id', 's.idx')}`),
    // #4431 (Questions S7, cor:agt:050:35): an answer to a question that blocks an open task wakes the
    // task's CURRENT assignee (so a task reassigned before the answer wakes its new one), until delivered or that worker
    // acts on the task since. Only an answer: a take-back (question.answer-retracted) is history and wakes nobody. Each
    // answer is its own event, so a re-answer wakes again. The nudge names the task; the event carries no answer.
    db.$queryRaw<(Row & { questionCode: string | null })[]>(Prisma.sql`
      SELECT t.assignee_worker_id AS "workerId", t.id AS "taskId", e.id AS "eventId", e.type, t.title, t.handle, e.created_at AS at,
             e.payload ->> 'code' AS "questionCode"
      FROM agent_team_events e
      JOIN agent_tasks t ON t.id = e.task_id AND t.app_id = e.app_id
      JOIN workers w ON w.id = t.assignee_worker_id AND w.app_id = t.app_id
      WHERE e.type = 'question.answered' AND t.assignee_worker_id IN (${ids}) AND t.status IN ${OPEN}
        AND ${liveApp('t')}
        AND NOT EXISTS (SELECT 1 FROM agent_team_events x
                        WHERE x.task_id = t.id AND x.app_id = t.app_id AND x.actor_worker_id = t.assignee_worker_id AND x.created_at >= e.created_at AND x.type NOT LIKE 'app.%' AND x.type NOT IN (${Prisma.join([...PASSIVE_EVENT_TYPES])}))
        AND ${undelivered('t.assignee_worker_id', 'e.id', '0')}`),
  ]);

  const current = await currentAlarmEpisodes(db, alarms, now);
  const push = (w: PendingTaskWake) => out.set(w.workerId, [...(out.get(w.workerId) ?? []), w]);
  for (const r of assigned) {
    push({ workerId: r.workerId, taskId: r.taskId, eventId: r.eventId, title: r.title, handle: r.handle, at: r.at, chainIndex: 0,
      event: ASSIGNED_KIND[r.type as keyof typeof ASSIGNED_KIND] });
  }
  for (const r of finished) push({ ...r, chainIndex: 0, event: CHILD_END_KIND[r.type as keyof typeof CHILD_END_KIND] });
  for (const r of endSession) push({ ...r, chainIndex: 0, event: 'END_SESSION' });
  for (const r of answered) push({ ...r, chainIndex: 0, event: 'ANSWERED' });
  for (const r of alarms) {
    if (!r.episodeStart || !current.has(alarmEpisodeKey(r.taskId, r.type, r.episodeStart))) continue;
    push({ workerId: r.workerId, taskId: r.taskId, eventId: r.eventId, title: r.title, handle: r.handle, at: r.at, chainIndex: r.chainIndex, event: 'ALARM' });
  }
  for (const r of darkAlarms) {
    push({ workerId: r.workerId, taskId: r.taskId, eventId: r.eventId, title: r.title, handle: r.handle, at: r.at, chainIndex: r.chainIndex, event: 'ALARM' });
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
  // Workers a task event could be pending for: assignees of open tasks (a parent's assignee among them, #4234), owners
  // of ended (finished or cancelled) children under an open parent, and worker positions of unacknowledged alarms. Retired workers and dead Apps are never due.
  const candidates = await db.$queryRaw<{ id: string; dormancyDays: number }[]>(Prisma.sql`
    SELECT w.id, a.session_dormancy_days AS "dormancyDays"
    FROM workers w JOIN apps a ON a.id = w.app_id
    LEFT JOIN organizations o ON o.id = a.organization_id
    WHERE w.retired_at IS NULL AND a.deleted_at IS NULL AND a.uninstalled_at IS NULL
      AND (a.organization_id IS NULL OR o.deleted_at IS NULL)
      AND (
        w.id IN (SELECT assignee_worker_id FROM agent_tasks WHERE status IN ${OPEN} AND assignee_worker_id IS NOT NULL)
        OR w.id IN (SELECT c.owner_worker_id FROM agent_tasks c JOIN agent_tasks p ON p.id = c.parent_task_id
                    WHERE c.status IN ('finished', 'cancelled') AND p.status IN ${OPEN} AND c.owner_worker_id IS NOT NULL)
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
