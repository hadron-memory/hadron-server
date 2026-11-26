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
import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../id.js';
import {
  CREDIT_EXPIRY_CREATED_BY,
  SETTLE_DELAY_MS,
  databaseNow,
  settleExpiredGrants,
  unsettledRemainder,
  settleAndMeasure,
  readReplayWindow,
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

/**
 * The client with its ledger reads counted: the probe is a single raw query, so a call the probe ends reads no ledger
 * rows through the model (the window rule alone would also return nothing, so only the reads can tell the probe ran
 * first).
 */
function countingLedgerReads() {
  const counter = { reads: 0 };
  const ledger = new Proxy(db.creditLedgerEntry, {
    get(target, key) {
      const value = Reflect.get(target, key);
      if (typeof value !== 'function') return value;
      if (key === 'findMany' || key === 'aggregate') {
        return (...args: unknown[]) => {
          counter.reads += 1;
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      return (value as (...a: unknown[]) => unknown).bind(target);
    },
  });
  const client = new Proxy(db, {
    get(target, key) {
      if (key === 'creditLedgerEntry') return ledger;
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  }) as typeof db;
  return { client, counter };
}

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

  it('#5100 settleAndMeasure: the 60 s boundary, write:false, and the unsettled figure come from one replay', async () => {
    const owner = { organizationId: orgId };
    const g = await grant(100, d('01-01'), d('02-01'));
    await debit(30, d('01-10'));
    const inside = later(d('02-01'), 59_000);
    // Inside the 60 s: nothing written, the whole remainder unsettled, the replay handed on.
    const a = await settleAndMeasure(db, owner, inside, { write: true });
    expect(a.settled).toEqual([]);
    expect(a.unsettled).toBe(70n);
    expect(a.replay).toBeTruthy();
    expect(await settlements()).toHaveLength(0);
    // At 60 s with write:false: still nothing written, everything unsettled.
    const at = later(d('02-01'), 60_000);
    const b = await settleAndMeasure(db, owner, at, { write: false });
    expect(b).toMatchObject({ settled: [], unsettled: 70n });
    expect(await settlements()).toHaveLength(0);
    // At 60 s with write:true: settled, nothing unsettled.
    const c = await settleAndMeasure(db, owner, at, { write: true });
    expect(c.settled).toEqual([{ grantId: g.id, amountMicroCents: -70n }]);
    expect(c.unsettled).toBe(0n);
    expect(await settlements()).toHaveLength(1);
    // Nothing expired and unsettled any more: no replay runs.
    expect(await settleAndMeasure(db, owner, later(at, 1000), { write: true })).toEqual({ settled: [], unsettled: 0n, replay: undefined });
  });

  it('ruling 10.1: within 60 s of the expiry nothing is written, and the remainder is still reported unsettled', async () => {
    expect(SETTLE_DELAY_MS).toBe(60_000);
    const g = await grant(100, d('01-01'), d('02-01'));
    await debit(30, d('01-10'));
    const inside = later(d('02-01'), 59_000);
    expect(await settleExpiredGrants(db, { organizationId: orgId }, { now: inside })).toEqual([]);
    expect(await settlements()).toHaveLength(0);
    expect(await unsettledRemainder(db, { organizationId: orgId }, inside)).toBe(70n);
    // At exactly 60 s it is settled.
    const at = later(d('02-01'), 60_000);
    expect(await settleExpiredGrants(db, { organizationId: orgId }, { now: at })).toEqual([
      { grantId: g.id, amountMicroCents: -70n },
    ]);
    expect(await unsettledRemainder(db, { organizationId: orgId }, at)).toBe(0n);
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
      const first = await writeSettlements(tx as typeof db, { organizationId: orgId }, [taken], d('02-02'));
      const second = await writeSettlements(tx as typeof db, { organizationId: orgId }, [taken], d('02-02'));
      return { first, second, count: await tx.creditLedgerEntry.count() };
    });
    expect(after).toEqual({ first: 1, second: 0, count: 2 });
  });

  it('S5: a fully used grant is settled once with a zero entry; the next call ends at the probe', async () => {
    const g = await grant(100, d('01-01'), d('02-01'));
    await debit(100, d('01-10'));
    // The control: a call the probe lets through reads the ledger through the counted client.
    const first = countingLedgerReads();
    expect(await settleExpiredGrants(first.client, { organizationId: orgId }, { now: d('02-02') })).toEqual([
      { grantId: g.id, amountMicroCents: 0n },
    ]);
    expect(first.counter.reads).toBeGreaterThan(0);
    expect((await settlements()).map((s) => s.amountMicroCents)).toEqual([0n]);
    const { client, counter } = countingLedgerReads();
    expect(await settleExpiredGrants(client, { organizationId: orgId }, { now: d('03-01') })).toEqual([]);
    expect(counter.reads).toBe(0);
  });

  it('S6: a grant with no expiry is never touched; the probe ends the call', async () => {
    await grant(100, d('01-01'), null);
    await debit(30, d('01-10'));
    const { client, counter } = countingLedgerReads();
    expect(await settleExpiredGrants(client, { organizationId: orgId }, { now: d('12-31') })).toEqual([]);
    expect(counter.reads).toBe(0);
    expect(await settlements()).toHaveLength(0);
    expect(await unsettledRemainder(db, { organizationId: orgId }, d('12-31'))).toBe(0n);
  });

  it('S7: a soft-deleted debit is ignored by the replay, as by the balance (a legacy row the #5010 guard would refuse today)', async () => {
    // Since #5010 (cor:dmo:170:08) the database refuses a soft-deleted ledger entry (CHECK chk_credit_ledger_not_soft_deleted),
    // so no live path can write one. The filter stays because creditBalance keeps it for a database where that migration was
    // refused (HDPRF) and the old schema is still served; this pin proves the replay agrees with it. The guard is bypassed
    // EXPLICITLY: the CHECK is dropped inside one transaction (DDL is transactional) that is always rolled back, so no other
    // test sees the dropped constraint.
    const g = await grant(100, d('01-01'), d('02-01'));
    const rollback = new Error('rollback S7');
    let seen: [string | null, bigint][] = [];
    await expect(
      db.$transaction(async (tx) => {
        await tx.$executeRawUnsafe('ALTER TABLE credit_ledger_entries DROP CONSTRAINT chk_credit_ledger_not_soft_deleted');
        await tx.creditLedgerEntry.create({
          data: {
            id: generateId(),
            organizationId: orgId,
            kind: 'debit',
            amountMicroCents: -30n,
            sourceType: 'usage-event',
            sourceId: generateId(),
            createdAt: d('01-10'),
            deletedAt: d('01-11'),
          },
        });
        await settleExpiredGrants(tx as unknown as typeof db, { organizationId: orgId }, { now: d('02-02') });
        const rows = await tx.creditLedgerEntry.findMany({ where: { sourceType: 'grant-expiry' } });
        seen = rows.map((r) => [r.sourceId, r.amountMicroCents]);
        throw rollback;
      }),
    ).rejects.toBe(rollback);
    expect(seen).toEqual([[g.id, -100n]]);
    expect(await settlements()).toHaveLength(0);
  });

  it('another organization\'s entries take no part', async () => {
    const other = (await db.organization.create({ data: { id: generateId(), name: 'ce-other', urn: 'ce-other' } })).id;
    const g = await grant(100, d('01-01'), d('02-01'));
    await debit(90, d('01-10'), null, other);
    await settleExpiredGrants(db, { organizationId: orgId }, { now: d('02-02') });
    expect((await settlements()).map((s) => [s.sourceId, s.amountMicroCents])).toEqual([[g.id, -100n]]);
  });

  it('a person owner is settled too, and never read as an organization (flipped by #5014: A4 refused it until A6)', async () => {
    const user = (await db.user.create({ data: { id: generateId(), handle: `ce-${generateId().slice(0, 8)}` } })).id;
    const g = await db.creditLedgerEntry.create({
      data: { id: generateId(), ownerUserId: user, kind: 'grant', amountMicroCents: 100n, sourceType: 't', sourceId: generateId(), expiresAt: d('02-01'), createdAt: d('01-01') },
    });
    expect(await settleExpiredGrants(db, { userId: user }, { now: d('02-02') })).toEqual([{ grantId: g.id, amountMicroCents: -100n }]);
    expect(await db.creditLedgerEntry.count({ where: { sourceType: 'grant-expiry', ownerUserId: user, organizationId: null } })).toBe(1);
  });

  it('with no `now`, the database clock is used', async () => {
    const dbNow = await databaseNow(db);
    const g = await grant(100, later(dbNow, -3_600_000), later(dbNow, -120_000));
    expect(await settleExpiredGrants(db, { organizationId: orgId })).toEqual([{ grantId: g.id, amountMicroCents: -100n }]);
  });
});

