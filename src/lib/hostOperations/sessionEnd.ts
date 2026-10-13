/**
 * #1709 (Task Management T6, slice 3) — cor:agt:050:10: finishing or
 * cancelling a task with `closeSessionWhenDone` ASKS its worker assignee to end
 * its session, and only if that same session is still open after the App's
 * grace period (default 10 minutes) does the platform end it, through a live
 * host that registers the worker (cor:agt:070:05: the platform's own
 * `worker.end`). With no live host, nothing more happens (Holger, team chat
 * #8182). Neither path creates or removes a worktree (cor:agt:070:06).
 *
 * The ask is a `task.session-end-requested` event on the task, with the
 * worker as its subject, and a {@link TaskSessionEndRequest} row the sweep
 * resolves. A worker that finished the task itself reads the ask on the task
 * it just finished (`AgentTask.sessionEndRequest`); one whose task someone else
 * cancelled is woken for it (taskWakes.ts, END_SESSION).
 *
 * ONLY THAT SESSION. The request names the session open when the task ended; a
 * replacement session the worker binds later is never ended by an old task's
 * fallback, and a session that ended in the meantime (with a handoff or
 * deliberately without one) resolves the request as `ended`.
 */

import { Prisma, type PrismaClient } from '../../generated/prisma/index.js';
import { generateId } from '../id.js';
import { toNaiveUtc } from '../sessionActivity.js';
import type { EventActor } from '../agentTasks/events.js';
import { HOST_LAPSE_CHECK_INS_DEFAULT } from '../agentTasks/hosts.js';

/** cor:agt:050:10 — the default grace, in minutes, when the App has not set one. */
export const SESSION_END_GRACE_DEFAULT_MINUTES = 10;
export const SESSION_END_GRACE_MIN_MINUTES = 1;
export const SESSION_END_GRACE_MAX_MINUTES = 1440;

export const SESSION_END_REQUESTED_EVENT = 'task.session-end-requested';

type Db = PrismaClient | Prisma.TransactionClient;

/** The App's grace in minutes: its stall schedule's, or the default. */
export async function sessionEndGraceMinutes(db: Db, appId: string): Promise<number> {
  const row = await db.agentTaskStallSchedule.findUnique({ where: { appId }, select: { sessionEndGraceMinutes: true } });
  return row?.sessionEndGraceMinutes ?? SESSION_END_GRACE_DEFAULT_MINUTES;
}

/**
 * In the finish's or cancellation's transaction (the task row locked): if the
 * task closes its session when done and its assignee is a worker with an open
 * session, ask it to end that session. Returns the request, or null when
 * nothing is asked (`closeSessionWhenDone` false, a person assignee, no
 * assignee, or no open session: "the session has already ended", 050:10's
 * Proposed edge case, so the worker is simply free).
 */
