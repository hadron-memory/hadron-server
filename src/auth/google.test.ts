/**
 * #581 — Sign-in-with-Google unit tests.
 *
 * Pins the pieces the route handlers depend on:
 *   - buildGoogleAuthUrl: login-only scopes (no gmail, no offline access),
 *     BASE_URL-derived redirect_uri.
 *   - verifyGoogleIdToken: signature/issuer/audience are actually verified
 *     (wrong audience/issuer/signature all throw), claims are extracted, and
 *     email_verified fails closed on non-boolean values. Uses a locally
 *     generated key pair injected as the JWKS — no network.
 *   - resolveGoogleUser: the three provisioning branches (by googleId / by
 *     verified email → link / fresh user) and the unverified-email refusals.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  SignJWT,
  exportJWK,
  generateKeyPair,
  createLocalJWKSet,
  type JWTVerifyGetKey,
} from 'jose';
import { mintProviderNonce } from './providerNonce.js';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import {
  buildGoogleAuthUrl,
  verifyGoogleIdToken,
  resolveGoogleUser,
  googleReauthenticatedSince,
  type GoogleIdentity,
} from './google.js';

// Pre-#2204 rows carry no nonce hash; the nonce paths have their own tests in providerNonce.test.ts.
const LEGACY = { legacyUnbound: true } as const;

const CLIENT_ID = 'test-client-id.apps.googleusercontent.com';

beforeEach(() => {
  vi.stubEnv('GOOGLE_CLIENT_ID', CLIENT_ID);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('buildGoogleAuthUrl', () => {
  it('#2204: sends the nonce it is given, and requires one', () => {
    expect(new URL(buildGoogleAuthUrl('s', 'nonce-xyz')).searchParams.get('nonce')).toBe('nonce-xyz');
    // @ts-expect-error — the nonce is a required argument, there is no default
    expect(() => buildGoogleAuthUrl('s')).not.toThrow();
  });

  it('carries login-only scopes, no offline access, and the state', () => {
    const url = new URL(buildGoogleAuthUrl('state-abc', 'n'));
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('client_id')).toBe(CLIENT_ID);
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('scope')).toBe('openid email profile');
    expect(url.searchParams.get('state')).toBe('state-abc');
    // Login needs no refresh token, and this client must never carry gmail
    // scopes (#580 separation — restricted-scope verification).
    expect(url.searchParams.get('access_type')).toBeNull();
    expect(url.searchParams.get('scope')).not.toMatch(/gmail/);
  });

  it('#1631: asks for re-authentication (max_age=0) only on the ceremony leg', () => {
    expect(new URL(buildGoogleAuthUrl('s', 'n')).searchParams.get('max_age')).toBeNull();
    expect(new URL(buildGoogleAuthUrl('s', 'n', { reauthenticate: true })).searchParams.get('max_age')).toBe('0');
  });

  it('derives redirect_uri from BASE_URL, not per-request headers', () => {
    vi.stubEnv('BASE_URL', 'https://hadron.example.com');
    const url = new URL(buildGoogleAuthUrl('s', 'n'));
    expect(url.searchParams.get('redirect_uri')).toBe(
      'https://hadron.example.com/auth/google/callback',
    );
  });

  it('falls back to localhost:PORT when BASE_URL is unset or empty', () => {
    vi.stubEnv('BASE_URL', '');
    vi.stubEnv('PORT', '4123');
    const url = new URL(buildGoogleAuthUrl('s', 'n'));
    expect(url.searchParams.get('redirect_uri')).toBe(
      'http://localhost:4123/auth/google/callback',
    );
  });
});

describe('verifyGoogleIdToken', () => {
  type SigningKey = Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];
  let getKey: JWTVerifyGetKey;
  let signKey: SigningKey;
  let wrongKey: SigningKey;

  beforeEach(async () => {
    const pair = await generateKeyPair('RS256');
    signKey = pair.privateKey;
    const jwk = await exportJWK(pair.publicKey);
    getKey = createLocalJWKSet({ keys: [{ ...jwk, alg: 'RS256', use: 'sig' }] });
    const wrongPair = await generateKeyPair('RS256');
    wrongKey = wrongPair.privateKey;
  });

  function mintIdToken(
    claims: Record<string, unknown>,
    opts: { issuer?: string; audience?: string; key?: SigningKey } = {},
  ): Promise<string> {
    return new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuedAt()
      .setIssuer(opts.issuer ?? 'https://accounts.google.com')
      .setAudience(opts.audience ?? CLIENT_ID)
      .setExpirationTime('5m')
      .sign(opts.key ?? signKey);
  }

  it('returns the identity claims from a valid token', async () => {
    const token = await mintIdToken({
      sub: '110248495921238986420',
      email: 'ada@example.com',
      email_verified: true,
      name: 'Ada Lovelace',
      picture: 'https://lh3.googleusercontent.com/a/pic',
    });
    expect(await verifyGoogleIdToken(token, LEGACY, getKey)).toEqual({
      sub: '110248495921238986420',
      email: 'ada@example.com',
      emailVerified: true,
      name: 'Ada Lovelace',
      picture: 'https://lh3.googleusercontent.com/a/pic',
      authTime: null,
    } satisfies GoogleIdentity);
  });

  it('#1631: reads auth_time, and ignores a non-numeric one', async () => {
    expect((await verifyGoogleIdToken(await mintIdToken({ sub: '42', auth_time: 1_700_000_000 }), LEGACY, getKey)).authTime).toBe(1_700_000_000);
    expect((await verifyGoogleIdToken(await mintIdToken({ sub: '42', auth_time: '1700000000' }), LEGACY, getKey)).authTime).toBeNull();
  });

  it('accepts the bare accounts.google.com issuer form', async () => {
    const token = await mintIdToken({ sub: '42' }, { issuer: 'accounts.google.com' });
    expect((await verifyGoogleIdToken(token, LEGACY, getKey)).sub).toBe('42');
  });

  it('rejects a token for a different audience (another OAuth client)', async () => {
    const token = await mintIdToken({ sub: '42' }, { audience: 'other-client' });
    await expect(verifyGoogleIdToken(token, LEGACY, getKey)).rejects.toThrow();
  });

  it('rejects a token from a different issuer', async () => {
    const token = await mintIdToken({ sub: '42' }, { issuer: 'https://evil.example' });
    await expect(verifyGoogleIdToken(token, LEGACY, getKey)).rejects.toThrow();
  });

  it('rejects a token signed by a different key', async () => {
    const token = await mintIdToken({ sub: '42' }, { key: wrongKey });
    await expect(verifyGoogleIdToken(token, LEGACY, getKey)).rejects.toThrow();
  });

  it('rejects a token without a sub claim', async () => {
    const token = await mintIdToken({ email: 'ada@example.com' });
    await expect(verifyGoogleIdToken(token, LEGACY, getKey)).rejects.toThrow(/sub/);
  });

  it('lowercases the email claim (parity with the magic-link flow)', async () => {
    // The magic-link flow stores email.toLowerCase(); a raw mixed-case Google
    // claim would miss that row on the case-sensitive unique and fork a
    // second account instead of linking (Codex/Copilot review on PR #582).
    const token = await mintIdToken({
      sub: '42',
      email: 'Ada@Example.COM',
      email_verified: true,
    });
    const identity = await verifyGoogleIdToken(token, LEGACY, getKey);
    expect(identity.email).toBe('ada@example.com');
  });

  it('fails closed on a non-boolean email_verified', async () => {
    // A string "true" must NOT authorize account linking.
    const token = await mintIdToken({
      sub: '42',
      email: 'ada@example.com',
      email_verified: 'true',
    });
    const identity = await verifyGoogleIdToken(token, LEGACY, getKey);
    expect(identity.emailVerified).toBe(false);
  });

  describe('#2204 nonce', () => {
    const { nonce, nonceHash } = mintProviderNonce();
    const bound = { bound: nonceHash };
    beforeEach(() => vi.spyOn(console, 'warn').mockImplementation(() => undefined));
    afterEach(() => vi.restoreAllMocks());

    it('accepts a token whose nonce hashes to the stored value', async () => {
      expect((await verifyGoogleIdToken(await mintIdToken({ sub: '42', nonce }), bound, getKey)).sub).toBe('42');
    });

    it.each([
      ['missing', undefined],
      ['empty', ''],
      ['not a string', 42],
      ['another attempt\'s', mintProviderNonce().nonce],
    ])('refuses a %s nonce on a bound row with a fixed message', async (_c, claim) => {
      const token = await mintIdToken({ sub: '42', nonce: claim });
      const err = await verifyGoogleIdToken(token, bound, getKey).catch((e: Error) => e);
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toBe('ID token nonce missing or mismatched');
      expect((err as Error).message).not.toContain(token);
    });

    it('still refuses a wrong signature, issuer or audience when the nonce is right', async () => {
      await expect(verifyGoogleIdToken(await mintIdToken({ sub: '42', nonce }, { key: wrongKey }), bound, getKey)).rejects.toThrow();
      await expect(verifyGoogleIdToken(await mintIdToken({ sub: '42', nonce }, { audience: 'other' }), bound, getKey)).rejects.toThrow();
      await expect(verifyGoogleIdToken(await mintIdToken({ sub: '42', nonce }, { issuer: 'https://evil.example' }), bound, getKey)).rejects.toThrow();
    });
  });
});

describe('resolveGoogleUser', () => {
  beforeEach(async () => {
    await cleanDb(db);
  });

  const identity: GoogleIdentity = {
    sub: '110248495921238986420',
    email: 'ada@example.com',
    emailVerified: true,
    name: 'Ada Lovelace',
    picture: 'https://pic.example/ada',
    authTime: null,
  };

  it('(a) resolves a returning user by googleId', async () => {
    const existing = await db.user.create({
      data: { googleId: identity.sub, identityProvider: 'GOOGLE', roles: ['READER'] },
    });
    const user = await resolveGoogleUser(identity);
    expect(user.id).toBe(existing.id);
    // Fills the missing profile fields without creating a second row.
    expect(user.name).toBe('Ada Lovelace');
    expect(await db.user.count()).toBe(1);
  });

  it('flags (never blocks) a returning sign-in whose stored address differs from the verified claim', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const existing = await db.user.create({
        data: { googleId: identity.sub, email: 'Other@Example.com', identityProvider: 'GOOGLE', roles: ['READER'] },
      });
      const user = await resolveGoogleUser(identity);
      expect(user.id).toBe(existing.id);
      expect(user.email).toBe('Other@Example.com');
      // Exact text: non-leakage is the point, so no part of either address
      // (local part, domain, length or hash) may appear in the line.
      expect(warn.mock.calls).toEqual([[
        `[auth] google sign-in for user ${existing.id}: the stored address differs from the provider's verified address; review per #1802`,
      ]]);
    } finally {
      warn.mockRestore();
    }
  });

  it.each([
    ['the same address in another case', 'ADA@example.com ', true],
    ['no stored address', null, true],
    ['an unverified claim', 'other@example.com', false],
  ])('no mismatch flag for %s', async (_label, stored, verified) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await db.user.create({ data: { googleId: identity.sub, email: stored, identityProvider: 'GOOGLE', roles: ['READER'] } });
      await resolveGoogleUser({ ...identity, emailVerified: verified });
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('(b) links an existing user by email when Google verified it', async () => {
    const existing = await db.user.create({
      data: {
        email: 'ada@example.com',
        identityProvider: 'EMAIL',
        name: 'Ada',
        roles: ['READER'],
      },
    });
    const user = await resolveGoogleUser(identity);
    expect(user.id).toBe(existing.id);
    expect(user.googleId).toBe(identity.sub);
    // Linking keeps the original provider and never overwrites an existing name.
    expect(user.identityProvider).toBe('EMAIL');
    expect(user.name).toBe('Ada');
    expect(await db.user.count()).toBe(1);
  });

  it('(b-refusal) does NOT link by email when email_verified is false', async () => {
    // Account-takeover vector: an attacker's Google account claiming (but not
    // verifying) the victim's email must not inherit the victim's user row.
    const victim = await db.user.create({
      data: { email: 'ada@example.com', identityProvider: 'EMAIL', roles: ['READER'] },
    });
    const user = await resolveGoogleUser({ ...identity, emailVerified: false });
    expect(user.id).not.toBe(victim.id);
    expect((await db.user.findUnique({ where: { id: victim.id } }))!.googleId).toBeNull();
    // And the fresh row must not squat the unverified address either (it would
    // collide with the victim's unique email — and become a magic-link identity).
    expect(user.email).toBeNull();
  });

  it('(b-refusal) does NOT relink a row already bound to a DIFFERENT Google account', async () => {
    // Recycled-email takeover: a Workspace admin recreates a deleted account
    // with the same address — same verified email, new `sub`. The old row's
    // Google identity must stay put; the new account gets a fresh user.
    const original = await db.user.create({
      data: {
        googleId: 'old-sub-123',
        email: 'ada@example.com',
        identityProvider: 'GOOGLE',
        roles: ['READER'],
      },
    });
    const user = await resolveGoogleUser(identity); // sub differs from old-sub-123
    expect(user.id).not.toBe(original.id);
    expect(user.googleId).toBe(identity.sub);
    // The email stays on (and unique to) the originally linked row.
    expect(user.email).toBeNull();
    expect((await db.user.findUnique({ where: { id: original.id } }))!.googleId).toBe(
      'old-sub-123',
    );
  });

  it('(c) creates a fresh user with identityProvider GOOGLE and a generated handle', async () => {
    const user = await resolveGoogleUser(identity);
    expect(user.googleId).toBe(identity.sub);
    expect(user.identityProvider).toBe('GOOGLE');
    expect(user.email).toBe('ada@example.com');
    expect(user.name).toBe('Ada Lovelace');
    // Handle is NOT NULL (spec 047): seeded from the display name.
    expect(user.handle).toBe('ada-lovelace');
    expect(user.roles).toEqual(['READER']);
  });

  it('(c) is idempotent — a second login resolves the same row', async () => {
    const first = await resolveGoogleUser(identity);
    const second = await resolveGoogleUser(identity);
    expect(second.id).toBe(first.id);
    expect(await db.user.count()).toBe(1);
  });
});

describe('#1631 googleReauthenticatedSince (R154)', () => {
  const started = new Date('2026-10-21T08:00:00Z');
  const at = (iso: string) => Date.parse(iso) / 1000;
  it('accepts an authentication at or after the leg began, within the skew', () => {
    expect(googleReauthenticatedSince(at('2026-10-21T08:00:05Z'), started)).toBe(true);
    expect(googleReauthenticatedSince(at('2026-10-21T07:59:00Z'), started)).toBe(true);
  });
  it('refuses an older authentication (a silent session) and a missing auth_time', () => {
    expect(googleReauthenticatedSince(at('2026-10-21T07:58:59Z'), started)).toBe(false);
    expect(googleReauthenticatedSince(null, started)).toBe(false);
  });
});
