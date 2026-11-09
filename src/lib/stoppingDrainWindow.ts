/**
 * #3021 part 2: how long the process keeps its listener open after
 * `readiness.markStopping()` and before `httpServer.close()`.
 *
 * `/ready` answers `503 stopping` from `markStopping()` on (#2998,
 * cor:api:270:01), but a proxy only sees that if it polls while connections
 * are still accepted. Closing the listener at once let a polling proxy miss
 * the signal and meet refused connections instead. The window gives it time
 * to observe the 503 and stop routing here first.
 *
 * Length: measured on Otto's rehearsal (hadron-cloud#15, Traefik Docker
 * provider, `/ready` health check every 2 s, about 20 req/s): 3 s still lost
 * 1 to 2 requests per swap, 5 s and 8 s lost none. Traefik needs about one
 * health interval plus the provider's event refresh to drop the old slot, so
 * the default is 6 s, with margin over the measured 5 s. `0` turns it off.
 *
 * Bound: the hard exit deadline in src/index.ts is the window plus 10 s, so a
 * long window never eats the drain, worker stop and disconnect. The process
 * can therefore live up to window + 10 s after the signal: whatever stops the
 * container (Docker's stop timeout, Komodo) must allow that or it is killed
 * mid-drain. The 30 s ceiling keeps that bounded.
 *
 * `STOPPING_DRAIN_WINDOW_MS` accepts only a plain non-negative integer up to
 * the ceiling. Anything else (unset, empty, signed, fractional, exponent,
 * hex, above 30000) falls back to the default, so a typo can neither widen
 * the window past the deadline nor silently switch it off.
 */
export const STOPPING_DRAIN_WINDOW_DEFAULT_MS = 6_000;
export const STOPPING_DRAIN_WINDOW_MAX_MS = 30_000;

export function stoppingDrainWindowMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.STOPPING_DRAIN_WINDOW_MS;
  if (raw !== undefined && /^(0|[1-9][0-9]{0,4})$/.test(raw)) {
    const ms = Number(raw);
    if (ms <= STOPPING_DRAIN_WINDOW_MAX_MS) return ms;
  }
  return STOPPING_DRAIN_WINDOW_DEFAULT_MS;
}
