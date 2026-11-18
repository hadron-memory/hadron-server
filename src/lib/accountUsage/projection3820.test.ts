/**
 * #3820 — the token-burn projection's arithmetic and its thresholds, on the pure module. The rulings under test are
 * Vera's V11 to V15 (hrn:node:hadronmemory.com:hadron-dev-team-shared:decisions:2026-11-10-vera-rulings-utilization-capacity).
 */
import { describe, expect, it } from 'vitest';
import {
  addBurn, runOutHours, parseUsageSnapshot, projectAccount, projectWindow, withWorkerCount, TOKEN_CEILING_PCT,
  FIVE_HOUR_MINUTES, SEVEN_DAY_MINUTES, type UsageSnapshot, type WindowKind,
} from './projection.js';

const NOW = new Date('2026-11-10T12:00:00.000Z');
const MIN = 60_000;
const HOUR = 60 * MIN;
const at = (minutesAgo: number) => new Date(NOW.getTime() - minutesAgo * MIN);

/** A history of one window: `pctAt(minutesAgo)` sampled every `stepMin` from `fromMin` ago to `lastMin` ago. */
function series(opts: {
  window?: WindowKind; fromMin: number; lastMin: number; stepMin: number; pctAt: (minutesAgo: number) => number;
  resetsInHours: number; workers?: string[]; label?: string;
}): UsageSnapshot[] {
  const out: UsageSnapshot[] = [];
  const window = opts.window ?? SEVEN_DAY_MINUTES;
  for (let m = opts.fromMin; m >= opts.lastMin; m -= opts.stepMin) {
    out.push({
      label: opts.label ?? 'acct', family: 'claude', host: 'h', observedAt: at(m),
      windows: { [window]: { pct: opts.pctAt(m), resetsAt: new Date(NOW.getTime() + opts.resetsInHours * HOUR) } },
      workers: opts.workers ?? ['Anne', 'Rook'], workersConfigured: true,
    });
  }
  return out;
}

describe('V13 INSUFFICIENT_DATA and V12 UNKNOWN', () => {
  it('1% used at 1%/h with six days left is INSUFFICIENT_DATA with no run-out time and no range', () => {
    // 0% an hour ago, 1% now: 1%/h, six days (144h) to the reset, and plenty of snapshots.
    const h = series({ fromMin: 60, lastMin: 0, stepMin: 15, pctAt: (m) => 1 - m / 60, resetsInHours: 144 });
    const w = projectWindow(h, SEVEN_DAY_MINUTES, NOW).projection;
    expect(w).toMatchObject({ status: 'INSUFFICIENT_DATA', reason: 'LOW_USE', runsOutAt: null, lowPctAtReset: null, highPctAtReset: null });
  });

  it('fewer than three snapshots, or three spanning under an hour, is INSUFFICIENT_DATA', () => {
    const two = series({ fromMin: 90, lastMin: 0, stepMin: 88, pctAt: () => 40, resetsInHours: 100 });
    expect(two).toHaveLength(2);
    expect(projectWindow(two, SEVEN_DAY_MINUTES, NOW).projection).toMatchObject({ status: 'INSUFFICIENT_DATA', reason: 'TOO_FEW_SNAPSHOTS', runsOutAt: null });
    const short = series({ fromMin: 50, lastMin: 0, stepMin: 24, pctAt: () => 40, resetsInHours: 100 });
    expect(short.length).toBeGreaterThanOrEqual(3);
    expect(projectWindow(short, SEVEN_DAY_MINUTES, NOW).projection).toMatchObject({ status: 'INSUFFICIENT_DATA', reason: 'TOO_FEW_SNAPSHOTS' });
    const ok = series({ fromMin: 62, lastMin: 0, stepMin: 30, pctAt: (m) => 40 - m / 60, resetsInHours: 100 });
    expect(projectWindow(ok, SEVEN_DAY_MINUTES, NOW).projection.status).toBe('PROJECTED');
  });

  it('a newest snapshot 61 minutes old is UNKNOWN, 59 minutes old is answered', () => {
    const mk = (last: number) => series({ fromMin: last + 120, lastMin: last, stepMin: 30, pctAt: (m) => 40 - (m - last) / 60, resetsInHours: 100 });
    expect(projectWindow(mk(61), SEVEN_DAY_MINUTES, NOW).projection).toMatchObject({ status: 'UNKNOWN', reason: 'STALE', lowPctAtReset: null, runsOutAt: null });
    expect(projectWindow(mk(59), SEVEN_DAY_MINUTES, NOW).projection.status).toBe('PROJECTED');
  });

  it('no history is UNKNOWN, never a number; a history with no such window is UNKNOWN', () => {
    expect(projectWindow([], FIVE_HOUR_MINUTES, NOW).projection).toMatchObject({ status: 'UNKNOWN', reason: 'NO_HISTORY' });
    const only7 = series({ fromMin: 120, lastMin: 0, stepMin: 30, pctAt: () => 40, resetsInHours: 100 });
    expect(projectWindow(only7, FIVE_HOUR_MINUTES, NOW).projection).toMatchObject({ status: 'UNKNOWN', reason: 'NO_WINDOW' });
  });

  it('a window already reset since the newest snapshot is UNKNOWN', () => {
    const h = series({ fromMin: 120, lastMin: 0, stepMin: 30, pctAt: (m) => 40 - m / 60, resetsInHours: -0.5 });
    // resetsAt is before the newest snapshot's own time
    h.forEach((s) => { s.windows[SEVEN_DAY_MINUTES]!.resetsAt = new Date(s.observedAt.getTime() - MIN); });
    expect(projectWindow(h, SEVEN_DAY_MINUTES, NOW).projection).toMatchObject({ status: 'UNKNOWN', reason: 'RESET_PASSED' });
  });
});

