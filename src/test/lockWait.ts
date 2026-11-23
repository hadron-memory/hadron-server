/**
 * A deterministic barrier for race tests: resolve once `n` other backends in
 * THIS database are blocked on a lock (row or advisory). It proves the
 * competing transaction is actually waiting, rather than assuming it from a
 * sleep. Each vitest worker has its own database clone, so the count is this
 * test's alone.
 */
import type { PrismaClient } from '../generated/prisma/index.js';

export async function waitForLockWaiters(db: PrismaClient, n = 1, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const [{ waiting }] = await db.$queryRaw<Array<{ waiting: number }>>`
      SELECT count(*)::int AS waiting FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()`;
    if (waiting >= n) return;
    if (Date.now() > deadline) throw new Error(`waitForLockWaiters: no backend blocked on a lock within ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

/**
 * #4940: resolve once `n` backends in THIS database are blocked on a lock held by the backend `blockerPid` (it appears in
 * their `pg_blocking_pids`). Use it when a pin must know ITS competitor is waiting on ITS holder: an unrelated waiter, in
 * this database or any other, cannot satisfy it. `blockerPid` is the holder's `SELECT pg_backend_pid()`, read inside its own
 * transaction (a Prisma interactive transaction pins one connection).
 */
export async function waitForLockWaitersBlockedBy(
  db: PrismaClient,
  blockerPid: number,
  n = 1,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const [{ waiting }] = await db.$queryRaw<Array<{ waiting: number }>>`
      SELECT count(*)::int AS waiting FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()
        AND ${blockerPid}::int = ANY (pg_blocking_pids(pid))`;
    if (waiting >= n) return;
    if (Date.now() > deadline) throw new Error(`waitForLockWaitersBlockedBy: no backend blocked behind pid ${blockerPid} within ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

/**
 * The typed barrier: resolve once `n` backends in THIS database hold an
 * ungranted lock of `locktype`. Use it when a race stages waits of different
 * kinds in sequence, so an earlier row-lock waiter cannot satisfy a later
 * advisory wait.
 *
 * Scoped by the waiting backend's database, not `pg_locks.database`: that
 * column is NULL for `transactionid` locks, so filtering on it let another
 * vitest worker's row-lock wait (its own database clone) satisfy this count
 * before the test's own blocked write existed (#1470).
 */
export async function waitForLockWaitersOfType(
  db: PrismaClient,
  locktype: 'advisory' | 'transactionid',
  n = 1,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const [{ waiting }] = await db.$queryRaw<Array<{ waiting: number }>>`
      SELECT count(*)::int AS waiting FROM pg_locks
      WHERE locktype = ${locktype}
        AND NOT granted
        AND pid IN (SELECT pid FROM pg_stat_activity WHERE datname = current_database())`;
    if (waiting >= n) return;
    if (Date.now() > deadline) {
      throw new Error(`waitForLockWaitersOfType: timed out waiting for ${n} ${locktype} lock waiter(s)`);
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** One backend's row from {@link describeLockHolders}. */
export interface LockHolderRow {
  pid: number;
  state: string | null;
  wait_event_type: string | null;
  wait_event: string | null;
  locktype: string;
  relation: string | null;
  mode: string;
  granted: boolean;
  query: string | null;
}

/** What {@link describeLockHolders} read: at most {@link HOLDER_ROW_CAP} rows, and whether more existed. */
export interface LockHolders { rows: LockHolderRow[]; truncated: boolean }
export const HOLDER_ROW_CAP = 40;

/**
 * #3272: who else holds or awaits a lock in THIS database right now, for a NOWAIT probe that just failed. Reads `pg_locks` joined
 * to `pg_stat_activity` (pid, state, wait event, lock type, relation, mode, granted, the backend's last query).
 *
 * Which rows: every backend's locks ON `relation` (the rows that name the holder of the probed table), then, after them, the
 * transactionid, advisory and tuple locks of every backend (a row lock shows as a tuple or transactionid lock, which carries no
 * relation of its own). The relation rows sort FIRST, so a busy database's unrelated lockers cannot push the holder out of the
 * cap; the cap is {@link HOLDER_ROW_CAP}, and `truncated` says when more rows existed. The capture is meant to run on a SEPARATE
 * connection, so its own backend holds none of these (the probing connection's own locks are reported like any other's).
 * It reports; it decides nothing.
 */
export async function describeLockHolders(
  db: Pick<PrismaClient, '$queryRaw'>,
  relation: string,
): Promise<LockHolders> {
  const rows = await db.$queryRaw<LockHolderRow[]>`
    SELECT l.pid, a.state, a.wait_event_type, a.wait_event, l.locktype, l.relation::regclass::text AS relation,
           l.mode, l.granted, left(a.query, 300) AS query
    FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
    WHERE a.datname = current_database()
      AND (l.relation = ${relation}::regclass OR l.locktype IN ('transactionid', 'advisory', 'tuple'))
    ORDER BY (l.relation = ${relation}::regclass) DESC NULLS LAST, l.pid, l.locktype
    LIMIT ${HOLDER_ROW_CAP + 1}`;
  return { rows: rows.slice(0, HOLDER_ROW_CAP), truncated: rows.length > HOLDER_ROW_CAP };
}

const isLockNotAvailable = (e: unknown): boolean => {
  const meta = (e as { meta?: { code?: unknown } } | null)?.meta;
  return meta?.code === '55P03' || /\b55P03\b|could not obtain lock/.test(String((e as { message?: unknown } | null)?.message ?? ''));
};

/**
 * #3272: run a NOWAIT probe; if it fails with 55P03 (lock not available), capture the holders on a SEPARATE connection and rethrow
 * with them in the message and the original error as `cause`. Any other error is rethrown untouched, a probe that succeeds returns
 * its value and reads nothing extra, and a capture that itself fails never hides the original (the message says so). No retry, no
 * budget change: the helper reports, it does not classify the failure.
 */
export async function withLockHolders<T>(
  db: Pick<PrismaClient, '$queryRaw'>,
  relation: string,
  probe: () => Promise<T>,
): Promise<T> {
  try {
    return await probe();
  } catch (err) {
    if (!isLockNotAvailable(err)) throw err;
    let holders: string;
    try {
      const found = await describeLockHolders(db, relation);
      holders = JSON.stringify(found.rows, null, 1) + (found.truncated ? `\n(truncated: more than ${HOLDER_ROW_CAP} rows; relation rows first)` : '');
    } catch (captureErr) {
      holders = `(capture failed: ${String((captureErr as Error)?.message ?? captureErr)})`;
    }
    throw new Error(`${(err as Error).message}\nlock holders on ${relation} at the failure (#3272):\n${holders}`, { cause: err });
  }
}
