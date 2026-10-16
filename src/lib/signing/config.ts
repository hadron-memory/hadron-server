/**
 * #1632 — deployment configuration for signing. Read on every call (tests and
 * operators may change the environment), validated loudly.
 */

/** cor:dmo:130:03: a request's lifetime. Default 24 hours (#1632 contract note; reported for the Built line). */
export function signingRequestTtlSeconds(): number {
  const raw = process.env.SIGNING_REQUEST_TTL_SECONDS;
  if (raw === undefined || raw === '') return 24 * 60 * 60;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 60 || n > 30 * 24 * 60 * 60) {
    throw new Error('SIGNING_REQUEST_TTL_SECONDS must be an integer between 60 and 2592000');
  }
  return n;
}

/** Thrown when signing is not configured on this deployment (no RP ID in production). */
export class SigningNotConfiguredError extends Error {}

/**
 * cor:aut:040:06: the WebAuthn relying-party id (the registrable domain). No
 * default in production; `localhost` elsewhere, for local development.
 */
export function passkeyRpId(): string {
  const v = process.env.PASSKEY_RP_ID?.trim();
  if (v) return v;
  if (process.env.NODE_ENV === 'production') throw new SigningNotConfiguredError('PASSKEY_RP_ID is not set');
  return 'localhost';
}

/**
 * cor:aut:040:06 (#10000): the exact origin allowlist for signing assertions:
 * only the server-hosted ceremony page. Comma-separated; empty means none, so
 * completion refuses until S2b-2's page is configured.
 */
export function signingCeremonyOrigins(): string[] {
  return (process.env.SIGNING_CEREMONY_ORIGINS ?? '')
    .split(',').map((s) => s.trim()).filter(Boolean);
}
