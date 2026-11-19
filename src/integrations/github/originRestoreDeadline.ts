/**
 * #2569: local `git remote set-url` only; fixed 10s, no env knob or network deadline.
 * SIGKILL may leave config.lock and prevent every later restore, retaining the
 * tokenized origin indefinitely. Never unlink it based on age: a lost PostgreSQL
 * lock connection does not abort a running writer, so ownership is unproven.
 * Fresh and stale locks stay untouched; ownership/fencing and recovery are #3227.
 */
export const RESTORE_DEADLINE_MS = 10_000;
