import { isSerializationConflict } from './includeHistoryFence.js';

/** Upper bound, in ms, of the first retry's random delay; it doubles per attempt (full jitter). */
const BASE_BACKOFF_MS = 10;

export interface AccountFenceRetryOptions {
  /** Total attempts for serialization/deadlock conflicts, the first included. */
  conflictAttempts: number;
  /** Errors the operation itself retries (a stale authority snapshot, a merge race), counted apart from conflicts. */
  semantic?: (e: unknown) => boolean;
  /** Re-runs allowed for `semantic` errors. */
  semanticRetries?: number;
  /** Wall-clock budget for all attempts, backoff included. Default 3 minutes. */
  deadlineMs?: number;
}

/**
 * #2046 S9-3: re-run a WHOLE account-operation attempt (new transaction, new snapshot, recomputed inputs, fence and
 * epoch proof again) after a conflict. Never retries inside an aborted transaction. `run` must have no effects outside
 * the database. Conflicts are P2034 and P2010/40001|40P01; semantic retries keep their own counter so the epoch's
 * conflicts cannot silently shrink or grow an operation's pre-existing semantic-race budget.
 */
export async function retryAccountFence<T>(run: () => Promise<T>, options: AccountFenceRetryOptions): Promise<T> {
  const deadline = performance.now() + (options.deadlineMs ?? 180_000);
  let conflicts = 0;
  let semantics = 0;
  for (;;) {
    try {
      return await run();
    } catch (e) {
      if (isSerializationConflict(e)) {
        conflicts++;
        if (conflicts >= options.conflictAttempts) throw e;
      } else if (options.semantic?.(e)) {
        semantics++;
        if (semantics > (options.semanticRetries ?? 0)) throw e;
      } else {
        throw e;
      }
      const ceiling = BASE_BACKOFF_MS * 2 ** (conflicts + semantics - 1);
      const delay = Math.random() * ceiling;
      if (performance.now() + delay >= deadline) throw e;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}
