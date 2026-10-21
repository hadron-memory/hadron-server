/**
 * #477 — single-use auth handoff codes (security core).
 *
 * Pins the properties the login-handoff + Exchange-start rewiring depends on:
 *   - single use: a second redemption of the same code fails (atomic claim).
 *   - expiry is enforced.
 *   - session-fixation binding: a code minted WITH a clientState requires the
 *     matching raw nonce; a missing or wrong nonce is rejected. A code minted
 *     WITHOUT one (email flow) redeems with no nonce.
 *   - redirect / isNew / orgId round-trip through the code record, not a URL.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import {
  issueLoginCode,
  redeemLoginCode,
  issueExchangeStartNonce,
  redeemExchangeStartNonce,
} from './authHandoff.js';

let userId: string;

beforeEach(async () => {
  await cleanDb(db);
  const user = await db.user.create({
    data: { githubId: 4771, githubUsername: 'handoff-user', roles: ['READER'] },
  });
  userId = user.id;
});

describe('login handoff codes', () => {
  it('issues an opaque code and redeems it once, returning redirect + isNew', async () => {
    const code = await issueLoginCode({ userId, redirect: '/app/setup', isNew: true });
    expect(code).toMatch(/^[0-9a-f]{64}$/); // 256-bit hex, never the JWT

    const redeemed = await redeemLoginCode(code);
    expect(redeemed).toEqual({ userId, redirect: '/app/setup', isNew: true, signInId: null });

    // Single use: a replay fails.
    expect(await redeemLoginCode(code)).toBeNull();
  });

  it('rejects an expired code', async () => {
    const code = await issueLoginCode({ userId, redirect: '/', isNew: false });
    // Force expiry in the past.
    await db.authHandoffCode.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    expect(await redeemLoginCode(code)).toBeNull();
  });

  it('rejects an unknown code', async () => {
    expect(await redeemLoginCode('deadbeef'.repeat(8))).toBeNull();
  });

  describe('session-fixation binding (GitHub flow)', () => {
    it('redeems when the presented clientState matches', async () => {
      const code = await issueLoginCode({
        userId,
        redirect: '/app',
        isNew: false,
        clientState: 'browser-nonce-abc',
      });
      const redeemed = await redeemLoginCode(code, 'browser-nonce-abc');
      expect(redeemed?.userId).toBe(userId);
    });

    it('rejects when the clientState is wrong (attacker browser)', async () => {
      const code = await issueLoginCode({
        userId,
        redirect: '/app',
        isNew: false,
        clientState: 'browser-nonce-abc',
      });
      expect(await redeemLoginCode(code, 'browser-nonce-WRONG')).toBeNull();
    });

    it('rejects when the code is bound but no clientState is presented', async () => {
      const code = await issueLoginCode({
        userId,
        redirect: '/app',
        isNew: false,
        clientState: 'browser-nonce-abc',
      });
      expect(await redeemLoginCode(code)).toBeNull();
    });

    it('a failed clientState check still consumes the code (no retry)', async () => {
      // The atomic claim marks the row redeemed before the binding check, so a
      // guessed code is burned on the first wrong-nonce attempt.
      const code = await issueLoginCode({
        userId,
        redirect: '/app',
        isNew: false,
        clientState: 'browser-nonce-abc',
      });
      expect(await redeemLoginCode(code, 'wrong')).toBeNull();
      expect(await redeemLoginCode(code, 'browser-nonce-abc')).toBeNull();
    });

    it('binds via a pre-hashed clientStateHash (email flow, #505)', async () => {
      // The email flow only has the hash at mint time (raw nonce lived in a
      // request-time cookie); issueLoginCode must bind on it identically.
      const nonce = 'email-browser-nonce';
      const clientStateHash = createHash('sha256').update(nonce).digest('hex');
      const code = await issueLoginCode({ userId, redirect: '/', isNew: false, clientStateHash });
      expect(await redeemLoginCode(code, 'wrong')).toBeNull();
      const again = await issueLoginCode({ userId, redirect: '/', isNew: false, clientStateHash });
      expect((await redeemLoginCode(again, nonce))?.userId).toBe(userId);
    });

    it('a code with neither clientState nor clientStateHash is unbound', async () => {
      const code = await issueLoginCode({ userId, redirect: '/', isNew: false });
      expect((await redeemLoginCode(code))?.userId).toBe(userId);
    });
  });
});

describe('exchange-start nonces', () => {
  it('issues and redeems once, returning orgId + redirect', async () => {
    const nonce = await issueExchangeStartNonce({
      userId,
      orgId: 'org_123',
      redirect: '/app/orgs/org_123/integrations',
    });
    const redeemed = await redeemExchangeStartNonce(nonce);
    expect(redeemed).toEqual({
      userId,
      orgId: 'org_123',
      redirect: '/app/orgs/org_123/integrations',
    });
    // Single use.
    expect(await redeemExchangeStartNonce(nonce)).toBeNull();
  });

  it('a login code is not redeemable as an exchange nonce (kind-scoped)', async () => {
    const login = await issueLoginCode({ userId, redirect: '/', isNew: false });
    expect(await redeemExchangeStartNonce(login)).toBeNull();
  });
});

it('preserves the verified login time through handoff instead of refreshing it', async () => {
  const login = { at: Date.now() - 30_000, method: 'github' as const };
  const code = await issueLoginCode({ userId, redirect: '/', isNew: false, login });
  expect((await redeemLoginCode(code))?.login).toEqual(login);
  const ordinary = await issueLoginCode({ userId, redirect: '/', isNew: false });
  expect((await redeemLoginCode(ordinary))?.login).toBeUndefined();
});
