/**
 * #3820 — the token-burn projection per account. PURE: no database, no clock of its own (`asOf` is passed in).
 *
 * A subscription account has two rolling windows (the 5-hour and the 7-day), each reporting a used percentage and
 * the instant it resets. The host collector (`hadron team usage collect`) writes one `account-usage` record per
 * account per observation; this module turns a history of them into "how much will be used when the window resets",
 * as a RANGE, and answers the what-ifs "add a worker" and "move a worker to another account" from the same function.
 *
 * Rulings it implements (Vera rulings 2026-11-10, hrn:node:hadronmemory.com:hadron-dev-team-shared:decisions:
 * 2026-11-10-vera-rulings-utilization-capacity; Holger may override, and V11 to V13 may become App settings):
 *  - V11 the token ceiling is 85% projected use at the reset, both windows (exposed here; `canAddWorker`, #3819, reads it);
 *  - V12 a newest snapshot older than 60 minutes is UNKNOWN, never an answer;
 *  - V13 INSUFFICIENT_DATA when the used share is under 5%, or fewer than 3 snapshots span at least one hour;
 *  - V14 `runsOutAt` only when the LOWER bound of the range reaches 100% before the reset;
 *  - V15 advisory only: nothing here authorizes, refuses or moves anything.
 */

export const ACCOUNT_USAGE_COLLECTION = 'account-usage';
/** V11. */
export const TOKEN_CEILING_PCT = 85;
/** V12. */
export const MAX_SNAPSHOT_AGE_MS = 60 * 60_000;
/** V13: a used share below this is INSUFFICIENT_DATA. */
export const MIN_USED_PCT = 5;
/** V13: fewer snapshots than this in the window, or spanning less than {@link MIN_SPAN_MS}, is INSUFFICIENT_DATA. */
export const MIN_SNAPSHOTS = 3;
export const MIN_SPAN_MS = 60 * 60_000;
/** The burn rate is measured over the last 1h, 6h and 24h; each lookback needs two snapshots at least this far apart. */
export const LOOKBACKS_HOURS = [1, 6, 24] as const;
const MIN_RATE_SPAN_MS = 15 * 60_000;
/** Two snapshots belong to one window cycle when their reset instants differ by less than this (the source jitters). */
const SAME_RESET_TOLERANCE_MS = 5 * 60_000;
/** The weekly shape needs the history to span a full week. */
const WEEKLY_MIN_HISTORY_MS = 7 * 24 * 3_600_000;
/** A snapshot dated further ahead than this is a clock fault or a forgery, and is left out. */
const MAX_FUTURE_SKEW_MS = 5 * 60_000;
const HOUR_MS = 3_600_000;

/** A window is named by its length in minutes (V29): a family's windows of another length are projected the same way. */
export type WindowKind = number;
export const FIVE_HOUR_MINUTES = 300;
export const SEVEN_DAY_MINUTES = 10080;
/** Always reported, UNKNOWN when no snapshot has a reading for them (V29). Other lengths appear when the newest snapshot reports them. */
export const STANDARD_WINDOWS: readonly WindowKind[] = [FIVE_HOUR_MINUTES, SEVEN_DAY_MINUTES];
const MAX_WINDOW_MINUTES = 100_000;
export type ProjectionStatus = 'PROJECTED' | 'INSUFFICIENT_DATA' | 'UNKNOWN';
export type ProjectionReason =
  | 'NO_HISTORY' | 'STALE' | 'NO_WINDOW' | 'NO_RESET' | 'RESET_PASSED'
  | 'LOW_USE' | 'TOO_FEW_SNAPSHOTS' | 'NO_WORKERS_CONFIGURED' | 'WHATIF_SOURCE_UNKNOWN';
export type Confidence = 'LOW' | 'MEDIUM' | 'HIGH';
export type Shape = 'FLAT' | 'WEEKLY';
/** The cumulative share of the remaining use reached by the end of each hour-of-week step: `hours` from the newest snapshot, `frac` 0..1. */
export type ShapeProfile = { hours: number; frac: number }[];

