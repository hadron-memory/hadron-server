/**
 * Spec 046 — usage metering + credit ledger unit/DB tests.
 *
 * Pins: cost math (ceil, bigint), markup (basis-point-safe), effective-dated
 * price lookup + cache semantics, the recordLlmUsage debit-gating matrix
 * (flag × keyOwnerType × org presence), ledger sign conventions, and the
 * throw-safety of recordLlmUsage (a metering failure must never propagate).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../id.js';
import {
  applyMarkup,
  clearPriceCache,
  computeCostMicroCents,
  creditBalance,
  debitCredits,
  getAiModelPrice,
  grantCredits,
  InvalidLedgerAmountError,
  recordLlmUsage,
} from './index.js';

// $3/MTok in, $15/MTok out (anthropic-sonnet-shaped numbers).
const IN_RATE = 30_000_000n;
const OUT_RATE = 150_000_000n;

let orgId: string;

async function mkPrice(
  provider: string,
  model: string,
  effectiveAt: Date,
  inRate = IN_RATE,
  outRate = OUT_RATE,
  extra: { tier?: number; markupBasisPoints?: number | null } = {},
) {
  return db.aiModelPrice.create({
    data: {
      id: generateId(),
      provider,
      model,
      tier: extra.tier ?? 1,
      inputMicroCentsPerMTok: inRate,
      outputMicroCentsPerMTok: outRate,
      markupBasisPoints: extra.markupBasisPoints ?? null,
      effectiveAt,
    },
  });
}

beforeEach(async () => {
  await cleanDb(db);
  clearPriceCache();
  const org = await db.organization.create({
    data: { id: generateId(), name: 'metering-org', urn: 'metering-org' },
  });
  orgId = org.id;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('computeCostMicroCents', () => {
  it('computes the exact cost for round token counts', () => {
    // 1000 in @ $3/MTok = 30_000 µ¢; 500 out @ $15/MTok = 75_000 µ¢.
    const cost = computeCostMicroCents(
      { inputMicroCentsPerMTok: IN_RATE, outputMicroCentsPerMTok: OUT_RATE },
      1000,
      500,
    );
    expect(cost).toBe(105_000n);
  });

  it('rounds up to the next micro-cent (never bill-under)', () => {
    // 1 token at 1 µ¢/MTok = 1e-6 µ¢ exact → ceil to 1n.
    const cost = computeCostMicroCents(
      { inputMicroCentsPerMTok: 1n, outputMicroCentsPerMTok: 0n },
      1,
      0,
    );
    expect(cost).toBe(1n);
  });

  it('is zero for zero tokens and clamps negative counts', () => {
    const price = { inputMicroCentsPerMTok: IN_RATE, outputMicroCentsPerMTok: OUT_RATE };
    expect(computeCostMicroCents(price, 0, 0)).toBe(0n);
    expect(computeCostMicroCents(price, -5, -5)).toBe(0n);
  });
});

describe('applyMarkup', () => {
  it('is identity at 0%', () => {
    expect(applyMarkup(105_000n, 0)).toBe(105_000n);
  });

  it('applies whole and fractional percentages, rounding up', () => {
    expect(applyMarkup(100_000n, 25)).toBe(125_000n);
    expect(applyMarkup(100_000n, 12.5)).toBe(112_500n);
    // 3n at 33% = 3.99n → ceil 4n.
    expect(applyMarkup(3n, 33)).toBe(4n);
  });
});

describe('getAiModelPrice', () => {
  it('returns null for an unpriced (provider, model) pair', async () => {
    expect(await getAiModelPrice(db, 'anthropic', 'claude-nope')).toBeNull();
  });

  it('selects the latest row effective at or before the given instant', async () => {
    const old = await mkPrice('anthropic', 'claude-x', new Date('2026-01-01'), 10n, 20n);
    const current = await mkPrice('anthropic', 'claude-x', new Date('2026-06-01'), 30n, 40n);
    // Historical `at` (cache-bypassing) → the old row.
    const atFeb = await getAiModelPrice(db, 'anthropic', 'claude-x', { at: new Date('2026-02-01') });
    expect(atFeb?.id).toBe(old.id);
    // `at` before any row → null.
    expect(await getAiModelPrice(db, 'anthropic', 'claude-x', { at: new Date('2025-01-01') })).toBeNull();
    // Now → the current row.
    const nowRow = await getAiModelPrice(db, 'anthropic', 'claude-x');
    expect(nowRow?.id).toBe(current.id);
  });

  it('isolates tiers: no cross-tier fallback, default is tier 1', async () => {
    const t1 = await mkPrice('anthropic', 'claude-t', new Date('2026-01-01'), 10n, 10n);
    const t2 = await mkPrice('anthropic', 'claude-t', new Date('2026-01-01'), 50n, 50n, {
      tier: 2,
    });
    // Default lookup resolves tier 1.
    expect((await getAiModelPrice(db, 'anthropic', 'claude-t'))?.id).toBe(t1.id);
    // Explicit tier 2 gets the tier-2 row.
    expect((await getAiModelPrice(db, 'anthropic', 'claude-t', { tier: 2 }))?.id).toBe(t2.id);
    // An unpriced tier is unpriced — never another tier's rate.
    expect(await getAiModelPrice(db, 'anthropic', 'claude-t', { tier: 3 })).toBeNull();
  });

  it('caches the now-lookup until clearPriceCache', async () => {
    await mkPrice('anthropic', 'claude-c', new Date('2026-01-01'), 10n, 10n);
    const first = await getAiModelPrice(db, 'anthropic', 'claude-c');
    // A newer row appears, but the cached row keeps serving...
    await mkPrice('anthropic', 'claude-c', new Date('2026-02-01'), 99n, 99n);
    const cached = await getAiModelPrice(db, 'anthropic', 'claude-c');
    expect(cached?.id).toBe(first?.id);
    // ...until the cache is dropped (what setAiModelPrice does).
    clearPriceCache();
    const fresh = await getAiModelPrice(db, 'anthropic', 'claude-c');
    expect(fresh?.inputMicroCentsPerMTok).toBe(99n);
  });
});

describe('recordLlmUsage', () => {
  const base = {
    type: 'app-run',
    provider: 'anthropic',
    model: 'claude-m',
    tokensIn: 1000,
    tokensOut: 500,
  } as const;

  it('snapshots cost from the effective price and stores attribution', async () => {
    await mkPrice('anthropic', 'claude-m', new Date('2026-01-01'));
    const event = await recordLlmUsage(db, {
      ...base,
      organizationId: orgId,
      keyOwnerType: 'HADRON_SERVER',
    });
    expect(event).not.toBeNull();
    expect(event!.costMicroCents).toBe(105_000n);
    expect(event!.organizationId).toBe(orgId);
    expect(event!.provider).toBe('anthropic');
    expect(event!.keyOwnerType).toBe('HADRON_SERVER');
  });

  it('stores a null cost for an unpriced pair (and never blocks)', async () => {
    const event = await recordLlmUsage(db, { ...base, organizationId: orgId });
    expect(event).not.toBeNull();
    expect(event!.costMicroCents).toBeNull();
    expect(event!.tokensIn).toBe(1000);
  });

  it('does NOT debit when BILLING_DEBIT_ENABLED is unset (default off)', async () => {
    await mkPrice('anthropic', 'claude-m', new Date('2026-01-01'));
    await recordLlmUsage(db, { ...base, organizationId: orgId, keyOwnerType: 'HADRON_SERVER' });
    expect(await db.creditLedgerEntry.count()).toBe(0);
  });

  it('debits platform-key spend when enabled, with markup', async () => {
    vi.stubEnv('BILLING_DEBIT_ENABLED', 'true');
    vi.stubEnv('CREDIT_MARKUP_PERCENT', '25');
    await mkPrice('anthropic', 'claude-m', new Date('2026-01-01'));
    await recordLlmUsage(db, { ...base, organizationId: orgId, keyOwnerType: 'HADRON_SERVER' });
    const entries = await db.creditLedgerEntry.findMany({ where: { organizationId: orgId } });
    expect(entries).toHaveLength(1);
    expect(entries[0].kind).toBe('debit');
    // 105_000 × 1.25 = 131_250, stored negated.
    expect(entries[0].amountMicroCents).toBe(-131_250n);
    expect(entries[0].sourceType).toBe('usage-event');
    expect(await creditBalance(db, orgId)).toBe(-131_250n);
  });

  it('row markupBasisPoints overrides the env markup (per-tier pricing)', async () => {
    vi.stubEnv('BILLING_DEBIT_ENABLED', 'true');
    vi.stubEnv('CREDIT_MARKUP_PERCENT', '25'); // must LOSE to the row value
    await mkPrice('anthropic', 'claude-m', new Date('2026-01-01'), IN_RATE, OUT_RATE, {
      markupBasisPoints: 5000, // 50%
    });
    await recordLlmUsage(db, { ...base, organizationId: orgId, keyOwnerType: 'HADRON_SERVER' });
    const [entry] = await db.creditLedgerEntry.findMany({ where: { organizationId: orgId } });
    // 105_000 × 1.5 = 157_500, stored negated — NOT the env's 131_250.
    expect(entry.amountMicroCents).toBe(-157_500n);
  });

  it('never debits BYOK spend (FR-004), even when enabled', async () => {
    vi.stubEnv('BILLING_DEBIT_ENABLED', 'true');
    await mkPrice('anthropic', 'claude-m', new Date('2026-01-01'));
    await recordLlmUsage(db, { ...base, organizationId: orgId, keyOwnerType: 'ORGANIZATION' });
    expect(await db.creditLedgerEntry.count()).toBe(0);
  });

  it('never debits without a billable org, and never throws on FK failure', async () => {
    vi.stubEnv('BILLING_DEBIT_ENABLED', 'true');
    await mkPrice('anthropic', 'claude-m', new Date('2026-01-01'));
    // No organizationId: event recorded, no debit.
    const noOrg = await recordLlmUsage(db, { ...base, keyOwnerType: 'HADRON_SERVER' });
    expect(noOrg).not.toBeNull();
    expect(await db.creditLedgerEntry.count()).toBe(0);
    // Nonexistent org: FK violation is swallowed (throw-safe), returns null.
    const bad = await recordLlmUsage(db, {
      ...base,
      organizationId: 'no-such-org',
      keyOwnerType: 'HADRON_SERVER',
    });
    expect(bad).toBeNull();
  });
});

describe('credit ledger primitives', () => {
  it('grants are positive, debits negated, balance is the running sum', async () => {
    await grantCredits(db, { organizationId: orgId, amountMicroCents: 500_000n });
    await debitCredits(db, { organizationId: orgId, amountMicroCents: 125_000n });
    expect(await creditBalance(db, orgId)).toBe(375_000n);
    const kinds = (await db.creditLedgerEntry.findMany({ orderBy: { createdAt: 'asc' } })).map(
      (e) => [e.kind, e.amountMicroCents],
    );
    expect(kinds).toEqual([
      ['grant', 500_000n],
      ['debit', -125_000n],
    ]);
  });

  it('rejects non-positive amounts', async () => {
    await expect(
      grantCredits(db, { organizationId: orgId, amountMicroCents: 0n }),
    ).rejects.toBeInstanceOf(InvalidLedgerAmountError);
    await expect(
      debitCredits(db, { organizationId: orgId, amountMicroCents: -5n }),
    ).rejects.toBeInstanceOf(InvalidLedgerAmountError);
  });

  it('balance is 0n for an empty ledger', async () => {
    expect(await creditBalance(db, orgId)).toBe(0n);
  });
});
