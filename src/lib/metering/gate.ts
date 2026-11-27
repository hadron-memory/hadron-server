/**
 * #5023 (Billing A3): the credit gate. Work that will run on the platform's own provider key is refused BEFORE it starts when
 * the billable account has no credit left (hrn:node:hadronmemory.com:specs:cor:acl:050:05, announced by
 * hrn:node:hadronmemory.com:specs:cor:dmo:170:09: "an access control that runs before the work starts, not a step of
 * metering"). It lives here and is called from the launch and gate points, never from `recordLlmUsage` or `debitCredits`.
 *
 * Own-key work is never gated (cor:dmo:170:07: only platform-key spend is debited), embedding is never debited so never
 * stopped (cor:dmo:170:05), and work with no billable account is never debited and so never gated.
 */
import type { PrismaClient } from '../../generated/prisma/index.js';
import type { OwnerRef } from '../owner.js';
import { debitEnabled, creditBalance } from './index.js';
import { databaseNow, settleAndMeasure } from './settleExpiredGrants.js';
import { ensurePeriodGrant, periodGrantDue } from './periodGrant.js';
import { ownerId, ownerType } from '../owner.js';

/** The one refusal. Its text names no amount and no owner (cor:acl:050:05): the same words for every owner and every door. */
export const CREDITS_EXHAUSTED_MESSAGE = 'The account has no AI credit left for work on the platform\'s own AI provider.';

export class CreditsExhaustedError extends Error {
  readonly code = 'CREDITS_EXHAUSTED' as const;
  constructor() {
    super(CREDITS_EXHAUSTED_MESSAGE);
    this.name = 'CreditsExhaustedError';
  }
}

/** The deployment switch: ONLY the exact value `true`, read per call. `TRUE`, `1`, ` true` and every other value mean off. */
export function creditGateEnabled(): boolean {
  return process.env.BILLING_CREDIT_GATE_ENABLED === 'true';
}

/** The gate runs only when debits are on as well: with no debit there is nothing to run out of. One parse, shared with the debit. */
export function creditGateActive(): boolean {
  return debitEnabled() && creditGateEnabled();
}


/**
 * Gate ruling 7 (Holger, 2026-11-27: option b): reading the sum of a 100,000-entry ledger costs about 16 ms, so the gate keeps a
 * per-process MEMO of "this owner had a positive balance a moment ago". It is not a stored balance under
 * hrn:node:hadronmemory.com:specs:cor:dmo:170:08 (Holger ruled so): it is never written anywhere, it answers no read (every
 * ledger read still sums the entries), and it only shortcuts an admission for {@link CREDIT_GATE_MEMO_TTL_MS}. It is
 * positive-only: a zero or negative balance is never memoised, so every refusal reads the ledger, and a burst can overshoot
 * a positive balance by at most the window, which the ledger already allows ("the balance may go negative"). It is neither
 * read nor written inside a caller's transaction, where the gate computes every time.
 */
export const CREDIT_GATE_MEMO_TTL_MS = 5_000;
/** The most owners the memo keeps: past it the expired ones go, then all, so it cannot grow without bound. */
const MEMO_MAX = 10_000;
const positiveUntil = new Map<string, number>();
const memoKey = (owner: OwnerRef): string => `${ownerType(owner)}:${ownerId(owner)}`;

function memoRemember(owner: OwnerRef): void {
  const now = Date.now();
  if (positiveUntil.size >= MEMO_MAX) {
    for (const [k, until] of positiveUntil) if (until <= now) positiveUntil.delete(k);
    if (positiveUntil.size >= MEMO_MAX) positiveUntil.clear();
  }
  positiveUntil.set(memoKey(owner), now + CREDIT_GATE_MEMO_TTL_MS);
}

/** Tests only: forget every memo. */
export function resetCreditGateMemoForTests(): void {
  positiveUntil.clear();
}

/** Whether `db` is an interactive transaction client (it carries no `$transaction`): the gate then writes nothing. */
const inTransaction = (db: PrismaClient): boolean => typeof (db as { $transaction?: unknown }).$transaction !== 'function';

/**
 * Refuse (throw {@link CreditsExhaustedError}) when `owner`'s balance is zero or below. A null owner (work with no billable
 * account) always passes. The balance is what a read of the account computes: the stored sum less what is left of expired,
 * unsettled grants, after the month's default grant is ensured.
 *
 * Outside a transaction it settles the expired grants (A4) and ensures the month's grant (A9) first, as a balance read does,
 * so the figure it judges is stored. INSIDE a caller's transaction (`importNode(taskRef:)`, the webfetch ingress) it computes
 * and writes nothing, adding the grant that is due (gate ruling 8a): a failing statement there would abort the caller's whole
 * transaction, and A9's grant write must never run inside one.
 */
export async function requireCreditHeadroom(db: PrismaClient, owner: OwnerRef | null): Promise<void> {
  if (owner == null) return;
  const tx = inTransaction(db);
  // The memo is consulted only outside a caller's transaction, and only for an unexpired positive entry.
  if (!tx) {
    const until = positiveUntil.get(memoKey(owner));
    if (until !== undefined) {
      if (until > Date.now()) return;
      positiveUntil.delete(memoKey(owner));
    }
  }
  const now = await databaseNow(db);
  if (!tx) await ensurePeriodGrant(db, owner, now);
  const balance = tx
    ? (await creditBalance(db, owner)) - (await settleAndMeasure(db, owner, now, { write: false })).unsettled + (await periodGrantDue(db, owner, now))
    : await db.$transaction(
        async (client) => {
          const c = client as unknown as PrismaClient;
          const measure = await settleAndMeasure(c, owner, now, { write: true });
          return (await creditBalance(c, owner)) - measure.unsettled;
        },
        { isolationLevel: 'RepeatableRead' },
      );
  if (balance <= 0n) {
    positiveUntil.delete(memoKey(owner)); // a zero or negative balance is never memoised
    throw new CreditsExhaustedError();
  }
  if (!tx) memoRemember(owner);
}

/**
 * The gate for one piece of platform-key work: a no-op unless the switch is active and the key is the platform's. `ownerType`
 * is the resolved configuration's; only `HADRON_SERVER` is gated.
 */
export async function gateCredit(db: PrismaClient, ownerType: string | null | undefined, owner: OwnerRef | null): Promise<void> {
  if (!creditGateActive() || ownerType !== 'HADRON_SERVER') return;
  await requireCreditHeadroom(db, owner);
}
