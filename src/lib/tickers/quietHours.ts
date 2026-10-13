// Ticker quiet-hours validation — #1747, cor:agt:080:01 / :06.
//
// `{ timezone, windows: [{ days: [1..7], from: "22:00", to: "07:00" }] }`.
// A window includes its start and excludes its end; `from` later than `to`
// runs overnight into the next day. Days are ISO (1 = Monday ... 7 = Sunday).
// Refused at save, never at tick time: a bad schedule must not be storable.

export const QUIET_HOURS_MAX_WINDOWS = 14;

export type QuietWindow = { days: number[]; from: string; to: string };
export type QuietHours = { timezone: string; windows: QuietWindow[] };

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const WEEK = 7 * 1440;

/**
 * A time zone the consumer (Intl, which evaluates quiet hours) accepts. Asking the
 * consumer rather than a list admits every valid IANA name and alias (`US/Pacific`)
 * and nothing the evaluator would choke on. Numeric offsets (`+01:00`), which newer
 * runtimes also accept, are not zone names and are refused: a ticker's day boundary
 * should follow a place's rules, including DST.
 */
function knownZone(zone: string): boolean {
  if (!/^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z][A-Za-z0-9_+-]*)*$/.test(zone)) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

function minutes(hhmm: string): number {
  const m = HHMM.exec(hhmm)!;
  return Number(m[1]) * 60 + Number(m[2]);
}

/**
 * The half-open [start, end) minute ranges one window covers on the week line,
 * split where an overnight window wraps past the end of Sunday.
 */
function ranges(w: QuietWindow): Array<[number, number]> {
  const f = minutes(w.from);
  const t = minutes(w.to);
  const out: Array<[number, number]> = [];
  for (const d of w.days) {
    const base = (d - 1) * 1440;
    if (t > f) {
      out.push([base + f, base + t]);
    } else {
      const end = base + 1440;
      out.push([base + f, Math.min(end, WEEK)]);
      const next = end % WEEK;
      if (t > 0) out.push([next, next + t]);
    }
  }
  return out;
}

/** The normalized value, or a message saying why it is invalid. */
export function validateQuietHours(input: unknown): { ok: true; value: QuietHours } | { ok: false; reason: string } {
  const bad = (reason: string) => ({ ok: false as const, reason });
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return bad('quietHours must be an object.');
  const { timezone, windows } = input as { timezone?: unknown; windows?: unknown };
  if (typeof timezone !== 'string' || !knownZone(timezone)) return bad('timezone is not an IANA time zone.');
  if (!Array.isArray(windows) || windows.length === 0) return bad('windows must be a non-empty list.');
  if (windows.length > QUIET_HOURS_MAX_WINDOWS) return bad(`At most ${QUIET_HOURS_MAX_WINDOWS} windows.`);
  const norm: QuietWindow[] = [];
  for (const w of windows) {
    if (typeof w !== 'object' || w === null) return bad('A window must be an object.');
    const { days, from, to } = w as { days?: unknown; from?: unknown; to?: unknown };
    if (!Array.isArray(days) || days.length === 0) return bad('A window needs at least one day.');
    if (!days.every((d) => Number.isInteger(d) && d >= 1 && d <= 7)) return bad('Days are integers 1 (Monday) to 7 (Sunday).');
    if (new Set(days).size !== days.length) return bad('A window lists a day twice.');
    if (typeof from !== 'string' || !HHMM.test(from) || typeof to !== 'string' || !HHMM.test(to)) {
      return bad('from and to are HH:MM, 00:00 to 23:59.');
    }
    if (from === to) return bad('A window cannot be zero-length.');
    norm.push({ days: [...(days as number[])].sort((a, b) => a - b), from, to });
  }
  const all = norm.flatMap((w) => ranges(w)).sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < all.length; i++) {
    if (all[i]![0] < all[i - 1]![1]) return bad('Windows overlap.');
  }
  return { ok: true, value: { timezone, windows: norm } };
}

const ISO_DAY: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
const formatters = new Map<string, Intl.DateTimeFormat>();

/** The local minute of the ISO week (Monday 00:00 = 0) at `at` in `timezone`. DST-correct: the zone's own clock decides. */
function weekMinuteIn(timezone: string, at: Date): number {
  let f = formatters.get(timezone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    formatters.set(timezone, f);
  }
  let day = 1;
  let hour = 0;
  let minute = 0;
  for (const part of f.formatToParts(at)) {
    if (part.type === 'weekday') day = ISO_DAY[part.value] ?? 1;
    else if (part.type === 'hour') hour = Number(part.value);
    else if (part.type === 'minute') minute = Number(part.value);
  }
  return (day - 1) * 1440 + hour * 60 + minute;
}

/** Is `at` inside the quiet hours (cor:agt:080:06)? A window includes its start and excludes its end. */
export function inQuietHours(quiet: QuietHours | null | undefined, at: Date): boolean {
  if (!quiet) return false;
  const minute = weekMinuteIn(quiet.timezone, at);
  for (const w of quiet.windows) {
    for (const [a, b] of ranges(w)) if (minute >= a && minute < b) return true;
  }
  return false;
}
