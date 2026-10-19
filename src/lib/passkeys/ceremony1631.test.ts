/**
 * #1631 S2a PR1 red pins: the DB-backed ceremony state. Proposed interface
 * (src/lib/passkeys/ceremony.ts, absent on main, so this file fails to load):
 *   createCeremony(tx, { purpose, browserNonceHash, ttlSeconds }) -> { id }
 *   consumeCeremony(tx, { id, browserNonceHash, purpose }) -> Promise<boolean>
 * One use, bound to the browser that opened it and to its purpose, expiry on the DB clock.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { createCeremony, consumeCeremony } from './ceremony.js';

beforeEach(async () => { await cleanDb(db); });

const input = { purpose: 'SIGN_IN', browserNonceHash: 'a'.repeat(64), ttlSeconds: 300, challengeHash: 'b'.repeat(64) } as const;

describe('#1631 ceremony state', () => {
  it('is single-use: a replay of a consumed ceremony is refused', async () => {
    const { id } = await db.$transaction((tx) => createCeremony(tx, input));
    expect(await db.$transaction((tx) => consumeCeremony(tx, { id, browserNonceHash: input.browserNonceHash, purpose: 'SIGN_IN' }))).toBe(true);
    expect(await db.$transaction((tx) => consumeCeremony(tx, { id, browserNonceHash: input.browserNonceHash, purpose: 'SIGN_IN' }))).toBe(false);
  });

  it('exactly one of two concurrent consumers wins', async () => {
    const { id } = await db.$transaction((tx) => createCeremony(tx, input));
    const results = await Promise.all([1, 2].map(() =>
      db.$transaction((tx) => consumeCeremony(tx, { id, browserNonceHash: input.browserNonceHash, purpose: 'SIGN_IN' }))));
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('refuses another browser (fixation) and another purpose, without consuming it', async () => {
    const { id } = await db.$transaction((tx) => createCeremony(tx, input));
    expect(await db.$transaction((tx) => consumeCeremony(tx, { id, browserNonceHash: 'b'.repeat(64), purpose: 'SIGN_IN' }))).toBe(false);
    expect(await db.$transaction((tx) => consumeCeremony(tx, { id, browserNonceHash: input.browserNonceHash, purpose: 'STEP_UP_ONLY' }))).toBe(false);
    expect(await db.$transaction((tx) => consumeCeremony(tx, { id, browserNonceHash: input.browserNonceHash, purpose: 'SIGN_IN' }))).toBe(true);
  });

  it('expires on the database clock, not the caller clock', async () => {
    const { id } = await db.$transaction((tx) => createCeremony(tx, { ...input, ttlSeconds: 1 }));
    await db.$executeRaw`UPDATE passkey_ceremonies SET expires_at = expires_at - interval '2 seconds' WHERE id = ${id}`;
    expect(await db.$transaction((tx) => consumeCeremony(tx, { id, browserNonceHash: input.browserNonceHash, purpose: 'SIGN_IN' }))).toBe(false);
  });

  it('rolls the consume back with a failed outer transaction', async () => {
    const { id } = await db.$transaction((tx) => createCeremony(tx, input));
    await expect(db.$transaction(async (tx) => {
      expect(await consumeCeremony(tx, { id, browserNonceHash: input.browserNonceHash, purpose: 'SIGN_IN' })).toBe(true);
      throw new Error('refused later in the same transaction');
    })).rejects.toThrow('refused later');
    expect(await db.$transaction((tx) => consumeCeremony(tx, { id, browserNonceHash: input.browserNonceHash, purpose: 'SIGN_IN' }))).toBe(true);
  });
});
