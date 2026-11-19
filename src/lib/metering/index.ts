/**
 * Usage metering + credit ledger (spec 046 — AI-credit billing, Phase 0).
 *
 * The single write path for token-bearing usage events: attribution
 * (user + org), provider cost snapshot at event time (FR-003), BYOK
 * classification (FR-004), and the gated automatic debit (FR-006).
 *
 * Money units: micro-cents (1e-8 USD) throughout, as bigint. Prices are
 * micro-cents per MILLION tokens (AiModelPrice), so a $3/MTok rate is
 * 30_000_000n and a 1k-token call at that rate costs 30_000n (= $0.0003).
 *
 * Posture: metering must never fail the work it meters — tokens are
 * already spent at the provider. recordLlmUsage is throw-safe (logs and
 * returns null on internal error); the ledger primitives DO throw, since
 * their callers (GraphQL mutations) want real errors.
 */

import { attributedRequestActivity } from '../usageRecorder.js';
import { Prisma } from '../../generated/prisma/index.js';
import type { AiModelPrice, PrismaClient, UsageEvent } from '../../generated/prisma/index.js';
import type { AiConfigOwnerType } from '../aiConfig.js';
import { generateId } from '../id.js';

/** Ledger entry kinds (string column, validated here — no enum by design). */
export const LEDGER_KINDS = ['grant', 'debit', 'adjustment'] as const;
export type LedgerKind = (typeof LEDGER_KINDS)[number];

const MTOK = 1_000_000n;

// ── Env gates (read at call time so tests can flip them) ────────────────

/**
 * #1389 review: providers whose price depends on WHICH host serves them. An
 * `openai-compatible` config names its own endpoint (Together, OpenRouter, a
 * local server), and the same model id costs differently on each, while
 * `AiModelPrice` is keyed by provider/model/tier only. Until pricing can name
 * the host, such spend is recorded UNPRICED (cost NULL), so it is never debited
 * at another host's rate.
 */
export const HOST_PRICED_PROVIDERS: ReadonlySet<string> = new Set(['openai-compatible']);

/** FR-006: automatic usage debits are OFF unless explicitly enabled. */
function debitEnabled(): boolean {
  const raw = process.env.BILLING_DEBIT_ENABLED?.trim().toLowerCase();
  return raw === 'true' || raw === '1';
}

/** FR-006: markup applied to platform-key cost when debiting; default 0%. */
function markupPercent(): number {
  const raw = Number(process.env.CREDIT_MARKUP_PERCENT);
  return Number.isFinite(raw) && raw >= 0 ? raw : 0;
}

// ── Price lookup (FR-002) ────────────────────────────────────────────────

interface CachedPrice {
  row: AiModelPrice | null;
  fetchedAt: number;
}

const PRICE_CACHE_TTL_MS = 60_000;
const priceCache = new Map<string, CachedPrice>();

/** Test hook: drop the price cache (e.g. after seeding AiModelPrice rows). */
export function clearPriceCache(): void {
  priceCache.clear();
}

/**
 * Pricing tiers are 1-3 (Holger, 2026-07-11) — schema headroom for future
 * product tiers with different markups, deliberately semantics-free today.
 * Everything defaults to tier 1 until tiers become a product concept.
 */
export const PRICE_TIER_MIN = 1;
export const PRICE_TIER_MAX = 3;
export const PRICE_TIER_DEFAULT = 1;

export interface GetAiModelPriceOpts {
  /** Event instant; omit for "now" (the cached hot path). */
  at?: Date;
  /** Pricing tier 1-3; defaults to tier 1. */
  tier?: number;
}

/**
 * The AiModelPrice row effective for (provider, model, tier) at `at` — the
 * latest row with `effectiveAt <= at`, or null when the triple is unpriced
 * (which means "no cost computed", never a blocked call — FR-002). Tier
 * defaults to 1; there is deliberately NO cross-tier fallback — an unpriced
 * tier under-bills (cost NULL) rather than billing at another tier's rate.
 *
 * A 60s TTL cache serves the hot path (`at` = now); calls with an explicit
 * historical `at` bypass the cache, since the cached row is the CURRENT
 * price and may postdate `at`.
 */
