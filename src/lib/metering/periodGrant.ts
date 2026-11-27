/**
 * The default monthly grant (hadron-server#5022, Billing A9; hrn:node:hadronmemory.com:specs:cor:dmo:170:12).
 *
 * A deployment may give every owner a free grant each UTC calendar month: env `OWNER_DEFAULT_MONTHLY_GRANT`, JSON
 * `{ "user": "<micro-cents>", "organization": "<micro-cents>" }`, each amount a base-10 string (every money field is one; a
 * JSON number would lose precision past 2^53). A missing owner type, an unset or blank value, and an amount of zero all
 * mean no grant, today's behaviour. Anything else refuses boot with one fixed sentence that never echoes the value (gate
 * ruling 2).
 *
 * The grant is one `grant` entry per owner and month, written through the ledger's {@link grantCredits} with source type
 * `period-grant`, expiring at the first instant of the next UTC month so A4's settlement removes what is left
 * (hrn:node:hadronmemory.com:specs:cor:dmo:170:10). Its source id is an unkeyed SHA-256 of owner type, owner id and month,
 * so the entry never names the owner in clear and still outlives it (hrn:node:hadronmemory.com:specs:cor:dmo:170:08, gate
 * ruling 5), and every server process computes the same id, so the ledger's unique (sourceType, sourceId) pair is what makes
 * the grant once per owner and month across processes (hrn:node:hadronmemory.com:specs:cor:dmo:170:03).
 */
import { createHash } from 'node:crypto';

import { Prisma, type PrismaClient } from '../../generated/prisma/index.js';
import { ownerId, ownerType, sameOwner, type OwnerRef, type OwnerType } from '../owner.js';
import { safeErrorCode } from '../safeErrorCode.js';
import { grantCredits, IdempotencyConflictError, LedgerOwnerDeletedError } from './index.js';

export const PERIOD_GRANT_SOURCE_TYPE = 'period-grant';
/** Who wrote the grant (gate ruling 4; the `system:gc` and A4 `system:credit-expiry` precedent), never the reader. */
export const PERIOD_GRANT_ACTOR = 'system:period-grant';

export type OwnerDefaultMonthlyGrant = Readonly<Record<OwnerType, bigint>>;

export const OWNER_DEFAULT_MONTHLY_GRANT_ERROR =
  'OWNER_DEFAULT_MONTHLY_GRANT must be a JSON object with the optional keys "user" and "organization", each a non-negative ' +
  'whole number of micro-cents written as a base-10 string within the 64-bit range; refusing to boot.';

const INT8_MAX = 2n ** 63n - 1n;
const AMOUNT = /^(0|[1-9][0-9]*)$/;
const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Parse the raw value, or throw the one fixed sentence (no part of the value, and no `cause`: a JSON parse error quotes its input). */
export function parseOwnerDefaultMonthlyGrant(raw: string | undefined): OwnerDefaultMonthlyGrant {
  const out: Record<OwnerType, bigint> = { user: 0n, organization: 0n };
  if (raw === undefined || raw.trim() === '') return out;
  const bad = () => new Error(OWNER_DEFAULT_MONTHLY_GRANT_ERROR);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw bad();
  }
  if (!isPlainObject(parsed)) throw bad();
  for (const [type, value] of Object.entries(parsed)) {
    if (type !== 'user' && type !== 'organization') throw bad();
    if (typeof value !== 'string' || !AMOUNT.test(value)) throw bad();
    const amount = BigInt(value);
    if (amount > INT8_MAX) throw bad();
    out[type] = amount;
  }
  return out;
}

let loaded: OwnerDefaultMonthlyGrant | undefined;

/** Parse and keep the amounts. Called by `createServer`, so a malformed value refuses boot. A refused value leaves the kept ones alone. */
export function loadOwnerDefaultMonthlyGrant(env: NodeJS.ProcessEnv = process.env): OwnerDefaultMonthlyGrant {
  loaded = parseOwnerDefaultMonthlyGrant(env.OWNER_DEFAULT_MONTHLY_GRANT);
  return loaded;
}

