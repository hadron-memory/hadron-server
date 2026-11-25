/**
 * #5011 (Billing A4): the pure replay of one owner's credit ledger that says what is left of each expiring grant.
 *
 * Rules (hrn:node:hadronmemory.com:specs:cor:dmo:170:10 and hrn:node:hadronmemory.com:specs:cor:dmo:170:11):
 * - a grant with an expiry opens its own bucket; a grant without one adds to the PERMANENT bucket (credit that never
 *   expires);
 * - a debit drains the expiring buckets soonest-expiring first, each to zero, taking only buckets whose expiry is LATER
 *   than the debit's createdAt, and only then the permanent bucket, which may go below zero (an expiring one cannot);
 * - an adjustment with sourceType `grant-expiry` (the settlement) empties the bucket of the grant it names; when that
 *   grant lies before the replay's window it has no bucket, and the settlement applies to the permanent bucket, where
 *   the opening figure carried that grant's remainder (review-rev11 finding 231);
 * - every other adjustment, of either sign (a refund, a cost correction, a manual correction), applies to the
 *   permanent bucket. cor:dmo:170:11 speaks only of debits: this line is the plan's reading (subscription-billing-plan
 *   section 13, item 13), written into :11 as Proposed.
 *
 * The bucket order is TOTAL, (expiresAt, createdAt, id): two readers that ordered equal expiries differently would
 * settle different grants and leave expired credit behind (review-rev11 L7). Entries are sorted here by
 * (createdAt, id), never in the caller's order. A grant is expired at `now` when `expiresAt <= now`: at the instant of
 * expiry it is expired for the debit (which does not draw on it) and for the settlement alike.
 *
 * The permanent bucket plus every bucket always equals the opening figure plus the sum of the replayed entries, so a
 * settlement that differs from its bucket's remainder (written before a late debit committed) moves the difference to
 * the permanent bucket instead of losing it.
 *
 * No database access: the settlement module (settleExpiredGrants.ts) reads the window and writes the entries.
 */

/** The fields of a ledger entry the replay reads. Amounts are signed micro-cents. */
export interface ReplayEntry {
  id: string;
  kind: string;
  amountMicroCents: bigint;
  expiresAt: Date | null;
  sourceType: string | null;
  sourceId: string | null;
  createdAt: Date;
}

/** What is left of one expiring grant. */
export interface GrantRemainder {
  grantId: string;
  remaining: bigint;
  expiresAt: Date;
}

export interface ReplayResult {
  /** Unexpired expiring grants (`expiresAt > now`) with something left, soonest first in the total order. */
  expiring: GrantRemainder[];
  /** Grants with `expiresAt <= now` and no settlement, in the total order. `remaining` may be 0n (a fully used grant). */
  toSettle: GrantRemainder[];
  /** Credit that never expires, after the replay (the opening figure included). May be negative. */
  permanent: bigint;
}

export interface ReplayOptions {
  /** The sum of every entry before the window, carried as one figure on the permanent bucket. */
  opening?: bigint;
  /**
   * Grant ids whose settlement pair is taken but whose settlement is not among the entries (a soft-deleted settlement
   * row still holds its pair). They are never listed to settle again.
   */
  settled?: ReadonlySet<string>;
}

/** The source type of a settlement entry, written only by the server (#5007's reserved source types). */
export const GRANT_EXPIRY_SOURCE_TYPE = 'grant-expiry';

interface Bucket {
  grantId: string;
  createdAt: Date;
  expiresAt: Date;
  remaining: bigint;
  settled: boolean;
}

/** Plain code-unit comparison: total and the same on every machine (no locale). */
function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareEntries(a: ReplayEntry, b: ReplayEntry): number {
  return a.createdAt.getTime() - b.createdAt.getTime() || compareIds(a.id, b.id);
}

/** The total order on buckets: (expiresAt, createdAt, id). */
function compareBuckets(a: Bucket, b: Bucket): number {
  return (
    a.expiresAt.getTime() - b.expiresAt.getTime() ||
    a.createdAt.getTime() - b.createdAt.getTime() ||
    compareIds(a.grantId, b.grantId)
  );
}

