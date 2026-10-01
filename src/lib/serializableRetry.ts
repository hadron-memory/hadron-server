import { Prisma } from '../generated/prisma/index.js';

/**
 * How many times a SERIALIZABLE transaction is re-run after a P2034
 * serialization abort before the error propagates.
 */
export const SERIALIZATION_RETRIES = 3;

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
 */
export async function retryOnSerializationFailure<T>(
  run: () => Promise<T>,
  retries: number = SERIALIZATION_RETRIES,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await run();
    } catch (e) {
      if (!isSerializationFailure(e) || attempt > retries) throw e;
    }
  }
}
