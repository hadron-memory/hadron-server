/**
 * #5011 (Billing A4): settling expired grants against the database.
 *
 * hrn:node:hadronmemory.com:specs:cor:dmo:170:10: an expired grant is settled by ONE new adjustment entry of minus its
 * remainder, source pair ('grant-expiry', <grant id>), also when the remainder is zero, and never again. Gate rulings
 * (issue #5011, gate comment): settle only at expiresAt <= now - 60 s (10.1), createdBy 'system:credit-expiry' and note
 * null (10.6), and a taken pair is done whatever its amount (never IdempotencyConflictError, never an aborted
 * transaction).
 *
 * Red on main: `./settleExpiredGrants.js` does not exist.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../id.js';
import { replayLedger } from './expiry.js';
import {
  CREDIT_EXPIRY_CREATED_BY,
  SETTLE_DELAY_MS,
  databaseNow,
  settleExpiredGrants,
  unsettledRemainders,
  writeSettlements,
} from './settleExpiredGrants.js';

const d = (s: string) => new Date(`2027-${s}T00:00:00.000Z`);
const later = (at: Date, ms: number) => new Date(at.getTime() + ms);

let orgId: string;

async function grant(amount: number, createdAt: Date, expiresAt: Date | null, deletedAt: Date | null = null) {
  return db.creditLedgerEntry.create({
    data: {
      id: generateId(),
      organizationId: orgId,
      kind: 'grant',
      amountMicroCents: BigInt(amount),
      expiresAt,
      sourceType: 'test-grant',
      sourceId: generateId(),
      createdAt,
      deletedAt,
    },
  });
}
async function debit(amount: number, createdAt: Date, deletedAt: Date | null = null, organizationId = orgId) {
  return db.creditLedgerEntry.create({
    data: {
      id: generateId(),
      organizationId,
      kind: 'debit',
      amountMicroCents: -BigInt(amount),
      sourceType: 'usage-event',
      sourceId: generateId(),
      createdAt,
      deletedAt,
    },
  });
}
const settlements = () =>
  db.creditLedgerEntry.findMany({ where: { sourceType: 'grant-expiry' }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });

beforeEach(async () => {
  await cleanDb(db);
  orgId = (await db.organization.create({ data: { id: generateId(), name: 'ce-org', urn: 'ce-org' } })).id;
});

describe('#5011 settleExpiredGrants', () => {
  it('S1 (acceptance 1): grant 100, debit 30, expiry passed: one -70 adjustment; a second call writes nothing', async () => {
    const g = await grant(100, d('01-01'), d('02-01'));
    await debit(30, d('01-10'));
    const now = later(d('02-01'), 2 * 60_000);
    const written = await settleExpiredGrants(db, { organizationId: orgId }, { now });
    expect(written).toEqual([{ grantId: g.id, amountMicroCents: -70n }]);
    const rows = await settlements();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      organizationId: orgId,
      kind: 'adjustment',
      amountMicroCents: -70n,
      sourceType: 'grant-expiry',
      sourceId: g.id,
      createdBy: CREDIT_EXPIRY_CREATED_BY,
      note: null,
      expiresAt: null,
      deletedAt: null,
    });
    expect(rows[0].createdAt).toEqual(now);
    expect(CREDIT_EXPIRY_CREATED_BY).toBe('system:credit-expiry');

    expect(await settleExpiredGrants(db, { organizationId: orgId }, { now: later(now, 60_000) })).toEqual([]);
    expect(await db.creditLedgerEntry.count()).toBe(3);
  });

  it('ruling 10.1: within 60 s of the expiry nothing is written, and the remainder is still reported unsettled', async () => {
    expect(SETTLE_DELAY_MS).toBe(60_000);
    const g = await grant(100, d('01-01'), d('02-01'));
    await debit(30, d('01-10'));
    const inside = later(d('02-01'), 59_000);
    expect(await settleExpiredGrants(db, { organizationId: orgId }, { now: inside })).toEqual([]);
    expect(await settlements()).toHaveLength(0);
    expect(await unsettledRemainders(db, { organizationId: orgId }, inside)).toBe(70n);
    // At exactly 60 s it is settled.
    const at = later(d('02-01'), 60_000);
    expect(await settleExpiredGrants(db, { organizationId: orgId }, { now: at })).toEqual([
      { grantId: g.id, amountMicroCents: -70n },
    ]);
    expect(await unsettledRemainders(db, { organizationId: orgId }, at)).toBe(0n);
  });

  it('S2 (acceptance 3): G0 is settled -40 and, a fortnight later, G1 -100', async () => {
    const g0 = await grant(100, d('01-01'), d('02-01'));
    const g1 = await grant(100, d('01-15'), d('02-15'));
    await debit(60, d('01-20'));
    await settleExpiredGrants(db, { organizationId: orgId }, { now: later(d('02-01'), 120_000) });
    await settleExpiredGrants(db, { organizationId: orgId }, { now: d('02-16') });
    expect((await settlements()).map((s) => [s.sourceId, s.amountMicroCents])).toEqual([
      [g0.id, -40n],
      [g1.id, -100n],
    ]);
  });

  it('S3 (acceptance 4): two concurrent settlements of equal expiries end at -140, neither throws', async () => {
    await grant(100, d('01-01'), d('02-01'));
    await grant(100, d('01-02'), d('02-01'));
    await debit(60, d('01-20'));
    const now = d('02-02');
    const results = await Promise.allSettled([
      settleExpiredGrants(db, { organizationId: orgId }, { now }),
      settleExpiredGrants(db, { organizationId: orgId }, { now }),
    ]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
    const rows = await settlements();
    expect(rows).toHaveLength(2);
    expect(rows.reduce((acc, r) => acc + r.amountMicroCents, 0n)).toBe(-140n);
  });

  it('S4: a pair already taken with another amount is done: no throw, no second row', async () => {
    const g = await grant(100, d('01-01'), d('02-01'));
    await db.creditLedgerEntry.create({
      data: {
        id: generateId(),
        organizationId: orgId,
        kind: 'adjustment',
        amountMicroCents: -5n,
        sourceType: 'grant-expiry',
        sourceId: g.id,
        createdAt: d('02-01'),
      },
    });
    expect(await settleExpiredGrants(db, { organizationId: orgId }, { now: d('02-02') })).toEqual([]);
    expect((await settlements()).map((s) => s.amountMicroCents)).toEqual([-5n]);
  });

  it('S4b: the writer never aborts a surrounding transaction when the pair is taken', async () => {
    const g = await grant(100, d('01-01'), d('02-01'));
    const taken = { grantId: g.id, amountMicroCents: -100n };
    // A concurrent settler got there first: the same pair is written twice inside one transaction.
    const after = await db.$transaction(async (tx) => {
      const first = await writeSettlements(tx as typeof db, orgId, [taken], d('02-02'));
      const second = await writeSettlements(tx as typeof db, orgId, [taken], d('02-02'));
      return { first, second, count: await tx.creditLedgerEntry.count() };
    });
    expect(after).toEqual({ first: 1, second: 0, count: 2 });
  });

  it('S5: a fully used grant is settled once with a zero entry; the next call ends at the probe', async () => {
    const g = await grant(100, d('01-01'), d('02-01'));
    await debit(100, d('01-10'));
    expect(await settleExpiredGrants(db, { organizationId: orgId }, { now: d('02-02') })).toEqual([
      { grantId: g.id, amountMicroCents: 0n },
    ]);
    expect((await settlements()).map((s) => s.amountMicroCents)).toEqual([0n]);
    const replay = vi.fn(replayLedger);
    expect(await settleExpiredGrants(db, { organizationId: orgId }, { now: d('03-01'), replay })).toEqual([]);
    expect(replay).not.toHaveBeenCalled();
  });

  it('S6: a grant with no expiry is never touched; the probe ends the call', async () => {
    await grant(100, d('01-01'), null);
    await debit(30, d('01-10'));
    const replay = vi.fn(replayLedger);
    expect(await settleExpiredGrants(db, { organizationId: orgId }, { now: d('12-31'), replay })).toEqual([]);
    expect(replay).not.toHaveBeenCalled();
    expect(await settlements()).toHaveLength(0);
    expect(await unsettledRemainders(db, { organizationId: orgId }, d('12-31'))).toBe(0n);
  });

  it('S7: a soft-deleted debit is ignored by the replay, as by the balance', async () => {
    const g = await grant(100, d('01-01'), d('02-01'));
    await debit(30, d('01-10'), d('01-11'));
    await settleExpiredGrants(db, { organizationId: orgId }, { now: d('02-02') });
    expect((await settlements()).map((s) => [s.sourceId, s.amountMicroCents])).toEqual([[g.id, -100n]]);
  });

  it('another organization\'s entries take no part', async () => {
    const other = (await db.organization.create({ data: { id: generateId(), name: 'ce-other', urn: 'ce-other' } })).id;
    const g = await grant(100, d('01-01'), d('02-01'));
    await debit(90, d('01-10'), null, other);
    await settleExpiredGrants(db, { organizationId: orgId }, { now: d('02-02') });
    expect((await settlements()).map((s) => [s.sourceId, s.amountMicroCents])).toEqual([[g.id, -100n]]);
  });

  it('a person owner is refused until A6 (never read as an organization)', async () => {
    await expect(settleExpiredGrants(db, { userId: generateId() }, { now: d('02-02') })).rejects.toThrow(/person/i);
  });

  it('with no `now`, the database clock is used', async () => {
    const dbNow = await databaseNow(db);
    const g = await grant(100, later(dbNow, -3_600_000), later(dbNow, -120_000));
    expect(await settleExpiredGrants(db, { organizationId: orgId })).toEqual([{ grantId: g.id, amountMicroCents: -100n }]);
  });
});
