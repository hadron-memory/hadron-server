// Metering resolvers — AiModelPrice rates + the org credit ledger (spec 046,
// AI-credit billing Phase 0). Rates, grants and adjustments (#5007) are
// PLATFORM-ADMIN writes: an org admin must never set the prices they are billed
// at, and grantCredits / adjustCredits move money — the org-ADMIN bar of
// setQuotaLimit does NOT carry over (self-grant risk). The two ledger writes also
// admit the BILLING platform role (#5012, mayWriteLedger); rates do not. Ledger
// reads are org-ADMIN (requireOrgRole). Since #5014 every ledger call takes `orgRef` OR `userRef`: a person has a ledger
// too, read by that person or a platform admin (requirePersonRecordRead) and written by the same writers.
import { GraphQLError } from 'graphql';
import {
  type Context,
  clampListTake,
  isPlatformAdmin,
  mayWriteLedger,
  requireOrgRole,
  requirePersonRecordRead,
  toISO,
} from './resolvers.helpers.js';
import { resolveOrgRef } from '../../../lib/entityRef/orgRef.js';
import { resolveUserRef } from '../../../lib/entityRef/userRef.js';
import { repointMergedLedgerOwners } from '../../../lib/metering/repointMergedOwners.js';
import { ownerWhere, type OwnerRef } from '../../../lib/owner.js';
import { OrganizationNotFoundError } from '../../../lib/entityRef/errors.js';
import { authorizationDenied } from '../../../lib/auth/authorizationDenied.js';
import { generateId } from '../../../lib/id.js';
import {
  adjustCredits,
  clearPriceCache,
  creditBalance,
  grantCredits,
  HOST_PRICED_PROVIDERS,
  IdempotencyConflictError,
  InvalidLedgerAmountError,
  isServerWrittenSourceType,
  LEDGER_SOURCE_CONFLICT_MESSAGE,
  PRICE_TIER_DEFAULT,
  PRICE_TIER_MAX,
  PRICE_TIER_MIN,
} from '../../../lib/metering/index.js';
import {
  AI_SPEND_MAX_DAYS,
  aiSpendSummary,
  parseSpendInstant,
  type AiSpendGroup,
} from '../../../lib/metering/spend.js';
import {
  databaseNow,
  expiringCredit,
  settleAndMeasure,
  type CreditMeasure,
} from '../../../lib/metering/settleExpiredGrants.js';
import type { ReplayResult } from '../../../lib/metering/expiry.js';
import { isReadOnlyImpersonation } from '../impersonationReadOnlyPlugin.js';
import { safeErrorCode } from '../../../lib/safeErrorCode.js';
import type { CreditLedgerEntry, AiModelPrice } from '../../../generated/prisma/index.js';

const badInput = (message: string) =>
  new GraphQLError(message, { extensions: { code: 'BAD_USER_INPUT' } });

const forbidden = () => new GraphQLError('Forbidden', { extensions: { code: 'FORBIDDEN' } });

/** The Postgres int8 range every money column is stored in. */
const INT8_MIN = -(2n ** 63n);
const INT8_MAX = 2n ** 63n - 1n;

/**
 * Parse a GraphQL String money field into non-negative bigint micro-cents.
 * BigInt travels as String on this schema (no custom scalar — plan §GraphQL);
 * rejects anything that isn't a plain base-10 integer, or that falls outside
 * int8 (#5007: an out-of-range value used to reach Prisma and surface as a
 * concealed INTERNAL_SERVER_ERROR).
 */
function parseMicroCents(raw: string, field: string): bigint {
  if (!/^\d+$/.test(raw)) {
    throw badInput(`${field} must be a base-10 integer string of micro-cents.`);
  }
  const value = BigInt(raw);
  if (value > INT8_MAX) throw badInput(`${field} is out of range.`);
  return value;
}

/**
 * The signed counterpart for adjustments (#5007): an optional leading minus,
 * base-10 digits, within int8. No plus sign, no fraction, no exponent.
 */