describe('the newest observation decides (V28, V29)', () => {
  it('a newest snapshot with no reading for the window is UNKNOWN; an older reading is not revived', () => {
    const h = series({ fromMin: 360, lastMin: 5, stepMin: 30, pctAt: (m) => 40 - m / 60, resetsInHours: 40 });
    h.push({ label: 'acct', family: 'claude', host: 'h', observedAt: at(0), windows: {}, workers: [], workersConfigured: true });
    expect(projectWindow(h, SEVEN_DAY_MINUTES, NOW).projection).toMatchObject({ status: 'UNKNOWN', reason: 'NO_WINDOW' });
  });
  it('a record without host or family is malformed, not a null identity', () => {
    const rec = { schemaVersion: 1, label: 'a', observedAt: NOW.toISOString(), sevenDayPct: 10 };
    expect(parseUsageSnapshot({ ...rec, host: 'h', family: 'claude' }, NOW)).not.toBeNull();
    expect(parseUsageSnapshot(rec, NOW)).toBeNull();
    expect(parseUsageSnapshot({ ...rec, host: 'h' }, NOW)).toBeNull();
  });
});

describe('an out-of-range reset is untrusted input', () => {
  it('a reset further ahead than the window is long reads as no reset, and answers at once', () => {
    const rec = { schemaVersion: 1, label: 'a', host: 'h', family: 'claude', observedAt: NOW.toISOString(), fiveHourPct: 30, fiveHourResetsAt: new Date(NOW.getTime() + 6 * 3_600_000).toISOString(), sevenDayPct: 30, sevenDayResetsAt: '9999-01-01T00:00:00.000Z' };
    const snap = parseUsageSnapshot(rec, NOW)!;
    expect(snap.windows[FIVE_HOUR_MINUTES]!.resetsAt).toBeNull();
    expect(snap.windows[SEVEN_DAY_MINUTES]!.resetsAt).toBeNull();
    const t0 = Date.now();
    expect(projectWindow([snap], SEVEN_DAY_MINUTES, NOW).projection).toMatchObject({ status: 'UNKNOWN', reason: 'NO_RESET' });
    expect(Date.now() - t0).toBeLessThan(500);
    const ok = parseUsageSnapshot({ ...rec, fiveHourResetsAt: new Date(NOW.getTime() + 4 * 3_600_000).toISOString() }, NOW)!;
    expect(ok.windows[FIVE_HOUR_MINUTES]!.resetsAt).not.toBeNull();
  });
});

describe('a reset after the newest snapshot but before asOf', () => {
  it('is UNKNOWN RESET_PASSED, never an expired cycle projected', () => {
    const h = series({ fromMin: 150, lastMin: 30, stepMin: 30, pctAt: (m) => 40 - m / 60, resetsInHours: -10 / 60 });
    expect(projectWindow(h, SEVEN_DAY_MINUTES, NOW).projection).toMatchObject({ status: 'UNKNOWN', reason: 'RESET_PASSED' });
  });
});

