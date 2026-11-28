import { Prisma } from '../../generated/prisma/index.js';

/**
 * #4926: the one spelling of when a recorded git-mirror obligation is next due. A PENDING capture is due
 * the moment it exists (its `last_attempt_at`, no wait); a FAILED or NOT_CLONED row waits
 * 5 minutes x 2^(attempts-1), the exponent held at 7 and the multiple capped at 72 (the 6-hour ceiling, #430).
 * The sweep's SQL and the in-lock TypeScript re-read both come from here, so they cannot drift apart by hand.
 */
export const MIRROR_RETRY_BASE_MS = 5 * 60_000;
export const MIRROR_RETRY_EXPONENT_CAP = 7;
export const MIRROR_RETRY_MULTIPLE_CAP = 72;
export const MIRROR_RETRY_MAX_BACKOFF_MS = MIRROR_RETRY_BASE_MS * MIRROR_RETRY_MULTIPLE_CAP;

/** The wait, in milliseconds, after `attempts` recorded attempts of a settled (non-PENDING) row. */
export function mirrorRetryBackoffMs(attempts: number): number {
  return Math.min(MIRROR_RETRY_BASE_MS * 2 ** Math.min(attempts - 1, MIRROR_RETRY_EXPONENT_CAP), MIRROR_RETRY_MAX_BACKOFF_MS);
}

/** Whether a re-read obligation row is due at `nowMs`. A PENDING capture is due the moment it exists, whatever its timestamp. */
export function mirrorRetryDue(row: { state: string; lastAttemptAt: Date; attempts: number }, nowMs: number): boolean {
  return row.state === 'PENDING' || mirrorDueAtMs(row) <= nowMs;
}

/** TypeScript twin of {@link mirrorDueAtSql}: the epoch millisecond the row is due. */
export function mirrorDueAtMs(row: { state: string; lastAttemptAt: Date; attempts: number }): number {
  return row.state === 'PENDING' ? row.lastAttemptAt.getTime() : row.lastAttemptAt.getTime() + mirrorRetryBackoffMs(row.attempts);
}

/**
 * SQL fragment for the due time, over the given `state`, `last_attempt_at` and `attempts` expressions. Built from the
 * constants above, so editing one moves both spellings. (The exponent cap only bounds `power()`: the multiple cap binds
 * first, from attempts 8.)
 */
export function mirrorDueAtSql(cols: { state: Prisma.Sql; lastAttemptAt: Prisma.Sql; attempts: Prisma.Sql }): Prisma.Sql {
  const { state, lastAttemptAt, attempts } = cols;
  const base = Prisma.raw(String(MIRROR_RETRY_BASE_MS));
  const expCap = Prisma.raw(String(MIRROR_RETRY_EXPONENT_CAP));
  const multCap = Prisma.raw(String(MIRROR_RETRY_MULTIPLE_CAP));
  return Prisma.sql`(CASE WHEN ${state} = 'PENDING' THEN ${lastAttemptAt}
    ELSE ${lastAttemptAt} + interval '1 millisecond' * ${base} * LEAST(power(2, LEAST(${attempts} - 1, ${expCap})), ${multCap}) END)`;
}
