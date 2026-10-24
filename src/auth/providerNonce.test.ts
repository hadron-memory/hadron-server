/**
 * #2204 — the OIDC nonce: generation, the callback's expectation, enforcement against a token's claim, the stored
 * hash and its database guard. The verifiers and the HTTP legs have their own cases in google/apple.test.ts and
 * freshSignInRoutes1631.test.ts.
 */
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { claimPendingLoginState, createPendingLoginState } from './pendingLoginState.js';
import {
  enforceIdTokenNonce,
  hashProviderNonce,
  mintProviderNonce,
  nonceExpectation,
  nonceRefusals,
} from './providerNonce.js';

const HASH = 'f'.repeat(64);

describe('mintProviderNonce', () => {
  it('is 256 random bits, base64url, and hashes to what is stored', () => {
    const a = mintProviderNonce();
    const b = mintProviderNonce();
    expect(a.nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a.nonce).not.toBe(b.nonce);
    expect(a.nonceHash).toBe(hashProviderNonce(a.nonce));
    expect(a.nonceHash).toMatch(/^[0-9a-f]{64}$/);
    expect(a.nonceHash).not.toContain(a.nonce);
  });
});

describe('nonceExpectation', () => {
  it('a row with a hash is always bound, ceremony or not', () => {
    expect(nonceExpectation({ providerNonceHash: HASH })).toEqual({ bound: HASH });
    expect(nonceExpectation({ providerNonceHash: HASH, ceremonyNonceHash: 'c' })).toEqual({ bound: HASH });
  });

  it('only a row WITHOUT a hash skips, and never on the ceremony branch', () => {
    expect(nonceExpectation({})).toEqual({ legacyUnbound: true });
    expect(nonceExpectation({ ceremonyNonceHash: 'c' })).toBeNull();
  });
});

describe('enforceIdTokenNonce', () => {
  const { nonce, nonceHash } = mintProviderNonce();
  const bound = { bound: nonceHash };
  beforeEach(() => vi.spyOn(console, 'warn').mockImplementation(() => undefined));
  afterEach(() => vi.restoreAllMocks());

  it('accepts the matching nonce', () => {
    expect(() => enforceIdTokenNonce('google', nonce, bound)).not.toThrow();
    expect(() => enforceIdTokenNonce('apple', nonce, bound)).not.toThrow();
  });

  it.each([undefined, null, '', 0, 42, {}, ['x'], true])('refuses a bound row when the claim is %j', (claim) => {
    expect(() => enforceIdTokenNonce('google', claim, bound)).toThrow('ID token nonce missing or mismatched');
  });

  it('refuses a different nonce, including the HASH presented as the nonce', () => {
    expect(() => enforceIdTokenNonce('apple', mintProviderNonce().nonce, bound)).toThrow('ID token nonce missing or mismatched');
    expect(() => enforceIdTokenNonce('apple', nonceHash, bound)).toThrow('ID token nonce missing or mismatched');
  });

  it('skips only a legacy-unbound row, whatever the claim', () => {
    expect(() => enforceIdTokenNonce('google', undefined, { legacyUnbound: true })).not.toThrow();
  });

  it('counts refusals per provider and never logs the nonce, the hash or the token', () => {
    const warn = vi.mocked(console.warn);
    const before = { g: nonceRefusals.google.mismatch, a: nonceRefusals.apple.missing };
    expect(() => enforceIdTokenNonce('google', 'some-other-nonce', bound)).toThrow();
    expect(() => enforceIdTokenNonce('apple', undefined, bound)).toThrow();
    expect(nonceRefusals.google.mismatch).toBe(before.g + 1);
    expect(nonceRefusals.apple.missing).toBe(before.a + 1);
    const logged = warn.mock.calls.flat().join('\n');
    expect(logged).toContain('provider=google reason=mismatch');
    expect(logged).toContain('provider=apple reason=missing');
    expect(logged).not.toContain('some-other-nonce');
    expect(logged).not.toContain(nonceHash);
  });
});