describe('the range and V14 runsOutAt', () => {
  /** 1.5 %/h for a day, ending 70% two minutes ago, 24 hours to the reset. */
  const steady = () => series({ fromMin: 24 * 60, lastMin: 0, stepMin: 30, pctAt: (m) => 70 - (m / 60) * 1.5, resetsInHours: 24 });

  it('70% used, 1.5%/h, a day to the reset: the range reaches the cap and runsOutAt is set before the reset', () => {
    const w = projectWindow(steady(), SEVEN_DAY_MINUTES, NOW).projection;
    expect(w.status).toBe('PROJECTED');
    expect(w.burn).toEqual({ lowPctPerHour: 1.5, highPctPerHour: 1.5 });
    expect(w.lowPctAtReset).toBe(100);
    expect(w.highPctAtReset).toBe(100);
    expect(w.confidence).toBe('HIGH');
    expect(w.shape).toBe('FLAT');
    // 30 points left at 1.5/h from the newest snapshot = 20 hours
    expect(w.runsOutAt!.getTime()).toBe(w.observedAt!.getTime() + 20 * HOUR);
    expect(w.runsOutAt!.getTime()).toBeLessThan(w.resetsAt!.getTime());
    expect(w.ceilingPct).toBe(TOKEN_CEILING_PCT);
    expect(TOKEN_CEILING_PCT).toBe(85);
  });

  it('a spread of rates is a range; runsOutAt needs the LOW end to reach 100, not the high end', () => {
    // 24h slow (0.4%/h), the last hour fast (2.5%/h): the low end stays under 100, the high end passes it.
    const h = series({
      fromMin: 24 * 60, lastMin: 0, stepMin: 30, resetsInHours: 24,
      pctAt: (m) => (m > 62 ? 50 - ((m - 62) / 60) * 0.4 : 50 + ((62 - m) / 60) * 4),
    });
    const w = projectWindow(h, SEVEN_DAY_MINUTES, NOW).projection;
    expect(w.status).toBe('PROJECTED');
    expect(w.burn!.lowPctPerHour).toBeLessThan(w.burn!.highPctPerHour);
    expect(w.lowPctAtReset!).toBeLessThan(100);
    expect(w.highPctAtReset!).toBe(100);
    expect(w.runsOutAt).toBeNull();
  });

  it('a fall in the reported percentage inside one cycle is no negative burn', () => {
    const h = series({ fromMin: 180, lastMin: 0, stepMin: 30, pctAt: (m) => 40 + m / 60, resetsInHours: 100 });
    const w = projectWindow(h, SEVEN_DAY_MINUTES, NOW).projection;
    expect(w.burn).toEqual({ lowPctPerHour: 0, highPctPerHour: 0 });
    expect(w.lowPctAtReset).toBe(w.usedPct);
    expect(w.runsOutAt).toBeNull();
  });

  it('snapshots of an earlier cycle (another reset instant) do not feed the burn', () => {
    const old = series({ fromMin: 600, lastMin: 300, stepMin: 30, pctAt: () => 0, resetsInHours: -3 });
    const cur = series({ fromMin: 180, lastMin: 0, stepMin: 30, pctAt: (m) => 20 - m / 60, resetsInHours: 100 });
    const w = projectWindow([...old, ...cur], SEVEN_DAY_MINUTES, NOW).projection;
    // The current cycle burns 1%/h; reading across the reset (0% ten hours ago) would claim 2%/h over the 24h lookback.
    expect(w.burn).toEqual({ lowPctPerHour: 1, highPctPerHour: 1 });
  });
});

