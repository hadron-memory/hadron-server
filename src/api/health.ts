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
 * What the first startup attempt has come to (#2998, cor:api:270:01):
 * `starting` until it settles, then `settled` or `startup_failed`, for good.
 */
export type StartupState = 'starting' | 'startup_failed' | 'settled';

/** The two readiness inputs `/ready` reads; `/health` reads neither. */
export interface ReadinessSource {
  startup(): StartupState;
  stopping(): boolean;
}

/** A {@link ReadinessSource} plus the two writes the process entry point makes. */
export interface Readiness extends ReadinessSource {
  /**
   * Record the FIRST startup attempt. Only the first call counts: a later
   * attempt (a reload) neither makes the server not ready again nor rescues a
   * failed first one. `onError` receives the rejection for the log; it never
   * reaches the response.
   */
  trackFirstStartup(attempt: Promise<unknown>, onError?: (err: unknown) => void): void;
  /** Graceful shutdown has begun: `/ready` answers `stopping` from now on. */
  markStopping(): void;
}

/**
 * #2998: the readiness state for one server process. The entry point
 * (`src/index.ts`) creates it, hands it to `createServer`, tracks the first
 * `controller.startup()` and marks the shutdown signal. A closure rather than
 * module state, so each server (and each test) owns its own.
 */
export function createReadiness(): Readiness {
  let state: StartupState = 'starting';
  let tracked = false;
  let stopping = false;
  return {
    startup: () => state,
    stopping: () => stopping,
    trackFirstStartup(attempt, onError) {
      if (tracked) {
        // Not the first attempt: its outcome is the caller's to handle.
        attempt.catch((err) => onError?.(err));
        return;
      }
      tracked = true;
      attempt.then(
        () => {
          state = 'settled';
        },
        (err) => {
          state = 'startup_failed';
          onError?.(err);
        },
      );
    },
    markStopping() {
      stopping = true;
    },
  };
}

/**
 * Mount GET /health and GET /ready.
 *
 * `/health` (#1906): 200 `{ ok: true }` when `SELECT 1` completes through
 * `db` within `timeoutMs`, otherwise 503 `{ ok: false, error: 'database_unavailable' }`.
 * It never reads `readiness`.
 *
 * `/ready` (#2998, hrn:node:hadronmemory.com:specs:cor:api:270:01): exactly
 * one of five fixed bodies, checked in this order: 503 `stopping` once
 * shutdown has begun; 503 `starting` while the first startup attempt is
 * pending; 503 `startup_failed` if it rejected; then the same database check
 * as `/health` (the same in-flight query, the same bound): 503
 * `database_unavailable` or 200 `{ ok: true }`, unless shutdown began while
 * that probe was in flight, which still answers `stopping`. Unauthenticated, no side
 * effects, `Cache-Control: no-store`. Without `readiness` (tests that mount
 * only `/health`), `/ready` reads a source that never saw a startup: `starting`.
 */
export function mountHealthRoutes(
  app: Express,
  db: HealthDb,
  {
    timeoutMs = HEALTH_DB_TIMEOUT_MS,
    readiness = createReadiness(),
    checkConfiguration,
  }: { timeoutMs?: number; readiness?: ReadinessSource; checkConfiguration?: () => Promise<void> } = {},
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

  /**
   * True when the shared probe completes within `timeoutMs`. Both routes call
   * this, so `/ready` can never answer the database differently from `/health`.
   */
  const databaseAnswers = async (route: string): Promise<boolean> => {
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${route} check timed out`)), timeoutMs);
    });
    try {
      await Promise.race([probe(), timedOut]);
      return true;
    } catch (err) {
      console.warn(`[${route}] database check failed:`, err instanceof Error ? err.message : err);
      return false;
    } finally {
      clearTimeout(timer);
    }
  };

  app.get('/health', async (_req, res) => {
    res.set('Cache-Control', 'no-store');
    if (await databaseAnswers('health')) {
      res.json({ ok: true });
    } else {
      res.status(503).json({ ok: false, error: 'database_unavailable' });
    }
  });

  app.get('/ready', async (_req, res) => {
    res.set('Cache-Control', 'no-store');
    if (readiness.stopping()) {
      res.status(503).json({ ok: false, error: 'stopping' });
      return;
    }
    const startup = readiness.startup();
    if (startup !== 'settled') {
      res.status(503).json({ ok: false, error: startup === 'starting' ? 'starting' : 'startup_failed' });
      return;
    }
    const databaseOk = await databaseAnswers('ready');
    // Shutdown may have begun while the probe was in flight: stopping still
    // wins, whatever the database answered.
    if (readiness.stopping()) {
      res.status(503).json({ ok: false, error: 'stopping' });
    } else if (databaseOk) {
      res.json({ ok: true });
    } else {
      res.status(503).json({ ok: false, error: 'database_unavailable' });
    }
  });
}