describe('the pending row', () => {
  beforeEach(async () => { await cleanDb(db); });
  const expiresAt = () => new Date(Date.now() + 60_000);

  it('carries the hash through create and claim, and the claim still burns the row', async () => {
    await createPendingLoginState('s1', { provider: 'google', data: { redirect: '/', clientState: 'c', providerNonceHash: HASH } });
    const claim = await claimPendingLoginState('s1', 'google');
    expect(claim).toMatchObject({ ok: true, pending: { providerNonceHash: HASH, clientState: 'c' } });
    expect(await claimPendingLoginState('s1', 'google')).toMatchObject({ ok: false });
  });

  it('a cross-provider claim burns nothing and returns no hash', async () => {
    await createPendingLoginState('s2', { provider: 'apple', data: { redirect: '/', providerNonceHash: HASH } });
    expect(await claimPendingLoginState('s2', 'google')).toMatchObject({ ok: false });
    expect(await claimPendingLoginState('s2', 'apple')).toMatchObject({ ok: true, pending: { providerNonceHash: HASH } });
  });

  it('github stores none', async () => {
    await createPendingLoginState('s3', { provider: 'github', data: { redirect: '/', clientState: 'c' } });
    expect(await claimPendingLoginState('s3', 'github')).toMatchObject({ ok: true, pending: { providerNonceHash: undefined } });
  });

  it.each(['google', 'apple'])('the database refuses a NEW %s row without a hash (23514)', async (provider) => {
    await expect(db.pendingLoginState.create({ data: { state: 's4', provider, redirect: '/', expiresAt: expiresAt() } }))
      .rejects.toThrow(/chk_pending_login_provider_nonce/);
    await expect(db.$executeRaw`INSERT INTO pending_login_states (state, provider, expires_at) VALUES ('s5', ${provider}, now() + interval '1 minute')`)
      .rejects.toThrow(/chk_pending_login_provider_nonce/);
  });

  it('the database refuses a malformed hash on any provider, and accepts github without one', async () => {
    await expect(db.$executeRaw`INSERT INTO pending_login_states (state, provider, provider_nonce_hash, expires_at) VALUES ('s6', 'google', 'XYZ', now() + interval '1 minute')`)
      .rejects.toThrow(/chk_pending_login_provider_nonce/);
    await expect(db.$executeRaw`INSERT INTO pending_login_states (state, provider, expires_at) VALUES ('s7', 'github', now() + interval '1 minute')`)
      .resolves.toBe(1);
  });

  it('a legacy NULL google row (minted before the guard) is still claimable, and is the only way to be NULL', async () => {
    await db.$executeRaw`ALTER TABLE pending_login_states DROP CONSTRAINT chk_pending_login_provider_nonce`;
    try {
      await db.pendingLoginState.create({ data: { state: 's8', provider: 'google', redirect: '/', expiresAt: expiresAt() } });
    } finally {
      for (const stmt of readFileSync('prisma/login-nonce-invariants.sql', 'utf8').split(/;\s*\n/).filter((x) => x.includes('ALTER TABLE'))) await db.$executeRawUnsafe(stmt);
    }
    // Re-adding the guard NOT VALID neither scans nor rejects the old row.
    const claim = await claimPendingLoginState('s8', 'google');
    expect(claim).toMatchObject({ ok: true });
    if (claim.ok) expect(nonceExpectation(claim.pending)).toEqual({ legacyUnbound: true });
  });
});

describe('comparison', () => {
  it('uses the shared constant-time compare, not ===/== (behaviourally invisible, so pinned in source)', () => {
    const src = readFileSync('src/auth/providerNonce.ts', 'utf8');
    expect(src).toContain("import { safeEqual } from '../lib/constantTime.js'");
    expect(src).toMatch(/safeEqual\(hashProviderNonce\(claim\), expected\.bound\)/);
    expect(src).not.toMatch(/(===|==|!==)\s*expected\.bound/);
  });
});

describe('the guard has one source', () => {
  it('the migration and both schema-push paths carry the same SQL', () => {
    const guard = readFileSync('prisma/login-nonce-invariants.sql', 'utf8');
    expect(readFileSync('prisma/migrations/20261023120000_pending_login_provider_nonce/migration.sql', 'utf8').endsWith(guard)).toBe(true);
    expect(readFileSync('prisma/post-push.sql', 'utf8')).toContain('\\ir login-nonce-invariants.sql');
    expect(readFileSync('src/test/globalSetup.ts', 'utf8')).toContain('../../prisma/login-nonce-invariants.sql');
    expect(guard).toContain('NOT VALID');
  });
});