describe('the weekly shape', () => {
  /** Eight days of a day/night pattern: 2%/h from 08:00 to 20:00 UTC, 0 otherwise, resetting weekly. */
  function week(): UsageSnapshot[] {
    const out: UsageSnapshot[] = [];
    const start = NOW.getTime() - 8 * 24 * HOUR;
    let pct = 0;
    let reset = start + 3 * 24 * HOUR; // the earlier cycle ends 3 days in; the next runs 7 days to 5 days from now? keep: reset every 7 days
    for (let t = start; t <= NOW.getTime() - 2 * MIN; t += 15 * MIN) {
      if (t >= reset) { pct = 0; reset += 7 * 24 * HOUR; }
      const hour = new Date(t).getUTCHours();
      pct = Math.min(100, pct + (hour >= 8 && hour < 20 ? 0.5 : 0));
      out.push({ label: 'acct', family: 'claude', host: 'h', observedAt: new Date(t), windows: { [SEVEN_DAY_MINUTES]: { pct, resetsAt: new Date(reset) } }, workers: ['Anne'], workersConfigured: true });
    }
    return out;
  }
  it('a history spanning a week uses the weekly shape; a day of history uses a flat rate, and says which', () => {
    const w = projectWindow(week(), SEVEN_DAY_MINUTES, NOW).projection;
    expect(w.status).toBe('PROJECTED');
    expect(w.shape).toBe('WEEKLY');
    const dayOnly = week().filter((s) => s.observedAt.getTime() > NOW.getTime() - 20 * HOUR);
    expect(projectWindow(dayOnly, SEVEN_DAY_MINUTES, NOW).projection.shape).toBe('FLAT');
  });
  it('runOutHours is exact across idle then active hours (flat would say 10h)', () => {
    const profile = [{ hours: 10, frac: 0 }, { hours: 20, frac: 1 }];
    expect(runOutHours(50, 100, 20, profile)).toBe(15);
    expect(runOutHours(50, 100, 20, null)).toBe(10);
    expect(runOutHours(100, 100, 20, profile)).toBe(0);
  });
  it('runsOutAt integrates the hourly shape: it lands in an active hour, not an idle stretch the average would pick', () => {
    const basis = projectWindow(week(), SEVEN_DAY_MINUTES, NOW);
    const hot = withWorkerCount(basis, 12).projection;
    expect(hot.runsOutAt).not.toBeNull();
    const hr = hot.runsOutAt!.getUTCHours() + hot.runsOutAt!.getUTCMinutes() / 60;
    // Idle hours add nothing, so the run-out instant is inside 08:00-20:00 UTC (or exactly at its edge).
    expect(hr >= 8 && hr <= 20).toBe(true);
  });
});

describe('per-worker burn and the what-ifs', () => {
  const two = () => series({ fromMin: 24 * 60, lastMin: 0, stepMin: 30, pctAt: (m) => 30 - m / 60, resetsInHours: 40, workers: ['Anne', 'Rook'], label: 'src' });

  it('per-worker burn is the account burn over the workers configured on it', () => {
    const w = projectWindow(two(), SEVEN_DAY_MINUTES, NOW).projection;
    expect(w.burn).toEqual({ lowPctPerHour: 1, highPctPerHour: 1 });
    expect(w.perWorkerBurn).toEqual({ lowPctPerHour: 0.5, highPctPerHour: 0.5 });
  });

  it('addWorkers: 1 raises the projected burn by the per-worker estimate', () => {
    const base = projectWindow(two(), SEVEN_DAY_MINUTES, NOW);
    const added = withWorkerCount(base, 3).projection;
    expect(added.burn).toEqual({ lowPctPerHour: 1.5, highPctPerHour: 1.5 });
    expect(added.highPctAtReset! - base.projection.highPctAtReset!).toBeCloseTo(0.5 * 40, 2);
    expect(added.perWorkerBurn).toEqual({ lowPctPerHour: 0.5, highPctPerHour: 0.5 });
  });

  it('a move lowers the source account and raises the target by the source per-worker estimate', () => {
    const src = projectWindow(two(), SEVEN_DAY_MINUTES, NOW);
    const tgt = projectWindow(series({ fromMin: 24 * 60, lastMin: 0, stepMin: 30, pctAt: (m) => 30 - m / 60 * 2.0, resetsInHours: 20, workers: ['Kit'], label: 'tgt' }), SEVEN_DAY_MINUTES, NOW);
    const srcAfter = withWorkerCount(src, 1).projection;
    const tgtAfter = addBurn(tgt, src.projection.perWorkerBurn).projection;
    expect(srcAfter.highPctAtReset!).toBeLessThan(src.projection.highPctAtReset!);
    expect(srcAfter.burn).toEqual({ lowPctPerHour: 0.5, highPctPerHour: 0.5 });
    expect(tgtAfter.burn).toEqual({ lowPctPerHour: 2.5, highPctPerHour: 2.5 });
    expect(tgtAfter.highPctAtReset!).toBeGreaterThan(tgt.projection.highPctAtReset!);
  });

  it('a what-if on an account with no configured workers, or from an unknown source, is UNKNOWN, never a guess', () => {
    const none = projectWindow(series({ fromMin: 24 * 60, lastMin: 0, stepMin: 30, pctAt: (m) => 30 - m / 60, resetsInHours: 40, workers: [] }), SEVEN_DAY_MINUTES, NOW);
    expect(withWorkerCount(none, 1).projection).toMatchObject({ status: 'UNKNOWN', reason: 'NO_WORKERS_CONFIGURED' });
    const tgt = projectWindow(two(), SEVEN_DAY_MINUTES, NOW);
    expect(addBurn(tgt, null).projection).toMatchObject({ status: 'UNKNOWN', reason: 'WHATIF_SOURCE_UNKNOWN' });
  });

  it('projectAccount gives both windows, each its own status', () => {
    const r = projectAccount(two(), NOW);
    expect(r.map((b) => b.projection.window)).toEqual([FIVE_HOUR_MINUTES, SEVEN_DAY_MINUTES]);
    expect(r[1]!.projection.status).toBe('PROJECTED');
    expect(r[0]!.projection).toMatchObject({ status: 'UNKNOWN', reason: 'NO_WINDOW' });
  });

  it('a window of another length the newest snapshot reports is projected with its own length (V29)', () => {
    const h = series({ window: 90, fromMin: 240, lastMin: 0, stepMin: 30, pctAt: (m) => 30 - m / 60, resetsInHours: 1 });
    const r = projectAccount(h, NOW);
    expect(r.map((b) => b.projection.window)).toEqual([90, FIVE_HOUR_MINUTES, SEVEN_DAY_MINUTES]);
    expect(r[0]!.projection).toMatchObject({ status: 'PROJECTED', window: 90, usedPct: 30 });
  });
});

