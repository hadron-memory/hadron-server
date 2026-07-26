/**
 * #796 — usage-activity time series: read/write event counts bucketed by time.
 *
 * The ONE aggregation code path. Both consumers — the `usageActivity` GraphQL
 * query and the USAGE_ACTIVITY dashboard-widget provider (#797) — call
 * `getUsageActivity` so a widget can never drift from the query it mirrors.
 *
 * Aggregation is a single `GROUP BY date_trunc(...)` with conditional counts;
 * no rows are streamed into the process. Only non-empty buckets come back — a
 * window with no activity yields `[]`, and the portal zero-fills client-side.
 *
 * AUTHORIZATION IS THE CALLER'S JOB. This module takes an already-authorized
 * scope: either a `userId` (the caller's own activity) or a `memoryId` the
 * caller has been confirmed to read. It performs no access checks.
 */

import { Prisma } from '../generated/prisma/index.js';
import type { PrismaClient } from '../generated/prisma/index.js';

/** Bucket widths, mirroring the `UsageActivityBucketSize` GraphQL enum. */
export type UsageActivityBucketSize = 'DAY' | 'WEEK' | 'MONTH';

/**
 * Enum member → the `date_trunc` field. Bound as a value, never interpolated:
 * `date_trunc(text, timestamp)`'s first argument is a genuine text parameter
 * (unlike a table/column identifier, which could not be bound). Mapping through
 * this record means nothing caller-supplied reaches the query even as a bind.
 */
const BUCKET_FIELD: Record<UsageActivityBucketSize, string> = {
  DAY: 'day',
  WEEK: 'week',
  MONTH: 'month',
};

/** True when `v` names a bucket size. For callers whose input never passed
 *  through GraphQL enum validation — e.g. widget `config`, which is raw JSON. */
export function isUsageActivityBucketSize(v: unknown): v is UsageActivityBucketSize {
  return typeof v === 'string' && Object.hasOwn(BUCKET_FIELD, v);
}

/** Default window when the caller names neither bound: the last 7 days. */
export const DEFAULT_WINDOW_DAYS = 7;

/**
 * Hard ceiling on the requested window. A bucketed scan is index-ranged on
 * `(user_id|memory_id, created_at)`, but an unbounded `from` would still let
 * one query walk the entire table.
 */
export const MAX_WINDOW_DAYS = 366;

export interface UsageActivityScope {
  /** Window start, INCLUSIVE. */
  from: Date;
  /** Window end, EXCLUSIVE — so adjacent windows tile without double-counting. */
  to: Date;
  bucket: UsageActivityBucketSize;
  /** IANA zone deciding where bucket boundaries fall. Validate before calling. */
  timeZone: string;
  /** Own-activity scope: events attributed to this user, across every memory. */
  userId?: string;
  /**
   * Memory scope: every user's events attributed to this memory. Takes
   * precedence over `userId` when both are set. MUST be pre-authorized.
   */
  memoryId?: string;
}

export interface UsageActivityBucket {
  /** Bucket start as `YYYY-MM-DD`, in the requested time zone. */
  date: string;
  reads: number;
  writes: number;
}

/**
 * Render an instant as the naive UTC literal Postgres should compare against a
 * `timestamp WITHOUT time zone` column (`2026-07-26T20:50:34.637`). See the
 * binding note in {@link getUsageActivity} for why a JS Date can't be used.
 */
const toNaiveUtc = (d: Date): string => d.toISOString().replace('Z', '');

