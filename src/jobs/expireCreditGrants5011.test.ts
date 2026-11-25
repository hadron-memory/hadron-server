/**
 * #5011 (Billing A4): the hourly job that settles expired grants for every owner a read has not reached
 * (hrn:node:hadronmemory.com:specs:cor:dmo:170:10). Batches of owners with a keyset inside a run, at most `maxPasses`
 * batches, one owner's failure never stops the rest, and only the exact value `true` disables the loop.
 *
 * Red on main: `./expireCreditGrants.js` does not exist.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import { settleExpiredGrants } from '../lib/metering/settleExpiredGrants.js';
import { creditExpirySweepDisabledReason, expireCreditGrants } from './expireCreditGrants.js';

const d = (s: string) => new Date(`2027-${s}T00:00:00.000Z`);
const NOW = d('03-01');

async function org(name: string) {
  return (await db.organization.create({ data: { id: generateId(), name, urn: name } })).id;
}
async function grant(organizationId: string, expiresAt: Date | null) {
  return db.creditLedgerEntry.create({
    data: {
      id: generateId(),
      organizationId,
      kind: 'grant',
      amountMicroCents: 100n,
      expiresAt,
      sourceType: 'test-grant',
      sourceId: generateId(),
      createdAt: d('01-01'),
    },
  });
}
const settledOrgs = async () =>
  (await db.creditLedgerEntry.findMany({ where: { sourceType: 'grant-expiry' }, select: { organizationId: true } }))
    .map((r) => r.organizationId)
    .sort();

beforeEach(async () => {
  await cleanDb(db);
});

describe('#5011 expireCreditGrants', () => {
  it('J1: settles every owner holding an expired, unsettled grant; a second run settles nothing', async () => {
    const owners = [await org('cj-a'), await org('cj-b'), await org('cj-c')];
    for (const o of owners) await grant(o, d('02-01'));
    const done = await org('cj-done');
    await grant(done, d('02-01'));
    await settleExpiredGrants(db, { organizationId: done }, { now: NOW });
    const none = await org('cj-none');
    await grant(none, null);
    await grant(none, d('12-01'));

    expect(await expireCreditGrants(db, { now: NOW })).toEqual({ owners: 3, settlements: 3, failures: 0 });
    expect(await settledOrgs()).toEqual([...owners, done].sort());
    expect(await expireCreditGrants(db, { now: NOW })).toEqual({ owners: 0, settlements: 0, failures: 0 });
  });

  it('J1b: a grant expired less than 60 s ago waits for the next run', async () => {
    const o = await org('cj-recent');
    await grant(o, new Date(NOW.getTime() - 30_000));
    expect(await expireCreditGrants(db, { now: NOW })).toEqual({ owners: 0, settlements: 0, failures: 0 });
  });

  it('J2: batchSize 2 and maxPasses 1 over five owners settles two, leaving three for the next run', async () => {
    for (let i = 0; i < 5; i++) await grant(await org(`cj-b${i}`), d('02-01'));
    expect(await expireCreditGrants(db, { now: NOW, batchSize: 2, maxPasses: 1 })).toEqual({
      owners: 2,
      settlements: 2,
      failures: 0,
    });
    expect(await expireCreditGrants(db, { now: NOW, batchSize: 2, maxPasses: 5 })).toEqual({
      owners: 3,
      settlements: 3,
      failures: 0,
    });
  });

  it('J3: an owner whose settlement throws is counted and passed; the others are settled and the run returns', async () => {
    const owners = [await org('cj-f1'), await org('cj-f2'), await org('cj-f3')];
    for (const o of owners) await grant(o, d('02-01'));
    const failing = owners[1];
    const settle: typeof settleExpiredGrants = async (client, owner, opts) => {
      if ('organizationId' in owner && owner.organizationId === failing) throw Object.assign(new Error('boom'), { code: 'P2010' });
      return settleExpiredGrants(client, owner, opts);
    };
    // batchSize 1: the failing owner is not selected again within the run (keyset), so the run ends.
    expect(await expireCreditGrants(db, { now: NOW, batchSize: 1, settle })).toEqual({ owners: 2, settlements: 2, failures: 1 });
    expect(await settledOrgs()).toEqual([owners[0], owners[2]].sort());
  });

  it('J4: only NODE_ENV=test or the exact value true disables the loop', () => {
    expect(creditExpirySweepDisabledReason({ NODE_ENV: 'test' })).toBe('NODE_ENV=test');
    expect(creditExpirySweepDisabledReason({ NODE_ENV: 'production', DISABLE_CREDIT_EXPIRY_SWEEP: 'true' })).toBe(
      'DISABLE_CREDIT_EXPIRY_SWEEP',
    );
    expect(creditExpirySweepDisabledReason({ NODE_ENV: 'production', DISABLE_CREDIT_EXPIRY_SWEEP: '1' })).toBeNull();
    expect(creditExpirySweepDisabledReason({ NODE_ENV: 'production', DISABLE_CREDIT_EXPIRY_SWEEP: 'TRUE' })).toBeNull();
    expect(creditExpirySweepDisabledReason({ NODE_ENV: 'production' })).toBeNull();
  });
});
