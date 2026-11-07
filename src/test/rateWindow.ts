import type { PrismaClient } from '../generated/prisma/index.js';

/** #3074. Default safety margin: a sequence of admissions that starts with at least this long left in the window fits in it. */
export const RATE_WINDOW_MARGIN_MS = 5_000;
/** Past the boundary, so the next window has certainly begun on the database clock. */
const PAST_BOUNDARY_MS = 30;
/**
 * #3480. The longest `withinOneRateWindow` can sleep at the default margin, for ANY window
 * length: `rateWindowWaitMs` sleeps only when less than the margin remains, and then for that
 * remainder plus `PAST_BOUNDARY_MS`. Pinned across the 1 min, 15 min and 1 h windows in
 * rateWindow3074.test.ts.
 */
export const RATE_WINDOW_MAX_SLEEP_MS = RATE_WINDOW_MARGIN_MS + PAST_BOUNDARY_MS;
/** Vitest's default per-test budget, which the body keeps after the sleep. */
const VITEST_DEFAULT_TIMEOUT_MS = 5_000;
/**
 * #3480. The Vitest budget for every test that calls `withinOneRateWindow` at the default
 * margin. A test that keeps Vitest's default 5000 ms budget can spend all of it asleep, so
 * the budget is the worst-case sleep plus that same default for the body.
 */
export const RATE_WINDOW_TEST_TIMEOUT_MS = RATE_WINDOW_MAX_SLEEP_MS + VITEST_DEFAULT_TIMEOUT_MS;
/**
 * #3480. Hook budget for `untilRateWindowRemaining` on a 1 min window: it can wait almost a
 * whole window (60 s) plus a clock read, so 2 windows leaves ample scheduling slack.
 */
export const FORCED_PHASE_HOOK_TIMEOUT_MS = 2 * 60_000 + 10_000;
/** #3480 forced-phase pins: time left in the window when the pinned site starts (inside the helper's sleep zone). */
export const FORCED_REMAINING_MS = RATE_WINDOW_MARGIN_MS - 10;

/**
 * Pure rule: how long to sleep so that `marginMs` remains in the fixed window
 * the database clock is in. 0 when enough of the window is left.
 */
export function rateWindowWaitMs(nowMs: number, windowSeconds: number, marginMs = RATE_WINDOW_MARGIN_MS): number {
  const windowMs = windowSeconds * 1000;
  const remaining = windowMs - (nowMs % windowMs);
  return remaining < marginMs ? remaining + PAST_BOUNDARY_MS : 0;
}

/**
 * Waits (on the DATABASE clock, the one `admitRateInTx` reads after the subject locks)
 * until the current fixed window of `fieldClass` has at least `marginMs` left, so a
 * multi-admission test sequence lands in ONE window. The window length is read from the
 * class's policy row (windows differ per class: 15 min, 1 h, 1 min), never hard-coded.
 *
 * Limit: the margin is not a guarantee. A scheduling stall longer than the margin
 * between this call and the last admission can still cross the boundary.
 */
export async function withinOneRateWindow(db: PrismaClient, fieldClass: string, marginMs = RATE_WINDOW_MARGIN_MS): Promise<void> {
  const { windowSeconds } = await db.rateLimitPolicy.findUniqueOrThrow({ where: { fieldClass }, select: { windowSeconds: true } });
  const [{ now }] = await db.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AT TIME ZONE 'UTC' AS now`;
  const wait = rateWindowWaitMs(now.getTime(), windowSeconds, marginMs);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
}

/** Sleeps on the database clock until it is `msBefore` before the next window boundary (test-only boundary forcing). */
export async function untilBeforeRateBoundary(db: PrismaClient, windowSeconds: number, msBefore: number): Promise<void> {
  const [{ now }] = await db.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AT TIME ZONE 'UTC' AS now`;
  const windowMs = windowSeconds * 1000;
  const remaining = windowMs - (now.getTime() % windowMs);
  if (remaining > msBefore) await new Promise(r => setTimeout(r, remaining - msBefore));
}

/** Time left in the current fixed window on the database clock. */
async function dbRemainingMs(db: PrismaClient, windowMs: number): Promise<number> {
  const [{ now }] = await db.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AT TIME ZONE 'UTC' AS now`;
  return windowMs - (now.getTime() % windowMs);
}

/**
 * #3480. Sleeps on the database clock until EXACTLY `msBefore` (within scheduling slack)
 * remains in the current window, then re-reads the clock and returns what actually remains.
 * Unlike `untilBeforeRateBoundary` (which returns at once when less than `msBefore` is left,
 * so its caller may already be past the point it asked for), this one waits into the next
 * window first, so the caller always lands at the requested phase.
 */
export async function untilRateWindowRemaining(db: PrismaClient, windowSeconds: number, msBefore: number): Promise<number> {
  const windowMs = windowSeconds * 1000;
  if (!(msBefore > 0 && msBefore < windowMs)) throw new Error(`msBefore ${msBefore} must lie inside a ${windowMs} ms window`);
  const remaining = await dbRemainingMs(db, windowMs);
  const wait = remaining > msBefore ? remaining - msBefore : remaining + windowMs - msBefore;
  await new Promise(r => setTimeout(r, wait));
  return dbRemainingMs(db, windowMs);
}

/**
 * #3480 forced-phase pins: force the phase, then assert the helper's sleep zone was really
 * reached, so a skewed clock or a wrong window fails loudly instead of pinning nothing.
 */
export async function forceRateWindowSleepZone(db: PrismaClient, windowSeconds: number): Promise<void> {
  const remaining = await untilRateWindowRemaining(db, windowSeconds, FORCED_REMAINING_MS);
  if (!(remaining > 0 && remaining < RATE_WINDOW_MARGIN_MS)) {
    throw new Error(`forced phase missed: ${remaining} ms left, need (0, ${RATE_WINDOW_MARGIN_MS})`);
  }
}
