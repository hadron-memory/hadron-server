import { getProjectBaseUrl } from '../lib/baseUrl.js';
// Issue #584 — Sign in with Apple, sibling of google.ts (#582). The linking
// rules from findings:oidc-login-sub-is-identity-email-is-not apply verbatim;
// where this module diverges from the Google one it's because Apple diverges
// from plain OIDC:
//
//   - The client secret is a JWT we mint per token call from a .p8 ES256 key
//     (mintAppleClientSecret) — there is no static secret.
//   - Requesting the `name email` scopes forces response_mode=form_post, so
//     the callback is a POST and the user's name rides in a `user` form field
//     on the FIRST authorization only (never in the ID token) —
//     parseAppleUserField.
//   - `email_verified` may arrive as the STRING "true" (documented Apple
//     quirk); accepted here, deliberately NOT loosened in the Google verifier.

import {
  jwtVerify,
  createRemoteJWKSet,
  importPKCS8,
  SignJWT,
  type JWTVerifyGetKey,
} from 'jose';
import { enforceIdTokenNonce, type NonceExpectation } from './providerNonce.js';
import { db } from '../integrations/db/client.js';
import { generateUniqueHandle, isHandleTaken } from '../lib/userHandle.js';
import { ensureUserPrincipal, RootNameTakenError } from '../lib/principal/mintPrincipal.js';
import { flagProviderEmailMismatch } from './providerEmailMismatch.js';

/** Identity claims extracted from a verified Apple ID token. */
export interface AppleIdentity {
  /** Apple account id (`sub`) — team-scoped, stored as User.appleId. */
  sub: string;
  email: string | null;
  /** Apple's assertion that it verified `email`. Gates account linking. */
  emailVerified: boolean;
  /** Hide-My-Email relay address (@privaterelay.appleid.com). Stored like any
   *  other email — it's real and routable — surfaced for observability. */
  isPrivateEmail: boolean;
}

const APPLE_AUTH_URL = 'https://appleid.apple.com/auth/authorize';
const APPLE_TOKEN_URL = 'https://appleid.apple.com/auth/token';
const APPLE_JWKS_URL = 'https://appleid.apple.com/auth/keys';
const APPLE_ISSUER = 'https://appleid.apple.com';

/** The four env vars that must all be present for Apple login to operate.
 *  The /auth/apple route answers 503 unless every one is set. */
export function isAppleConfigured(): boolean {
  return Boolean(
    process.env.APPLE_CLIENT_ID &&
    process.env.APPLE_TEAM_ID &&
    process.env.APPLE_KEY_ID &&
    process.env.APPLE_PRIVATE_KEY,
  );
}

/**
 * Build the Apple authorization redirect URL for the given state-CSRF token.
 * `response_mode=form_post` is not a choice: Apple requires it whenever any
 * scope is requested, which is why /auth/apple/callback is a POST.
 */
export function buildAppleAuthUrl(state: string, nonce: string): string {
  const params = new URLSearchParams({
    client_id: process.env.APPLE_CLIENT_ID!,
    redirect_uri: getAppleCallbackUrl(),
    response_type: 'code',
    response_mode: 'form_post',
    scope: 'name email',
    state,
    // #2204: echoed back inside the signed ID token; the callback compares its hash.
    nonce,
  });
  return `${APPLE_AUTH_URL}?${params}`;
}

/** Client-secret JWT lifetime. Apple allows up to 6 months; minting a fresh
 *  short-lived one per token call is simpler than caching + rotation. */
const CLIENT_SECRET_TTL_S = 5 * 60;

/**
 * Mint the per-request client secret — an ES256 JWT signed with the .p8 key
 * from the Apple Developer portal (`kid` header = Key ID, `iss` = Team ID,
 * `sub` = client id / Services ID, `aud` = Apple's issuer).
 */