/** The kept amounts. Loads lazily for code that runs without `createServer` (a resolver test, a script). */
export function ownerDefaultMonthlyGrant(): OwnerDefaultMonthlyGrant {
  return loaded ?? loadOwnerDefaultMonthlyGrant();
}

/** Tests set the amounts per case. */
export function reloadOwnerDefaultMonthlyGrantForTests(env: Record<string, string | undefined>): void {
  loadOwnerDefaultMonthlyGrant(env as NodeJS.ProcessEnv);
}

/** `YYYY-MM` of `now` in UTC (cor:dmo:170:12: the period is the UTC calendar month). */
const utcMonth = (now: Date): string =>
  `${now.getUTCFullYear().toString().padStart(4, '0')}-${(now.getUTCMonth() + 1).toString().padStart(2, '0')}`;

/** The first instant of the UTC month after `now`'s: the grant's expiry. */
const nextUtcMonthStart = (now: Date): Date => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));

/**
 * The month's grant's source id: hex SHA-256 of `period-grant:<organization|user>:<owner id>:<YYYY-MM>`. Opaque (it names
 * neither the owner nor the month in clear; cor:dmo:170:08) and the same in every process. Unkeyed on purpose (gate ruling
 * 5): whoever already holds the owner's id can recompute it, nobody else learns the id from it, and a keyed digest would
 * add a secret whose rotation would let a second grant through.
 */
export function periodGrantSourceId(owner: OwnerRef, now: Date): string {
  return createHash('sha256').update(`${PERIOD_GRANT_SOURCE_TYPE}:${ownerType(owner)}:${ownerId(owner)}:${utcMonth(now)}`).digest('hex');
}

/**
 * Owners this process already knows to be done for the current month: granted, or conflicted (the amount changed mid-month;
 * retrying on every read would only conflict again). Holds one month only: a key of another month clears it first, so it
 * cannot grow past the owners read in one month. A failed write is never added, so the next read tries again.
 */
let doneMonth: string | null = null;
const done = new Set<string>();

function doneKey(owner: OwnerRef, month: string): string {
  if (doneMonth !== month) {
    done.clear();
    doneMonth = month;
  }
  return `${ownerType(owner)}:${ownerId(owner)}:${month}`;
}

type Writer = typeof grantCredits;
let writer: Writer = grantCredits;

/** Tests replace the ledger write (a failing or racing writer); `null` restores the real one. */
export function setPeriodGrantWriterForTests(fn: Writer | null): void {
  writer = fn ?? grantCredits;
}

/** Tests start from a fresh process state. */
export function resetPeriodGrantStateForTests(): void {
  done.clear();
  doneMonth = null;
}

export function periodGrantCacheKeysForTests(): string[] {
  return [...done];
}

const logOwner = (owner: OwnerRef) =>
  'organizationId' in owner ? { organizationId: owner.organizationId } : { ownerUserId: owner.userId };

/** The month's stored grant for `owner`, by the unique pair (one indexed read), or null. */
async function storedGrant(db: PrismaClient, owner: OwnerRef, now: Date) {
  return db.creditLedgerEntry.findUnique({
    where: { sourceType_sourceId: { sourceType: PERIOD_GRANT_SOURCE_TYPE, sourceId: periodGrantSourceId(owner, now) } },
    select: { organizationId: true, ownerUserId: true, amountMicroCents: true, kind: true },
  });
}

/**
 * Whether `owner` is soft-deleted: a deleted owner is owed no grant (issue #5022 section 8; the sec10 P3-1 on #5317 found a
 * platform admin's read of a deleted person reaching the write, since that gate resolves deleted people for admins). A row
 * that is gone altogether counts as deleted. One indexed read; safe inside a transaction.
 */
