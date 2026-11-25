/**
 * #5011 (Billing A4): settle expired grants. hrn:node:hadronmemory.com:specs:cor:dmo:170:10: free credit expires, and
 * each expired grant is settled by ONE new `adjustment` entry of minus what was left of it, source pair
 * ('grant-expiry', <grant id>), also when nothing was left (a zero entry), and never again. What was left comes from
 * the pure replay in ./expiry.ts (hrn:node:hadronmemory.com:specs:cor:dmo:170:11, soonest-expiring first).
 *
 * The owner is an organization or a person (#5014, A6): every read and write goes through the one owner column it sets.
 *
 * Called for the owner at hand before a balance is read (the creditBalance resolver; A3's gate later) and by the hourly
 * job (src/jobs/expireCreditGrants.ts) for everyone else.
 *
 * Gate rulings on #5011:
 * - 10.1 the clock: `now` is the database's. A grant is written settled only once `expiresAt <= now - 60 s`
 *   ({@link SETTLE_DELAY_MS}), so a debit stamped just before the expiry that commits a moment later is still counted
 *   in the settlement instead of being charged twice. Every read answers the computed figure meanwhile
 *   ({@link unsettledRemainders}), so no balance ever includes credit whose expiry has passed (10.7).
 * - 10.6 a settlement carries createdBy {@link CREDIT_EXPIRY_CREATED_BY} and no note (the source pair says it all).
 *
 * The writer is NOT A1's insert-or-replay helper: a pair already taken is done whatever its amount (a concurrent
 * settler, another instance, a second read), so it is an `INSERT ... ON CONFLICT DO NOTHING` (createMany with
 * skipDuplicates) that never raises P2002 and never aborts a surrounding transaction (#5064 blind finding F1).
 */
import { Prisma, type PrismaClient } from '../../generated/prisma/index.js';
import { generateId } from '../id.js';
import { ownerColumns, ownerWhere, type OwnerRef } from '../owner.js';
import {
  GRANT_EXPIRY_SOURCE_TYPE,
  replayLedger,
  replayWindowStart,
  type ReplayEntry,
  type ReplayResult,
} from './expiry.js';

/** Ruling 10.1: how long after its expiry a grant is first written settled. */
export const SETTLE_DELAY_MS = 60_000;

/** Ruling 10.6: the createdBy of every settlement entry. */
export const CREDIT_EXPIRY_CREATED_BY = 'system:credit-expiry';

/** One settlement: the grant and the signed amount written for it (minus its remainder; may be 0n). */
export interface Settlement {
  grantId: string;
  amountMicroCents: bigint;
}

export interface SettleOptions {
  /** The instant to settle at; defaults to the database clock. */
  now?: Date;
}

/** `created_at` and `expires_at` are naive UTC timestamps: bind a naive UTC literal (finding prisma-naive-timestamp-raw-sql). */
export const toNaiveUtc = (at: Date): string => at.toISOString().replace('Z', '');

/** The database clock, the one `created_at` defaults come from. */
export async function databaseNow(db: PrismaClient): Promise<Date> {
  const [row] = await db.$queryRaw<{ now: Date }[]>`SELECT now() AS now`;
  return row.now;
}

/**
 * #5014: the raw-SQL predicate that selects an owner's ledger rows by the ONE column it sets (the Prisma `where` twin is
 * {@link ownerWhere}). `alias` is a trusted literal at the call sites, never caller input.
 */
function ownerPredicate(owner: OwnerRef, alias: 'g'): Prisma.Sql {
  const cols = ownerColumns(owner);
  return cols.ownerUserId != null
    ? Prisma.sql`${Prisma.raw(alias)}.owner_user_id = ${cols.ownerUserId}`
    : Prisma.sql`${Prisma.raw(alias)}.organization_id = ${cols.organizationId}`;
}

/**
 * The probe: does the owner (an organization or a person) hold a live grant that expired at or before `cutoff` and has no settlement? One
 * range on the partial index `credit_ledger_entries_expiring_grants_idx` plus the unique pair index. The pair is
 * checked whatever its row's deletedAt: a taken pair is settled (the writer could never write it again). Internal:
 * exported for the M1 measurement, not for other callers.
 */
export async function hasUnsettledExpiredGrant(db: PrismaClient, owner: OwnerRef, cutoff: Date): Promise<boolean> {
  const rows = await db.$queryRaw<{ one: number }[]>(Prisma.sql`
    SELECT 1 AS one
      FROM credit_ledger_entries g
     WHERE ${ownerPredicate(owner, 'g')}
       AND g.expires_at IS NOT NULL
       AND g.expires_at <= ${toNaiveUtc(cutoff)}::timestamp
       AND g.kind = 'grant'
       AND g.deleted_at IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM credit_ledger_entries s
          WHERE s.source_type = ${GRANT_EXPIRY_SOURCE_TYPE} AND s.source_id = g.id
       )
     LIMIT 1`);
  return rows.length > 0;
}

/** What the replay of one owner reads: its window's entries, the opening figure and the taken pairs. */
export interface ReplayWindow {
  entries: ReplayEntry[];
  opening: bigint;
  settled: Set<string>;
}