describe('parsing the collector record', () => {
  const rec = (over: Record<string, unknown> = {}) => ({
    schemaVersion: 1, label: 'acct', family: 'claude', host: 'h', observedAt: at(5).toISOString(),
    fiveHourPct: 12.5, fiveHourResetsAt: new Date(NOW.getTime() + 2 * HOUR).toISOString(),
    sevenDayPct: 40, sevenDayResetsAt: new Date(NOW.getTime() + 50 * HOUR).toISOString(), workers: ['Anne'], workersConfigured: true, ...over,
  });
  it('reads claude-shaped and codex-shaped records, and ignores what it cannot place', () => {
    expect(parseUsageSnapshot(rec(), NOW)).toMatchObject({ label: 'acct', workers: ['Anne'], windows: { 300: { pct: 12.5 }, 10080: { pct: 40 } } });
    const codex = parseUsageSnapshot(rec({ fiveHourPct: undefined, sevenDayPct: undefined, primaryPct: 7, primaryMinutes: 300, primaryResetsAt: rec().fiveHourResetsAt, secondaryPct: 33, secondaryMinutes: 10080, secondaryResetsAt: rec().sevenDayResetsAt }), NOW);
    expect(codex!.windows).toMatchObject({ 300: { pct: 7 }, 10080: { pct: 33 } });
    // a window of another length keeps its own length (V29); a nonsense length is dropped
    const odd = parseUsageSnapshot(rec({ fiveHourPct: undefined, sevenDayPct: undefined, primaryPct: 7, primaryMinutes: 90, primaryResetsAt: rec().fiveHourResetsAt, secondaryPct: 9, secondaryMinutes: -5 }), NOW);
    expect(odd!.windows).toMatchObject({ 90: { pct: 7 } });
    expect(Object.keys(odd!.windows)).toEqual(['90']);
  });
  it('drops malformed, out-of-range, future-dated and wrong-version records instead of throwing', () => {
    for (const bad of [null, 'x', [], rec({ schemaVersion: 2 }), rec({ label: '' }), rec({ observedAt: 'nope' }), rec({ observedAt: new Date(NOW.getTime() + 20 * MIN).toISOString() })]) {
      expect(parseUsageSnapshot(bad, NOW)).toBeNull();
    }
    expect(parseUsageSnapshot(rec({ fiveHourPct: 140, sevenDayPct: -1 }), NOW)!.windows).toEqual({});
  });
});
