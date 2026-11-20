/**
 * #3998 S3 / #3991 R1, R3: the grant is the secret-read counter. These database
 * pins need no S2 tables or secret value. Synthetic activation bypasses only the
 * INSERT guard in the existing fixture helper; every tested UPDATE runs the real
 * grant guard. The signing ceremony and reveal transaction get separate pins
 * once S2 has merged and S0 fixes the secret action's signed terms.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import {
  DB_NOW, dropTestActions, insertGrant, insertGrantUnguarded, raw, seedWorld, type World,
} from './grantFixtures3668.js';
import { readGrantForUpdate } from './live.js';

let w: World;
beforeEach(async () => { await cleanDb(db); w = await seedWorld(); });
afterAll(async () => { await cleanDb(db); await dropTestActions(); });

/** A live synthetic grant; fixtures may override a single liveness term. */
const live = (over: Parameters<typeof insertGrantUnguarded>[1] = {}) => insertGrantUnguarded(w, {
  activated_at: raw(`${DB_NOW} - interval '1 minute'`),
  starts_at: raw(`${DB_NOW} - interval '1 minute'`),
  expires_at: raw(`${DB_NOW} + interval '1 hour'`),
  max_uses: 3,
  ...over,
});

/** Exercise the guard directly: there is no resolver gate to mask a broken SQL predicate. */
const spend = (id: string, amount = 1) => db.$executeRaw`
  UPDATE grants SET use_count = use_count + ${amount}, updated_at = (clock_timestamp() AT TIME ZONE 'UTC')
  WHERE id = ${id}`;

async function count(id: string): Promise<number> {
  const rows = await db.$queryRaw<Array<{ use_count: number }>>`SELECT use_count FROM grants WHERE id = ${id}`;
  return rows[0].use_count;
}

describe('#3998 grant counter: exactly one use on a live row', () => {
  it('admits +1 without changing the version or any signed term', async () => {
    const id = await live();
    const before = await db.$queryRaw`SELECT action_values, starts_at, expires_at, max_uses, reason, version FROM grants WHERE id = ${id}`;
    await expect(spend(id)).resolves.toBe(1);
    expect(await count(id)).toBe(1);
    expect(await db.$queryRaw`SELECT action_values, starts_at, expires_at, max_uses, reason, version FROM grants WHERE id = ${id}`).toEqual(before);
  });

  it('admits repeated single spends up to the signed budget, then refuses', async () => {
    const id = await live({ max_uses: 2 });
    await expect(spend(id)).resolves.toBe(1);
    await expect(spend(id)).resolves.toBe(1);
    await expect(spend(id)).rejects.toThrow();
    expect(await count(id)).toBe(2);
    expect(await db.$transaction((tx) => readGrantForUpdate(tx, id))).toMatchObject({ live: false });
  });

  it('admits +1 on a live unlimited grant too', async () => {
    const id = await live({ max_uses: null, expires_at: null });
    await expect(spend(id)).resolves.toBe(1);
    expect(await count(id)).toBe(1);
  });

  it('refuses a rise of two, even when the budget has room', async () => {
    const id = await live();
    await expect(spend(id, 2)).rejects.toThrow();
    expect(await count(id)).toBe(0);
  });

  it('refuses a decrease that would restore a read', async () => {
    const id = await live({ use_count: 1 });
    await expect(spend(id, -1)).rejects.toThrow();
    expect(await count(id)).toBe(1);
  });

  it('does not combine a spend with an edit of the signed reason', async () => {
    const id = await live();
    await expect(db.$executeRaw`UPDATE grants SET use_count = use_count + 1, reason = 'different' WHERE id = ${id}`).rejects.toThrow();
    expect(await count(id)).toBe(0);
  });

  it('a rolled-back transaction spends nothing', async () => {
    const id = await live();
    const abort = new Error('deliberate abort after accepted spend');
    await expect(db.$transaction(async (tx) => {
      await tx.$executeRaw`UPDATE grants SET use_count = use_count + 1 WHERE id = ${id}`;
      throw abort;
    })).rejects.toBe(abort);
    expect(await count(id)).toBe(0);
  });
});

describe('#3998 grant counter: each non-live state refuses at the database', () => {
  it('pending', async () => {
    const id = await insertGrant(w, { max_uses: 1 });
    await expect(spend(id)).rejects.toThrow();
    expect(await count(id)).toBe(0);
  });

  it('revoked', async () => {
    const id = await live({ revoked_at: raw(DB_NOW), revoked_by: w.userId });
    await expect(spend(id)).rejects.toThrow();
    expect(await count(id)).toBe(0);
  });

  it('not started', async () => {
    const id = await live({ starts_at: raw(`${DB_NOW} + interval '30 minutes'`) });
    await expect(spend(id)).rejects.toThrow();
    expect(await count(id)).toBe(0);
  });

  it('expired', async () => {
    const id = await live({ starts_at: null, expires_at: raw(`${DB_NOW} - interval '1 second'`) });
    await expect(spend(id)).rejects.toThrow();
    expect(await count(id)).toBe(0);
  });

  it('spent', async () => {
    const id = await live({ max_uses: 1, use_count: 1 });
    await expect(spend(id)).rejects.toThrow();
    expect(await count(id)).toBe(1);
  });

  it('holder departed', async () => {
    const id = await live({ holder_departed_at: raw(DB_NOW) });
    await expect(spend(id)).rejects.toThrow();
    expect(await count(id)).toBe(0);
  });

  it('scope App deleted', async () => {
    const id = await live();
    await db.app.update({ where: { id: w.appId }, data: { deletedAt: new Date() } });
    await expect(spend(id)).rejects.toThrow();
    expect(await count(id)).toBe(0);
  });
});

describe('#3998 budget integrity independently of the UPDATE trigger', () => {
  it('the CHECK rejects a row already above max_uses, even with the insert trigger bypassed', async () => {
    await expect(live({ max_uses: 1, use_count: 2 })).rejects.toThrow(/check constraint/i);
  });

  it('two locked spenders at budget 1: one spends, the second sees spent', async () => {
    const id = await live({ max_uses: 1 });
    const attempt = () => db.$transaction(async (tx) => {
      const grant = await readGrantForUpdate(tx, id);
      if (!grant?.live) return 'SPENT';
      await tx.$executeRaw`UPDATE grants SET use_count = use_count + 1 WHERE id = ${id}`;
      return 'OK';
    });
    expect((await Promise.all([attempt(), attempt()])).sort()).toEqual(['OK', 'SPENT']);
    expect(await count(id)).toBe(1);
  });
});
