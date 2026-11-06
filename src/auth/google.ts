// Issue #581 — Sign-in-with-Google, the login/identity half of the Google
// story. Near-verbatim sibling of github.ts, with two deliberate differences:
//
//   - Identity comes from the VERIFIED ID-token claims (issuer + audience +
//     signature checked against Google's JWKS via jose), never from a bare
//     decode and never from a userinfo fetch.
//   - No `access_type=offline`: login needs no refresh token. This OAuth
//     client carries only `openid email profile` — do NOT add gmail scopes
//     here, ever; the Gmail mailbox tool (#580) uses a separate client in a
//     separate GCP project so login never enters restricted-scope
//     verification.

import { getProjectBaseUrl } from '../lib/baseUrl.js';
import {
  jwtVerify,
  createRemoteJWKSet,
  type JWTVerifyGetKey,
} from 'jose';
import { enforceIdTokenNonce, type NonceExpectation } from './providerNonce.js';
import { db } from '../integrations/db/client.js';
import { generateUniqueHandle, isHandleTaken } from '../lib/userHandle.js';
import { ensureUserPrincipal, RootNameTakenError } from '../lib/principal/mintPrincipal.js';
import { flagProviderEmailMismatch } from './providerEmailMismatch.js';

/** Identity claims extracted from a verified Google ID token. */
export interface GoogleIdentity {
  /** Google account id (OIDC `sub`) — the stable key, stored as User.googleId. */
  sub: string;
  email: string | null;
  /** Google's assertion that it verified `email`. Gates account linking. */
  emailVerified: boolean;
  name: string | null;
  picture: string | null;
  /** OIDC `auth_time` in epoch seconds, when Google sent it (it does when `max_age` was requested). */
  authTime: number | null;
}

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';

/** Both variables must be present for Google login to operate: `/auth/google` answers 503 unless each is set. */
export function isGoogleConfigured(): boolean {
  return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

/**
 * Build the Google authorization redirect URL for the given state-CSRF token. `reauthenticate` (#1631 PR1b, R154)
 * asks Google for a fresh authentication with `max_age=0`; the callback must then check `auth_time`.
 */
export function buildGoogleAuthUrl(state: string, nonce: string, opts: { reauthenticate?: boolean } = {}): string {
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID!,
    redirect_uri: getGoogleCallbackUrl(),
    response_type: 'code',
    scope: 'openid email profile',
    state,
    // #2204: echoed back inside the signed ID token; the callback compares its hash.
    nonce,
  });
  if (opts.reauthenticate) params.set('max_age', '0');
  return `${GOOGLE_AUTH_URL}?${params}`;
}

/**
 * Exchange the authorization code for tokens and return the raw ID token.
 * The access token is deliberately discarded — identity comes from the ID
 * token's verified claims, and login makes no further Google API calls.
 */
export async function exchangeGoogleCode(code: string): Promise<string> {
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: process.env.GOOGLE_CLIENT_ID ?? '',
      client_secret: process.env.GOOGLE_CLIENT_SECRET ?? '',
      // Must byte-match the redirect_uri sent on the authorize request.
      redirect_uri: getGoogleCallbackUrl(),
      grant_type: 'authorization_code',
    }),
  });
  const data = (await res.json()) as { id_token?: string; error?: string };
  if (data.error || !data.id_token) {
    throw new Error(`Google OAuth error: ${data.error ?? 'no id_token'}`);
  }
  return data.id_token;
}

// Google's JWKS, fetched lazily and cached by jose (which handles key
// rotation via cache-control). Module-level so every verify shares the cache.
let remoteJwks: JWTVerifyGetKey | undefined;

/**
 * Verify a Google ID token (signature against Google's JWKS, issuer,
 * audience = our client id) and extract the identity claims. Throws on any
 * verification failure — callers must never fall back to an unverified
 * decode. `getKey` is injectable for tests (a locally-generated key set).
 */
export async function verifyGoogleIdToken(
  idToken: string,
  expected: NonceExpectation,
  getKey?: JWTVerifyGetKey,
): Promise<GoogleIdentity> {
  const key = getKey ?? (remoteJwks ??= createRemoteJWKSet(new URL(GOOGLE_JWKS_URL)));
  const { payload } = await jwtVerify(idToken, key, {
    // Google emits both forms depending on the flow — the OIDC discovery doc
    // says to accept either.
    issuer: ['https://accounts.google.com', 'accounts.google.com'],
    audience: process.env.GOOGLE_CLIENT_ID ?? '',
  });
  enforceIdTokenNonce('google', payload.nonce, expected);
  if (typeof payload.sub !== 'string' || payload.sub === '') {
    throw new Error('Google ID token missing sub claim');
  }
  return {
    sub: payload.sub,
    // Lowercase-canonical, matching the magic-link flow (src/auth/email.ts
    // stores email.toLowerCase()): Postgres text uniqueness is case-sensitive,
    // so a raw `Ada@Example.com` claim would miss the existing `ada@…` row and
    // fork a second account instead of linking. Normalized here — the single
    // producer of GoogleIdentity — so lookup, link, and create all agree.
    email: typeof payload.email === 'string' ? payload.email.toLowerCase() : null,
    // Google sends a boolean, but fail closed on anything else (a string
    // "true" from a misbehaving proxy must not authorize account linking).
    emailVerified: payload.email_verified === true,
    name: typeof payload.name === 'string' ? payload.name : null,
    picture: typeof payload.picture === 'string' ? payload.picture : null,
    authTime: typeof payload.auth_time === 'number' && Number.isFinite(payload.auth_time) ? payload.auth_time : null,
  };
}

