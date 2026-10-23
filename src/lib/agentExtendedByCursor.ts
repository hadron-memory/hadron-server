/**
 * #2177 — the continuation token of `Agent.extendedBy`.
 *
 * A page can end on a row the caller may not read (the checked-path scan advances over hidden
 * candidates), so the token must reveal nothing about its position. It is authenticated
 * encryption (AES-256-GCM, the key `tokenCrypto` already uses), not an encoding: the payload is the
 * last scanned Agent's ID only (no name, so every valid token is the same small size however long
 * or Unicode the names are), bound to the parent Agent, the caller's audience, a format version
 * and an expiry. Any failure to open it is the one `InvalidExtendedByCursorError`: a caller cannot
 * tell a forged token from a stale one from another caller's.
 *
 * The token only RESUMES a position. The next page re-evaluates visibility in full; a valid token
 * never grants a read.
 */
import { createHash } from 'node:crypto';
import { decryptToken, encryptToken } from './tokenCrypto.js';

export const EXTENDED_BY_CURSOR_VERSION = 1;
export const EXTENDED_BY_CURSOR_TTL_MS = 15 * 60_000;
/** Accepted input bound; a freshly minted token is far below it (see the length pin). */
export const EXTENDED_BY_CURSOR_MAX_LENGTH = 512;

export class InvalidExtendedByCursorError extends Error {
  constructor() {
    super('invalid cursor');
    this.name = 'InvalidExtendedByCursorError';
  }
}

/** What a token is bound to: the same Agent, the same kind of caller, nothing else. */
export interface ExtendedByBinding {
  /** The Agent the field ran on. */
  base: string;
  /** The caller's audience, from {@link extendedByAudience}. */
  aud: string;
}

/** A stable, non-reversible digest of who is reading, so a token from one principal fails for another. */
export function extendedByAudience(p: {
  userId?: string | null;
  appId?: string | null;
  admin: boolean;
  impersonationOrgId?: string | null;
}): string {
  const kind = p.userId ? (p.admin ? 'admin' : 'user') : p.appId ? 'app' : 'anon';
  const subject = p.userId ?? p.appId ?? '';
  return createHash('sha256').update(`${kind}\0${subject}\0${p.impersonationOrgId ?? ''}`).digest('hex');
}

const toUrlSafe = (b64: string) => b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromUrlSafe = (s: string) => s.replace(/-/g, '+').replace(/_/g, '/');

/** Seal the position (the last scanned Agent's id). Throws if the encryption key is missing: fail closed. */
export function sealExtendedByCursor(lastScannedId: string, b: ExtendedByBinding, now = Date.now()): string {
  return toUrlSafe(encryptToken(JSON.stringify({
    v: EXTENDED_BY_CURSOR_VERSION, exp: now + EXTENDED_BY_CURSOR_TTL_MS, base: b.base, aud: b.aud, id: lastScannedId,
  })));
}

/** The position the token carries, or {@link InvalidExtendedByCursorError} for ANY defect. */
export function openExtendedByCursor(token: string, b: ExtendedByBinding, now = Date.now()): string {
  try {
    if (typeof token !== 'string' || token.length === 0 || token.length > EXTENDED_BY_CURSOR_MAX_LENGTH
      || !/^[A-Za-z0-9_-]+$/.test(token)) throw new InvalidExtendedByCursorError();
    const p = JSON.parse(decryptToken(fromUrlSafe(token))) as Record<string, unknown>;
    if (p.v !== EXTENDED_BY_CURSOR_VERSION || typeof p.exp !== 'number' || p.exp <= now
      || p.base !== b.base || p.aud !== b.aud || typeof p.id !== 'string' || p.id.length === 0) {
      throw new InvalidExtendedByCursorError();
    }
    return p.id;
  } catch {
    throw new InvalidExtendedByCursorError();
  }
}
