/**
 * A deterministic barrier for race tests: resolve once `n` other backends in
 * THIS database are blocked on a lock (row or advisory). It proves the
 * competing transaction is actually waiting, rather than assuming it from a
 * sleep. Each vitest worker has its own database clone, so the count is this
 * test's alone.
 */
import type { PrismaClient } from '../generated/prisma/index.js';

export async function waitForLockWaiters(db: PrismaClient, n = 1, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const [{ waiting }] = await db.$queryRaw<Array<{ waiting: number }>>`
      SELECT count(*)::int AS waiting FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()`;
    if (waiting >= n) return;
    if (Date.now() > deadline) throw new Error(`waitForLockWaiters: no backend blocked on a lock within ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 20));
  }
}
