// Metering resolvers — AiModelPrice rates + the org credit ledger (spec 046,
// AI-credit billing Phase 0). Rates, grants and adjustments (#5007) are
// PLATFORM-ADMIN writes: an org admin must never set the prices they are billed
// at, and grantCredits / adjustCredits move money — the org-ADMIN bar of
// setQuotaLimit does NOT carry over (self-grant risk). Ledger reads are
// org-ADMIN (requireOrgRole).
import { GraphQLError } from 'graphql';
import {
  type Context,
  clampListTake,
  isPlatformAdmin,
  requireOrgRole,
  toISO,
} from './resolvers.helpers.js';
import { resolveOrgRef } from '../../../lib/entityRef/orgRef.js';
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

  /** Org balance = SUM over the append-only ledger. Org-ADMIN. */
  creditBalance: async (_: unknown, { orgRef }: { orgRef: string }, ctx: Context) => {
    const { id: orgId } = await resolveOrgRef(ctx.db, orgRef);
    await requireOrgRole(ctx, orgId, 'ADMIN');
    const balance = await creditBalance(ctx.db, orgId);
    return { organizationId: orgId, balanceMicroCents: balance.toString() };
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
    if (!isPlatformAdmin(ctx)) throw forbidden();
    const { id: orgId } = await resolveOrgRef(ctx.db, input.orgRef);
    const amount = parseMicroCents(input.amountMicroCents, 'amountMicroCents');
    const expiresAt = input.expiresAt ? new Date(input.expiresAt) : null;
    if (expiresAt && Number.isNaN(expiresAt.getTime())) {
      throw badInput('expiresAt is not a valid date.');
    }
    refuseServerWrittenSource(input.sourceType);
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
    if (!isPlatformAdmin(ctx)) throw forbidden();
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