export async function getAiModelPrice(
  db: PrismaClient,
  provider: string,
  model: string,
  opts: GetAiModelPriceOpts = {},
): Promise<AiModelPrice | null> {
  const { at } = opts;
  const tier = opts.tier ?? PRICE_TIER_DEFAULT;
  const now = Date.now();
  const useCache = at === undefined;
  const key = `${provider} ${model} ${tier}`;
  if (useCache) {
    const hit = priceCache.get(key);
    if (hit && now - hit.fetchedAt < PRICE_CACHE_TTL_MS) return hit.row;
  }
  const row = await db.aiModelPrice.findFirst({
    where: { provider, model, tier, deletedAt: null, effectiveAt: { lte: at ?? new Date(now) } },
    orderBy: { effectiveAt: 'desc' },
  });
  if (useCache) priceCache.set(key, { row, fetchedAt: now });
  return row;
}

/**
 * Provider cost in micro-cents for a token pair under `price`, rounded UP
 * to the next micro-cent (never bill-under on our own ledger).
 */
export function computeCostMicroCents(
  price: Pick<AiModelPrice, 'inputMicroCentsPerMTok' | 'outputMicroCentsPerMTok'>,
  tokensIn: number,
  tokensOut: number,
): bigint {
  const exactTimesMTok =
    BigInt(Math.max(0, Math.trunc(tokensIn))) * price.inputMicroCentsPerMTok +
    BigInt(Math.max(0, Math.trunc(tokensOut))) * price.outputMicroCentsPerMTok;
  return (exactTimesMTok + MTOK - 1n) / MTOK;
}

/** Debit amount for a platform cost: cost × (1 + bp/10000), rounded up. */
export function applyMarkupBp(costMicroCents: bigint, basisPoints: number): bigint {
  const bp = BigInt(Math.max(0, Math.trunc(basisPoints)));
  return (costMicroCents * (10_000n + bp) + 9_999n) / 10_000n;
}

/** Debit amount for a platform cost: cost × (1 + markup%), rounded up. */
export function applyMarkup(costMicroCents: bigint, percent: number): bigint {
  // Integer-safe: percent is scaled to basis points to survive fractional
  // markups (e.g. 12.5%) without float drift on the bigint path.
  return applyMarkupBp(costMicroCents, Math.round(percent * 100));
}

/**
 * Markup for a debit, in basis points: the effective-dated per-tier value on
 * the AiModelPrice row wins; a NULL column falls back to the global
 * CREDIT_MARKUP_PERCENT env (the row column supersedes the env, which
 * remains only as the fleet-wide default).
 */
export function markupBpFor(price: Pick<AiModelPrice, 'markupBasisPoints'>): number {
  return price.markupBasisPoints ?? Math.round(markupPercent() * 100);
}

// ── Usage recording (FR-001/003/004) ─────────────────────────────────────

export interface LlmUsageParams {
  /** UsageEvent.type, e.g. 'app-run' | 'embedding'. */
  type: string;
  nodeLoc?: string | null;
  nodeId?: string | null;
  /**
   * Memory to attribute the event to (#796) — stored directly so it survives
   * node deletion. Omitted by the `app-run` caller: the flow runner addresses
   * nodes by URN through `deps.loadNodeSpec`, whose `RunNodeSpec` carries no
   * memory id, so populating it would cost a per-hop lookup for an event type
   * no memory-scoped surface counts today.
   */
  memoryId?: string | null;
  sessionId?: string | null;
  appId?: string | null;
  /** On-behalf-of user (FR-001); null for pure-App service runs. */
  userId?: string | null;
  /** Billable org (FR-001). Required for a debit to happen. */
  organizationId?: string | null;
  provider: string;
  model: string;
  tokensIn: number;
  tokensOut: number;
  /** Owner level of the API key that served the call (FR-004). */
  keyOwnerType?: AiConfigOwnerType | null;
  /** Pricing tier 1-3; callers default to tier 1 until tiers are a product concept. */
  tier?: number;
  /** Audit column passthrough (existing createdBy semantics untouched). */
  createdBy?: string | null;
  /** #2439: the AppRun this spend belongs to. Its priced cost is added to the
   * run's `costMicroCents` in the SAME transaction as the event, so the run's
   * total and its usage events can never disagree. */
  appRunId?: string | null;
}

/**
 * Record one token-bearing usage event: cost snapshot from the effective
 * AiModelPrice (null when unpriced), then the gated automatic debit —
 * only when BILLING_DEBIT_ENABLED, only for platform-key spend
 * (keyOwnerType === 'HADRON_SERVER', FR-004), only with a billable org.
 *
 * Throw-safe: an internal failure logs and returns null; it must never
 * fail the run/job that spent the tokens (FR-006).
 */