function parseSignedMicroCents(raw: string, field: string): bigint {
  if (!/^-?\d+$/.test(raw)) {
    throw badInput(`${field} must be a signed base-10 integer string of micro-cents.`);
  }
  const value = BigInt(raw);
  if (value < INT8_MIN || value > INT8_MAX) throw badInput(`${field} is out of range.`);
  return value;
}

/**
 * The mutation-level source rule shared by grantCredits and adjustCredits
 * (#5007 ruling 3): never a type the server writes itself, matched trimmed and
 * case-insensitively. Judged before the write. A missing or blank pair, a zero
 * amount and a blank note are the library's refusals (also judged before its
 * insert, mapped to BAD_USER_INPUT by {@link ledgerRefusal}), kept in ONE layer
 * so each guard has a single place a test can see it fail.
 */
function refuseServerWrittenSource(sourceType: string | null | undefined): void {
  if (sourceType != null && isServerWrittenSourceType(sourceType)) {
    throw badInput('sourceType names a source type the server writes itself.');
  }
}

/**
 * #5014: the account a ledger call names, from exactly one of `orgRef` and `userRef`. Both or neither is BAD_USER_INPUT,
 * judged before any lookup. `read` applies the read gate of the named kind (an organization's ADMIN or a platform admin,
 * unchanged; a person themselves or a platform admin, {@link requirePersonRecordRead}); `write` resolves only, because
 * the write gate ({@link mayWriteLedger}) is the caller's first act and is the same for both kinds. A soft-deleted person
 * is not found by a write (resolveUserRef excludes them), so nothing is granted to an erased account.
 */
async function resolveLedgerOwner(
  ctx: Context,
  refs: { orgRef?: string | null; userRef?: string | null },
  mode: 'read' | 'write',
): Promise<OwnerRef> {
  const hasOrg = refs.orgRef != null;
  const hasUser = refs.userRef != null;
  if (hasOrg === hasUser) throw badInput('Give exactly one of orgRef and userRef.');
  if (hasOrg) {
    const { id: organizationId } = await resolveOrgRef(ctx.db, refs.orgRef!);
    if (mode === 'read') await requireOrgRole(ctx, organizationId, 'ADMIN');
    return { organizationId };
  }
  if (mode === 'read') return { userId: await requirePersonRecordRead(ctx, refs.userRef!) };
  const { id: userId } = await resolveUserRef(ctx.db, refs.userRef!);
  return { userId };
}

/** Map the ledger library's typed refusals; anything else propagates. */
function ledgerRefusal(err: unknown): never {
  if (err instanceof InvalidLedgerAmountError) throw badInput(err.message);
  // Mismatched replay of an existing (sourceType, sourceId): a typed,
  // NON-retryable error. The caller (a payment service) must stop redelivering
  // and reconcile manually (PR-624 review, Gemini high). One fixed sentence,
  // nothing about the stored entry (#5007 ruling 4).
  if (err instanceof IdempotencyConflictError) {
    throw new GraphQLError(LEDGER_SOURCE_CONFLICT_MESSAGE, {
      extensions: { code: 'IDEMPOTENCY_CONFLICT' },
    });
  }
  throw err;
}

/** GraphQL projection — bigint stringified, dates ISO. */
function projectPrice(p: AiModelPrice) {
  return {
    id: p.id,
    provider: p.provider,
    model: p.model,
    tier: p.tier,
    inputMicroCentsPerMTok: p.inputMicroCentsPerMTok.toString(),
    outputMicroCentsPerMTok: p.outputMicroCentsPerMTok.toString(),
    markupBasisPoints: p.markupBasisPoints,
    effectiveAt: toISO(p.effectiveAt),
    createdAt: toISO(p.createdAt),
    createdBy: p.createdBy,
  };
}

/** GraphQL projection — scalars only (the #552 nested-field-leak invariant). */
function projectLedgerEntry(e: CreditLedgerEntry) {
  return {
    id: e.id,
    organizationId: e.organizationId,
    ownerUserId: e.ownerUserId,
    kind: e.kind,
    amountMicroCents: e.amountMicroCents.toString(),
    expiresAt: toISO(e.expiresAt),
    sourceType: e.sourceType,
    sourceId: e.sourceId,
    note: e.note,
    createdAt: toISO(e.createdAt),
    createdBy: e.createdBy,
  };
}

