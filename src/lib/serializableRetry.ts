import { Prisma } from '../generated/prisma/index.js';
import { AuthoritySnapshotStale } from './auth/authorityAnchors.js';

/**
 * How many times a SERIALIZABLE transaction is re-run after a P2034
 * serialization abort before the error propagates.
 */
export const SERIALIZATION_RETRIES = 5;

/** Upper bound, in ms, of the first retry's random delay; it doubles per attempt. */
const BASE_BACKOFF_MS = 10;

/** Shared full-jitter wait for a retry's one-based attempt, without selecting its errors or budget. */
export async function waitForSerializationRetry(attempt: number): Promise<void> {
  const ceiling = BASE_BACKOFF_MS * 2 ** (attempt - 1);
  await new Promise((resolve) => setTimeout(resolve, Math.random() * ceiling));
}

/** True when `e` is Postgres's serialization failure (40001) as Prisma reports it. */
export function isSerializationFailure(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2034';
}

/**
 * Runs `run`, which must open ONE SERIALIZABLE transaction, and re-runs it when
 * Postgres aborts it as a serialization failure.
 *
 * This is for count-then-act invariants whose competing writers are all
 * SERIALIZABLE (`conventions:count-then-act-serializable-txn`): the aborted
 * attempt re-reads the state the winner committed and decides again, so the
 * retry is what turns the abort into the right answer instead of an error.
 * `run` must have no effects outside the database, because it can run more
 * than once.
 *
 * Each retry waits a random delay ("full jitter": uniform in
 * `[0, BASE_BACKOFF_MS * 2^(attempt-1)]`). Without it, two transactions that
 * abort EACH OTHER retry in lockstep and can keep colliding until the retries
 * run out. That escaped as a raw P2034 under CI load: 4 of 40 parallel runs of
 * the #1544 race tests before this delay, including a removal racing
 * `deleteUser`.
 */
export async function retryOnSerializationFailure<T>(
  run: () => Promise<T>,
  retries: number = SERIALIZATION_RETRIES,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await run();
    } catch (e) {
      if ((!isSerializationFailure(e) && !(e instanceof AuthoritySnapshotStale)) || attempt > retries) throw e;
      await waitForSerializationRetry(attempt);
    }
  }
}
