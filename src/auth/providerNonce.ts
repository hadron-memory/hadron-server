/**
 * #2204 — the OIDC `nonce` of the Google and Apple sign-in flows.
 *
 * A nonce binds the ID token to THIS login attempt. It is the IdP's value, sent in the authorize request and echoed
 * back inside the signed token, so it is deliberately a separate secret from `state` (the CSRF handle), from the
 * portal's `client_state` (#477 handoff binding) and from the ceremony browser cookie (`ceremony_nonce_hash`, #1631).
 * None of those is derived from another.
 *
 * Only the SHA-256 is stored on the pending row. The raw value exists in the authorize URL and in the ID token.
 */

import { createHash, randomBytes } from 'crypto';
import { safeEqual } from '../lib/constantTime.js';

export type NonceProvider = 'google' | 'apple';

export function hashProviderNonce(nonce: string): string {
  return createHash('sha256').update(nonce).digest('hex');
}

/** A fresh, independent nonce and the hash to persist. */
export function mintProviderNonce(): { nonce: string; nonceHash: string } {
  const nonce = randomBytes(32).toString('base64url');
  return { nonce, nonceHash: hashProviderNonce(nonce) };
}

/**
 * What the callback expects of the token. `legacyUnbound` is ONLY for an ordinary login row minted before #2204
 * shipped: its authorize request carried no nonce, so there is nothing to compare. A row older than one
 * `LOGIN_STATE_TTL_MS` cannot exist after deploy, and the DB refuses to insert a new one without a hash.
 * TODO(#2204 follow-up): delete this branch one TTL after deploy.
 */
export type NonceExpectation = { bound: string } | { legacyUnbound: true };

/**
 * Derive the expectation from a claimed state. A row with a hash is always bound. Only a row WITHOUT one skips, and
 * never on the passkey ceremony branch (step-up): that returns null, which the callback must refuse.
 */
export function nonceExpectation(pending: { providerNonceHash?: string; ceremonyNonceHash?: string }): NonceExpectation | null {
  if (pending.providerNonceHash) return { bound: pending.providerNonceHash };
  if (pending.ceremonyNonceHash) return null;
  return { legacyUnbound: true };
}

/** Refusals per provider and reason since boot, so a real-user lockout is visible. Never holds a nonce, token or sub. */
export const nonceRefusals: Record<NonceProvider, Record<'missing' | 'mismatch' | 'ceremony_unbound', number>> = {
  google: { missing: 0, mismatch: 0, ceremony_unbound: 0 },
  apple: { missing: 0, mismatch: 0, ceremony_unbound: 0 },
};

export function recordNonceRefusal(provider: NonceProvider, reason: keyof (typeof nonceRefusals)['google']): void {
  nonceRefusals[provider][reason] += 1;
  console.warn(`[auth] oidc nonce refused provider=${provider} reason=${reason} count=${nonceRefusals[provider][reason]}`);
}

/**
 * Check the token's `nonce` claim. A bound row refuses a missing, empty, non-string or different nonce, with no
 * exception for any provider. Throws a fixed-text error that carries neither the nonce nor the token.
 */
export function enforceIdTokenNonce(provider: NonceProvider, claim: unknown, expected: NonceExpectation): void {
  if ('legacyUnbound' in expected) return;
  if (typeof claim !== 'string' || claim === '') {
    recordNonceRefusal(provider, 'missing');
    throw new Error('ID token nonce missing or mismatched');
  }
  if (!safeEqual(hashProviderNonce(claim), expected.bound)) {
    recordNonceRefusal(provider, 'mismatch');
    throw new Error('ID token nonce missing or mismatched');
  }
}