export async function mintAppleClientSecret(): Promise<string> {
  // Doppler stores the PEM with real newlines, but tolerate the common
  // \n-escaped single-line form too.
  const pem = process.env.APPLE_PRIVATE_KEY!.replace(/\\n/g, '\n');
  const key = await importPKCS8(pem, 'ES256');
  return new SignJWT({})
    .setProtectedHeader({ alg: 'ES256', kid: process.env.APPLE_KEY_ID! })
    .setIssuer(process.env.APPLE_TEAM_ID!)
    .setSubject(process.env.APPLE_CLIENT_ID!)
    .setAudience(APPLE_ISSUER)
    .setIssuedAt()
    .setExpirationTime(`${CLIENT_SECRET_TTL_S}s`)
    .sign(key);
}

/**
 * Exchange the authorization code for tokens and return the raw ID token.
 * Access and refresh tokens are deliberately discarded — login makes no
 * Apple API calls and needs no offline access.
 */
export async function exchangeAppleCode(code: string): Promise<string> {
  const res = await fetch(APPLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: process.env.APPLE_CLIENT_ID ?? '',
      client_secret: await mintAppleClientSecret(),
      // Must byte-match the redirect_uri sent on the authorize request.
      redirect_uri: getAppleCallbackUrl(),
      grant_type: 'authorization_code',
    }),
  });
  const data = (await res.json()) as { id_token?: string; error?: string };
  if (data.error || !data.id_token) {
    throw new Error(`Apple OAuth error: ${data.error ?? 'no id_token'}`);
  }
  return data.id_token;
}

// Apple's JWKS, fetched lazily and cached by jose (key rotation handled via
// cache-control). Module-level so every verify shares the cache.
let remoteJwks: JWTVerifyGetKey | undefined;

/**
 * Apple sends some boolean claims as the STRING "true" / "false" (documented
 * quirk). Accept boolean true and the exact string 'true' as true; everything
 * else — including 'false', 'yes', 1 — fails closed to false.
 */
function appleBool(v: unknown): boolean {
  return v === true || v === 'true';
}

/**
 * Verify an Apple ID token (signature against Apple's JWKS, issuer, audience
 * = our client id) and extract the identity claims. Throws on any
 * verification failure — callers must never fall back to an unverified
 * decode. `getKey` is injectable for tests (a locally-generated key set).
 */
export async function verifyAppleIdToken(
  idToken: string,
  expected: NonceExpectation,
  getKey?: JWTVerifyGetKey,
): Promise<AppleIdentity> {
  const key = getKey ?? (remoteJwks ??= createRemoteJWKSet(new URL(APPLE_JWKS_URL)));
  const { payload } = await jwtVerify(idToken, key, {
    issuer: APPLE_ISSUER,
    audience: process.env.APPLE_CLIENT_ID ?? '',
  });
  // Refuse-always (Ruth, #2204): an Apple token without a nonce is refused, with no nonce_supported exception.
  enforceIdTokenNonce('apple', payload.nonce, expected);
  if (typeof payload.sub !== 'string' || payload.sub === '') {
    throw new Error('Apple ID token missing sub claim');
  }
  return {
    sub: payload.sub,
    // Lowercase-canonical, matching the magic-link flow and the Google
    // verifier (PR #582 review): Postgres text uniqueness is case-sensitive,
    // so a raw mixed-case claim would miss the existing row and fork a
    // second account instead of linking.
    email: typeof payload.email === 'string' ? payload.email.toLowerCase() : null,
    emailVerified: appleBool(payload.email_verified),
    isPrivateEmail: appleBool(payload.is_private_email),
  };
}

/**
 * Parse the `user` form field Apple POSTs to the callback on the FIRST
 * authorization only — a JSON string like
 * `{"name":{"firstName":"Ada","lastName":"Lovelace"},"email":"…"}`. The name
 * never appears again (not in the ID token, not on later logins), so this is
 * the one chance to capture it. Returns the joined display name, or null on
 * anything missing or malformed (the field is attacker-typeable form data —
 * fail soft, a nameless account beats a 500).
 */
export function parseAppleUserField(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw === '') return null;
  try {
    const parsed = JSON.parse(raw) as { name?: { firstName?: unknown; lastName?: unknown } };
    const parts = [parsed?.name?.firstName, parsed?.name?.lastName]
      .filter((p): p is string => typeof p === 'string' && p.trim() !== '')
      .map((p) => p.trim());
    return parts.length > 0 ? parts.join(' ') : null;
  } catch {
    return null;
  }
}

