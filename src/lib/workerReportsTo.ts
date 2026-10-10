/**
 * #1726 — who a worker reports to (Task Management, #1704).
 *
 * Holger (2026-10-09): a worker reports to exactly one other worker, and the
 * platform records it as a field of the Worker (the casting), not of a session.
 * The value is a non-retired Worker of the same App, never the worker itself,
 * and never a cycle. Null reports to nobody.
 *
 * This module is the ONLY writer of `Worker.reportsToWorkerId`. Every change
 * goes through {@link writeReportsTo}, which validates the target, refuses a
 * cycle, and appends the `worker.reports-to` event that is the value's history
 * (the row holds only the current one). Authority (who may make the change) is
 * the caller's: this module decides only whether the change is well-formed.
 *
 * CONCURRENCY. Two changes in one App could each pass the cycle check and
 * together close a loop (A → B while B → A). Every write therefore takes one
 * advisory lock per App first, so the checks and writes in an App run one at a
 * time. The worker rows are then locked FOR UPDATE, which also orders a write
 * against `retireWorker`.
 */

import { GraphQLError } from 'graphql';
import type { Prisma, PrismaClient } from '../generated/prisma/index.js';
import { appendReportsToEvent, type EventActor, type ReportsToSetter } from './agentTasks/events.js';

type Tx = Prisma.TransactionClient;
type Db = Pick<PrismaClient, '$queryRaw'> | Tx;

/** A chain longer than this is treated as corrupt rather than walked forever. */
const MAX_CHAIN = 1000;

function refusal(code: string, message: string, extensions: Record<string, unknown> = {}): GraphQLError {
  return new GraphQLError(message, { extensions: { ...extensions, code } });
}

/** Serialize every reportsTo change in one App (see the module header). */
export async function lockAppReportsTo(tx: Tx, appId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'worker-reports-to:' + appId}))`;
}

/**
 * The workers above `workerId`, nearest first: who it reports to, who that one
 * reports to, and so on. Excludes `workerId` itself. Retired workers are
 * included: a chain is a record of the structure, and a stale link is for the
 * roster to flag, not for this walk to hide.
 */
export async function reportsToChain(db: Db, workerId: string): Promise<string[]> {
  const rows = await db.$queryRaw<Array<{ id: string }>>`
    WITH RECURSIVE up(id, depth) AS (
      SELECT reports_to_worker_id, 1 FROM workers WHERE id = ${workerId} AND reports_to_worker_id IS NOT NULL
      UNION ALL
      SELECT w.reports_to_worker_id, up.depth + 1 FROM workers w JOIN up ON w.id = up.id
      WHERE w.reports_to_worker_id IS NOT NULL AND up.depth < ${MAX_CHAIN}
    )
    SELECT id FROM up ORDER BY depth`;
  return rows.map((r) => r.id);
}

export type ReportsToChange = { workerId: string; appId: string; from: string | null; to: string | null; changed: boolean };

/**
 * Set, hand over or clear `workerId`'s reportsTo inside the caller's
 * transaction, and record it. A no-op (the value already) writes nothing and
 * returns `changed: false`. Refusals:
 *
 * - `WORKER_NOT_FOUND`: the worker, or the target, does not exist;
 * - `WORKER_RETIRED`: the worker is retired (its value was cleared at
 *   retirement and stays clear);
 * - `WORKER_REPORTS_TO_SELF`, `WORKER_REPORTS_TO_OTHER_APP`,
 *   `WORKER_REPORTS_TO_RETIRED`, `WORKER_REPORTS_TO_CYCLE`: the target is
 *   not a worker this one may report to.
 *
 * `expectedFrom`, when given, must match the value under the lock
 * (`WORKER_REPORTS_TO_STALE` otherwise): a caller that decided on the current
 * value never overwrites a change made since.
 */
export async function writeReportsTo(
  tx: Tx,
  args: {
    workerId: string;
    to: string | null;
    actor: EventActor;
    setBy: ReportsToSetter;
    expectedFrom?: string | null;
    /** The worker's App, when the caller already holds it; else read here. */
    appId?: string;
    /**
     * The caller's authority, decided on the value as it is under the lock:
     * returns the setter word, or throws. Without it, `setBy` is used as given
     * (the platform's own writes: retirement).
     */
    authorize?: (from: string | null) => Promise<ReportsToSetter>;
  },
): Promise<ReportsToChange> {
  const appId = args.appId ?? (await tx.worker.findUnique({ where: { id: args.workerId }, select: { appId: true } }))?.appId;
  if (!appId) throw refusal('WORKER_NOT_FOUND', `Worker not found: "${args.workerId}"`);
  await lockAppReportsTo(tx, appId);

  const ids = [...new Set([args.workerId, ...(args.to ? [args.to] : [])])].sort();
  const rows = await tx.$queryRaw<Array<{ id: string; app_id: string; retired_at: Date | null; reports_to_worker_id: string | null }>>`
    SELECT id, app_id, retired_at, reports_to_worker_id FROM workers WHERE id = ANY(${ids}::text[]) ORDER BY id FOR UPDATE`;
  const worker = rows.find((r) => r.id === args.workerId);
  if (!worker || worker.app_id !== appId) throw refusal('WORKER_NOT_FOUND', `Worker not found: "${args.workerId}"`);
  const from = worker.reports_to_worker_id;
  if (args.expectedFrom !== undefined && args.expectedFrom !== from) {
    throw refusal('WORKER_REPORTS_TO_STALE', 'Who this worker reports to changed since you read it; read it again.', { reportsTo: from });
  }
  // A retired worker's value is cleared at retirement; only that clear may write.
  if (worker.retired_at && !(args.to === null && args.setBy === 'retirement')) {
    throw refusal('WORKER_RETIRED', 'A retired worker reports to nobody.', { workerId: worker.id });
  }

  if (args.to !== null) {
    if (args.to === args.workerId) throw refusal('WORKER_REPORTS_TO_SELF', 'A worker cannot report to itself.');
    const target = rows.find((r) => r.id === args.to);
    if (!target) throw refusal('WORKER_NOT_FOUND', `Worker not found: "${args.to}"`);
    if (target.app_id !== appId) {
      throw refusal('WORKER_REPORTS_TO_OTHER_APP', 'A worker reports to a worker of its own App.', { reportsTo: args.to });
    }
    if (target.retired_at) {
      throw refusal('WORKER_REPORTS_TO_RETIRED', 'A worker cannot report to a retired worker.', { reportsTo: args.to });
    }
    const above = await reportsToChain(tx, args.to);
    if (above.includes(args.workerId)) {
      throw refusal('WORKER_REPORTS_TO_CYCLE', 'That would make the worker report to itself through the chain.', { reportsTo: args.to });
    }
  }

  if (from === args.to) return { workerId: args.workerId, appId, from, to: args.to, changed: false };
  const setBy = args.authorize ? await args.authorize(from) : args.setBy;
  await tx.worker.update({ where: { id: args.workerId }, data: { reportsToWorkerId: args.to } });
  await appendReportsToEvent(tx, { appId, actor: args.actor, workerId: args.workerId, from, to: args.to, setBy });
  return { workerId: args.workerId, appId, from, to: args.to, changed: true };
}
