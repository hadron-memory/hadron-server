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
import { PRICE_CACHE_TTL_MS, priceCache } from './priceCache.js';

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

export { clearPriceCache, PRICE_CACHE_TTL_MS } from './priceCache.js';

/**
 * Pricing tiers are 1-3 (Holger, 2026-07-11) — schema headroom for future
 * product tiers with different markups, deliberately semantics-free today.
 * Everything defaults to tier 1 until tiers become a product concept.
 */
export const PRICE_TIER_MIN = 1;
export const PRICE_TIER_MAX = 3;
export const PRICE_TIER_DEFAULT = 1;

export interface GetAiModelPriceOpts {
  /** A historical instant; bypasses the cache. Omit for the current price (the cached hot path). */
  at?: Date;
  /** #5021: the instant the caller is pricing NOW, on the cached path (recordLlmUsage passes the unit's own recorded
   * instant, gate ruling 5). Defaults to the clock. Ignored when `at` is given. */
  now?: Date;
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
 * A 60s TTL cache serves the hot path (`at` omitted); calls with an explicit
 * historical `at` bypass the cache, since the cached row is the CURRENT
 * price and may postdate `at`. #5021: a cache entry also holds the effective
 * instant of the next row for its key and is not served from that instant
 * on, so every process switches to a new row at its effective instant (a
 * new row is always written at least one cache lifetime ahead, so a process
 * whose entry predates the write has expired by then). Soft-deleted rows are
 * still skipped (gate ruling 1); after #5021's trigger no row can be marked.
 */
export async function getAiModelPrice(
  db: PrismaClient,
  provider: string,
  model: string,
  opts: GetAiModelPriceOpts = {},
): Promise<AiModelPrice | null> {
  const { at } = opts;
  const tier = opts.tier ?? PRICE_TIER_DEFAULT;
  if (at !== undefined) {
    return db.aiModelPrice.findFirst({
      where: { provider, model, tier, deletedAt: null, effectiveAt: { lte: at } },
      orderBy: { effectiveAt: 'desc' },
    });
  }
  const now = (opts.now ?? new Date()).getTime();
  const key = `${provider} ${model} ${tier}`;
  const hit = priceCache.get(key);
  if (
    hit &&
    now >= hit.fetchedAt &&
    now - hit.fetchedAt < PRICE_CACHE_TTL_MS &&
    (hit.nextEffectiveAt === null || now < hit.nextEffectiveAt)
  ) {
    return hit.row;
  }
  const [row, next] = await Promise.all([
    db.aiModelPrice.findFirst({
      where: { provider, model, tier, deletedAt: null, effectiveAt: { lte: new Date(now) } },
      orderBy: { effectiveAt: 'desc' },
    }),
    db.aiModelPrice.findFirst({
      where: { provider, model, tier, deletedAt: null, effectiveAt: { gt: new Date(now) } },
      orderBy: { effectiveAt: 'asc' },
      select: { effectiveAt: true },
    }),
  ]);
  priceCache.set(key, { row, fetchedAt: now, nextEffectiveAt: next ? next.effectiveAt.getTime() : null });
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
    // #1660 review (local P2-1): the event is stamped at the instant its
    // activity was judged, so it cannot count for a session that lapsed after.
    // #5021 (gate ruling 5): the instant is taken FIRST and the unit is priced
    // at it, so a unit stamped just after a new row's effective time is never
    // priced from the old row.
    const at = new Date();
    const price = HOST_PRICED_PROVIDERS.has(params.provider)
      ? null
      : await getAiModelPrice(db, params.provider, params.model, { tier: params.tier, now: at });
    const cost = price
      ? computeCostMicroCents(price, params.tokensIn, params.tokensOut)
      : null;
    // The debit condition, decided once: it gates both the markup the unit
    // records and the debit itself (#5021, cor:dmo:170:06), so the two cannot
    // disagree. Whether the debit then succeeded is read from the ledger.
    const charged =
      price != null &&
      cost != null &&
      cost > 0n &&
      debitEnabled() &&
      params.keyOwnerType === 'HADRON_SERVER' &&
      !!params.organizationId;
    const markupBasisPoints = charged ? markupBpFor(price) : null;
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
        // #5021 (cor:dmo:170:06): the row that priced the unit and the markup
        // of its charge; both null when the unit is unpriced or not charged.
        priceRowId: price?.id ?? null,
        markupBasisPoints,
        // #5021 (gate ruling 9): the run, in the same insert.
        appRunId: params.appRunId ?? null,
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
    if (charged) {
      await debitCredits(db, {
        organizationId: params.organizationId!,
        amountMicroCents: applyMarkupBp(cost!, markupBasisPoints!),
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
 * The one sentence every ledger replay conflict answers (#5007 ruling 4). It
 * names the condition and nothing else: never the stored entry's id, account or
 * amount, nor the caller's (with a billing role and personal ledgers those
 * would disclose another owner's ledger). The CLI prints it verbatim.
 */
export const LEDGER_SOURCE_CONFLICT_MESSAGE =
  'This source is already recorded on the ledger with a different account, amount or kind.';

/**
 * A (sourceType, sourceId) replay whose account, amount or kind DISAGREES with
 * the stored entry. This is never normal webhook redelivery (a Stripe session's
 * metadata is immutable): it signals a caller bug or tampering, so it must
 * surface loudly instead of silently returning the mismatched row (PR-624
 * review, Gemini high). It carries only {@link LEDGER_SOURCE_CONFLICT_MESSAGE}.
 */
export class IdempotencyConflictError extends Error {
  constructor() {
    super(LEDGER_SOURCE_CONFLICT_MESSAGE);
    this.name = 'IdempotencyConflictError';
  }
}

/**
 * The source types the server writes itself (#5007 ruling 3): `usage-event`
 * (debitCredits, from recordLlmUsage), `grant-expiry` (A4's settlement),
 * `period-grant` (A9's monthly grant) and `cost-correction` (A15). The
 * grantCredits and adjustCredits MUTATIONS refuse them, so a hand-typed entry
 * can never pose as one of the server's own (an adjustment typed `grant-expiry`
 * would empty a bucket in A4's replay while the sum says otherwise). The library
 * does NOT refuse them: its server-side callers write these types. Listed in the
 * SDL descriptions of both inputs (checked by `pnpm check:sdl-enums`).
 */
export const SERVER_WRITTEN_SOURCE_TYPES = [
  'usage-event',
  'grant-expiry',
  'period-grant',
  'cost-correction',
] as const;

const SERVER_WRITTEN_SOURCE_TYPE_SET: ReadonlySet<string> = new Set(SERVER_WRITTEN_SOURCE_TYPES);

/** Matched trimmed and case-insensitively (#5007 ruling 3); values are stored as given. */
export function isServerWrittenSourceType(sourceType: string): boolean {
  return SERVER_WRITTEN_SOURCE_TYPE_SET.has(sourceType.trim().toLowerCase());
}

/** A blank or whitespace-only value counts as missing (#5007 ruling 3). */
function isBlank(value: string | null | undefined): boolean {
  return value == null || value.trim() === '';
}

/**
 * hrn:node:hadronmemory.com:specs:cor:dmo:170:03: "each entry names its
 * source, a kind of source and an id within it". Both halves are required and
 * non-blank (#5007 ruling 1, library and mutation).
 */
function requireSource(sourceType: string | null | undefined, sourceId: string | null | undefined) {
  if (isBlank(sourceType) || isBlank(sourceId)) {
    throw new InvalidLedgerAmountError('sourceType and sourceId are both required and must not be blank.');
  }
}

interface LedgerInsert {
  organizationId: string;
  kind: LedgerKind;
  amountMicroCents: bigint;
  expiresAt: Date | null;
  sourceType: string;
  sourceId: string;
  note: string | null;
  createdBy: string | null;
}

/**
 * Whether a stored entry is a true replay of `params`: the same account, the
 * same amount and the same kind (hrn:node:hadronmemory.com:specs:cor:dmo:170:03,
 * plus kind, #5007). The pair is unique across the WHOLE ledger, so without the
 * kind an adjustment reusing a grant's pair would get the grant back as a
 * success. `expiresAt` is deliberately not compared (#5007 ruling 5, A4). A6
 * adds the person owner here, null-safely, in this one place.
 */
function isSameLedgerEntry(
  existing: { organizationId: string; amountMicroCents: bigint; kind: string },
  params: Pick<LedgerInsert, 'organizationId' | 'amountMicroCents' | 'kind'>,
): boolean {
  return (
    existing.organizationId === params.organizationId &&
    existing.amountMicroCents === params.amountMicroCents &&
    existing.kind === params.kind
  );
}

/**
 * Insert one sourced entry, or return the existing one on a true replay.
 * Unique (sourceType, sourceId) hit ⇒ the entry already landed (webhook
 * redelivery): idempotent success ONLY when {@link isSameLedgerEntry}; any
 * disagreement is {@link IdempotencyConflictError}, never silently absorbed.
 */
async function insertOrReplay(db: PrismaClient, params: LedgerInsert) {
  try {
    return await db.creditLedgerEntry.create({ data: { id: generateId(), ...params } });
  } catch (err) {
    if ((err as { code?: string }).code !== 'P2002') throw err;
    const existing = await db.creditLedgerEntry.findFirstOrThrow({
      where: { sourceType: params.sourceType, sourceId: params.sourceId },
    });
    if (!isSameLedgerEntry(existing, params)) throw new IdempotencyConflictError();
    return existing;
  }
}

export interface GrantCreditsParams {
  organizationId: string;
  /** Positive micro-cents. */
  amountMicroCents: bigint;
  /** Policy field only in Phase 0 (FR-005). */
  expiresAt?: Date | null;
  /**
   * Idempotency + provenance pair, required (#5007): e.g. ('stripe-checkout',
   * <session id>). (sourceType, sourceId) is UNIQUE across the ledger;
   * re-granting the same pair returns the EXISTING row instead of
   * double-crediting, which is what makes at-least-once payment webhooks from a
   * payment service safe.
   */
  sourceType: string;
  sourceId: string;
  note?: string | null;
  createdBy?: string | null;
}

/**
 * Append a positive `grant` row (hrn:node:hadronmemory.com:specs:cor:dmo:170:03).
 * Throws InvalidLedgerAmountError on <= 0 and on a missing or blank source pair
 * (#5007: every entry names its source). Idempotent on (sourceType, sourceId):
 * a true replay (same account, amount and kind) returns the existing entry;
 * anything else throws IdempotencyConflictError.
 */
export async function grantCredits(db: PrismaClient, params: GrantCreditsParams) {
  if (params.amountMicroCents <= 0n) {
    throw new InvalidLedgerAmountError('grantCredits requires a positive amountMicroCents.');
  }
  requireSource(params.sourceType, params.sourceId);
  return insertOrReplay(db, {
    organizationId: params.organizationId,
    kind: 'grant',
    amountMicroCents: params.amountMicroCents,
    expiresAt: params.expiresAt ?? null,
    sourceType: params.sourceType,
    sourceId: params.sourceId,
    note: params.note ?? null,
    createdBy: params.createdBy ?? null,
  });
}

export interface AdjustCreditsParams {
  organizationId: string;
  /** Signed, non-zero micro-cents (a refund is negative). */
  amountMicroCents: bigint;
  /** Required, non-blank: the idempotency + provenance pair. */
  sourceType: string;
  sourceId: string;
  /** Required, non-blank. Kept for the life of the entry: codes and ids, never personal data. */
  note: string;
  createdBy?: string | null;
}

/**
 * Append a signed `adjustment` row: a correction of either sign, such as a
 * refund or the settlement of an expired grant
 * (hrn:node:hadronmemory.com:specs:cor:dmo:170:03). A correction is a NEW entry,
 * never an edit (hrn:node:hadronmemory.com:specs:cor:dmo:170:08). Throws
 * InvalidLedgerAmountError on a zero amount or a missing or blank source pair or
 * note; replays exactly as grantCredits does (kind included). It does not refuse
 * the server-written source types: A4 and A15 call it with their own.
 */
export async function adjustCredits(db: PrismaClient, params: AdjustCreditsParams) {
  if (params.amountMicroCents === 0n) {
    throw new InvalidLedgerAmountError('adjustCredits requires a non-zero amountMicroCents.');
  }
  requireSource(params.sourceType, params.sourceId);
  if (isBlank(params.note)) {
    throw new InvalidLedgerAmountError('note is required and must not be blank.');
  }
  return insertOrReplay(db, {
    organizationId: params.organizationId,
    kind: 'adjustment',
    amountMicroCents: params.amountMicroCents,
    expiresAt: null,
    sourceType: params.sourceType,
    sourceId: params.sourceId,
    note: params.note,
    createdBy: params.createdBy ?? null,
  });
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
    // deletedAt null: since #5010 the database refuses a soft-deleted entry (cor:dmo:170:08), so this only keeps
    // the balance unchanged where that migration refused (HDPRF) and the old schema is still served. Sanctioned
    // corrections are `adjustment` rows, which DO count.
    where: { organizationId, deletedAt: null },
    _sum: { amountMicroCents: true },
  });
  return agg._sum.amountMicroCents ?? 0n;
}
