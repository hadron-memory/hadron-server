/**
 * Constant-time string comparison for secrets (bearer tokens, nonces).
 * The codebase has three older private copies (oauth.ts verifyPkceS256,
 * authHandoff.ts hashesEqual, an inline compare in server.ts) — new secret
 * comparisons use THIS export; consolidating the older copies onto it is a
 * known follow-up (a hardening change must not fork four ways).
 */
import { timingSafeEqual } from 'crypto';

/** True when the two strings match, without an early-exit timing side channel on content. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