export async function requestSessionEnd(
  tx: Prisma.TransactionClient,
  args: {
    appId: string;
    task: { id: string; closeSessionWhenDone: boolean; assigneeWorkerId: string | null };
    actor: EventActor;
    now: Date;
  },
): Promise<{ id: string; sessionId: string; dueAt: Date } | null> {
  const { task, now } = args;
  if (!task.closeSessionWhenDone || !task.assigneeWorkerId) return null;
  const [session] = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM sessions
    WHERE worker_id = ${task.assigneeWorkerId} AND ended_at IS NULL AND deleted_at IS NULL
    ORDER BY started_at DESC, id DESC
    LIMIT 1`;
  if (!session) return null;
  const grace = await sessionEndGraceMinutes(tx, args.appId);
  const dueAt = new Date(now.getTime() + grace * 60_000);
  const eventId = generateId();
  await tx.agentTeamEvent.create({
    data: {
      id: eventId,
      appId: args.appId,
      taskId: task.id,
      type: SESSION_END_REQUESTED_EVENT,
      actorUserId: args.actor.userId,
      actorWorkerId: args.actor.workerId,
      actorAgentId: args.actor.agentId,
      actorRunId: args.actor.runId ?? null,
      subjectWorkerId: task.assigneeWorkerId,
      payload: { sessionId: session.id, dueAt: dueAt.toISOString(), graceMinutes: grace },
      createdAt: now,
    },
  });
  const id = generateId();
  await tx.taskSessionEndRequest.create({
    data: {
      id,
      appId: args.appId,
      taskId: task.id,
      workerId: task.assigneeWorkerId,
      sessionId: session.id,
      eventId,
      requestedByWorkerId: args.actor.workerId,
      requestedAt: now,
      dueAt,
    },
  });
  return { id, sessionId: session.id, dueAt };
}

export type SessionEndResolution = 'ended' | 'end-issued' | 'no-live-host';

/**
 * The sweep: resolve every open request whose grace has passed (at most 500
 * a pass, oldest first). Each in its own transaction, the request locked and
 * re-read, so overlapping passes resolve it once. Returns how many it resolved.
 */
export async function sweepSessionEndRequests(db: PrismaClient, now = new Date()): Promise<number> {
  const due = await db.taskSessionEndRequest.findMany({
    where: { resolvedAt: null, dueAt: { lte: now } },
    orderBy: [{ dueAt: 'asc' }, { id: 'asc' }],
    take: 500,
    select: { id: true },
  });
  let resolved = 0;
  for (const r of due) {
    try {
      if (await resolveSessionEndRequest(db, r.id, now)) resolved += 1;
    } catch (err) {
      console.error('[session-end] resolving request failed:', r.id, err);
    }
  }
  return resolved;
}

/** Resolve one due request; false when it was already resolved, or is not yet due. */
export async function resolveSessionEndRequest(db: PrismaClient, requestId: string, now: Date): Promise<SessionEndResolution | null> {
  return db.$transaction(async (tx) => {
    const [req] = await tx.$queryRaw<{ id: string; appId: string; workerId: string; sessionId: string; dueAt: Date; resolvedAt: Date | null }[]>`
      SELECT id, app_id AS "appId", worker_id AS "workerId", session_id AS "sessionId", due_at AS "dueAt", resolved_at AS "resolvedAt"
      FROM task_session_end_requests WHERE id = ${requestId} FOR UPDATE`;
    if (!req || req.resolvedAt || req.dueAt.getTime() > now.getTime()) return null;
    // The session, held: an end that commits first is seen, one that comes later waits for this decision.
    const [session] = await tx.$queryRaw<{ endedAt: Date | null; deletedAt: Date | null; host: string | null }[]>`
      SELECT ended_at AS "endedAt", deleted_at AS "deletedAt", host FROM sessions WHERE id = ${req.sessionId} FOR SHARE`;
    const finish = (resolution: SessionEndResolution, operationId: string | null = null) =>
      tx.taskSessionEndRequest.update({ where: { id: req.id }, data: { resolvedAt: now, resolution, operationId } });
    if (!session || session.endedAt || session.deletedAt) {
      await finish('ended');
      return 'ended';
    }
    // The App must still be live to issue anything to its hosts.
    const app = await tx.app.findUnique({ where: { id: req.appId }, select: { deletedAt: true, uninstalledAt: true } });
    const hostId = app && !app.deletedAt && !app.uninstalledAt ? await pickLiveHost(tx, req.appId, req.workerId, session.host, now) : null;
    if (!hostId) {
      await finish('no-live-host');
      return 'no-live-host';
    }
    const operationId = generateId();
    await tx.hostOperation.create({
      data: {
        id: operationId,
        appId: req.appId,
        hostId,
        type: 'worker.end',
        args: { workerId: req.workerId, sessionId: req.sessionId },
        workerId: req.workerId,
        issuedBy: 'platform',
      },
    });
    await finish('end-issued', operationId);
    return 'end-issued';
  });
}

/**
 * A live host registering the worker, to end its session through. Proposed
 * (#1709): the host the session itself names when one of them matches, else
 * the first by host id; a worker is normally registered by one host.
 */
async function pickLiveHost(tx: Prisma.TransactionClient, appId: string, workerId: string, sessionHost: string | null, now: Date): Promise<string | null> {
  const rows = await tx.$queryRaw<{ hostId: string }[]>`
    SELECT r.host_id AS "hostId"
    FROM host_registrations r
    JOIN host_registration_workers w ON w.registration_id = r.id AND w.worker_id = ${workerId}
    LEFT JOIN agent_task_stall_schedule s ON s.app_id = r.app_id
    WHERE r.app_id = ${appId}
      AND r.refreshed_at + make_interval(secs => r.poll_interval_seconds * COALESCE(s.host_lapse_check_ins, ${HOST_LAPSE_CHECK_INS_DEFAULT})) >= ${toNaiveUtc(now)}::timestamp
    ORDER BY r.host_id`;
  if (rows.length === 0) return null;
  return rows.find((r) => r.hostId === sessionHost)?.hostId ?? rows[0]!.hostId;
}

/** Is a worker waiting on a session end, so the matcher should not hand it new work yet? (#1709, Proposed.) */
export const PENDING_SESSION_END_SQL = (workerColumn: Prisma.Sql) => Prisma.sql`(
  EXISTS (SELECT 1 FROM task_session_end_requests q
          JOIN sessions s ON s.id = q.session_id AND s.ended_at IS NULL
          WHERE q.worker_id = ${workerColumn} AND q.resolved_at IS NULL)
  OR EXISTS (SELECT 1 FROM host_operations o
             WHERE o.worker_id = ${workerColumn} AND o.type = 'worker.end' AND o.status IN ('issued', 'collected')))`;
