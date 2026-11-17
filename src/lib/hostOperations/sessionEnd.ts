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
 *
 * #4223 (S2 of #4229) — A SHORT-LIVED WORKER (cor:agt:050:10's short-lived paragraph, Proposed; Holger's G7 ruling,
 * hrn:node:hadronmemory.com:hadron-dev-team-shared:coordination:team-on-orca-decisions, log 2026-11-15 15:10). For a
 * worker whose Agent's lifecycle is SHORT_LIVED, `closeSessionWhenDone` is not read. While any other task assigned to
 * it is pending or started, one waiting on its child tasks included, nothing is asked: it stays up with its context
 * (no parking). When the LAST such task finishes or is cancelled, it is asked exactly as above, and the same grace and
 * the same `worker.end` follow. A worker marked leave-alone (`Worker.leaveAlone`, #4224) keeps the ordinary rule, so
 * a marked worker is never ended by its Agent's lifecycle. LONG_LIVED, the default, is unchanged.
 *
 * REASSIGNED AWAY (Peter, team chat #108497; one Proposed sentence in 050:10): a short-lived worker whose last open
 * task is reassigned to someone else is asked the same way, by the reassignment's transaction, with the FORMER
 * assignee as the request's worker. So one task may carry several requests over its life: one each time it leaves a
 * short-lived worker or ends under a worker (nothing limits it to one per worker: moved away and back, a worker has
 * two). `AgentTask.sessionEndRequest` shows only the task's current assignee's latest; the former assignee has no
 * task to read its request on, so it is always woken for it (taskWakes.ts, END_SESSION).
 *
 * #4265 — HANDED BACK (cor:agt:050:10 r20, Proposed; Peter, team chat #109434): a short-lived worker that hands back
 * its last open task (cor:agt:050:29) is asked the same way, by the hand-back's transaction. The task goes back to
 * the queue with no assignee, so the request is never read on the task: the worker is woken for it, although it made
 * the hand-back itself, and a later assignee of the re-queued task never reads it.
 */

import { Prisma, type PrismaClient } from '../../generated/prisma/index.js';
import { generateId } from '../id.js';
import { toNaiveUtc } from '../sessionActivity.js';
import type { EventActor } from '../agentTasks/events.js';
import { HOST_LAPSE_CHECK_INS_DEFAULT, lockAppHostLapse } from '../agentTasks/hosts.js';
import { lockAuthorityAnchors } from '../auth/authorityAnchors.js';
import { OPEN_SESSION_PLACEMENT_JOIN } from '../sessionPlacement.js';

/** cor:agt:050:10 — the default grace, in minutes, when the App has not set one. */
export const SESSION_END_GRACE_DEFAULT_MINUTES = 10;
export const SESSION_END_GRACE_MIN_MINUTES = 1;
export const SESSION_END_GRACE_MAX_MINUTES = 1440;

export const SESSION_END_REQUESTED_EVENT = 'task.session-end-requested';

/** How a task left its worker assignee WITHOUT ending (#4223 reassigned away, #4265 handed back). */
export type SessionEndCause = 'reassigned' | 'handed-back';

type Db = PrismaClient | Prisma.TransactionClient;

/** The App's grace in minutes: its stall schedule's, or the default. */
export async function sessionEndGraceMinutes(db: Db, appId: string): Promise<number> {
  const row = await db.agentTaskStallSchedule.findUnique({ where: { appId }, select: { sessionEndGraceMinutes: true } });
  return row?.sessionEndGraceMinutes ?? SESSION_END_GRACE_DEFAULT_MINUTES;
}

/**
 * #4223: is the worker's Agent SHORT_LIVED, and is the worker marked leave-alone? The Agent is the one its open
 * session was bound under (#2458; the live worker row's when it has none), held FOR SHARE like the context reset
 * holds `resetContextAfterTask`, so a lifecycle change either committed first or waits for this task write.
 */
export async function workerLifecycle(
  tx: Prisma.TransactionClient, workerId: string,
): Promise<{ shortLived: boolean; leaveAlone: boolean }> {
  const [row] = await tx.$queryRaw<{ lifecycle: string; leaveAlone: boolean }[]>`
    SELECT a.lifecycle::text AS lifecycle, w.leave_alone AS "leaveAlone" FROM workers w
    ${OPEN_SESSION_PLACEMENT_JOIN}
    JOIN agents a ON a.id = COALESCE(os.agent_id, w.agent_id) WHERE w.id = ${workerId} FOR SHARE OF a`;
  return { shortLived: row?.lifecycle === 'SHORT_LIVED', leaveAlone: row?.leaveAlone ?? false };
}

/**
 * In the finish's, cancellation's, reassignment's or hand-back's transaction (the task row locked, and the assignee's per-worker assignment lock
 * held, which every assignment, start, finish and cancel takes: src/lib/agentTasks/workerLock.ts): ask the task's
 * worker assignee to end its open session, if the rule says so. Returns the request, or null when nothing is asked.
 *
 * The rule: for a short-lived worker (#4223, see the file header), this was the LAST pending or started task
 * assigned to it; for every other worker, the task's `closeSessionWhenDone` is yes. Never asked of a person
 * assignee, with no assignee, or with no open session ("the session has already ended", 050:10's Proposed edge
 * case, so the worker is simply free). The count of other open tasks is read under the per-worker lock, so of two
 * tasks of one worker ending at once the second sees the first ended, and exactly one of them asks.
 */
export async function requestSessionEnd(
  tx: Prisma.TransactionClient,
  args: {
    appId: string;
    /** The task as it was BEFORE this write: `assigneeWorkerId` is the worker that finished it, had it cancelled, or lost it. */
    task: { id: string; closeSessionWhenDone: boolean; assigneeWorkerId: string | null };
    actor: EventActor;
    now: Date;
    /**
     * The task did not end. `reassigned`: it moved to another assignee (the caller holds the former assignee's
     * per-worker lock too). `handed-back` (#4265): its assignee returned it to the queue. Only the lifecycle asks
     * then; `closeSessionWhenDone` is about the task's end.
     */
    cause?: SessionEndCause;
  },
): Promise<{ id: string; sessionId: string; dueAt: Date } | null> {
  const { task, now } = args;
  if (!task.assigneeWorkerId) return null;
  const { shortLived, leaveAlone } = await workerLifecycle(tx, task.assigneeWorkerId);
  const byLifecycle = shortLived && !leaveAlone;
  if (byLifecycle) {
    const otherOpen = await tx.agentTask.count({
      where: { assigneeWorkerId: task.assigneeWorkerId, status: { in: ['pending', 'started'] }, id: { not: task.id } },
    });
    if (otherOpen > 0) return null;
  } else if (args.cause || !task.closeSessionWhenDone) {
    return null;
  }
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
      // #4223: `lifecycle` is present exactly when the Agent's lifecycle, not the task's closeSessionWhenDone, asked;
      // `cause` exactly when the task did not end but was reassigned away or (#4265) handed back.
      payload: { sessionId: session.id, dueAt: dueAt.toISOString(), graceMinutes: grace, ...(byLifecycle ? { lifecycle: 'SHORT_LIVED' } : {}), ...(args.cause ? { cause: args.cause } : {}) },
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

/**
 * Resolve one due request; null when it was already resolved, or is not yet due.
 *
 * FENCED THROUGH THE INSERT (#1877 review, Colin P2-1; Greta P3): everything the
 * decision reads is held until the platform's `worker.end` is written, in the
 * host-registration lock order (registerHost, recordHostLost): the App's
 * authority anchor SHARED (an uninstall or delete committed first and is seen,
 * or waits), the App's host-lapse lock SHARED with its count (a count change
 * waits), the request FOR UPDATE, the session FOR SHARE, then every registration
 * of the App FOR SHARE (a refresh that would drop the worker waits) BEFORE a
 * fresh read of which of them list the worker and are live. A row lock taken in
 * the same statement as that read could hand back a membership the refresh was
 * replacing; a separate statement after the lock cannot.
 */
export async function resolveSessionEndRequest(db: PrismaClient, requestId: string, now: Date): Promise<SessionEndResolution | null> {
  const head = await db.taskSessionEndRequest.findUnique({ where: { id: requestId }, select: { appId: true } });
  if (!head) return null;
  const owner = await db.app.findUnique({ where: { id: head.appId }, select: { organizationId: true, ownerUserId: true } });
  return db.$transaction(async (tx) => {
    await lockAuthorityAnchors(tx, [
      { kind: 'app', id: head.appId },
      ...(owner?.organizationId ? [{ kind: 'org' as const, id: owner.organizationId }] : []),
      ...(owner?.ownerUserId ? [{ kind: 'user' as const, id: owner.ownerUserId }] : []),
    ], 'shared');
    await lockAppHostLapse(tx, head.appId, 'shared');
    const [schedule] = await tx.$queryRaw<{ checkIns: number | null }[]>`
      SELECT host_lapse_check_ins AS "checkIns" FROM agent_task_stall_schedule WHERE app_id = ${head.appId} FOR SHARE`;
    const checkIns = schedule?.checkIns ?? HOST_LAPSE_CHECK_INS_DEFAULT;
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
    // The App, read under its anchor: live, or nothing is issued to its hosts.
    const app = await tx.app.findUnique({ where: { id: req.appId }, select: { deletedAt: true, uninstalledAt: true } });
    const hostId = app && !app.deletedAt && !app.uninstalledAt
      ? await pickLiveHost(tx, req.appId, req.workerId, session.host, now, checkIns)
      : null;
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
 * the first by host id; a worker is normally registered by one host. Locks the
 * App's registrations FOR SHARE first, then reads membership and liveness in a
 * separate statement, under the lapse count the caller holds.
 */
async function pickLiveHost(
  tx: Prisma.TransactionClient, appId: string, workerId: string, sessionHost: string | null, now: Date, checkIns: number,
): Promise<string | null> {
  await tx.$queryRaw`SELECT id FROM host_registrations WHERE app_id = ${appId} ORDER BY id FOR SHARE`;
  const rows = await tx.$queryRaw<{ hostId: string }[]>`
    SELECT r.host_id AS "hostId"
    FROM host_registrations r
    JOIN host_registration_workers w ON w.registration_id = r.id AND w.worker_id = ${workerId}
    WHERE r.app_id = ${appId}
      AND r.refreshed_at + make_interval(secs => r.poll_interval_seconds * ${checkIns}) >= ${toNaiveUtc(now)}::timestamp
    ORDER BY r.host_id`;
  if (rows.length === 0) return null;
  return rows.find((r) => r.hostId === sessionHost)?.hostId ?? rows[0]!.hostId;
}

/**
 * Is a worker waiting on a session end, so the matcher should not hand it new work yet? (#1709, Proposed.) An open
 * request whose session is still open, or an outstanding `worker.end` whose session is still open: once the named
 * session has ended, a replacement session is free to take work even while the host has not reported yet (#1877
 * review, Colin P3).
 */
export const PENDING_SESSION_END_SQL = (workerColumn: Prisma.Sql) => Prisma.sql`(
  EXISTS (SELECT 1 FROM task_session_end_requests q
          JOIN sessions s ON s.id = q.session_id AND s.ended_at IS NULL
          WHERE q.worker_id = ${workerColumn} AND q.resolved_at IS NULL)
  OR EXISTS (SELECT 1 FROM host_operations o
             JOIN sessions so ON so.id = o.args ->> 'sessionId' AND so.ended_at IS NULL
             WHERE o.worker_id = ${workerColumn} AND o.type = 'worker.end' AND o.status IN ('issued', 'collected')))`;