export interface WindowReading { pct: number; resetsAt: Date | null }
export interface UsageSnapshot {
  label: string;
  family: string | null;
  host: string | null;
  observedAt: Date;
  windows: Record<number, WindowReading>;
  workers: string[];
  workersConfigured: boolean;
}

export interface BurnRange { lowPctPerHour: number; highPctPerHour: number }
export interface WindowProjection {
  /** The window's length in minutes. */
  window: WindowKind;
  status: ProjectionStatus;
  reason: ProjectionReason | null;
  usedPct: number | null;
  resetsAt: Date | null;
  observedAt: Date | null;
  lowPctAtReset: number | null;
  highPctAtReset: number | null;
  burn: BurnRange | null;
  perWorkerBurn: BurnRange | null;
  confidence: Confidence | null;
  shape: Shape | null;
  runsOutAt: Date | null;
  ceilingPct: number;
}

/** What a window projection needs to be recomputed under a changed burn rate (the what-if), kept beside it. */
export interface WindowBasis {
  projection: WindowProjection;
  /** Present only when `projection.status` is PROJECTED. */
  calc: { used: number; observedAt: Date; hoursToReset: number; shapeScale: number; rateLow: number; rateHigh: number; workers: number; profile: ShapeProfile | null } | null;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const pctOf = (v: unknown): number | null => { const n = num(v); return n !== null && n >= 0 && n <= 100 ? n : null; };
const dateOf = (v: unknown): Date | null => {
  if (typeof v !== 'string') return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

/**
 * One stored `account-usage` object's properties (the collector's record, schemaVersion 1) as a snapshot, or null when it
 * is not usable. A claude/glm record carries `fiveHourPct`/`sevenDayPct`; a codex record carries `primaryPct` with
 * `primaryMinutes` (and secondary), mapped by the window's length: 300 minutes is the 5-hour window, 10080 the 7-day one.
 * Anything else is ignored rather than guessed. Never throws: a malformed record is one snapshot fewer.
 */
export function parseUsageSnapshot(properties: unknown, now: Date): UsageSnapshot | null {
  if (properties === null || typeof properties !== 'object' || Array.isArray(properties)) return null;
  const p = properties as Record<string, unknown>;
  if (p.schemaVersion !== 1) return null;
  if (typeof p.label !== 'string' || p.label === '') return null;
  const observedAt = dateOf(p.observedAt);
  if (!observedAt || observedAt.getTime() > now.getTime() + MAX_FUTURE_SKEW_MS) return null;
  const windows: UsageSnapshot['windows'] = {};
  const put = (kind: WindowKind, pct: unknown, resetsAt: unknown): void => {
    const v = pctOf(pct);
    if (v !== null && windows[kind] === undefined) windows[kind] = { pct: v, resetsAt: dateOf(resetsAt) };
  };
  put(FIVE_HOUR_MINUTES, p.fiveHourPct, p.fiveHourResetsAt);
  put(SEVEN_DAY_MINUTES, p.sevenDayPct, p.sevenDayResetsAt);
  // A family whose windows have another length reports them as primary/secondary with their length in minutes (cor:agt:140:01).
  for (const [pct, minutes, resets] of [[p.primaryPct, p.primaryMinutes, p.primaryResetsAt], [p.secondaryPct, p.secondaryMinutes, p.secondaryResetsAt]] as const) {
    if (typeof minutes === 'number' && Number.isInteger(minutes) && minutes > 0 && minutes <= MAX_WINDOW_MINUTES) put(minutes, pct, resets);
  }
  const workers = Array.isArray(p.workers) ? p.workers.filter((w): w is string => typeof w === 'string' && w !== '') : [];
  return {
    label: p.label,
    family: typeof p.family === 'string' ? p.family : null,
    host: typeof p.host === 'string' ? p.host : null,
    observedAt,
    windows,
    workers,
    workersConfigured: p.workersConfigured === true,
  };
}

const empty = (window: WindowKind, status: ProjectionStatus, reason: ProjectionReason, partial: Partial<WindowProjection> = {}): WindowBasis => ({
  projection: {
    window, status, reason, usedPct: null, resetsAt: null, observedAt: null, lowPctAtReset: null, highPctAtReset: null,
    burn: null, perWorkerBurn: null, confidence: null, shape: null, runsOutAt: null, ceilingPct: TOKEN_CEILING_PCT, ...partial,
  },
  calc: null,
});

const round = (n: number): number => Math.round(n * 1000) / 1000;

/**
 * Hours after the newest snapshot at which the LOW end's cumulative use reaches 100%, integrating the hourly shape
 * (`profile`, null = flat). `addLow` is the low end's whole use to the reset. Exported for the exact-timestamp pin.
 */
export function runOutHours(used: number, addLow: number, hoursToReset: number, profile: ShapeProfile | null): number {
  if (used >= 100 || addLow <= 0) return 0;
  const target = (100 - used) / addLow;
  if (!profile) return target * hoursToReset;
  let prevH = 0; let prevF = 0;
  for (const seg of profile) {
    if (seg.frac >= target) return seg.frac > prevF ? prevH + ((target - prevF) / (seg.frac - prevF)) * (seg.hours - prevH) : prevH;
    prevH = seg.hours; prevF = seg.frac;
  }
  return hoursToReset;
}

/** The projected range at the reset for burn rates `[rateLow, rateHigh]` (percent per hour) under the basis's shape. */
function applyRates(
  window: WindowKind,
  base: NonNullable<WindowBasis['calc']>,
  rateLow: number,
  rateHigh: number,
  carry: Pick<WindowProjection, 'confidence' | 'shape'>,
  resetsAt: Date,
  workers: number = base.workers,
): WindowBasis {
  const addLow = rateLow * base.hoursToReset * base.shapeScale;
  const addHigh = rateHigh * base.hoursToReset * base.shapeScale;
  const lowRaw = base.used + addLow;
  const highRaw = base.used + addHigh;
  // V14: a run-out time only when even the LOW end reaches 100% before the reset.
  let runsOutAt: Date | null = null;
  if (lowRaw >= 100) {
    runsOutAt = new Date(base.observedAt.getTime() + runOutHours(base.used, addLow, base.hoursToReset, base.profile) * HOUR_MS);
  }
  const perWorker = workers > 0 ? { lowPctPerHour: round(rateLow / workers), highPctPerHour: round(rateHigh / workers) } : null;
  return {
    projection: {
      window, status: 'PROJECTED', reason: null, usedPct: base.used, resetsAt, observedAt: base.observedAt,
      lowPctAtReset: round(Math.min(100, lowRaw)), highPctAtReset: round(Math.min(100, highRaw)),
      burn: { lowPctPerHour: round(rateLow), highPctPerHour: round(rateHigh) }, perWorkerBurn: perWorker,
      confidence: carry.confidence, shape: carry.shape, runsOutAt, ceilingPct: TOKEN_CEILING_PCT,
    },
    calc: { ...base, rateLow, rateHigh, workers },
  };
}

/**
 * One window's baseline projection for one account. `history` is that account's snapshots (any order); `asOf` is the
 * read's instant. UNKNOWN comes first (no data, or too old to trust, V12), then INSUFFICIENT_DATA (V13).
 */
export function projectWindow(history: readonly UsageSnapshot[], window: WindowKind, asOf: Date): WindowBasis {
  const withWindow = history.filter((s) => s.windows[window] !== undefined).sort((a, b) => a.observedAt.getTime() - b.observedAt.getTime());
  const newest = withWindow[withWindow.length - 1];
  if (!newest) return empty(window, 'UNKNOWN', history.length === 0 ? 'NO_HISTORY' : 'NO_WINDOW');
  const reading = newest.windows[window]!;
  if (asOf.getTime() - newest.observedAt.getTime() > MAX_SNAPSHOT_AGE_MS) {
    return empty(window, 'UNKNOWN', 'STALE', { usedPct: reading.pct, resetsAt: reading.resetsAt, observedAt: newest.observedAt });
  }
  const resetsAt = reading.resetsAt;
  if (!resetsAt) return empty(window, 'UNKNOWN', 'NO_RESET', { usedPct: reading.pct, observedAt: newest.observedAt });
  // A reset between the newest snapshot and `asOf` has already expired the cycle the snapshot describes.
  if (resetsAt.getTime() <= Math.max(newest.observedAt.getTime(), asOf.getTime())) {
    return empty(window, 'UNKNOWN', 'RESET_PASSED', { usedPct: reading.pct, resetsAt, observedAt: newest.observedAt });
  }
  const sameCycle = (s: UsageSnapshot): boolean => {
    const r = s.windows[window]!.resetsAt;
    return r !== null && Math.abs(r.getTime() - resetsAt.getTime()) <= SAME_RESET_TOLERANCE_MS;
  };
  const epoch = withWindow.filter(sameCycle);
  const known = { usedPct: reading.pct, resetsAt, observedAt: newest.observedAt };
  const span = newest.observedAt.getTime() - epoch[0]!.observedAt.getTime();
  if (reading.pct < MIN_USED_PCT) return empty(window, 'INSUFFICIENT_DATA', 'LOW_USE', known);
  if (epoch.length < MIN_SNAPSHOTS || span < MIN_SPAN_MS) return empty(window, 'INSUFFICIENT_DATA', 'TOO_FEW_SNAPSHOTS', known);

  const rates: number[] = [];
  for (const hours of LOOKBACKS_HOURS) {
    const from = newest.observedAt.getTime() - hours * HOUR_MS;
    const first = epoch.find((s) => s.observedAt.getTime() >= from);
    if (!first) continue;
    const dt = newest.observedAt.getTime() - first.observedAt.getTime();
    if (dt < MIN_RATE_SPAN_MS) continue;
    rates.push(Math.max(0, newest.windows[window]!.pct - first.windows[window]!.pct) / (dt / HOUR_MS));
  }
  // The span rule guarantees the 24h lookback saw at least an hour, so a rate exists; stay total anyway.
  if (rates.length === 0) return empty(window, 'INSUFFICIENT_DATA', 'TOO_FEW_SNAPSHOTS', known);
  const rateLow = Math.min(...rates);
  const rateHigh = Math.max(...rates);
  const confidence: Confidence = rates.length >= 3 ? 'HIGH' : rates.length === 2 ? 'MEDIUM' : 'LOW';
  const hoursToReset = (resetsAt.getTime() - newest.observedAt.getTime()) / HOUR_MS;
  const workers = newest.workersConfigured ? newest.workers.length : 0;

  let shape: Shape = 'FLAT';
  let shapeScale = 1;
  let profile: ShapeProfile | null = null;
  if (window === SEVEN_DAY_MINUTES) {
    const weekly = weeklyAdditional(withWindow, newest, resetsAt, hoursToReset);
    const flatMid = ((rateLow + rateHigh) / 2) * hoursToReset;
    if (weekly !== null && flatMid > 0 && weekly.additional > 0) { shape = 'WEEKLY'; shapeScale = weekly.additional / flatMid; profile = weekly.profile; }
  }
  return applyRates(window, { used: reading.pct, observedAt: newest.observedAt, hoursToReset, shapeScale, rateLow, rateHigh, workers, profile }, rateLow, rateHigh, { confidence, shape }, resetsAt);
}

/**
 * The 7-day window's use over the hours left to the reset, from the hour-of-week burn seen in the history, or null when
 * the history does not span a week or some remaining hour of the week was never observed (the caller then stays FLAT).
 */
function weeklyAdditional(series: readonly UsageSnapshot[], newest: UsageSnapshot, resetsAt: Date, hoursToReset: number): { additional: number; profile: ShapeProfile } | null {
  const first = series[0]!;
  if (newest.observedAt.getTime() - first.observedAt.getTime() < WEEKLY_MIN_HISTORY_MS) return null;
  const sums = new Map<number, { total: number; n: number }>();
  const bucketOf = (t: number): number => Math.floor(t / HOUR_MS) % 168;
  for (let i = 1; i < series.length; i += 1) {
    const a = series[i - 1]!; const b = series[i]!;
    const ra = a.windows[SEVEN_DAY_MINUTES]!.resetsAt; const rb = b.windows[SEVEN_DAY_MINUTES]!.resetsAt;
    if (!ra || !rb || Math.abs(ra.getTime() - rb.getTime()) > SAME_RESET_TOLERANCE_MS) continue;
    const dt = b.observedAt.getTime() - a.observedAt.getTime();
    if (dt < 5 * 60_000 || dt > 6 * HOUR_MS) continue;
    const rate = Math.max(0, b.windows[SEVEN_DAY_MINUTES]!.pct - a.windows[SEVEN_DAY_MINUTES]!.pct) / (dt / HOUR_MS);
    const key = bucketOf(a.observedAt.getTime() + dt / 2);
    const cur = sums.get(key) ?? { total: 0, n: 0 };
    sums.set(key, { total: cur.total + rate, n: cur.n + 1 });
  }
  let additional = 0;
  const steps: { hours: number; cum: number }[] = [];
  let t = newest.observedAt.getTime();
  const startT = t;
  const end = resetsAt.getTime();
  while (t < end) {
    const next = Math.min(end, (Math.floor(t / HOUR_MS) + 1) * HOUR_MS);
    const cell = sums.get(bucketOf(t));
    if (!cell) return null;
    additional += (cell.total / cell.n) * ((next - t) / HOUR_MS);
    steps.push({ hours: (next - startT) / HOUR_MS, cum: additional });
    t = next;
  }
  if (!(hoursToReset > 0) || !(additional > 0)) return null;
  return { additional, profile: steps.map((x) => ({ hours: x.hours, frac: x.cum / additional })) };
}

/**
 * Every window of one account, shortest first: the two standard windows always (UNKNOWN when nothing reports them), plus
 * each other-length window the NEWEST snapshot reports (V29).
 */
export function projectAccount(history: readonly UsageSnapshot[], asOf: Date): WindowBasis[] {
  const latest = history.reduce<UsageSnapshot | null>((best, s) => (best === null || s.observedAt > best.observedAt ? s : best), null);
  const lengths = new Set<number>(STANDARD_WINDOWS);
  if (latest) for (const k of Object.keys(latest.windows)) lengths.add(Number(k));
  return [...lengths].sort((a, b) => a - b).map((w) => projectWindow(history, w, asOf));
}

/** The same window with `workers` workers on the account instead of its current count: the burn scales with the count. */
export function withWorkerCount(basis: WindowBasis, workers: number): WindowBasis {
  if (!basis.calc) return basis;
  if (basis.calc.workers <= 0) return empty(basis.projection.window, 'UNKNOWN', 'NO_WORKERS_CONFIGURED', {
    usedPct: basis.projection.usedPct, resetsAt: basis.projection.resetsAt, observedAt: basis.projection.observedAt,
  });
  const { rateLow, rateHigh, workers: now } = basis.calc;
  const factor = workers / now;
  return applyRates(basis.projection.window, basis.calc, rateLow * factor, rateHigh * factor, basis.projection, basis.projection.resetsAt!, workers);
}

/** The window with one more worker's burn added: `perWorker` is the SOURCE account's per-worker estimate (a move). */
export function addBurn(target: WindowBasis, perWorker: BurnRange | null): WindowBasis {
  if (!target.calc) return target;
  if (!perWorker) return empty(target.projection.window, 'UNKNOWN', 'WHATIF_SOURCE_UNKNOWN', {
    usedPct: target.projection.usedPct, resetsAt: target.projection.resetsAt, observedAt: target.projection.observedAt,
  });
  return applyRates(target.projection.window, target.calc, target.calc.rateLow + perWorker.lowPctPerHour, target.calc.rateHigh + perWorker.highPctPerHour, target.projection, target.projection.resetsAt!, target.calc.workers + 1);
}
