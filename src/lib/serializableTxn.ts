// Shared SERIALIZABLE-transaction runner with a bounded retry on serialization
// failures (issue #664).
//
// A count-then-act invariant (e.g. "refuse to delete a node that still has
// descendants") is only race-safe under SERIALIZABLE isolation: at the default
// READ COMMITTED a concurrent transaction can commit a new row between the
// count and the act, defeating the check. Under SERIALIZABLE, Postgres detects
// the read/write conflict and aborts one side with SQLSTATE 40001, which the
// loser must retry — that retry lives here so every call site gets the same
// bounded, well-behaved behavior instead of hand-rolling it.
//
// Prisma surfaces a Postgres serialization failure (40001) or deadlock (40P01)
// as a PrismaClientKnownRequestError with code P2034 ("Transaction failed due
// to a write conflict or a deadlock. Please retry your transaction.").
import { Prisma, type PrismaClient } from '../generated/prisma/index.js';

/** Prisma's code for a write conflict / deadlock (Postgres 40001 / 40P01). */
const SERIALIZATION_FAILURE_CODE = 'P2034';

/**
 * True when `e` is a transient serialization failure / deadlock that is safe to
 * retry (the transaction was rolled back cleanly, so re-running from the top is
 * correct).
 */
export function isSerializationFailure(e: unknown): boolean {
  if (
    e instanceof Prisma.PrismaClientKnownRequestError &&
    e.code === SERIALIZATION_FAILURE_CODE
  ) {
    return true;
  }
  // Belt-and-suspenders: some runtime/driver paths surface the raw SQLSTATE on
  // an unknown-request error rather than the mapped P2034.
  if (
    e instanceof Prisma.PrismaClientUnknownRequestError &&
    /\b40001\b|\b40P01\b/.test(e.message)
  ) {
    return true;
  }
  return false;
}

export interface RunSerializableOptions {
  /** Total attempts (initial try + retries). Default 5. */
  maxAttempts?: number;
  /** Prisma interactive-transaction timeout (ms). */
  timeout?: number;
  /** Prisma interactive-transaction maxWait (ms). */
  maxWait?: number;
}

/**
 * Run `fn` inside a SERIALIZABLE interactive transaction, retrying the WHOLE
 * transaction on a serialization failure / deadlock up to `maxAttempts` times.
 * The final failure (or any non-retryable error) propagates unchanged, so typed
 * errors thrown inside `fn` (e.g. a GraphQLError) surface to the caller as-is.
 *
 * `fn` MUST be side-effect-free outside the transaction: on a serialization
 * failure it is re-run from the top, so any external mutation (an enqueue, a
 * git write) would run more than once. Keep those after the transaction.
 */
export async function runSerializable<T>(
  db: PrismaClient,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
  opts: RunSerializableOptions = {},
): Promise<T> {
  const maxAttempts = Math.max(1, opts.maxAttempts ?? 5);
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await db.$transaction(fn, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        ...(opts.timeout != null ? { timeout: opts.timeout } : {}),
        ...(opts.maxWait != null ? { maxWait: opts.maxWait } : {}),
      });
    } catch (e) {
      lastErr = e;
      if (attempt < maxAttempts && isSerializationFailure(e)) {
        continue;
      }
      throw e;
    }
  }
  // Unreachable: the loop always returns or throws. Present for the type checker.
  throw lastErr;
}