export async function recordLlmUsage(
  db: PrismaClient,
  params: LlmUsageParams,
): Promise<UsageEvent | null> {
  try {
    const price = HOST_PRICED_PROVIDERS.has(params.provider)
      ? null
      : await getAiModelPrice(db, params.provider, params.model, { tier: params.tier });
    const cost = price
      ? computeCostMicroCents(price, params.tokensIn, params.tokensOut)
      : null;
    // #1660 review (local P2-1): the event is stamped at the instant its
    // activity was judged, so it cannot count for a session that lapsed after.
    const at = new Date();
    // #1653 / DY-2: counts toward liveness only for a live, owned session.
    // The same door as every attributed request (#1660 review, Cloe P3):
    // counts for a live owned session, and a pure App key's own lapsed
    // worker session resumes through the locked verdict (DY-1).
    const countsAsActivity = await attributedRequestActivity(
      db, { userId: params.userId ?? null, appId: params.appId ?? null }, params.sessionId, { at },
    );
    const data = {
        id: generateId(),
        type: params.type,
        nodeLoc: params.nodeLoc ?? null,
        nodeId: params.nodeId ?? null,
        memoryId: params.memoryId ?? null,
        sessionId: params.sessionId ?? null,
        countsAsActivity,
        createdAt: at,
        appId: params.appId ?? null,
        userId: params.userId ?? null,
        organizationId: params.organizationId ?? null,
        provider: params.provider,
        model: params.model,
        tokensIn: params.tokensIn,
        tokensOut: params.tokensOut,
        keyOwnerType: params.keyOwnerType ?? null,
        costMicroCents: cost,
        createdBy: params.createdBy ?? null,
    };
    const event = params.appRunId && cost != null
      ? await db.$transaction(async (tx) => {
          const created = await tx.usageEvent.create({ data });
          // A run minted before the column keeps NULL (unknown): `not: null` skips it.
          await tx.appRun.updateMany({ where: { id: params.appRunId!, costMicroCents: { not: null } }, data: { costMicroCents: { increment: cost } } });
          return created;
        })
      : await db.usageEvent.create({ data });
    if (
      debitEnabled() &&
      params.keyOwnerType === 'HADRON_SERVER' &&
      cost != null &&
      cost > 0n &&
      params.organizationId
    ) {
      await debitCredits(db, {
        organizationId: params.organizationId,
        amountMicroCents: applyMarkupBp(cost, markupBpFor(price!)),
        sourceType: 'usage-event',
        sourceId: event.id,
        createdBy: params.createdBy ?? null,
      });
    }
    return event;
  } catch (err) {
    // Fail-open (FR-006): metering must never fail the run that spent the
    // tokens. But log enough to diagnose transient failures post-hoc — a bare
    // error object logs Prisma's message as truncated noise without the P-code
    // or meta that actually identifies the cause (issue #643).
    if (err instanceof Prisma.PrismaClientKnownRequestError) {
      // Pass meta as a separate arg rather than JSON.stringify-ing it: meta can
      // carry a bigint, which JSON.stringify throws on — and a throw here would
      // defeat the fail-open guarantee. Node's console formatter is bigint-safe.
      console.error(
        `recordLlmUsage failed (usage NOT recorded): PrismaClientKnownRequestError code=${err.code}`,
        'meta:',
        err.meta,
        err,
      );
    } else {
      console.error('recordLlmUsage failed (usage NOT recorded):', err);
    }
    return null;
  }
}

// ── Credit ledger (FR-005) ───────────────────────────────────────────────

export class InvalidLedgerAmountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidLedgerAmountError';
  }
}

/**
 * A (sourceType, sourceId) replay whose org or amount DISAGREES with the
 * stored grant. This is never normal webhook redelivery (a Stripe session's
 * metadata is immutable) — it signals a caller bug or tampering, so it must
 * surface loudly instead of silently returning the mismatched row
 * (PR-624 review, Gemini high).
 */
export class IdempotencyConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IdempotencyConflictError';
  }
}

export interface GrantCreditsParams {
  organizationId: string;
  /** Positive micro-cents. */
  amountMicroCents: bigint;
  /** Policy field only in Phase 0 (FR-005). */
  expiresAt?: Date | null;
  /**
   * Idempotency + provenance pair: e.g. ('stripe-checkout', <session id>).
   * (sourceType, sourceId) is UNIQUE across the ledger — re-granting the
   * same pair returns the EXISTING row instead of double-crediting, which
   * is what makes at-least-once payment webhooks safe (hadrontool-billing).
   */
  sourceType?: string | null;
  sourceId?: string | null;
  note?: string | null;
  createdBy?: string | null;
}