export const meteringQueries = {
  /** One price row by id. Authenticated read — rates are not a secret. */
  aiModelPrice: async (_: unknown, { ref }: { ref: string }, ctx: Context) => {
    if (!ctx.userId && !ctx.appId) throw forbidden();
    const row = await ctx.db.aiModelPrice.findFirst({ where: { id: ref, deletedAt: null } });
    return row ? projectPrice(row) : null;
  },

  /**
   * Uniform list (cor:api:120): all price rows, newest effective first,
   * optionally filtered by provider/model/tier. Authenticated read.
   */
  aiModelPrices: async (
    _: unknown,
    {
      provider,
      model,
      tier,
      limit,
      offset,
    }: {
      provider?: string | null;
      model?: string | null;
      tier?: number | null;
      limit?: number | null;
      offset?: number | null;
    },
    ctx: Context,
  ) => {
    if (!ctx.userId && !ctx.appId) throw forbidden();
    const where = {
      deletedAt: null,
      ...(provider ? { provider } : {}),
      ...(model ? { model } : {}),
      ...(tier != null ? { tier } : {}),
    };
    const [items, total] = await Promise.all([
      ctx.db.aiModelPrice.findMany({
        where,
        orderBy: [{ provider: 'asc' }, { model: 'asc' }, { tier: 'asc' }, { effectiveAt: 'desc' }],
        take: clampListTake(limit),
        skip: Math.max(0, offset ?? 0),
      }),
      ctx.db.aiModelPrice.count({ where }),
    ]);
    return { items: items.map(projectPrice), total };
  },

  /**
   * An account's ledger page, newest first: an organization's (org-ADMIN or platform admin) or a person's (that person
   * or a platform admin; #5014).
   */
  creditLedgerEntries: async (
    _: unknown,
    { orgRef, userRef, limit, offset }: { orgRef?: string | null; userRef?: string | null; limit?: number | null; offset?: number | null },
    ctx: Context,
  ) => {
    const owner = await resolveLedgerOwner(ctx, { orgRef, userRef }, 'read');
    const where = { ...ownerWhere(owner), deletedAt: null };
    const [items, total] = await Promise.all([
      ctx.db.creditLedgerEntry.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: clampListTake(limit),
        skip: Math.max(0, offset ?? 0),
      }),
      ctx.db.creditLedgerEntry.count({ where }),
    ]);
    return { items: items.map(projectLedgerEntry), total };
  },

  /**
   * An account's balance: an organization's or a person's, gated as {@link creditLedgerEntries}. #5011 (Billing A4,
   * hrn:node:hadronmemory.com:specs:cor:dmo:170:10): the owner's expired grants are settled FIRST (written entries,
   * once each), then the stored sum is read, less what is left of any grant whose expiry has passed and is not yet
   * settled (inside the 60 s of ruling 10.1), so no answer ever includes expired credit (ruling 10.7). An impersonated
   * session writes nothing (the impersonation plugin blocks mutations, not a query that writes) and gets the same
   * figure, worked out. A settlement that fails logs one line (owner id, error code) and the read answers the
   * computed figure (ruling 10.4); the hourly job retries. #5014: the same for a person's ledger.
   */
  creditBalance: async (_: unknown, { orgRef, userRef }: { orgRef?: string | null; userRef?: string | null }, ctx: Context) => {
    const owner = await resolveLedgerOwner(ctx, { orgRef, userRef }, 'read');
    const asOf = await databaseNow(ctx.db);
    // One probe and at most one replay (#5100 items 2, 8): what is settled, what stays unsettled and the `expiring` list all
    // come from that one read, and the probe, the replay, any settlement written and the stored sum are taken in ONE
    // REPEATABLE READ snapshot, for the writing read and the read that writes nothing alike (#5242 item 2): a settlement the
    // sweep commits meanwhile is then in neither or in both of the replay and the sum, never counted twice. A writing read
    // that fails (a serialization failure with a concurrent settler included) logs one line and answers from the read-only
    // snapshot (ruling 10.4).
    const snapshot = (write: boolean): Promise<{ measure: CreditMeasure; sum: bigint }> =>
      ctx.db.$transaction(
        async (tx) => {
          const m = await settleAndMeasure(tx as unknown as typeof ctx.db, owner, asOf, { write });
          return { measure: m, sum: await creditBalance(tx as unknown as typeof ctx.db, owner) };
        },
        { isolationLevel: 'RepeatableRead' },
      );
    let measure: CreditMeasure;
    let sum: bigint;
    if (isReadOnlyImpersonation(ctx)) {
      ({ measure, sum } = await snapshot(false));
    } else {
      try {
        // #5014 (local review P2): first bring in any entry still named by a person merged into this one, so the figure
        // and the settlement below see the whole ledger whatever the interleaving of a merge and a write.
        if ('userId' in owner) await repointMergedLedgerOwners(ctx.db, { survivor: owner.userId });
        // #5014 (the #5221 carry, #5242 item 2): the probe, the replay, any settlement written and the stored sum in ONE snapshot.
        ({ measure, sum } = await snapshot(true));
      } catch (err) {
        console.error('credit_expiry.settle_failed', {
          ...('organizationId' in owner ? { organizationId: owner.organizationId } : { ownerUserId: owner.userId }),
          code: safeErrorCode(err),
        });
        ({ measure, sum } = await snapshot(false));
      }
    }
    return {
      organizationId: 'organizationId' in owner ? owner.organizationId : null,
      ownerUserId: 'userId' in owner ? owner.userId : null,
      balanceMicroCents: (sum - measure.unsettled).toString(),
      asOf,
      replay: measure.replay,
    };
  },

  /**
   * #5008 (Billing A2): the organization's AI spend for [from, to), one grouping. Org-ADMIN, the gate of `creditBalance`
   * and answered first, so a caller who may not read gets FORBIDDEN whatever the range says. Rows are scalars: `APP` keys
   * are ids, never an App object (cor:dmo:170:04 keeps cost and charge apart; see the SDL).
   */
  aiSpend: async (
    _: unknown,
    { orgRef, from, to, groupBy }: { orgRef: string; from: string; to: string; groupBy: AiSpendGroup },
    ctx: Context,
  ) => {
    // A reference that names no organization answers the denial any non-admin gets for an existing one, so the
    // refusal does not tell which organizations exist (and echoes nothing of the ref). A platform admin passes
    // the gate for every organization, so for them nothing is concealed and the not-found stays. Only the RESPONSE is
    // equalised, not the work: a missing organization skips the membership lookup an existing one runs, so a timing
    // difference remains. That is not a secret kept: organizations are listable (the #5008 issue), and the refusal is
    // identical so this surface does not read as an existence oracle. An App key (no user) is denied by
    // requireOrgRole with the same authorizationDenied(), so it gets the same answer for either.
    let orgId: string;
    try {
      ({ id: orgId } = await resolveOrgRef(ctx.db, orgRef));
    } catch (e) {
      if (e instanceof OrganizationNotFoundError && !isPlatformAdmin(ctx)) throw authorizationDenied();
      throw e;
    }
    await requireOrgRole(ctx, orgId, 'ADMIN');
    const fromAt = parseSpendInstant(from);
    const toAt = parseSpendInstant(to);
    if (!fromAt || !toAt) throw badInput('from and to must be ISO 8601 dates or date-times (a value with no offset is UTC).');
    if (fromAt.getTime() >= toAt.getTime()) throw badInput('from must be before to.');
    if (toAt.getTime() - fromAt.getTime() > AI_SPEND_MAX_DAYS * 86_400_000) {
      throw badInput(`The range may span at most ${AI_SPEND_MAX_DAYS} days.`);
    }
    const summary = await aiSpendSummary(ctx.db, { organizationId: orgId, from: fromAt, to: toAt, groupBy });
    return { from: fromAt.toISOString(), to: toAt.toISOString(), ...summary };
  },
};

