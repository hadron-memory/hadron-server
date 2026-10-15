/**
 * #1881 (cor:agt:070:02; Holger via Vera, team chat #10765) — nothing stays in flight forever.
 *
 * - A COLLECTED operation the host has not reported fails once the App's report timeout has passed since it was
 *   collected (default {@link HOST_REPORT_TIMEOUT_DEFAULT_MINUTES} minutes, 5 to 1440: Proposed).
 * - An ISSUED operation no host has collected is settled when its host's registration lapses (recorded lost), or when
 *   its reason goes away. The reasons that can go away are a `worker.start`'s (its worker retired, its hold changed,
 *   or the task it was for is no longer that worker's open task) and a `worker.end`'s (its session already ended).
 *   A `worktree.create` / `worktree.remove` has no reason that can vanish, so only its host's lapse settles it.
 *
 * Settling gives the outcome a FAILED report would have: a `worker.start` whose session is bound succeeded, a
 * `worker.end` whose session ended succeeded (cor:agt:020:10: it fails only if the session did not end), anything
 * else failed with why. A failure revokes the start's unconsumed grant. Each settlement writes
 * `host.operation.succeeded` / `.failed`, as a report does.
 *
 * Every decision is made again under the operation's row lock (a collect or a report holding it either committed
 * first and is seen, or waits), and the timeout is read under the App's host-lapse lock taken SHARED, which the
 * setter of the timeout takes EXCLUSIVE: a timeout cannot fire under a value a manager has just raised.
 */

import { Prisma, type PrismaClient } from '../../generated/prisma/index.js';
import { toNaiveUtc } from '../sessionActivity.js';
import { appendHostOperationEvent } from '../agentTasks/events.js';
import { lockAppHostLapse } from '../agentTasks/hosts.js';
import { handoffSessionId, newestHandoff } from '../workerHandoff.js';

export const HOST_REPORT_TIMEOUT_DEFAULT_MINUTES = 60;
export const HOST_REPORT_TIMEOUT_MIN_MINUTES = 5;
export const HOST_REPORT_TIMEOUT_MAX_MINUTES = 1440;

type Db = PrismaClient | Prisma.TransactionClient;
type OpRow = Prisma.HostOperationGetPayload<Record<string, never>>;

/** The App's report timeout in minutes: its stall schedule's, or the default. */
export async function hostReportTimeoutMinutes(db: Db, appId: string): Promise<number> {
  const row = await db.agentTaskStallSchedule.findUnique({ where: { appId }, select: { hostReportTimeoutMinutes: true } });
  return row?.hostReportTimeoutMinutes ?? HOST_REPORT_TIMEOUT_DEFAULT_MINUTES;
}

/** Did the worker write its closing handoff for this session (cor:agt:020:10)? Its newest handoff names the session. */
export async function sessionHasHandoff(tx: Prisma.TransactionClient, workerId: string, sessionId: string): Promise<boolean> {
  const worker = await tx.worker.findUnique({ where: { id: workerId }, select: { memoryId: true } });
  if (!worker?.memoryId) return false;
  const newest = await newestHandoff(tx, worker.memoryId);
  return Boolean(newest && handoffSessionId(newest.data) === sessionId);
}

/** Why an unreported operation is settled now. */
export type SettleReason = 'timeout' | 'host-lost' | 'worker-retired' | 'hold-changed' | 'task-gone' | 'session-ended';

/**
 * The one predicate, in SQL over `o` (host_operations), so the sweep's candidate read and the re-decision under the
 * row lock are the same computation. Yields the reason, or NULL when the operation stays in flight.
 */
function reasonSql(now: Date): Prisma.Sql {
  const at = Prisma.sql`${toNaiveUtc(now)}::timestamp`;
  return Prisma.sql`CASE
    WHEN o.status = 'collected' AND o.collected_at + make_interval(mins => COALESCE(
           (SELECT s.host_report_timeout_minutes FROM agent_task_stall_schedule s WHERE s.app_id = o.app_id),
           ${HOST_REPORT_TIMEOUT_DEFAULT_MINUTES})::int) <= ${at}
      THEN 'timeout'
    WHEN o.status <> 'issued' THEN NULL
    WHEN o.type = 'worker.end' AND EXISTS (
           SELECT 1 FROM sessions se WHERE se.id = o.args ->> 'sessionId' AND se.ended_at IS NOT NULL)
      THEN 'session-ended'
    WHEN NOT EXISTS (
           SELECT 1 FROM host_registrations r WHERE r.app_id = o.app_id AND r.host_id = o.host_id AND r.lost_at IS NULL)
      THEN 'host-lost'
    WHEN o.type <> 'worker.start' THEN NULL
    WHEN EXISTS (SELECT 1 FROM workers w WHERE w.id = o.worker_id AND w.retired_at IS NOT NULL)
      THEN 'worker-retired'
    WHEN NOT EXISTS (
           SELECT 1 FROM workers w WHERE w.id = o.worker_id
             AND w.held_by_user_id IS NOT DISTINCT FROM o.hold_user_id AND w.held_at IS NOT DISTINCT FROM o.hold_at)
      THEN 'hold-changed'
    WHEN o.args ? 'taskId' AND NOT EXISTS (
           SELECT 1 FROM agent_tasks t WHERE t.id = o.args ->> 'taskId'
             AND t.assignee_worker_id = o.worker_id AND t.status IN ('pending', 'started'))
      THEN 'task-gone'
    ELSE NULL
  END`;
}

