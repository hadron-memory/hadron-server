/**
 * #1906 — GET /health: a liveness check that fails the way the app fails.
 *
 * The 2026-10-14 outage (dev memory
 * `ops:alpha:incident-2026-10-14-pool-exhaustion-liveness-query`) was Prisma
 * pool exhaustion while Postgres itself stayed healthy, and the old `/health`
 * answered a constant 200 for 55 minutes, so nothing paged. The check now runs
 * a trivial `SELECT 1` through the app's OWN pool (the `db` every request
 * uses). A raw connection would have stayed green through that outage, just as
 * the constant did.
 *
 * This is `/health` itself, not a separate `/health/ready`, so every existing
 * probe (Komodo's container check, the e2e compose healthcheck, `stack.sh`)
 * means "can serve a request" without a config change. The consequence is
 * deliberate: a wedged pool or an unreachable database now fails the liveness
 * probe too.
 *
 * - **Timeout.** Prisma's acquire timeout (`pool_timeout`, 10s by default)
 *   is a pool-wide URL setting, so the check bounds its own wait instead:
 *   503 after {@link HEALTH_DB_TIMEOUT_MS}. A query still queued past that
 *   point is harmless; it settles when the pool frees or Prisma's own timeout
 *   fires.
 * - **Single flight.** Concurrent probes share one in-flight query, so a
 *   wedged pool gains at most one waiter from health checks however often
 *   they arrive.
 * - **No side effects.** Raw SQL, mounted outside /graphql and /mcp: no
 *   usage event and no session heartbeat (pinned by the test).
 * - **No detail on failure.** The body is a fixed `database_unavailable`;
 *   the route is unauthenticated, so error text (hosts, codes) stays in logs.
 */

import type { Express } from 'express';
import type { PrismaClient } from '../generated/prisma/index.js';

/** How long the check waits for the pool and the query before answering 503. */
export const HEALTH_DB_TIMEOUT_MS = 2_000;

/** The one capability the check needs; the app's extended client satisfies it. */
export type HealthDb = Pick<PrismaClient, '$queryRaw'>;

/**
 * Mount GET /health: 200 `{ ok: true }` when `SELECT 1` completes through
 * `db` within `timeoutMs`, otherwise 503 `{ ok: false, error: 'database_unavailable' }`.
 */
export function mountHealthRoutes(
  app: Express,
  db: HealthDb,
  { timeoutMs = HEALTH_DB_TIMEOUT_MS, checkConfiguration }: { timeoutMs?: number; checkConfiguration?: () => Promise<void> } = {},
): void {
  let inFlight: Promise<void> | null = null;

  /** One `SELECT 1` shared by every probe that arrives while it is pending. */
  const probe = (): Promise<void> => {
    if (!inFlight) {
      inFlight = Promise.resolve(db.$queryRaw`SELECT 1`)
        .then(async () => { await checkConfiguration?.(); })
        .finally(() => {
          inFlight = null;
        });
    }
    return inFlight;
  };

  app.get('/health', async (_req, res) => {
    res.set('Cache-Control', 'no-store');
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('health check timed out')), timeoutMs);
    });
    try {
      await Promise.race([probe(), timedOut]);
      res.json({ ok: true });
    } catch (err) {
      console.warn('[health] database check failed:', err instanceof Error ? err.message : err);
      res.status(503).json({ ok: false, error: 'database_unavailable' });
    } finally {
      clearTimeout(timer);
    }
  });
}