describe('#5242 item 1: the window drops a grant whose expiry precedes its creation', () => {
  // A row only a direct database write can make (the mutation refuses a grant dated in the past): created at 02-10, "expired" at 02-01.
  it('is no expiring grant: it stays in the running balance as plain credit, is never settled and never reported unsettled, next to a legitimate expired grant', async () => {
    const owner = { organizationId: orgId };
    const good = await grant(100, d('01-01'), d('02-01'));
    const odd = await grant(500, d('02-10'), d('02-01'));
    const now = d('02-20');
    const window = await readReplayWindow(db, owner, now);
    const entry = (id: string) => window?.entries.find((e) => e.id === id);
    expect(entry(good.id)?.expiresAt).toEqual(d('02-01')); // the legitimate grant still expires
    expect(entry(odd.id)).toBeDefined(); // its amount is a real entry of the ledger ...
    expect(entry(odd.id)?.expiresAt).toBeNull(); // ... but it never expires
    const m = await settleAndMeasure(db, owner, now, { write: true });
    expect(m.settled).toEqual([{ grantId: good.id, amountMicroCents: -100n }]); // only the legitimate grant, nothing of the odd one
    expect(m.unsettled).toBe(0n);
    expect((await settlements()).map((r) => r.sourceId)).toEqual([good.id]);
    // The balance keeps the odd row's credit: the stored sum less what the settlement took.
    const sum = (await db.creditLedgerEntry.aggregate({ where: { organizationId: orgId }, _sum: { amountMicroCents: true } }))._sum.amountMicroCents;
    expect(sum).toBe(500n);
  });

  it('an organization that holds only such a row: no replay, nothing settled, the balance is the stored sum', async () => {
    const owner = { organizationId: orgId };
    await grant(500, d('02-10'), d('02-01'));
    const now = d('02-20');
    expect(await readReplayWindow(db, owner, now)).toBeNull();
    expect(await settleAndMeasure(db, owner, now, { write: true })).toEqual({ settled: [], unsettled: 0n, replay: undefined });
    expect(await settlements()).toHaveLength(0);
  });
});