const FAILURE_TEXT: Record<Exclude<SettleReason, 'timeout' | 'session-ended'>, string> = {
  'host-lost': "The host's registration lapsed before it collected this.",
  'worker-retired': 'The worker was retired before its start was collected.',
  'hold-changed': 'The hold changed after this start was issued.',
  'task-gone': "The task this start was for is no longer the worker's open task.",
};

/**
 * Settle every operation whose reason holds at `now` (at most 500 a pass, oldest first). Each in its own transaction,
 * decided again there under locks. Returns how many were settled.
 */
export async function sweepUnreportedHostOperations(db: PrismaClient, now = new Date()): Promise<number> {
  const candidates = await db.$queryRaw<{ id: string; appId: string }[]>`
    SELECT o.id, o.app_id AS "appId" FROM host_operations o
    WHERE o.status IN ('issued', 'collected') AND (${reasonSql(now)}) IS NOT NULL
    ORDER BY o.issued_at, o.id
    LIMIT 500`;
  let settled = 0;
  for (const c of candidates) {
    try {
      if (await settleOne(db, c, now)) settled += 1;
    } catch (err) {
      console.error('[host-ops] settling an unreported operation failed:', c.id, err);
    }
  }
  return settled;
}

async function settleOne(db: PrismaClient, c: { id: string; appId: string }, now: Date): Promise<boolean> {
  return db.$transaction(async (tx) => {
    // The timeout's setter takes this exclusive: the timeout read below is the one in force.
    await lockAppHostLapse(tx, c.appId, 'shared');
    const [locked] = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM host_operations WHERE id = ${c.id} FOR UPDATE`;
    if (!locked) return false;
    const [row] = await tx.$queryRaw<{ reason: SettleReason | null }[]>`
      SELECT (${reasonSql(now)}) AS reason FROM host_operations o WHERE o.id = ${c.id}`;
    if (!row?.reason) return false;
    const op = await tx.hostOperation.findUniqueOrThrow({ where: { id: c.id } });
    const minutes = row.reason === 'timeout' ? await hostReportTimeoutMinutes(tx, op.appId) : 0;
    const text = row.reason === 'timeout'
      ? `No report within ${minutes} minutes of collection.`
      : row.reason === 'session-ended' ? 'The session had already ended.' : FAILURE_TEXT[row.reason];
    await settleAsFailedReport(tx, op, text, now);
    return true;
  });
}

/**
 * The outcome a FAILED report with `reason` would have (the report path's rules), written for an operation still
 * `issued` or `collected`. A worker.start whose session is bound and a worker.end whose session ended succeeded.
 */
export async function settleAsFailedReport(
  tx: Prisma.TransactionClient,
  op: OpRow,
  reason: string,
  now: Date,
): Promise<'succeeded' | 'failed'> {
  let outcome: 'succeeded' | 'failed' = 'failed';
  let result: Prisma.InputJsonObject | null = null;
  if (op.type === 'worker.start') {
    const bound = await tx.session.findUnique({ where: { launchOperationId: op.id }, select: { id: true } });
    if (bound) {
      outcome = 'succeeded';
      result = { sessionId: bound.id };
    }
  }
  if (op.type === 'worker.end') {
    const args = op.args as { workerId: string; sessionId: string };
    const [session] = await tx.$queryRaw<{ endedAt: Date | null }[]>`
      SELECT ended_at AS "endedAt" FROM sessions WHERE id = ${args.sessionId} FOR UPDATE`;
    if (session?.endedAt) {
      outcome = 'succeeded';
      result = { handoff: await sessionHasHandoff(tx, args.workerId, args.sessionId) };
    }
  }
  await tx.hostOperation.update({
    where: { id: op.id },
    data: {
      status: outcome,
      finishedAt: now,
      result: result ?? Prisma.DbNull,
      failureReason: outcome === 'failed' ? reason.slice(0, 2000) : null,
    },
  });
  if (outcome === 'failed') {
    await tx.launchGrant.updateMany({ where: { operationId: op.id, consumedAt: null, revokedAt: null }, data: { revokedAt: now } });
  }
  await appendHostOperationEvent(tx, {
    appId: op.appId,
    type: outcome === 'succeeded' ? 'host.operation.succeeded' : 'host.operation.failed',
    operationId: op.id,
    hostId: op.hostId,
    operationType: op.type,
    workerId: op.workerId,
    createdAt: now,
  });
  return outcome;
}
