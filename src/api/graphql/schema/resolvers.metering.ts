// Metering resolvers — AiModelPrice rates + the org credit ledger (spec 046,
// AI-credit billing Phase 0). Rates, grants and adjustments (#5007) are
// PLATFORM-ADMIN writes: an org admin must never set the prices they are billed
// at, and grantCredits / adjustCredits move money — the org-ADMIN bar of
// setQuotaLimit does NOT carry over (self-grant risk). The two ledger writes also
// admit the BILLING platform role (#5012, mayWriteLedger); rates do not. Ledger
// reads are org-ADMIN (requireOrgRole).
import { GraphQLError } from 'graphql';
import {
  type Context,
  clampListTake,
  isPlatformAdmin,
  mayWriteLedger,
  requireOrgRole,
  toISO,
} from './resolvers.helpers.js';
import { resolveOrgRef } from '../../../lib/entityRef/orgRef.js';
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
  PRICE_CACHE_TTL_MS,
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
  settleExpiredGrants,
  unsettledRemainders,
} from '../../../lib/metering/settleExpiredGrants.js';
import { isReadOnlyImpersonation } from '../impersonationReadOnlyPlugin.js';
import { safeErrorCode } from '../../../lib/secrets/autoDelete.js';
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

  /** Org ledger page, newest first. Org-ADMIN (or platform admin). */
  creditLedgerEntries: async (
    _: unknown,
    { orgRef, limit, offset }: { orgRef: string; limit?: number | null; offset?: number | null },
    ctx: Context,
  ) => {
    const { id: orgId } = await resolveOrgRef(ctx.db, orgRef);
    await requireOrgRole(ctx, orgId, 'ADMIN');
    const where = { organizationId: orgId, deletedAt: null };
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
   * Org balance. Org-ADMIN (the one gate; A6 widens it). #5011 (Billing A4,
   * hrn:node:hadronmemory.com:specs:cor:dmo:170:10): the owner's expired grants are settled FIRST (written entries,
   * once each), then the stored sum is read, less what is left of any grant whose expiry has passed and is not yet
   * settled (inside the 60 s of ruling 10.1), so no answer ever includes expired credit (ruling 10.7). An impersonated
   * session writes nothing (the impersonation plugin blocks mutations, not a query that writes) and gets the same
   * figure, worked out. A settlement that fails logs one line (organization id, error code) and the read answers the
   * computed figure (ruling 10.4); the hourly job retries.
   */
  creditBalance: async (_: unknown, { orgRef }: { orgRef: string }, ctx: Context) => {
    const { id: orgId } = await resolveOrgRef(ctx.db, orgRef);
    await requireOrgRole(ctx, orgId, 'ADMIN');
    const owner = { organizationId: orgId };
    const asOf = await databaseNow(ctx.db);
    if (!isReadOnlyImpersonation(ctx)) {
      try {
        await settleExpiredGrants(ctx.db, owner, { now: asOf });
      } catch (err) {
        console.error('credit_expiry.settle_failed', { organizationId: orgId, code: safeErrorCode(err) });
      }
    }
    const sum = await creditBalance(ctx.db, orgId);
    const unsettled = await unsettledRemainders(ctx.db, owner, asOf);
    return { organizationId: orgId, balanceMicroCents: (sum - unsettled).toString(), asOf };
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
    // #5021 (hrn:node:hadronmemory.com:specs:cor:dmo:170:06): a row may not take effect in the past, which would
    // change which row covers units already recorded, nor before every process's price cache has had one lifetime
    // to expire (or learn the new row's instant), so it takes effect everywhere at once. An omitted date is the
    // earliest allowed instant. The text is read by the strict ISO rule (gate ruling 7, #5008's rule).
    const earliest = new Date(Date.now() + PRICE_CACHE_TTL_MS);
    let effectiveAt = earliest;
    if (input.effectiveAt != null) {
      const parsed = parseSpendInstant(input.effectiveAt);
      if (!parsed) throw badInput('effectiveAt must be an ISO 8601 date or date-time, for example 2026-12-01T00:00:00Z.');
      if (parsed.getTime() < earliest.getTime()) {
        throw badInput(
          `effectiveAt must be at least ${PRICE_CACHE_TTL_MS / 1000} seconds from now (not before ${earliest.toISOString()}): a price takes effect only once every server can apply it, and never in the past. Leave it out for the earliest allowed time.`,
        );
      }
      effectiveAt = parsed;
    }
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
    // #5021: no longer needed for correctness (the lead and the next-row expiry switch every process at the
    // effective instant); dropping this process's cache just makes it look the new row up on its next unit.
    clearPriceCache();
    return projectPrice(row);
  },

  /**
   * Mint credits for an org (positive `grant` row). PLATFORM ADMIN ONLY —
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
        orgRef: string;
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
    const { id: orgId } = await resolveOrgRef(ctx.db, input.orgRef);
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
        organizationId: orgId,
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
   * Write a signed correction on an org's ledger (an `adjustment` row), such as
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
        orgRef: string;
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
    const { id: orgId } = await resolveOrgRef(ctx.db, input.orgRef);
    const amount = parseSignedMicroCents(input.amountMicroCents, 'amountMicroCents');
    refuseServerWrittenSource(input.sourceType);
    try {
      const entry = await adjustCredits(ctx.db, {
        organizationId: orgId,
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
      parent: { organizationId: string; asOf: Date },
      _: unknown,
      ctx: Context,
    ) => {
      const parts = await expiringCredit(ctx.db, { organizationId: parent.organizationId }, parent.asOf);
      return parts.map((p) => ({ amountMicroCents: p.remaining.toString(), expiresAt: p.expiresAt.toISOString() }));
    },
  },
};
