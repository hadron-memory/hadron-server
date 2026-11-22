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
 * What the callback expects of the token: the stored hash of the nonce it must carry. There is no "skip" variant
 * (#2282): a row without a hash has no expectation (`null` from `nonceExpectation`) and the callback refuses it
 * before any exchange.
 */
export type NonceExpectation = { bound: string };

/**
 * Derive the expectation from a claimed state. A row with a hash is bound. A row WITHOUT one returns null, whether it
 * is an ordinary login row or the passkey ceremony branch (step-up), and the callback must refuse it.
 */
export function nonceExpectation(pending: { providerNonceHash?: string }): NonceExpectation | null {
  if (pending.providerNonceHash) return { bound: pending.providerNonceHash };
  return null;
}

/** Counts the refusal of a row with no nonce hash: a passkey-ceremony row or an ordinary login row (#2282). */
export function refuseUnboundNonce(provider: NonceProvider, pending: { ceremonyNonceHash?: string }): void {
  recordNonceRefusal(provider, pending.ceremonyNonceHash ? 'ceremony_unbound' : 'unbound');
}

/** Refusals per provider and reason since boot, so a real-user lockout is visible. Never holds a nonce, token or sub. */
export const nonceRefusals: Record<NonceProvider, Record<'missing' | 'mismatch' | 'ceremony_unbound' | 'unbound', number>> = {
  google: { missing: 0, mismatch: 0, ceremony_unbound: 0, unbound: 0 },
  apple: { missing: 0, mismatch: 0, ceremony_unbound: 0, unbound: 0 },
};

export function recordNonceRefusal(provider: NonceProvider, reason: keyof (typeof nonceRefusals)['google']): void {
  nonceRefusals[provider][reason] += 1;
  console.warn(`[auth] oidc nonce refused provider=${provider} reason=${reason} count=${nonceRefusals[provider][reason]}`);
}

/**
 * Check the token's `nonce` claim. A bound row refuses a missing, empty, non-string or different nonce, with no
 * exception for any provider (an empty `bound` included). Throws a fixed-text error that carries neither the nonce nor the token.
 */
export function enforceIdTokenNonce(provider: NonceProvider, claim: unknown, expected: NonceExpectation): void {
  if (typeof claim !== 'string' || claim === '') {
    recordNonceRefusal(provider, 'missing');
    throw new Error('ID token nonce missing or mismatched');
  }
  if (!safeEqual(hashProviderNonce(claim), expected.bound)) {
    recordNonceRefusal(provider, 'mismatch');
    throw new Error('ID token nonce missing or mismatched');
  }
}
