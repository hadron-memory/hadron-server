import { Prisma } from '../generated/prisma/index.js';
import { AuthoritySnapshotStale } from './auth/authorityAnchors.js';

/**
 * How many times a SERIALIZABLE transaction is re-run after a serialization
 * abort (see `isSerializationFailure`) before the error propagates.
 */
export const SERIALIZATION_RETRIES = 5;

/** Upper bound, in ms, of the first retry's random delay; it doubles per attempt. */
const BASE_BACKOFF_MS = 10;

/** Shared full-jitter wait for a retry's one-based attempt, without selecting its errors or budget. */
export async function waitForSerializationRetry(attempt: number): Promise<void> {
  const ceiling = BASE_BACKOFF_MS * 2 ** (attempt - 1);
  await new Promise((resolve) => setTimeout(resolve, Math.random() * ceiling));
}

/**
 * True when `e` is Postgres's serialization failure (SQLSTATE 40001) as Prisma
 * reports it: P2034 from a model operation or the transaction, or P2010 with
 * `meta.code === '40001'` from a raw statement (`$queryRaw` / `$executeRaw`).
 *
 * The raw form matters because the authority gates' locking reads are raw
 * (`withAuthorizedTx`'s anchor rows, `afterLock` hooks): a caller revoked while
 * queued on the anchor gets 40001 there, and must be retried into the
 * in-transaction refusal rather than escape as an internal error (#2876). A
 * P2010 wrapping any other database code is a real failure and is not retried.
 */
export function isSerializationFailure(e: unknown): boolean {
  if (!(e instanceof Prisma.PrismaClientKnownRequestError)) return false;
  if (e.code === 'P2034') return true;
  return e.code === 'P2010' && (e.meta as { code?: unknown } | undefined)?.code === '40001';
}

/**
 * Runs `run`, which must open ONE transaction at SERIALIZABLE or REPEATABLE READ
 * (the latter for locking-read snapshots such as the signing reads, #2973/#4065),
 * and re-runs it when Postgres aborts it as a serialization failure.
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

/**
 * #4318: true when `e` is Postgres's deadlock abort, by its STRUCTURED SQLSTATE 40P01 only: Prisma's P2010 from a raw
 * statement with `meta.code === '40P01'` (the form a locking `$queryRaw` raises, as the crossed-fence deadlock does).
 * Prisma's P2034 is NOT matched: its fixed message names "a write conflict or a deadlock" without a code, so matching it
 * would retry write conflicts too (#4354 BLIND F1, §10 note F1). Deliberately SEPARATE from {@link isSerializationFailure}:
 * widening that predicate would change the behaviour of every existing caller.
 */
export function isDeadlock(e: unknown): boolean {
  if (!(e instanceof Prisma.PrismaClientKnownRequestError)) return false;
  return e.code === 'P2010' && (e.meta as { code?: unknown } | undefined)?.code === '40P01';
}

/** #4318: how many times a deadlocked transaction is re-run (four attempts in all) before the 40P01 surfaces as today. */
export const DEADLOCK_RETRIES = 3;

/**
 * Runs `run`, which must open ONE transaction and have no effect outside the database, and re-runs it when Postgres aborts
 * it as a deadlock. A 40P01 aborts the WHOLE transaction, so the retry must wrap the transaction itself (never a step
 * inside it): each attempt is fresh, takes its locks again and re-reads under them, and nothing from the aborted attempt
 * survives. The same full-jitter wait as {@link retryOnSerializationFailure}, so two transactions that deadlocked each
 * other do not retry in lockstep. After {@link DEADLOCK_RETRIES} retries the error is rethrown unchanged.
 */
export async function retryOnDeadlock<T>(run: () => Promise<T>, retries: number = DEADLOCK_RETRIES): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await run();
    } catch (e) {
      if (!isDeadlock(e) || attempt > retries) throw e;
      await waitForSerializationRetry(attempt);
    }
  }
}
