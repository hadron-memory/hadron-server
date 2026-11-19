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
 * CONCURRENCY: ONE LOCK PROTOCOL for every path that writes the graph or
 * decides authority from it (#1737 review: Diego P2-2, P2-3; Rook P2-1).
 *
 *   1. authority anchors (`withAuthorizedTx`), when the path takes them;
 *   2. the App's reportsTo GRAPH lock ({@link lockAppReportsTo}): EXCLUSIVE
 *      for a writer (a set, a bind's `reportsTo`, a retirement), SHARED for a
 *      reader whose authority depends on the graph (every task write,
 *      `inTaskWriteTx`);
 *   3. membership rows (`app_members`, `org_members`, `users`) FOR SHARE;
 *   4. worker rows.
 *
 * The graph lock comes BEFORE any worker row on every path. A path that locked
 * a worker first and then waited on the graph lock would deadlock with a
 * writer holding the graph lock and waiting on that worker. Holding it shared,
 * a reader sees a graph no writer can change before it commits, so the chain
 * walk needs no row locks of its own.
 *
 * The exclusive lock also serializes the writes themselves: two changes on
 * disjoint rows could each pass the cycle check and together close a loop
 * (Marco → Dan and Liam → Ada while Ada → Marco and Dan → Liam exist).
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

/**
 * The App's reportsTo graph lock (see the module header): `exclusive` for a
 * writer, `shared` for a reader deciding authority from the graph. Re-entrant
 * within a transaction; never upgrade (take `exclusive` first if you will write).
 */
export async function lockAppReportsTo(tx: Tx, appId: string, mode: 'exclusive' | 'shared' = 'exclusive'): Promise<void> {
  const key = 'worker-reports-to:' + appId;
  if (mode === 'shared') await tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(hashtext(${key}))`;
  else await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
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
 * transaction, and record it. A no-op (the pointer AND recorded choice already match) writes nothing and
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
  const rows = await tx.$queryRaw<Array<{ id: string; app_id: string; retired_at: Date | null; reports_to_worker_id: string | null; explicit_no_team: boolean }>>`
    SELECT id, app_id, retired_at, explicit_no_team, reports_to_worker_id FROM workers WHERE id = ANY(${ids}::text[]) ORDER BY id FOR UPDATE`;
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

  // Authority BEFORE the target's checks, so a target refusal (another App,
  // retired, a cycle) only ever answers a caller allowed to make the change
  // (#1737 QA, Chip's P2). A no-op still returns first: the current value is
  // readable by everyone who can reach this. Marker-only changes still need authority.
  const explicitNoTeam = args.to === null && args.setBy !== 'retirement';
  const markerChanged = worker.explicit_no_team !== explicitNoTeam;
  let setBy = args.setBy;
  if ((from !== args.to || markerChanged) && args.authorize) setBy = await args.authorize(from);

  if (args.to !== null) {
    if (args.to === args.workerId) throw refusal('WORKER_REPORTS_TO_SELF', 'A worker cannot report to itself.');
    const target = rows.find((r) => r.id === args.to);
    if (!target) throw refusal('WORKER_NOT_FOUND', `Worker not found: "${args.to}"`);
    if (target.app_id !== appId) {
      throw refusal('WORKER_REPORTS_TO_OTHER_APP', 'A worker reports to a worker of its own App.');
    }
    if (target.retired_at) {
      throw refusal('WORKER_REPORTS_TO_RETIRED', 'A worker cannot report to a retired worker.', { reportsTo: args.to });
    }
    const above = await reportsToChain(tx, args.to);
    if (above.includes(args.workerId)) {
      throw refusal('WORKER_REPORTS_TO_CYCLE', 'That would make the worker report to itself through the chain.', { reportsTo: args.to });
    }
  }

  if (from === args.to && !markerChanged) return { workerId: args.workerId, appId, from, to: args.to, changed: false };
  await tx.worker.update({ where: { id: args.workerId }, data: { reportsToWorkerId: args.to, explicitNoTeam } });
  await appendReportsToEvent(tx, { appId, actor: args.actor, workerId: args.workerId, from, to: args.to, setBy, ...(markerChanged ? { oldExplicitNoTeam: worker.explicit_no_team, newExplicitNoTeam: explicitNoTeam } : {}) });
  return { workerId: args.workerId, appId, from, to: args.to, changed: true };
}
