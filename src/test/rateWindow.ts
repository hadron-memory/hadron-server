import type { PrismaClient } from '../generated/prisma/index.js';

/** #3074. Default safety margin: a sequence of admissions that starts with at least this long left in the window fits in it. */
export const RATE_WINDOW_MARGIN_MS = 5_000;
/** Past the boundary, so the next window has certainly begun on the database clock. */
const PAST_BOUNDARY_MS = 30;

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