export const meteringMutations = {
  /**
   * Append a price row for (provider, model, tier) effective at `effectiveAt`
   * (default now; tier default 1). Platform admin only. Appends — never
   * mutates an existing row (FR-002/003: historical costs stay auditable);
   * re-posting the same (provider, model, tier, effectiveAt) is a unique
   * violation surfaced as BAD_USER_INPUT. `markupBasisPoints` (2500 = 25%)
   * is the per-tier debit markup; NULL falls back to CREDIT_MARKUP_PERCENT.
   */
  setAiModelPrice: async (
    _: unknown,
    {
      input,
    }: {
      input: {
        provider: string;
        model: string;
        tier?: number | null;
        inputMicroCentsPerMTok: string;
        outputMicroCentsPerMTok: string;
        markupBasisPoints?: number | null;
        effectiveAt?: string | null;
      };
    },
    ctx: Context,
  ) => {
    if (!isPlatformAdmin(ctx)) throw forbidden();
    const provider = input.provider.trim();
    const model = input.model.trim();
    if (!provider || !model) throw badInput('provider and model are required.');
    // A price that metering would never read: `openai-compatible` spend is
    // recorded unpriced until prices can name the serving host (#1389 review).
    if (HOST_PRICED_PROVIDERS.has(provider)) {
      throw badInput(`"${provider}" is priced by the host that serves it, which a price row cannot name yet; its usage is recorded unpriced.`);
    }
    const tier = input.tier ?? PRICE_TIER_DEFAULT;
    if (!Number.isInteger(tier) || tier < PRICE_TIER_MIN || tier > PRICE_TIER_MAX) {
      throw badInput(`tier must be an integer ${PRICE_TIER_MIN}-${PRICE_TIER_MAX}.`);
    }
    const markupBasisPoints = input.markupBasisPoints ?? null;
    if (markupBasisPoints != null && (!Number.isInteger(markupBasisPoints) || markupBasisPoints < 0)) {
      throw badInput('markupBasisPoints must be a non-negative integer (2500 = 25%).');
    }
    const effectiveAt = input.effectiveAt ? new Date(input.effectiveAt) : new Date();
    if (Number.isNaN(effectiveAt.getTime())) throw badInput('effectiveAt is not a valid date.');
    let row: AiModelPrice;
    try {
      row = await ctx.db.aiModelPrice.create({
        data: {
          id: generateId(),
          provider,
          model,
          tier,
          inputMicroCentsPerMTok: parseMicroCents(input.inputMicroCentsPerMTok, 'inputMicroCentsPerMTok'),
          outputMicroCentsPerMTok: parseMicroCents(input.outputMicroCentsPerMTok, 'outputMicroCentsPerMTok'),
          markupBasisPoints,
          effectiveAt,
          createdBy: ctx.userId ?? null,
        },
      });
    } catch (err) {
      if ((err as { code?: string }).code === 'P2002') {
        throw badInput(
          `A price for ${provider}/${model} tier ${tier} at ${effectiveAt.toISOString()} already exists — post a new effectiveAt.`,
        );
      }
      throw err;
    }
    // The hot-path cache may hold the now-superseded row for up to its TTL;
    // drop it so new events price correctly right away.
    clearPriceCache();
    return projectPrice(row);
  },

  /**
   * Mint credits for an organization or a person (positive `grant` row). PLATFORM ADMIN ONLY —
   * this creates money; org admins must not self-grant. Top-ups from a payment
   * service land here with sourceType 'stripe-checkout' + the Checkout session
   * id: (sourceType, sourceId) is ledger-unique and the mutation is IDEMPOTENT
   * on it — a webhook redelivery returns the existing grant instead of
   * double-crediting. Since #5007 the pair is required, and the source types
   * the server writes itself are refused.
   */
  grantCredits: async (
    _: unknown,
    {
      input,
    }: {
      input: {
        orgRef?: string | null;
        userRef?: string | null;
        amountMicroCents: string;
        expiresAt?: string | null;
        sourceType?: string | null;
        sourceId?: string | null;
        note?: string | null;
      };
    },
    ctx: Context,
  ) => {
    // #5012: a platform admin or the BILLING role (mayWriteLedger), judged before the organization resolves.
    if (!mayWriteLedger(ctx)) throw forbidden();
    const owner = await resolveLedgerOwner(ctx, input, 'write');
    const amount = parseMicroCents(input.amountMicroCents, 'amountMicroCents');
    const expiresAt = input.expiresAt ? new Date(input.expiresAt) : null;
    if (expiresAt && Number.isNaN(expiresAt.getTime())) {
      throw badInput('expiresAt is not a valid date.');
    }
    refuseServerWrittenSource(input.sourceType);
    // #5011 ruling 10.3: a grant already expired would be settled at once for its full amount. Judged on the
    // database clock, before the write.
    if (expiresAt && expiresAt.getTime() <= (await databaseNow(ctx.db)).getTime()) {
      throw badInput('expiresAt must be later than now.');
    }
    try {
      const entry = await grantCredits(ctx.db, {
        owner,
        amountMicroCents: amount,
        expiresAt,
        // Missing reaches the library as blank, which refuses it (#5007 ruling 1).
        sourceType: input.sourceType ?? '',
        sourceId: input.sourceId ?? '',
        note: input.note ?? null,
        createdBy: ctx.userId ?? null,
      });
      return projectLedgerEntry(entry);
    } catch (err) {
      ledgerRefusal(err);
    }
  },

  /**
   * Write a signed correction on an organization's or a person's ledger (an `adjustment` row), such as
   * a refund (#5007; hrn:node:hadronmemory.com:specs:cor:dmo:170:03). A
   * correction is a new entry, never an edit
   * (hrn:node:hadronmemory.com:specs:cor:dmo:170:08). PLATFORM ADMIN ONLY, the
   * same single gate as grantCredits (A5 widens both). Every refusal is judged
   * before the write: a signed int8 amount here, a server-written source type
   * here, and a zero amount, a blank source half or a blank note in the
   * library before its insert. Idempotent on the pair
   * exactly as grantCredits is, kind included.
   */
  adjustCredits: async (
    _: unknown,
    {
      input,
    }: {
      input: {
        orgRef?: string | null;
        userRef?: string | null;
        amountMicroCents: string;
        sourceType: string;
        sourceId: string;
        note: string;
      };
    },
    ctx: Context,
  ) => {
    // #5012: a platform admin or the BILLING role (mayWriteLedger), judged before the organization resolves.
    if (!mayWriteLedger(ctx)) throw forbidden();
    const owner = await resolveLedgerOwner(ctx, input, 'write');
    const amount = parseSignedMicroCents(input.amountMicroCents, 'amountMicroCents');
    refuseServerWrittenSource(input.sourceType);
    try {
      const entry = await adjustCredits(ctx.db, {
        owner,
        amountMicroCents: amount,
        sourceType: input.sourceType,
        sourceId: input.sourceId,
        note: input.note,
        createdBy: ctx.userId ?? null,
      });
      return projectLedgerEntry(entry);
    } catch (err) {
      ledgerRefusal(err);
    }
  },
};

/**
 * #5011 (Billing A4): what is left of each unexpired expiring grant, soonest first, at the instant the parent read
 * settled and summed (`asOf`). Runs the replay only when the field is selected; the parent query already passed the
 * org-ADMIN gate, and the field reads only that organization's ledger.
 */
export const meteringTypeResolvers = {
  CreditBalance: {
    expiring: async (
      parent: { organizationId: string | null; ownerUserId: string | null; asOf: Date; replay?: ReplayResult | null },
      _: unknown,
      ctx: Context,
    ) => {
      // #5014: the owner the balance was read for, one column set (a person's balance has no organization).
      if (parent.ownerUserId == null && parent.organizationId == null) throw new Error('A balance names an owner.');
      const owner: OwnerRef = parent.ownerUserId != null ? { userId: parent.ownerUserId } : { organizationId: parent.organizationId as string };
      // The parent's one replay when it ran (#5100 item 2); a read whose probe found nothing expired runs it here, once.
      const parts = parent.replay !== undefined
        ? (parent.replay?.expiring ?? [])
        : await expiringCredit(ctx.db, owner, parent.asOf);
      return parts.map((p) => ({ amountMicroCents: p.remaining.toString(), expiresAt: p.expiresAt.toISOString() }));
    },
  },
};
