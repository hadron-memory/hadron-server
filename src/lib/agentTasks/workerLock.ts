/**
 * The per-worker assignment lock (#1707, the matcher's; #2162 makes it shared). A transaction-scoped advisory lock on
 * one worker, taken by every writer that decides whether a worker may take work or be reset: the matcher's
 * assignment, a hand assign, reassign or create-with-assignee, a task start, finish or cancel, a session bind, an
 * availability write, and every step of a context reset (cor:agt:050:27).
 *
 * THE ORDER (src/lib/stopSignals/state.ts and the #2162 build boundary): authority anchors → stop fence → reportsTo →
 * THIS LOCK → app_members / workers rows → the task row → worker_availability → context_resets. It is taken before
 * any row lock, never after one: a writer holding a worker or task row and then waiting here can cycle with one that
 * holds this lock and waits for that row. Several workers are locked in id order, once.
 */

import type { Prisma } from '../../generated/prisma/index.js';

/** Lock each worker of `workerIds` (deduplicated, in id order) for this transaction. */
export async function lockWorkersForAssignment(tx: Prisma.TransactionClient, workerIds: readonly (string | null | undefined)[]): Promise<void> {
  const ids = [...new Set(workerIds.filter((id): id is string => typeof id === 'string' && id !== ''))].sort();
  for (const id of ids) {
    // $executeRaw: pg_advisory_xact_lock returns void, which $queryRaw cannot deserialize.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('agent-task-matcher:worker'), hashtext(${id}))`;
  }
}
