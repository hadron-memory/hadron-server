import type { PrismaClient } from '../generated/prisma/index.js';
import { DECISION_FAMILY_WHERE } from '../lib/decisions/index.js';
import { withSweepLock, type SweepLockResult } from '../lib/sweepLock.js';

/**
 * Deletes expired anonymous memories. A memory is "anonymous" when it was
 * created for a session that never resolved to a real user, and has an
 * `anonymousExpiresAt` timestamp in the past.
 *
 * Returns the number of rows deleted.
 */
export async function cleanupAnonymousMemories(db: PrismaClient): Promise<number> {
  const result = await db.memory.deleteMany({
    where: {
      anonymousExpiresAt: { lt: new Date() },
      userMemoryOfAgentId: { not: null },
      // #1468 — a mint-stamped corpus is never swept away by expiry. Anonymous
      // memories are not created as draft corpora, so none should ever be
      // stamped; the exclusion keeps this bulk delete safe if one is.
      corpusMintedAt: null,
      // #1641 §3.2 — nor one holding a decision or a decision log (Q17).
      nodes: { none: DECISION_FAMILY_WHERE },
    },
  });
  return result.count;
}

/**
 * One loop tick under the sweep lock (#445): a second server process running the
 * same tick skips instead of issuing a duplicate delete. The delete is
 * self-idempotent, so a lost lock only costs a redundant statement.
 */
export function runAnonymousCleanupTick(db: PrismaClient): Promise<SweepLockResult<number>> {
  return withSweepLock('anonymous-memory-cleanup', () => cleanupAnonymousMemories(db));
}

/**
 * Starts a recurring cleanup loop. Returns a handle that can be cleared to
 * stop the loop (e.g. during tests or graceful shutdown).
 *
 * Defaults: runs once per hour, with an initial delay of 60s so it doesn't
 * pile onto startup.
 */
export function startAnonymousMemoryCleanupLoop(
  db: PrismaClient,
  options: { intervalMs?: number; initialDelayMs?: number } = {},
): NodeJS.Timeout {
  const intervalMs = options.intervalMs ?? 60 * 60 * 1000; // 1 hour
  const initialDelayMs = options.initialDelayMs ?? 60 * 1000; // 60s

  const run = async () => {
    try {
      const result = await runAnonymousCleanupTick(db);
      if (result.ran && result.value > 0) {
        console.log(`[cleanup] deleted ${result.value} expired anonymous memories`);
      }
    } catch (err) {
      console.error('[cleanup] anonymous memory cleanup failed:', err);
    }
  };

  // Schedule first run after the initial delay, then interval after.
  let timer: NodeJS.Timeout;
  const initial = setTimeout(() => {
    run();
    timer = setInterval(run, intervalMs);
  }, initialDelayMs);

  // Return the initial timer so callers can clearTimeout() it; the interval
  // timer replaces it in the closure and leaks intentionally for the server
  // lifetime. Tests that need to stop the loop should use
  // cleanupAnonymousMemories() directly rather than the loop.
  return initial;
}