async function ownerDeleted(db: PrismaClient, owner: OwnerRef): Promise<boolean> {
  const row = 'organizationId' in owner
    ? await db.organization.findUnique({ where: { id: owner.organizationId }, select: { deletedAt: true } })
    : await db.user.findUnique({ where: { id: owner.userId }, select: { deletedAt: true } });
  return row == null || row.deletedAt != null;
}

/**
 * Write the month's default grant for `owner`, once (cor:dmo:170:12). `now` is the clock the caller judges expiry with: the
 * database's (`databaseNow`), as A4 settles with it. Never throws: a conflict (the amount changed mid-month, so the owner
 * keeps the first grant; cor:dmo:170:03) logs `period_grant.conflict` once and is not retried this month; any other failure
 * logs `period_grant.failed` with the owner id and error code only, and the next call tries again (cor:dmo:170:09).
 *
 * Call it OUTSIDE any transaction of the caller's (A3: before the gate's own transaction): a concurrent writer of the same
 * grant makes the insert raise a unique violation, which would abort the caller's transaction even though the replay that
 * follows succeeds. Inside one, use {@link periodGrantDue} instead.
 *
 * Whoever may read the owner's balance may cause the write; the entry is recorded as {@link PERIOD_GRANT_ACTOR}, never the
 * reader. The caller must not call it for an impersonated (read-only) session (cor:dmo:170:12 S4).
 */
export async function ensurePeriodGrant(db: PrismaClient, owner: OwnerRef, now: Date): Promise<void> {
  const amount = ownerDefaultMonthlyGrant()[ownerType(owner)];
  if (amount <= 0n) return;
  const key = doneKey(owner, utcMonth(now));
  if (done.has(key)) return;
  const conflict = () => {
    done.add(key);
    console.error('period_grant.conflict', { ownerType: ownerType(owner), ...logOwner(owner) });
  };
  try {
    // Not cached as done: a deleted owner reaches this only through an admin's read, which is rare.
    if (await ownerDeleted(db, owner)) return;
    const stored = await storedGrant(db, owner, now);
    if (stored) {
      if (sameOwner(stored, owner) && stored.amountMicroCents === amount && stored.kind === 'grant') done.add(key);
      else conflict();
      return;
    }
    await writer(db, {
      owner,
      amountMicroCents: amount,
      expiresAt: nextUtcMonthStart(now),
      sourceType: PERIOD_GRANT_SOURCE_TYPE,
      sourceId: periodGrantSourceId(owner, now),
      note: null,
      createdBy: PERIOD_GRANT_ACTOR,
      // Dated at the read's instant, so that read's replay (createdAt <= now) lists it under `expiring` (QA P3 on #5317).
      createdAt: now,
    });
    done.add(key);
  } catch (err) {
    if (err instanceof IdempotencyConflictError) {
      conflict();
      return;
    }
    // #5352: the owner was deleted between the check above and the append, which refused and wrote nothing. Not a failure to
    // retry, and not cached as done (as the deleted-owner return above).
    if (err instanceof LedgerOwnerDeletedError) return;
    console.error('period_grant.failed', { ...logOwner(owner), code: safeErrorCode(err) });
  }
}

/**
 * What {@link ensurePeriodGrant} would add for `owner` in `now`'s month, without writing (gate ruling 9a): the owner type's
 * amount while the month's grant is absent, else zero. One indexed read; safe inside a transaction. Every path that may not
 * write (an impersonated read, A3's check inside a caller's transaction) adds it, so it answers what the next writing read
 * would. A stored entry with the pair counts as the grant whatever its amount: the owner keeps the first grant of the month.
 */
export async function periodGrantDue(db: PrismaClient | Prisma.TransactionClient, owner: OwnerRef, now: Date): Promise<bigint> {
  const amount = ownerDefaultMonthlyGrant()[ownerType(owner)];
  if (amount <= 0n) return 0n;
  if (await ownerDeleted(db as PrismaClient, owner)) return 0n;
  return (await storedGrant(db as PrismaClient, owner, now)) ? 0n : amount;
}