const isExpiringGrant = (e: ReplayEntry): e is ReplayEntry & { expiresAt: Date } =>
  e.kind === 'grant' && e.expiresAt !== null;

/**
 * Replay one owner's entries at `now` (entries created after `now` take no part). See the module comment for the rules.
 */
export function replayLedger(entries: readonly ReplayEntry[], now: Date, opts: ReplayOptions = {}): ReplayResult {
  const nowMs = now.getTime();
  const sorted = entries.filter((e) => e.createdAt.getTime() <= nowMs).sort(compareEntries);
  const buckets = new Map<string, Bucket>();
  // Kept in the total order, so a debit walks them soonest-expiring first.
  const ordered: Bucket[] = [];
  let permanent = opts.opening ?? 0n;

  for (const e of sorted) {
    if (e.kind === 'grant') {
      if (isExpiringGrant(e)) {
        const bucket: Bucket = {
          grantId: e.id,
          createdAt: e.createdAt,
          expiresAt: e.expiresAt,
          remaining: e.amountMicroCents,
          settled: false,
        };
        buckets.set(e.id, bucket);
        ordered.push(bucket);
        ordered.sort(compareBuckets);
      } else {
        permanent += e.amountMicroCents;
      }
    } else if (e.kind === 'debit' && e.amountMicroCents < 0n) {
      let need = -e.amountMicroCents;
      const at = e.createdAt.getTime();
      for (const b of ordered) {
        if (need === 0n) break;
        // Only a bucket still live at the debit's time: its expiry must be LATER than the debit.
        if (b.expiresAt.getTime() <= at || b.remaining <= 0n) continue;
        const take = b.remaining < need ? b.remaining : need;
        b.remaining -= take;
        need -= take;
      }
      permanent -= need;
    } else if (e.kind === 'adjustment' && e.sourceType === GRANT_EXPIRY_SOURCE_TYPE && e.sourceId !== null) {
      const b = buckets.get(e.sourceId);
      if (b) {
        // Empties the bucket; a settlement that differs from what is left moves the difference to permanent.
        permanent += e.amountMicroCents + b.remaining;
        b.remaining = 0n;
        b.settled = true;
      } else {
        // The grant lies before the window: its remainder is in the opening figure, which this entry corrects.
        permanent += e.amountMicroCents;
      }
    } else {
      // Any other adjustment (either sign), and any entry of another shape, applies to credit that never expires.
      permanent += e.amountMicroCents;
    }
  }

  const expiring: GrantRemainder[] = [];
  const toSettle: GrantRemainder[] = [];
  for (const b of ordered) {
    const view = { grantId: b.grantId, remaining: b.remaining, expiresAt: b.expiresAt };
    if (b.expiresAt.getTime() <= nowMs) {
      if (!b.settled && !opts.settled?.has(b.grantId)) toSettle.push(view);
    } else if (b.remaining > 0n) {
      expiring.push(view);
    }
  }
  return { expiring, toSettle, permanent };
}

/** An expiring grant as the window rule reads it. */
export interface ExpiringGrantSpan {
  id: string;
  createdAt: Date;
  expiresAt: Date;
}

/**
 * Where a replay may start (the plan's "Bounds" rule, A4): at the creation of the oldest UNSETTLED expiring grant, moved
 * back to the creation of every expiring grant, settled or not, that was still live at the start, until none is. At
 * that moment no expiring grant is live, so everything before it collapses into one opening figure on the permanent
 * bucket without changing any bucket. Null when the owner holds no unsettled expiring grant (nothing to replay).
 * Entries with `createdAt >= start` are replayed; entries before it are the opening figure.
 */
export function replayWindowStart(grants: readonly ExpiringGrantSpan[], settled: ReadonlySet<string>): Date | null {
  let start: number | null = null;
  for (const g of grants) {
    if (settled.has(g.id)) continue;
    const at = g.createdAt.getTime();
    if (start === null || at < start) start = at;
  }
  if (start === null) return null;
  let moved = true;
  while (moved) {
    moved = false;
    for (const g of grants) {
      const created = g.createdAt.getTime();
      if (created < start && g.expiresAt.getTime() > start) {
        start = created;
        moved = true;
      }
    }
  }
  return new Date(start);
}
