/**
 * #3571 (ruling 0223, cor:int:010:01): the one-off reconciliation of a memory the pre-#3568 no-installation path left
 * reading SYNCING. Such a row becomes PENDING and NOTHING ELSE: no report, no audit row, no enqueued sync, and
 * `sync_error`, `last_sync_report`, `last_synced_at` and every other byte (`updated_at` included) keep their values,
 * so applying it again changes nothing.
 *
 * Eligible: `sync_status = 'SYNCING'`, not deleted, not encrypted (cor:sec:040:05), AND no source, or an organization
 * with no installation (the two cases the ruling names), AND no sync running. "No sync running" is the sync-run lock
 * (syncRunLock.ts): every attempt holds it shared from before its SYNCING stamp to after its final status write, and
 * this takes it exclusively with a TRY, per row, inside the row's own transaction, so a running sync makes the row
 * skip (`held`). Configuration age or absence alone is never treated as proof. The row is re-checked under that lock
 * and `FOR UPDATE`, so a candidate whose configuration changed since the scan is skipped (`ineligible`).
 *
 * A user-owned memory (no organization) with a source is not one of the ruled cases: it is counted as `uncovered`
 * and never changed.
 *
 * One bad row never aborts the run (#4731, #4719 BLIND P3-4): each row's failure (a lock wait that times out behind a slow
 * write, a dropped connection) is caught on its own, counted as `failed`, and the run goes on and reports it; the row
 * is left as it was, so re-running is safe. The row transaction bounds its own waits with a `lock_timeout` (the
 * try-lock never waits; the `FOR UPDATE` can), so a stuck row is a failed row and not a hung run. The sync's own shared
 * lock wait is deliberately NOT bounded: it waits only for a reconciliation's one short, now time-bounded transaction,
 * and bounding it would turn a harmless wait into a failed sync (#4719 LOCAL F2).
 *
 * Who may run this, and any production inventory or repair, is outside the ruling and this code: it needs its own
 * explicit grant.
 */
import type { PrismaClient } from '../../generated/prisma/index.js';
import { syncRunLockKey } from './syncRunLock.js';

export interface ReconcileSyncingResult {
  apply: boolean;
  /** Rows matching the eligibility predicate at the scan. */
  candidates: number;
  /** Rows set to PENDING (apply only). */
  reconciled: number;
  /**
   * Candidates skipped because their run lock was held (apply only): a running sync, or another reconciliation working
   * the same row at that moment (#4719 BLIND P3-3). Either way the row was not written; re-running is safe.
   */
  held: number;
  /** Candidates that no longer matched when re-checked under the lock (apply only). */
  ineligible: number;
  /** SYNCING rows of a user-owned memory with a source: not a ruled case, never changed. */
  uncovered: number;
  /** Candidates whose own transaction failed (apply only), for example a row lock that timed out; left unchanged, safe to re-run. */
  failed: number;
}

export interface ReconcileSyncingOptions {
  /** Write the reconciliation; without it this is a dry run that counts and writes nothing. */
  apply: boolean;
  /** Runs after the candidate scan and before the locked re-checks (tests use it to change state in between). */
  onCandidates?: () => Promise<void>;
  /** How long one row's transaction may wait for a lock, in milliseconds. A positive integer; anything else is the default (5000). */
  lockTimeoutMs?: number;
}

const DEFAULT_LOCK_TIMEOUT_MS = 5000;

function lockTimeoutMs(value: number | undefined): number {
  return Number.isSafeInteger(value) && (value as number) > 0 ? (value as number) : DEFAULT_LOCK_TIMEOUT_MS;
}

/** Ids of eligible SYNCING rows at this moment; a hint only, every row is re-checked under its lock before a write. */
async function scanCandidates(db: PrismaClient): Promise<string[]> {
  const rows = await db.$queryRaw<Array<{ id: string }>>`
    SELECT m.id FROM memories m LEFT JOIN organizations o ON o.id = m.organization_id
    WHERE m.sync_status = 'SYNCING' AND m.deleted_at IS NULL AND m.is_encrypted = false
      AND (m.source IS NULL OR (m.organization_id IS NOT NULL AND o.github_installation_id IS NULL))
    ORDER BY m.id`;
  return rows.map((r) => r.id);
}

async function countUncovered(db: PrismaClient): Promise<number> {
  const [{ n }] = await db.$queryRaw<Array<{ n: bigint }>>`
    SELECT count(*) AS n FROM memories m
    WHERE m.sync_status = 'SYNCING' AND m.deleted_at IS NULL AND m.is_encrypted = false
      AND m.source IS NOT NULL AND m.organization_id IS NULL`;
  return Number(n);
}

/** One candidate in its own short transaction: try the run lock, re-check the exact row, write sync_status only. */
async function reconcileRow(db: PrismaClient, id: string, timeoutMs: number): Promise<'reconciled' | 'held' | 'ineligible'> {
  return db.$transaction(async (tx) => {
    // Local to this transaction (set_config(..., true)): it dies with the commit or rollback and never reaches a pooled session.
    await tx.$executeRaw`SELECT set_config('lock_timeout', ${`${timeoutMs}ms`}, true)`;
    const [{ locked }] = await tx.$queryRaw<Array<{ locked: boolean }>>`
      SELECT pg_try_advisory_xact_lock(hashtext(${syncRunLockKey(id)})) AS locked`;
    if (!locked) return 'held';
    const still = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT m.id FROM memories m LEFT JOIN organizations o ON o.id = m.organization_id
      WHERE m.id = ${id} AND m.sync_status = 'SYNCING' AND m.deleted_at IS NULL AND m.is_encrypted = false
        AND (m.source IS NULL OR (m.organization_id IS NOT NULL AND o.github_installation_id IS NULL))
      FOR UPDATE OF m`;
    if (still.length === 0) return 'ineligible';
    // Raw SQL on purpose: Prisma's @updatedAt would also rewrite updated_at, and ruling 0223 allows sync_status only.
    await tx.$executeRaw`UPDATE memories SET sync_status = 'PENDING' WHERE id = ${id} AND sync_status = 'SYNCING'`;
    return 'reconciled';
  });
}

export async function reconcileSyncingStatus(db: PrismaClient, opts: ReconcileSyncingOptions): Promise<ReconcileSyncingResult> {
  const candidates = await scanCandidates(db);
  const result: ReconcileSyncingResult = {
    apply: opts.apply, candidates: candidates.length, reconciled: 0, held: 0, ineligible: 0, uncovered: await countUncovered(db), failed: 0,
  };
  if (!opts.apply) return result;
  await opts.onCandidates?.();
  const timeoutMs = lockTimeoutMs(opts.lockTimeoutMs);
  for (const id of candidates) {
    try {
      result[await reconcileRow(db, id, timeoutMs)] += 1;
    } catch (error) {
      // Code only, never the message (it can name the host) or the id: the run reports counts.
      result.failed += 1;
      console.error('[reconcile-syncing] a row failed and was left unchanged', { code: (error as { code?: string } | null)?.code ?? 'unknown' });
    }
  }
  return result;
}