/**
 * Find-or-link-or-create the platform User for a verified Apple identity —
 * same match order and guards as resolveGoogleUser (#581 /
 * findings:oidc-login-sub-is-identity-email-is-not):
 *
 *   (a) existing user by appleId → login;
 *   (b) else existing user by email, ONLY when Apple verified it AND the
 *       row is not already linked to a different Apple account → link
 *       (set appleId, keep the existing identityProvider);
 *   (c) else create a fresh user (identityProvider APPLE).
 *
 * An unverified email is never linked and never stored. `name` is the
 * first-auth capture from parseAppleUserField — it only fills gaps on
 * (a)/(b) (Apple is the secondary provider on a linked account) and is
 * usually null on every login after the first. No handle is derived (Apple
 * has no username; the user picks one in setup).
 */
export async function resolveAppleUser(identity: AppleIdentity, name: string | null) {
  const bySub = await db.user.findUnique({ where: { appleId: identity.sub } });
  if (bySub) {
    flagProviderEmailMismatch('apple', bySub, identity);
    return db.user.update({
      where: { id: bySub.id },
      data: { name: bySub.name ?? name },
    });
  }

  if (identity.email && identity.emailVerified) {
    const byEmail = await db.user.findUnique({ where: { email: identity.email } });
    // Link ONLY when the row has no Apple identity yet — a different existing
    // appleId means a different Apple account once owned this email
    // (recycled-email takeover; sub is the identity, email is not). Refused
    // links fall through to (c), which creates a fresh, email-less user.
    if (byEmail && byEmail.appleId === null) {
      return db.user.update({
        where: { id: byEmail.id },
        data: {
          appleId: identity.sub,
          name: byEmail.name ?? name,
        },
      });
    }
    if (byEmail) {
      return createFreshUser({ ...identity, email: null }, name);
    }
  }

  return createFreshUser(identity, name);
}

/**
 * Branch (c) of {@link resolveAppleUser}: create the user, tolerating a
 * concurrent first-login losing the create race (P2002 on appleId — see
 * findings:prisma-upsert-not-race-safe) by resolving to the winner's row.
 */
async function createFreshUser(identity: AppleIdentity, name: string | null) {
  // Handle is NOT NULL (spec 047): generate a legal, currently-free one seeded
  // from the display name (first-auth only) then the email local-part. Two
  // attempts so a lost handle race regenerates rather than failing signup; the
  // DB `lower(handle)` unique index stays the real guard.
  for (let attempt = 0; attempt < 2; attempt++) {
    const handle = await generateUniqueHandle(db, {
      seeds: [name, identity.email?.split('@')[0]],
    });
    try {
      // #692: create the user and mint its pool principal in ONE transaction.
      return await db.$transaction(async (tx) => {
        const user = await tx.user.create({
          data: {
            appleId: identity.sub,
            handle,
            identityProvider: 'APPLE',
            email: identity.emailVerified ? identity.email : null,
            name,
            roles: ['READER'],
          },
        });
        await ensureUserPrincipal(tx, user);
        return user;
      });
    } catch (err: any) {
      if (err instanceof RootNameTakenError) continue; // pool race → regenerate
      if (err?.code === 'P2002') {
        const winner = await db.user.findUnique({ where: { appleId: identity.sub } });
        if (winner) return winner;
        // Only a genuine handle collision is retryable; anything else rethrows.
        if (await isHandleTaken(db, handle)) continue;
      }
      throw err;
    }
  }
  throw new Error('createFreshUser: handle contention after retry');
}

function getAppleCallbackUrl(): string {
  // `||` (not `??`) so empty-string BASE_URL / PORT fall back instead of
  // producing `http://localhost:` — symmetric with github.ts / google.ts.
  // Behind Cloudflare, BASE_URL (not per-request headers) MUST drive the
  // redirect URI (see findings:oauth-mcp-https-discovery-bug). NOTE: Apple
  // refuses localhost/http return URLs at registration time, so real
  // round-trips in dev need a tunnel with BASE_URL set to its origin.
  const base = getProjectBaseUrl();
  return `${base}/auth/apple/callback`;
}
