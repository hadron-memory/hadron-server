// Metering resolvers — ModelPrice rates + the org credit ledger (spec 046,
// AI-credit billing Phase 0). Rates and grants are PLATFORM-ADMIN writes:
// an org admin must never set the prices they are billed at, and grantCredits
// is minting money — the org-ADMIN bar of setQuotaLimit does NOT carry over
// (self-grant risk). Ledger reads are org-ADMIN (requireOrgRole).
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
  clearPriceCache,
  creditBalance,
  grantCredits,
  InvalidLedgerAmountError,
} from '../../../lib/metering/index.js';
import type { CreditLedgerEntry, ModelPrice } from '../../../generated/prisma/index.js';

const badInput = (message: string) =>
  new GraphQLError(message, { extensions: { code: 'BAD_USER_INPUT' } });

const forbidden = () => new GraphQLError('Forbidden', { extensions: { code: 'FORBIDDEN' } });

/**
 * Parse a GraphQL String money field into non-negative bigint micro-cents.
 * BigInt travels as String on this schema (no custom scalar — plan §GraphQL);
 * rejects anything that isn't a plain base-10 integer.
 */
function parseMicroCents(raw: string, field: string): bigint {
  if (!/^\d+$/.test(raw)) {
    throw badInput(`${field} must be a base-10 integer string of micro-cents.`);
  }
  return BigInt(raw);
}

/** GraphQL projection — bigint stringified, dates ISO. */
function projectPrice(p: ModelPrice) {
  return {
    id: p.id,
    provider: p.provider,
    model: p.model,
    inputMicroCentsPerMTok: p.inputMicroCentsPerMTok.toString(),
    outputMicroCentsPerMTok: p.outputMicroCentsPerMTok.toString(),
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
  modelPrice: async (_: unknown, { ref }: { ref: string }, ctx: Context) => {
    if (!ctx.userId && !ctx.appId) throw forbidden();
    const row = await ctx.db.modelPrice.findUnique({ where: { id: ref } });
    return row ? projectPrice(row) : null;
  },

  /**
   * Uniform list (cor:api:120): all price rows, newest effective first,
   * optionally filtered by provider/model. Authenticated read.
   */
  modelPrices: async (
    _: unknown,
    {
      provider,
      model,
      limit,
      offset,
    }: { provider?: string | null; model?: string | null; limit?: number | null; offset?: number | null },
    ctx: Context,
  ) => {
    if (!ctx.userId && !ctx.appId) throw forbidden();
    const where = {
      ...(provider ? { provider } : {}),
      ...(model ? { model } : {}),
    };
    const [items, total] = await Promise.all([
      ctx.db.modelPrice.findMany({
        where,
        orderBy: [{ provider: 'asc' }, { model: 'asc' }, { effectiveAt: 'desc' }],
        take: clampListTake(limit),
        skip: Math.max(0, offset ?? 0),
      }),
      ctx.db.modelPrice.count({ where }),
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
    const where = { organizationId: orgId };
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
   * Append a price row for (provider, model) effective at `effectiveAt`
   * (default now). Platform admin only. Appends — never mutates an existing
   * row (FR-002/003: historical costs stay auditable); re-posting the same
   * (provider, model, effectiveAt) is a unique violation surfaced as
   * BAD_USER_INPUT.
   */
  setModelPrice: async (
    _: unknown,
    {
      input,
    }: {
      input: {
        provider: string;
        model: string;
        inputMicroCentsPerMTok: string;
        outputMicroCentsPerMTok: string;
        effectiveAt?: string | null;
      };
    },
    ctx: Context,
  ) => {
    if (!isPlatformAdmin(ctx)) throw forbidden();
    const provider = input.provider.trim();
    const model = input.model.trim();
    if (!provider || !model) throw badInput('provider and model are required.');
    const effectiveAt = input.effectiveAt ? new Date(input.effectiveAt) : new Date();
    if (Number.isNaN(effectiveAt.getTime())) throw badInput('effectiveAt is not a valid date.');
    let row: ModelPrice;
    try {
      row = await ctx.db.modelPrice.create({
        data: {
          id: generateId(),
          provider,
          model,
          inputMicroCentsPerMTok: parseMicroCents(input.inputMicroCentsPerMTok, 'inputMicroCentsPerMTok'),
          outputMicroCentsPerMTok: parseMicroCents(input.outputMicroCentsPerMTok, 'outputMicroCentsPerMTok'),
          effectiveAt,
          createdBy: ctx.userId ?? null,
        },
      });
    } catch (err) {
      if ((err as { code?: string }).code === 'P2002') {
        throw badInput(
          `A price for ${provider}/${model} at ${effectiveAt.toISOString()} already exists — post a new effectiveAt.`,
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
   * this creates money; org admins must not self-grant. Payment-processor
   * top-ups land here in a later phase with sourceType 'payment'.
   */
  grantCredits: async (
    _: unknown,
    {
      input,
    }: {
      input: { orgRef: string; amountMicroCents: string; expiresAt?: string | null; note?: string | null };
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
    try {
      const entry = await grantCredits(ctx.db, {
        organizationId: orgId,
        amountMicroCents: amount,
        expiresAt,
        note: input.note ?? null,
        createdBy: ctx.userId ?? null,
      });
      return projectLedgerEntry(entry);
    } catch (err) {
      if (err instanceof InvalidLedgerAmountError) throw badInput(err.message);
      throw err;
    }
  },
};
