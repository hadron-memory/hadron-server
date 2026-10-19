// Tick arithmetic — #1748, cor:agt:080:06. Ticks are COMPUTED, never stored:
// tick k of a ticker falls at anchorAt + k·cadence for k >= 1 (the anchor itself
// is not a tick), is skipped inside the ticker's quiet hours, and a disabled or
// deleted ticker has none. The CURRENT tick at t is the latest firing tick at or
// before t, so a router that asks late sees one tick, never a backlog.
//
// EDGE (Diego's P3, pinned here rather than changed): quiet hours decide which
// ticks FIRE, not whether a tick already fired and unacknowledged is still owed.
// So unread that arrives DURING quiet hours can make the last tick before them
// due, at the next time a router asks. cor:agt:080:06 defines it this way; a
// 'quiet now' guard would be a spec change, not a bug fix.

import { inQuietHours, type QuietHours } from './quietHours.js';

export type TickerSchedule = {
  anchorAt: Date;
  cadenceSeconds: number;
  quietHours: unknown;
  enabled: boolean;
  deletedAt?: Date | null;
};

/** Most quiet-hour skips examined before giving up: a week of the fastest cadence. */
const MAX_SKIPS = (7 * 86_400) / 60 + 1;

export function tickTime(t: Pick<TickerSchedule, 'anchorAt' | 'cadenceSeconds'>, k: number): Date {
  return new Date(t.anchorAt.getTime() + k * t.cadenceSeconds * 1000);
}

/** The current tick index at `now`, or null when none has fired (or the ticker cannot tick). */
export function currentTick(t: TickerSchedule, now: Date): number | null {
  if (!t.enabled || t.deletedAt) return null;
  const stepMs = t.cadenceSeconds * 1000;
  let k = Math.floor((now.getTime() - t.anchorAt.getTime()) / stepMs);
  const quiet = (t.quietHours ?? null) as QuietHours | null;
  for (let skipped = 0; k >= 1 && skipped <= MAX_SKIPS; k--, skipped++) {
    if (!inQuietHours(quiet, tickTime(t, k))) return k;
  }
  return null;
}

/**
 * R63 (#2017): the time of the OLDEST tick the subscriber has not acknowledged, up to and including tick `k`: the first
 * non-quiet tick after `lastAcked`. A tick that has waited since then keeps its older anchor, so a steady cadence cannot
 * push a delivery out. Falls back to tick `k` itself when none is found within the skip bound.
 */
export function oldestUnackedTickAt(t: TickerSchedule, lastAcked: number, k: number): Date {
  const quiet = (t.quietHours ?? null) as QuietHours | null;
  for (let j = Math.max(lastAcked + 1, 1), n = 0; j <= k && n <= MAX_SKIPS; j++, n++) {
    if (!inQuietHours(quiet, tickTime(t, j))) return tickTime(t, j);
  }
  return tickTime(t, k);
}

/** When the next firing tick after `now` falls, or null. Used by readers; not by the due rule. */
export function nextTickAfter(t: TickerSchedule, now: Date): Date | null {
  if (!t.enabled || t.deletedAt) return null;
  const stepMs = t.cadenceSeconds * 1000;
  let k = Math.max(1, Math.floor((now.getTime() - t.anchorAt.getTime()) / stepMs) + 1);
  const quiet = (t.quietHours ?? null) as QuietHours | null;
  for (let i = 0; i <= MAX_SKIPS; i++, k++) {
    const at = tickTime(t, k);
    if (at.getTime() > now.getTime() && !inQuietHours(quiet, at)) return at;
  }
  return null;
}