/** Tolerated clock difference between Google and this server when comparing `auth_time` (seconds). */
export const GOOGLE_AUTH_TIME_SKEW_SECONDS = 60;

/**
 * #1631 PR1b (R154): did Google re-authenticate the person for THIS leg? True only when `auth_time` is present and
 * no earlier than the moment the leg's state was minted, less a small clock skew. A missing `auth_time` fails
 * closed: we asked with `max_age=0`, so its absence means the request was not honoured.
 */
export function googleReauthenticatedSince(authTime: number | null, startedAt: Date): boolean {
  return authTime !== null && authTime * 1000 >= startedAt.getTime() - GOOGLE_AUTH_TIME_SKEW_SECONDS * 1000;
}

/**
 * Find-or-link-or-create the platform User for a verified Google identity
 * (#581 match order):
 *
 *   (a) existing user by googleId → login;
 *   (b) else existing user by email, ONLY when Google verified it AND the
 *       row is not already linked to a different Google account → link
 *       (set googleId, keep the existing identityProvider);
 *   (c) else create a fresh user (identityProvider GOOGLE).
 *
 * Linking on an unverified email is an account-takeover vector, so (b) is
 * gated on `emailVerified`; for the same reason (c) stores the email only
 * when verified — an attacker-controlled unverified address must not become
 * a magic-link/invite identity. No handle is derived (Google has no
 * username; mirrors the email flow — the user picks one in setup).
 * Profile fields only fill gaps on (a)/(b): Google is the secondary
 * provider on a linked account, so it must not overwrite an existing
 * name/avatar.
 */
export async function resolveGoogleUser(identity: GoogleIdentity) {
  const bySub = await db.user.findUnique({ where: { googleId: identity.sub } });
  if (bySub) {
    flagProviderEmailMismatch('google', bySub, identity);
    return db.user.update({
      where: { id: bySub.id },
      data: {
        name: bySub.name ?? identity.name,
        avatarUrl: bySub.avatarUrl ?? identity.picture,
      },
    });
  }

  if (identity.email && identity.emailVerified) {
    const byEmail = await db.user.findUnique({ where: { email: identity.email } });
    // Link ONLY when the row has no Google identity yet. A different existing
    // googleId means a DIFFERENT Google account once owned this email (e.g. a
    // Workspace admin recreated a deleted account with the same address —
    // same email, new `sub`). Overwriting would hand the old row to the new
    // account; Google's guidance is that `sub` is the identity, email is not.
    // Fall through to (c), which creates a fresh, email-less user (the email
    // stays on — and unique to — the originally linked row).
    if (byEmail && byEmail.googleId === null) {
      return db.user.update({
        where: { id: byEmail.id },
        data: {
          googleId: identity.sub,
          name: byEmail.name ?? identity.name,
          avatarUrl: byEmail.avatarUrl ?? identity.picture,
        },
      });
    }
    if (byEmail) {
      return createFreshUser({ ...identity, email: null });
    }
  }

  return createFreshUser(identity);
}

/**
 * Branch (c) of {@link resolveGoogleUser}: create the user, tolerating a
 * concurrent first-login losing the create race (P2002 on googleId — see
 * findings:prisma-upsert-not-race-safe) by resolving to the winner's row.
 */
async function createFreshUser(identity: GoogleIdentity) {
  // Handle is NOT NULL (spec 047): generate a legal, currently-free one seeded
  // from the display name then the email local-part (Google has no username).
  // Two attempts so a lost handle race regenerates rather than failing signup;
  // the DB `lower(handle)` unique index stays the real guard.
  for (let attempt = 0; attempt < 2; attempt++) {
    const handle = await generateUniqueHandle(db, {
      seeds: [identity.name, identity.email?.split('@')[0]],
    });
    try {
      // #692: create the user and mint its pool principal in ONE transaction.
      return await db.$transaction(async (tx) => {
        const user = await tx.user.create({
          data: {
            googleId: identity.sub,
            handle,
            identityProvider: 'GOOGLE',
            email: identity.emailVerified ? identity.email : null,
            name: identity.name,
            avatarUrl: identity.picture,
            roles: ['READER'],
          },
        });
        await ensureUserPrincipal(tx, user);
        return user;
      });
    } catch (err: any) {
      // The handle got taken in the pool between the probe and the mint (a
      // rare race) — regenerate and retry.
      if (err instanceof RootNameTakenError) continue;
      if (err?.code === 'P2002') {
        // Provider-id race: the concurrent winner already created this account.
        const winner = await db.user.findUnique({ where: { googleId: identity.sub } });
        if (winner) return winner;
        // Only a genuine handle collision is retryable — regenerate against the
        // now-updated table. Any other unique conflict rethrows (not masked).
        if (await isHandleTaken(db, handle)) continue;
      }
      throw err;
    }
  }
  throw new Error('createFreshUser: handle contention after retry');
}

function getGoogleCallbackUrl(): string {
  // `||` (not `??`) so empty-string BASE_URL / PORT fall back instead of
  // producing `http://localhost:` — symmetric with github.ts. Behind
  // Cloudflare, BASE_URL (not per-request headers) MUST drive the redirect
  // URI (see findings:oauth-mcp-https-discovery-bug).
  const base = getProjectBaseUrl();
  return `${base}/auth/google/callback`;
}
