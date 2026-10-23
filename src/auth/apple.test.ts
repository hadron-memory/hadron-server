/**
 * #584 — Sign in with Apple unit tests. Mirrors google.test.ts (#582) plus
 * the Apple-specific pieces:
 *   - mintAppleClientSecret: the per-request ES256 client-secret JWT (kid /
 *     iss / sub / aud / short expiry), signed with a locally generated key.
 *   - verifyAppleIdToken: signature/issuer/audience actually verified, email
 *     lowercased, and the string-"true" email_verified quirk accepted while
 *     everything else fails closed.
 *   - parseAppleUserField: the first-auth-only `user` form field (attacker-
 *     typeable — must fail soft).
 *   - resolveAppleUser: the three provisioning branches, both refusals, and
 *     first-auth name capture semantics.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  SignJWT,
  jwtVerify,
  exportJWK,
  exportPKCS8,
  generateKeyPair,
  createLocalJWKSet,
  decodeProtectedHeader,
  type JWTVerifyGetKey,
} from 'jose';
import { mintProviderNonce } from './providerNonce.js';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import {
  isAppleConfigured,
  buildAppleAuthUrl,
  mintAppleClientSecret,
  verifyAppleIdToken,
  parseAppleUserField,
  resolveAppleUser,
  type AppleIdentity,
} from './apple.js';

// Pre-#2204 rows carry no nonce hash; the nonce paths have their own tests in providerNonce.test.ts.
const LEGACY = { legacyUnbound: true } as const;

const CLIENT_ID = 'com.hadronmemory.signin';
const TEAM_ID = 'TEAMID9999';
const KEY_ID = 'KEYID88888';

beforeEach(() => {
  vi.stubEnv('APPLE_CLIENT_ID', CLIENT_ID);
  vi.stubEnv('APPLE_TEAM_ID', TEAM_ID);
  vi.stubEnv('APPLE_KEY_ID', KEY_ID);
  vi.stubEnv('APPLE_PRIVATE_KEY', 'placeholder — replaced per test where signing happens');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('isAppleConfigured', () => {
  it('requires all four env vars together', () => {
    expect(isAppleConfigured()).toBe(true);
    for (const v of ['APPLE_CLIENT_ID', 'APPLE_TEAM_ID', 'APPLE_KEY_ID', 'APPLE_PRIVATE_KEY']) {
      vi.stubEnv(v, '');
      expect(isAppleConfigured()).toBe(false);
      vi.stubEnv(v, 'restored');
    }
  });
});

describe('buildAppleAuthUrl', () => {
  it('#2204: sends the nonce it is given, and requires one', () => {
    expect(new URL(buildAppleAuthUrl('s', 'nonce-xyz')).searchParams.get('nonce')).toBe('nonce-xyz');
    // @ts-expect-error — the nonce is a required argument, there is no default
    expect(() => buildAppleAuthUrl('s')).not.toThrow();
  });

  it('carries login-only scopes, form_post, and the state', () => {
    const url = new URL(buildAppleAuthUrl('state-abc', 'n'));
    expect(url.origin + url.pathname).toBe('https://appleid.apple.com/auth/authorize');
    expect(url.searchParams.get('client_id')).toBe(CLIENT_ID);
    expect(url.searchParams.get('response_type')).toBe('code');
    // form_post is forced by requesting scopes — the callback is a POST.
    expect(url.searchParams.get('response_mode')).toBe('form_post');
    expect(url.searchParams.get('scope')).toBe('name email');
    expect(url.searchParams.get('state')).toBe('state-abc');
  });

  it('derives redirect_uri from BASE_URL, not per-request headers', () => {
    vi.stubEnv('BASE_URL', 'https://hadron.example.com');
    const url = new URL(buildAppleAuthUrl('s', 'n'));
    expect(url.searchParams.get('redirect_uri')).toBe(
      'https://hadron.example.com/auth/apple/callback',
    );
  });
});

describe('mintAppleClientSecret', () => {
  it('mints a verifiable ES256 JWT with the Apple-required shape', async () => {
    const pair = await generateKeyPair('ES256', { extractable: true });
    vi.stubEnv('APPLE_PRIVATE_KEY', await exportPKCS8(pair.privateKey));

    const secret = await mintAppleClientSecret();
    const header = decodeProtectedHeader(secret);
    expect(header.alg).toBe('ES256');
    expect(header.kid).toBe(KEY_ID);

    // Verifiable with the matching public key — proves a real signature.
    const { payload } = await jwtVerify(secret, pair.publicKey, {
      issuer: TEAM_ID,
      audience: 'https://appleid.apple.com',
    });
    expect(payload.sub).toBe(CLIENT_ID);
    // Short-lived (~5 min), not the 6-month maximum.
    expect(payload.exp! - payload.iat!).toBeLessThanOrEqual(5 * 60);
  });

  it('tolerates a \\n-escaped single-line PEM', async () => {
    const pair = await generateKeyPair('ES256', { extractable: true });
    const pem = await exportPKCS8(pair.privateKey);
    vi.stubEnv('APPLE_PRIVATE_KEY', pem.replace(/\n/g, '\\n'));
    const secret = await mintAppleClientSecret();
    await expect(jwtVerify(secret, pair.publicKey)).resolves.toBeDefined();
  });
});

describe('verifyAppleIdToken', () => {
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
      .setIssuer(opts.issuer ?? 'https://appleid.apple.com')
      .setAudience(opts.audience ?? CLIENT_ID)
      .setExpirationTime('5m')
      .sign(opts.key ?? signKey);
  }

  it('returns the identity claims from a valid token', async () => {
    const token = await mintIdToken({
      sub: '001234.abcd1234ef567890.0102',
      email: 'ada@example.com',
      email_verified: true,
      is_private_email: false,
    });
    expect(await verifyAppleIdToken(token, LEGACY, getKey)).toEqual({
      sub: '001234.abcd1234ef567890.0102',
      email: 'ada@example.com',
      emailVerified: true,
      isPrivateEmail: false,
    } satisfies AppleIdentity);
  });

  it('accepts the string "true" for email_verified / is_private_email (Apple quirk)', async () => {
    const token = await mintIdToken({
      sub: '42',
      email: 'relay@privaterelay.appleid.com',
      email_verified: 'true',
      is_private_email: 'true',
    });
    const identity = await verifyAppleIdToken(token, LEGACY, getKey);
    expect(identity.emailVerified).toBe(true);
    expect(identity.isPrivateEmail).toBe(true);
  });

  it('fails closed on any other email_verified shape', async () => {
    for (const v of ['false', false, 'yes', 1, undefined]) {
      const token = await mintIdToken({ sub: '42', email: 'a@b.com', email_verified: v });
      expect((await verifyAppleIdToken(token, LEGACY, getKey)).emailVerified).toBe(false);
    }
  });

  it('lowercases the email claim (magic-link/Google parity)', async () => {
    const token = await mintIdToken({ sub: '42', email: 'Ada@Example.COM' });
    expect((await verifyAppleIdToken(token, LEGACY, getKey)).email).toBe('ada@example.com');
  });

  it('rejects wrong audience, wrong issuer, wrong key, and missing sub', async () => {
    await expect(
      verifyAppleIdToken(await mintIdToken({ sub: '42' }, { audience: 'other' }), LEGACY, getKey),
    ).rejects.toThrow();
    await expect(
      verifyAppleIdToken(
        await mintIdToken({ sub: '42' }, { issuer: 'https://evil.example' }),
        LEGACY,
        getKey,
      ),
    ).rejects.toThrow();
    await expect(
      verifyAppleIdToken(await mintIdToken({ sub: '42' }, { key: wrongKey }), LEGACY, getKey),
    ).rejects.toThrow();
    await expect(
      verifyAppleIdToken(await mintIdToken({ email: 'a@b.com' }), LEGACY, getKey),
    ).rejects.toThrow(/sub/);
  });

  describe('#2204 nonce', () => {
    const { nonce, nonceHash } = mintProviderNonce();
    const bound = { bound: nonceHash };
    beforeEach(() => vi.spyOn(console, 'warn').mockImplementation(() => undefined));
    afterEach(() => vi.restoreAllMocks());

    it('accepts a token whose nonce hashes to the stored value', async () => {
      expect((await verifyAppleIdToken(await mintIdToken({ sub: '42', nonce }), bound, getKey)).sub).toBe('42');
    });

    it.each([
      ['missing', undefined],
      ['empty', ''],
      ['not a string', 42],
      ['another attempt\'s', mintProviderNonce().nonce],
    ])('refuses a %s nonce on a bound row with a fixed message', async (_c, claim) => {
      const token = await mintIdToken({ sub: '42', nonce: claim });
      const err = await verifyAppleIdToken(token, bound, getKey).catch((e: Error) => e);
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toBe('ID token nonce missing or mismatched');
      expect((err as Error).message).not.toContain(token);
    });

    it('still refuses a wrong signature, issuer or audience when the nonce is right', async () => {
      await expect(verifyAppleIdToken(await mintIdToken({ sub: '42', nonce }, { key: wrongKey }), bound, getKey)).rejects.toThrow();
      await expect(verifyAppleIdToken(await mintIdToken({ sub: '42', nonce }, { audience: 'other' }), bound, getKey)).rejects.toThrow();
      await expect(verifyAppleIdToken(await mintIdToken({ sub: '42', nonce }, { issuer: 'https://evil.example' }), bound, getKey)).rejects.toThrow();
    });

    it('Apple refuses a token without a nonce even when it claims nonce_supported: false (no exception without Apple\'s text)', async () => {
      await expect(verifyAppleIdToken(await mintIdToken({ sub: '42', nonce_supported: false }), bound, getKey)).rejects.toThrow('ID token nonce missing or mismatched');
    });
  });
});

describe('parseAppleUserField', () => {
  it('joins firstName and lastName from the first-auth payload', () => {
    expect(
      parseAppleUserField(
        JSON.stringify({ name: { firstName: 'Ada', lastName: 'Lovelace' }, email: 'a@b.com' }),
      ),
    ).toBe('Ada Lovelace');
  });

  it('handles a single present part', () => {
    expect(parseAppleUserField(JSON.stringify({ name: { firstName: 'Ada' } }))).toBe('Ada');
  });

  it('fails soft on everything malformed', () => {
    expect(parseAppleUserField(undefined)).toBeNull();
    expect(parseAppleUserField('')).toBeNull();
    expect(parseAppleUserField('not json')).toBeNull();
    expect(parseAppleUserField(JSON.stringify({ email: 'a@b.com' }))).toBeNull();
    expect(parseAppleUserField(JSON.stringify({ name: { firstName: '  ' } }))).toBeNull();
    expect(parseAppleUserField(JSON.stringify({ name: 'Ada' }))).toBeNull();
    expect(parseAppleUserField(42)).toBeNull();
  });
});

describe('resolveAppleUser', () => {
  beforeEach(async () => {
    await cleanDb(db);
  });

  const identity: AppleIdentity = {
    sub: '001234.abcd1234ef567890.0102',
    email: 'ada@example.com',
    emailVerified: true,
    isPrivateEmail: false,
  };

  it('(a) resolves a returning user by appleId; later logins keep the first-auth name', async () => {
    const existing = await db.user.create({
      data: {
        appleId: identity.sub,
        identityProvider: 'APPLE',
        name: 'Ada Lovelace',
        roles: ['READER'],
      },
    });
    // Apple never resends the name after first auth — must not null it out.
    const user = await resolveAppleUser(identity, null);
    expect(user.id).toBe(existing.id);
    expect(user.name).toBe('Ada Lovelace');
    expect(await db.user.count()).toBe(1);
  });

  it('flags (never blocks) a returning sign-in whose stored address differs from the verified claim', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const existing = await db.user.create({
        data: { appleId: identity.sub, email: 'other@example.com', identityProvider: 'APPLE', roles: ['READER'] },
      });
      const user = await resolveAppleUser(identity, null);
      expect(user.id).toBe(existing.id);
      expect(user.email).toBe('other@example.com');
      // Exact text: non-leakage is the point, so no part of either address
      // (local part, domain, length or hash) may appear in the line.
      expect(warn.mock.calls).toEqual([[
        `[auth] apple sign-in for user ${existing.id}: the stored address differs from the provider's verified address; review per #1802`,
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
      await db.user.create({ data: { appleId: identity.sub, email: stored, identityProvider: 'APPLE', roles: ['READER'] } });
      await resolveAppleUser({ ...identity, emailVerified: verified }, null);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('(b) links an existing user by verified email, keeping provider and name', async () => {
    const existing = await db.user.create({
      data: { email: 'ada@example.com', identityProvider: 'EMAIL', name: 'Ada', roles: ['READER'] },
    });
    const user = await resolveAppleUser(identity, 'Ada Lovelace');
    expect(user.id).toBe(existing.id);
    expect(user.appleId).toBe(identity.sub);
    expect(user.identityProvider).toBe('EMAIL');
    expect(user.name).toBe('Ada'); // fill-only, never overwrite
  });

  it('(b-refusal) does NOT link when email_verified is false', async () => {
    const victim = await db.user.create({
      data: { email: 'ada@example.com', identityProvider: 'EMAIL', roles: ['READER'] },
    });
    const user = await resolveAppleUser({ ...identity, emailVerified: false }, null);
    expect(user.id).not.toBe(victim.id);
    expect((await db.user.findUnique({ where: { id: victim.id } }))!.appleId).toBeNull();
    expect(user.email).toBeNull();
  });

  it('(b-refusal) does NOT relink a row already bound to a DIFFERENT Apple account', async () => {
    const original = await db.user.create({
      data: {
        appleId: '000000.oldsub.0000',
        email: 'ada@example.com',
        identityProvider: 'APPLE',
        roles: ['READER'],
      },
    });
    const user = await resolveAppleUser(identity, null);
    expect(user.id).not.toBe(original.id);
    expect(user.appleId).toBe(identity.sub);
    expect(user.email).toBeNull();
    expect((await db.user.findUnique({ where: { id: original.id } }))!.appleId).toBe(
      '000000.oldsub.0000',
    );
  });

  it('(c) creates a fresh user with the first-auth name and a generated handle', async () => {
    const user = await resolveAppleUser(identity, 'Ada Lovelace');
    expect(user.appleId).toBe(identity.sub);
    expect(user.identityProvider).toBe('APPLE');
    expect(user.email).toBe('ada@example.com');
    expect(user.name).toBe('Ada Lovelace');
    // Handle is NOT NULL (spec 047): seeded from the first-auth name.
    expect(user.handle).toBe('ada-lovelace');
    expect(user.roles).toEqual(['READER']);
  });

  it('(c) is idempotent — a second login resolves the same row', async () => {
    const first = await resolveAppleUser(identity, 'Ada Lovelace');
    const second = await resolveAppleUser(identity, null); // name absent after first auth
    expect(second.id).toBe(first.id);
    expect(second.name).toBe('Ada Lovelace');
    expect(await db.user.count()).toBe(1);
  });
});