/**
 * Append a positive `grant` row. Throws InvalidLedgerAmountError on <= 0
 * and on a half-provided source pair (an orphan sourceId would silently
 * lose the unique-constraint protection — PR-624 review, Gemini medium).
 * Idempotent on (sourceType, sourceId): a duplicate pair returns the
 * already-existing entry (never a second credit) — but ONLY when org and
 * amount agree; a disagreeing replay throws IdempotencyConflictError.
 * Rows without a source are unaffected (Postgres treats NULLs as distinct
 * in unique indexes).
 */
export async function grantCredits(db: PrismaClient, params: GrantCreditsParams) {
  if (params.amountMicroCents <= 0n) {
    throw new InvalidLedgerAmountError('grantCredits requires a positive amountMicroCents.');
  }
  if (!!params.sourceType !== !!params.sourceId) {
    throw new InvalidLedgerAmountError('sourceType and sourceId must be provided together.');
  }
  try {
    return await db.creditLedgerEntry.create({
      data: {
        id: generateId(),
        organizationId: params.organizationId,
        kind: 'grant',
        amountMicroCents: params.amountMicroCents,
        expiresAt: params.expiresAt ?? null,
        sourceType: params.sourceType ?? null,
        sourceId: params.sourceId ?? null,
        note: params.note ?? null,
        createdBy: params.createdBy ?? null,
      },
    });
  } catch (err) {
    // Unique (sourceType, sourceId) hit ⇒ this grant already landed
    // (webhook redelivery). Idempotent success ONLY for a true replay —
    // a mismatched org/amount is a conflict, never silently absorbed.
    if ((err as { code?: string }).code === 'P2002' && params.sourceType && params.sourceId) {
      const existing = await db.creditLedgerEntry.findFirstOrThrow({
        where: { sourceType: params.sourceType, sourceId: params.sourceId },
      });
      if (
        existing.organizationId !== params.organizationId ||
        existing.amountMicroCents !== params.amountMicroCents
      ) {
        throw new IdempotencyConflictError(
          `Grant (${params.sourceType}, ${params.sourceId}) already exists as ledger entry ` +
            `${existing.id} with org ${existing.organizationId} / amount ` +
            `${existing.amountMicroCents} — refusing the mismatched replay ` +
            `(org ${params.organizationId} / amount ${params.amountMicroCents}).`,
        );
      }
      return existing;
    }
    throw err;
  }
}

export interface DebitCreditsParams {
  organizationId: string;
  /** Positive micro-cents; stored negated. */
  amountMicroCents: bigint;
  sourceType?: string | null;
  sourceId?: string | null;
  note?: string | null;
  createdBy?: string | null;
}

/**
 * Append a negative `debit` row. The balance MAY go negative (overage) —
 * tokens are already spent at the provider; the launch gate, not the
 * ledger write, is the enforcement point (same posture as
 * recordQuotaUsage, PR-493 Codex P2).
 */
export async function debitCredits(db: PrismaClient, params: DebitCreditsParams) {
  if (params.amountMicroCents <= 0n) {
    throw new InvalidLedgerAmountError('debitCredits requires a positive amountMicroCents.');
  }
  return db.creditLedgerEntry.create({
    data: {
      id: generateId(),
      organizationId: params.organizationId,
      kind: 'debit',
      amountMicroCents: -params.amountMicroCents,
      sourceType: params.sourceType ?? null,
      sourceId: params.sourceId ?? null,
      note: params.note ?? null,
      createdBy: params.createdBy ?? null,
    },
  });
}

/** Org balance = SUM over the append-only ledger; 0n for an empty ledger. */
export async function creditBalance(db: PrismaClient, organizationId: string): Promise<bigint> {
  const agg = await db.creditLedgerEntry.aggregate({
    // deletedAt null: soft-delete is break-glass ops; the balance follows
    // the codebase-wide soft-deleted-is-gone semantic. Sanctioned
    // corrections are `adjustment` rows, which DO count.
    where: { organizationId, deletedAt: null },
    _sum: { amountMicroCents: true },
  });
  return agg._sum.amountMicroCents ?? 0n;
}
