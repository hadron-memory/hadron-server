// S7 (#2023, cor:agt:080:29–:31) — the ONE definition of "on standby" and of what a standby worker is still sent.
//
// Two questions, each answered once here and twice in form (a TS function and its SQL twin, pinned equal by
// standby.test.ts in the mentionReach / mentionReachSql style):
//
//   1. Is this worker on standby?      workerStandby()  /  onStandbySql()
//   2. Is this message still admitted? standbyAdmits()  /  standbyAdmitsSql()
//
// A worker is on standby iff ALL hold: the App's switch is on (default off); the worker is not retired; its
// `reportsTo` names an UNRETIRED worker (a report of a retired head gets ordinary delivery, Proposed 080:30); it is not
// itself a team head (some unretired worker reports to it, R88); it has no task as assignee in `pending` or `started`.
// Never cached: every caller evaluates this inside the transaction that decides, so an assignment, a `reportsTo` change,
// a retirement or a switch flip takes effect on the next read.
//
// A message is admitted to a standby worker iff it reaches the worker DIRECTLY (a broadcast is held even from a head or a
// human, Proposed 080:31) AND its author is a human (a person, not a worker, not the system) or the worker's team head.
// Task-assignment wakes and S6 stop notices ride their own lanes and never come through here.
//
// RENDERING vs METADATA (Xan, 6259618779): the reach/authority predicate stays shared. Only the renderer
// (deliveryBatch.ts) applies `standbyAdmitsSql`, to its rows, its count and its overflow. The complete pending
// enumeration keeps the held messages, and `StandbyCoverageClassifier` is how S5 asks which of them are held.
import { Prisma } from '../../generated/prisma/index.js';
import { mentionReach, reachEnvelopeOf } from '../mentionReach.js';
import { mentionTokenOf } from '../mentionToken.js';
import { s7Available } from './s7Availability.js';

type Tx = Pick<Prisma.TransactionClient, 'worker' | 'app' | 'agentTask' | '$queryRaw'>;

export type WorkerStandby = { onStandby: boolean; headWorkerId: string | null };
const OFF: WorkerStandby = { onStandby: false, headWorkerId: null };

/** The task statuses that take a worker off standby (cor:agt:050:02). */
export const STANDBY_BUSY_TASK_STATUSES = ['pending', 'started'] as const;

/** Question 1, in TS. Evaluate inside the deciding transaction. */
/** `excludeTaskId`: the assignment being made, so "was on standby immediately before this assignment" reads true inside it. */
export async function workerStandby(tx: Tx, workerId: string, opts: { excludeTaskId?: string } = {}): Promise<WorkerStandby> {
  if (!s7Available()) return OFF;
  const w = await tx.worker.findUnique({
    where: { id: workerId },
    select: { appId: true, retiredAt: true, reportsToWorkerId: true },
  });
  if (!w || w.retiredAt || !w.reportsToWorkerId) return OFF;
  const [app, head, report, busy] = await Promise.all([
    tx.app.findUnique({ where: { id: w.appId }, select: { deliveryStandbyEnabled: true } }),
    tx.worker.findFirst({ where: { id: w.reportsToWorkerId, appId: w.appId, retiredAt: null }, select: { id: true } }),
    tx.worker.findFirst({ where: { reportsToWorkerId: workerId, appId: w.appId, retiredAt: null }, select: { id: true } }),
    tx.agentTask.findFirst({ where: { assigneeWorkerId: workerId, status: { in: [...STANDBY_BUSY_TASK_STATUSES] }, ...(opts.excludeTaskId ? { id: { not: opts.excludeTaskId } } : {}) }, select: { id: true } }),
  ]);
  if (!app?.deliveryStandbyEnabled || !head || report || busy) return OFF;
  return { onStandby: true, headWorkerId: head.id };
}