/**
 * Read the organization's window at `now` (expiry.ts `replayWindowStart`): every live expiring grant and every taken
 * settlement pair, one opening figure for the entries before the window, the live entries from it to `now`. Null when
 * the organization holds no unsettled expiring grant. Internal: exported for the M1 measurement.
 */
export async function readReplayWindow(db: PrismaClient, owner: OwnerRef, now: Date): Promise<ReplayWindow | null> {
  const who = ownerWhere(owner);
  const grants = await db.creditLedgerEntry.findMany({
    where: { ...who, kind: 'grant', expiresAt: { not: null }, deletedAt: null },
    select: { id: true, createdAt: true, expiresAt: true },
  });
  if (grants.length === 0) return null;
  const pairs = await db.creditLedgerEntry.findMany({
    where: { sourceType: GRANT_EXPIRY_SOURCE_TYPE, sourceId: { in: grants.map((g) => g.id) } },
    select: { sourceId: true },
  });
  const settled = new Set(pairs.map((p) => p.sourceId as string));
  const start = replayWindowStart(
    grants.map((g) => ({ id: g.id, createdAt: g.createdAt, expiresAt: g.expiresAt as Date })),
    settled,
  );
  if (start === null) return null;
  const [opening, entries] = await Promise.all([
    db.creditLedgerEntry.aggregate({
      where: { ...who, deletedAt: null, createdAt: { lt: start } },
      _sum: { amountMicroCents: true },
    }),
    db.creditLedgerEntry.findMany({
      where: { ...who, deletedAt: null, createdAt: { gte: start, lte: now } },
      select: {
        id: true,
        kind: true,
        amountMicroCents: true,
        expiresAt: true,
        sourceType: true,
        sourceId: true,
        createdAt: true,
      },
    }),
  ]);
  return { entries, opening: opening._sum.amountMicroCents ?? 0n, settled };
}

/** Replay the organization's ledger at `now` through its window; null when there is nothing to replay. */
async function replayOwner(db: PrismaClient, owner: OwnerRef, now: Date): Promise<ReplayResult | null> {
  const window = await readReplayWindow(db, owner, now);
  if (window === null) return null;
  return replayLedger(window.entries, now, { opening: window.opening, settled: window.settled });
}

/**
 * Write settlement entries, skipping any pair already taken (never a throw, never an aborted transaction). Returns
 * how many rows were inserted. Internal: exported for the settlement pins, not for other callers.
 */
export async function writeSettlements(
  db: PrismaClient,
  owner: OwnerRef,
  settlements: readonly Settlement[],
  now: Date,
): Promise<number> {
  if (settlements.length === 0) return 0;
  const { count } = await db.creditLedgerEntry.createMany({
    data: settlements.map((s) => ({
      id: generateId(),
      ...ownerColumns(owner),
      kind: 'adjustment',
      amountMicroCents: s.amountMicroCents,
      expiresAt: null,
      sourceType: GRANT_EXPIRY_SOURCE_TYPE,
      sourceId: s.grantId,
      note: null,
      createdAt: now,
      createdBy: CREDIT_EXPIRY_CREATED_BY,
    })),
    skipDuplicates: true,
  });
  return count;
}

/**
 * Settle every grant of `owner` that expired at least {@link SETTLE_DELAY_MS} before `now` and has no settlement.
 * Returns the settlements it asked to write, in the replay's total order (a pair another settler took meanwhile is
 * skipped by the insert, so a concurrent call may list one that it did not itself insert). Most calls end at the probe.
 */
export async function settleExpiredGrants(db: PrismaClient, owner: OwnerRef, opts: SettleOptions = {}): Promise<Settlement[]> {
  ownerColumns(owner); // a value naming neither or both is a programming error, refused before any read
  const now = opts.now ?? (await databaseNow(db));
  const cutoff = new Date(now.getTime() - SETTLE_DELAY_MS);
  if (!(await hasUnsettledExpiredGrant(db, owner, cutoff))) return [];
  const result = await replayOwner(db, owner, now);
  const due = (result?.toSettle ?? [])
    .filter((g) => g.expiresAt.getTime() <= cutoff.getTime())
    .map((g) => ({ grantId: g.grantId, amountMicroCents: -g.remaining }));
  await writeSettlements(db, owner, due, now);
  return due;
}

/**
 * What is left of every grant of `owner` whose expiry has passed at `now` (inside the 60 s included) and that has no
 * settlement: the figure a read subtracts from the stored sum, written nowhere (the impersonated read, and any read
 * inside the 60 s; rulings 10.1 and 10.7). 0n after the probe in the common case.
 */
export async function unsettledRemainders(db: PrismaClient, owner: OwnerRef, now: Date): Promise<bigint> {
  ownerColumns(owner);
  if (!(await hasUnsettledExpiredGrant(db, owner, now))) return 0n;
  const result = await replayOwner(db, owner, now);
  return (result?.toSettle ?? []).reduce((acc, g) => acc + g.remaining, 0n);
}

/** What is left of each unexpired expiring grant of `owner` at `now`, soonest first (CreditBalance.expiring). */
export async function expiringCredit(db: PrismaClient, owner: OwnerRef, now: Date) {
  const result = await replayOwner(db, owner, now);
  return result?.expiring ?? [];
}
