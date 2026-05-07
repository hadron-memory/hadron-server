/**
 * Retention-sweep eligibility math (011-soft-delete-memory FR-023, R-4).
 *
 * The sweep counts retention from `max(deletedAt, releaseMarker)` so memories
 * whose `deletedAt` predates the 011 release (legacy rows from the
 * half-implemented soft-delete behavior) get a full review window from launch
 * date instead of being surprise-purged on the first sweep tick.
 *
 *     eligible(deletedAt, releaseMarker, window, now)
 *       = deletedAt != null
 *       AND max(deletedAt, releaseMarker) + window <= now
 *
 * The releaseMarker must be set by the deploy-time migration; if it is
 * missing the helper returns false (and the sweep job is expected to log a
 * warning and exit at job-start, separately from this predicate).
 */

export type RetentionEligibilityInput = {
  /** `Memory.deletedAt`. Null => memory is active, never eligible. */
  deletedAt: Date | null;
  /** The 011 release marker (per R-4). Null => sweep should refuse to run. */
  releaseMarker: Date | null;
  /** Retention window in milliseconds. Default 30 days = 30 * 24 * 60 * 60 * 1000. */
  retentionWindowMs: number;
  /** Current time (injected for testability). */
  now: Date;
};

export const DEFAULT_RETENTION_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/** Returns true iff the memory is eligible for hard-delete in the next sweep tick. */
export function isHardDeleteEligible({
  deletedAt,
  releaseMarker,
  retentionWindowMs,
  now,
}: RetentionEligibilityInput): boolean {
  if (deletedAt === null) {
    return false;
  }
  if (releaseMarker === null) {
    // Defensive: the sweep itself MUST refuse to run without the marker (per
    // contracts/job-retention-sweep.md). This branch returns false to make
    // sure no eligibility check accidentally returns true under that
    // condition.
    return false;
  }
  const anchor = deletedAt.getTime() > releaseMarker.getTime()
    ? deletedAt.getTime()
    : releaseMarker.getTime();
  return anchor + retentionWindowMs <= now.getTime();
}