/** Question 1, in SQL: a boolean expression over `workers` aliased by `w`. The twin of {@link workerStandby}. */
export function onStandbySql(w: Prisma.Sql = Prisma.sql`w`): Prisma.Sql {
  if (!s7Available()) return Prisma.sql`false`;
  return Prisma.sql`(
    ${w}.retired_at IS NULL
    AND ${w}.reports_to_worker_id IS NOT NULL
    AND EXISTS (SELECT 1 FROM apps a WHERE a.id = ${w}.app_id AND a.delivery_standby_enabled)
    AND EXISTS (SELECT 1 FROM workers h WHERE h.id = ${w}.reports_to_worker_id AND h.app_id = ${w}.app_id AND h.retired_at IS NULL)
    AND NOT EXISTS (SELECT 1 FROM workers r WHERE r.reports_to_worker_id = ${w}.id AND r.app_id = ${w}.app_id AND r.retired_at IS NULL)
    AND NOT EXISTS (SELECT 1 FROM agent_tasks t WHERE t.assignee_worker_id = ${w}.id AND t.status IN (${Prisma.join([...STANDBY_BUSY_TASK_STATUSES])}))
  )`;
}

/** Is the author a person acting as themselves: not the system, not a worker, a user id present. */
function humanAuthored(data: unknown): boolean {
  const e = data && typeof data === 'object' ? (data as Record<string, unknown>) : {};
  return e.authorSystem !== true && typeof e.authorWorkerId !== 'string' && typeof e.authorUserId === 'string';
}

/** Question 2, in TS: does a standby worker (token set `tokens`, head `headWorkerId`) still receive this envelope? */
export function standbyAdmits(data: unknown, tokens: readonly string[], headWorkerId: string): boolean {
  const env = reachEnvelopeOf(data);
  if (mentionReach(env, tokens) !== 'direct') return false;
  return humanAuthored(data) || env.authorWorkerId === headWorkerId;
}

/** Question 2, in SQL over a `data` jsonb expression; the twin of {@link standbyAdmits}. */
export function standbyAdmitsSql(data: Prisma.Sql, tokens: Prisma.Sql, headWorkerId: string): Prisma.Sql {
  return Prisma.sql`(
    jsonb_typeof(${data} -> 'mentions') = 'array' AND (${data} -> 'mentions') ?| ${tokens}
    AND (
      ((${data} -> 'authorSystem') IS DISTINCT FROM 'true'::jsonb
        AND jsonb_typeof(${data} -> 'authorWorkerId') IS DISTINCT FROM 'string'
        AND jsonb_typeof(${data} -> 'authorUserId') = 'string')
      OR (${data} -> 'authorWorkerId') = ${JSON.stringify(headWorkerId)}::jsonb
    )
  )`;
}

export type StandbyCoverageArgs = { workerId: string; channelId: string; incarnation: number; seq: number; headWorkerId: string };
export type StandbyCoverage = { held: boolean; headWorkerId: string };

/**
 * What S5 asks (Diego, #23022): is message `seq` of this channel incarnation HELD from this worker by standby right now?
 * Refuses (throws) when the worker is not on standby, or its head is not `headWorkerId`, or the message is missing: it
 * never answers "not held" for a coverage claim it could not verify. Reads only; the caller holds the delivery locks.
 */
export async function StandbyCoverageClassifier(tx: Tx, args: StandbyCoverageArgs): Promise<StandbyCoverage> {
  const state = await workerStandby(tx, args.workerId);
  if (!state.onStandby || state.headWorkerId !== args.headWorkerId) {
    throw new Error('STANDBY_COVERAGE_MISMATCH: the worker is not on standby under that head.');
  }
  const w = await tx.worker.findUniqueOrThrow({ where: { id: args.workerId }, select: { name: true } });
  const token = mentionTokenOf(w.name);
  const rows = await tx.$queryRaw<Array<{ data: unknown }>>(Prisma.sql`
    SELECT n.data FROM nodes n JOIN channels c ON c.id = n.message_channel_id
    WHERE n.message_channel_id = ${args.channelId} AND c.incarnation = ${args.incarnation}
      AND n.seq = ${args.seq} AND n.node_type = 'chat-message' AND n.deleted_at IS NULL`);
  if (rows.length === 0) throw new Error('STANDBY_COVERAGE_MISMATCH: no such message in that channel incarnation.');
  return { held: !token || !standbyAdmits(rows[0]!.data, [token], args.headWorkerId), headWorkerId: args.headWorkerId };
}
