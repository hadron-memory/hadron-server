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
 * Bound: the hard exit deadline (`SHUTDOWN_DEADLINE_MS`, src/index.ts) starts
 * at the signal and is NOT extended, so the window is spent out of it. The
 * 5 s ceiling leaves at least 5 s for the HTTP drain, the embedding worker
 * and the database disconnect. The 3 s default covers one poll of a proxy
 * checking every 2 s. `0` turns the window off.
 *
 * `STOPPING_DRAIN_WINDOW_MS` accepts only a plain non-negative integer up to
 * the ceiling. Anything else (unset, empty, signed, fractional, exponent,
 * hex, above 5000) falls back to the default, so a typo can neither widen
 * the window past the deadline nor silently switch it off.
 */
export const STOPPING_DRAIN_WINDOW_DEFAULT_MS = 3_000;
export const STOPPING_DRAIN_WINDOW_MAX_MS = 5_000;

export function stoppingDrainWindowMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.STOPPING_DRAIN_WINDOW_MS;
  if (raw !== undefined && /^(0|[1-9][0-9]{0,3})$/.test(raw)) {
    const ms = Number(raw);
    if (ms <= STOPPING_DRAIN_WINDOW_MAX_MS) return ms;
  }
  return STOPPING_DRAIN_WINDOW_DEFAULT_MS;
}