/** True when `tz` is a zone this runtime's ICU data knows. */
export function isValidTimeZone(tz: string): boolean {
  try {
    // Throws RangeError on an unknown zone. Doing this here keeps an invalid
    // value from reaching Postgres, where `AT TIME ZONE` would raise at
    // runtime and surface as a 500 rather than a input-validation error.
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Count `read` and `write` events per time bucket within a window.
 *
 * Deliberately limited to those two types: they are the "activity" a person
 * recognizes. The bucket enum + window shape is meant to grow into the wider
 * analytics surface (per-app split, other event types) without a redesign.
 *
 * Returns buckets ascending by date, non-empty ones only.
 */
export async function getUsageActivity(
  db: Pick<PrismaClient, '$queryRaw'>,
  scope: UsageActivityScope,
): Promise<UsageActivityBucket[]> {
  // A memory scope and a user scope are alternatives, never an intersection:
  // "all users of this memory" is the documented meaning of passing memoryId.
  const scopePredicate = scope.memoryId
    ? Prisma.sql`e.memory_id = ${scope.memoryId}`
    : Prisma.sql`e.user_id = ${scope.userId}`;

  // Defense in depth for a SHARED service: the GraphQL enum guards the query
  // path, but the widget provider's bucket comes from raw config JSON. Without
  // this an unknown value binds `undefined` into date_trunc and surfaces as an
  // opaque driver error instead of a clear one.
  if (!isUsageActivityBucketSize(scope.bucket)) {
    throw new Error(`Unknown usage-activity bucket size: ${String(scope.bucket)}`);
  }
  const field = BUCKET_FIELD[scope.bucket];

  // The DOUBLE `AT TIME ZONE` is load-bearing — do not "simplify" it to one.
  // `created_at` is `timestamp WITHOUT time zone` holding a UTC instant (how
  // Prisma maps DateTime), so:
  //   1. `AT TIME ZONE 'UTC'` labels that naive value as UTC → timestamptz.
  //   2. `AT TIME ZONE ${tz}`  converts it back to a naive wall-clock reading
  //      in the requested zone.
  // date_trunc then operates on a plain timestamp and is deterministic. With a
  // single conversion the result is a timestamptz and date_trunc silently uses
  // the SESSION time zone instead — which made every bucket land a day early on
  // a US-West dev box while looking correct on a UTC server.
  //
  // Counts come back as bigint (Postgres COUNT) and must be Number()-cast —
  // JSON can't serialize a BigInt and GraphQL Int wants a number.
  //
  // The window bounds are bound as NAIVE-UTC strings cast to `timestamp`, not as
  // JS Dates. Prisma binds a Date as `timestamp WITH time zone`, and comparing
  // the naive `created_at` column against a timestamptz makes Postgres coerce
  // the column using the SESSION time zone — so on a UTC-7 server the newest
  // ~7 hours of events silently fell outside their own window (correct on a UTC
  // server, wrong everywhere else). Keeping the COLUMN bare rather than wrapping
  // it also preserves the (user_id|memory_id, created_at) index range scan.
  const rows = await db.$queryRaw<Array<{ date: string; reads: bigint; writes: bigint }>>`
    SELECT to_char(date_trunc(${field}, (e.created_at AT TIME ZONE 'UTC') AT TIME ZONE ${scope.timeZone}), 'YYYY-MM-DD') AS date,
           COUNT(*) FILTER (WHERE e.type = 'read')  AS reads,
           COUNT(*) FILTER (WHERE e.type = 'write') AS writes
    FROM usage_events e
    WHERE e.created_at >= ${toNaiveUtc(scope.from)}::timestamp
      AND e.created_at < ${toNaiveUtc(scope.to)}::timestamp
      AND e.type IN ('read', 'write')
      AND e.deleted_at IS NULL
      AND ${scopePredicate}
    GROUP BY 1
    ORDER BY 1`;

  return rows.map((r) => ({
    date: r.date,
    reads: Number(r.reads),
    writes: Number(r.writes),
  }));
}

/**
 * Resolve the effective `[from, to)` window from optional caller bounds.
 * Defaults to the last {@link DEFAULT_WINDOW_DAYS} days and clamps the span to
 * {@link MAX_WINDOW_DAYS} by moving `from` forward — the recent end of a window
 * is the interesting one, so an over-long request is truncated at the far edge.
 * Returns null when a supplied bound is unparseable or the window is inverted.
 */
export function resolveWindow(
  from?: string | null,
  to?: string | null,
  now: Date = new Date(),
): { from: Date; to: Date } | null {
  const toDate = to ? new Date(to) : now;
  if (Number.isNaN(toDate.getTime())) return null;

  const fromDate = from
    ? new Date(from)
    : new Date(toDate.getTime() - DEFAULT_WINDOW_DAYS * 86_400_000);
  if (Number.isNaN(fromDate.getTime())) return null;
  if (fromDate.getTime() >= toDate.getTime()) return null;

  const maxMs = MAX_WINDOW_DAYS * 86_400_000;
  const clampedFrom =
    toDate.getTime() - fromDate.getTime() > maxMs
      ? new Date(toDate.getTime() - maxMs)
      : fromDate;

  return { from: clampedFrom, to: toDate };
}
