/**
 * #421: the production signing-secret strength guard.
 *
 * The threshold counts UTF-8 BYTES, not JS characters, so the boundary
 * fixtures below include multi-byte secrets whose character count and byte
 * count land on opposite sides of 32. Dev and test keep accepting short,
 * non-empty fixture secrets; only production refuses.
 */

import { describe, it, expect } from 'vitest';
import { assertProductionSigningSecret, JWT_SECRET_MIN_BYTES } from './signingSecret.js';

const prod = (env: Record<string, string | undefined>) => ({ NODE_ENV: 'production', ...env });

/** Run the guard and return the refusal, or null when it accepts. */
function refusal(env: Record<string, string | undefined>): Error | null {
  try {
    assertProductionSigningSecret(env);
    return null;
  } catch (err) {
    return err as Error;
  }
}

describe('assertProductionSigningSecret (#421)', () => {
  it('requires 32 bytes', () => {
    expect(JWT_SECRET_MIN_BYTES).toBe(32);
  });

  it('refuses a missing, empty or 31-byte secret in production', () => {
    expect(refusal(prod({}))).toBeInstanceOf(Error);
    expect(refusal(prod({ JWT_SECRET: '' }))).toBeInstanceOf(Error);
    expect(refusal(prod({ JWT_SECRET: 'a'.repeat(31) }))).toBeInstanceOf(Error);
  });

  it('accepts a 32-byte secret in production', () => {
    expect(refusal(prod({ JWT_SECRET: 'a'.repeat(32) }))).toBeNull();
  });

  it('counts UTF-8 bytes, not characters', () => {
    // 16 characters, 32 bytes: accepted, though a character count says 16.
    expect(refusal(prod({ JWT_SECRET: 'é'.repeat(16) }))).toBeNull();
    // 16 characters, 31 bytes: refused.
    expect(refusal(prod({ JWT_SECRET: 'é'.repeat(15) + 'a' }))).toBeInstanceOf(Error);
    // 31 characters, 32 bytes: accepted, though a character count says 31.
    expect(refusal(prod({ JWT_SECRET: 'a'.repeat(30) + 'é' }))).toBeNull();
    // Surrogate pairs: 8 four-byte emoji = 16 UTF-16 units, 32 bytes: accepted.
    expect(refusal(prod({ JWT_SECRET: '🔑'.repeat(8) }))).toBeNull();
    // 7 emoji + 3 ASCII = 17 UTF-16 units, 31 bytes: refused.
    expect(refusal(prod({ JWT_SECRET: '🔑'.repeat(7) + 'abc' }))).toBeInstanceOf(Error);
  });

  it('refuses a weak JWT_SECRET even when the dedicated team-attention and CSRF secrets are set', () => {
    // Both fall back to JWT_SECRET when unset, and JWT_SECRET signs sign-in
    // tokens regardless, so a strong dedicated secret never excuses it.
    const err = refusal(
      prod({
        JWT_SECRET: 'short',
        TEAM_ATTENTION_TOKEN_SECRET: 'x'.repeat(64),
        CSRF_SECRET: 'y'.repeat(64),
      }),
    );
    expect(err).toBeInstanceOf(Error);
  });

  it('never puts the secret or its length in the refusal', () => {
    const secret = 'Fx31-' + 'q'.repeat(26);
    expect(Buffer.byteLength(secret)).toBe(31);
    const err = refusal(prod({ JWT_SECRET: secret }))!;
    expect(err.message).not.toContain(secret);
    expect(err.message).not.toContain('qqqq');
    expect(err.message).not.toMatch(/\b31\b/);
    expect(err.stack ?? '').not.toContain(secret);
  });

  it('keeps short non-empty secrets working outside production', () => {
    for (const NODE_ENV of ['development', 'test', undefined]) {
      expect(refusal({ NODE_ENV, JWT_SECRET: 'short' })).toBeNull();
    }
  });

  it('leaves a missing secret to the crypto paths outside production', () => {
    // Dev/test boot as today; signJwt/verifyJwt still throw on use, and no
    // secret is generated or defaulted.
    expect(refusal({ NODE_ENV: 'development' })).toBeNull();
    expect(refusal({ NODE_ENV: 'development', JWT_SECRET: '' })).toBeNull();
  });
});
