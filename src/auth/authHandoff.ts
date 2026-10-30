// Issue #477 — single-use handoff codes that keep the session JWT out of
// browser-visible URLs.
//
// Two flows share the `auth_handoff_codes` store (see the AuthHandoffCode model
// for the column contract):
//
//   - LOGIN handoff: after GitHub/email auth the server mints a `login` code and
//     302s the browser to `portal/auth/callback?code=<opaque>`. The portal's
//     server `load` redeems it at POST /auth/session (server-to-server) for the
//     JWT, which it sets as an HttpOnly cookie. The JWT never rides in a URL.
//     For the GitHub flow the portal also sets a browser nonce cookie and the
//     server binds it (`clientState`) so the browser that FINISHES login must be
//     the one that STARTED it (session-fixation defense). The email flow leaves
//     the binding null — magic links legitimately open on a different device.
//
//   - EXCHANGE start: POST /auth/microsoft/start (Bearer-authed) mints an
//     `exchange_start` code; the browser is then redirected to
//     /auth/microsoft?nonce=<opaque>. The long-lived JWT never rides in a URL.
//
// The raw code is handed out once; only its SHA-256 hash is stored. Single use
// is an atomic `updateMany({ redeemedAt: null })` claim (the conditional WHERE
// is the lock — mirrors the AuthCode /token redemption). DB-backed so it holds
// across multi-worker deploys and restarts, like the pending login states
// (src/auth/pendingLoginState.ts) that feed it.

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { db } from '../integrations/db/client.js';
import type { HadronJwtPayload } from './jwt.js';
import { lockAuthorityAnchors } from '../lib/auth/authorityAnchors.js';
import { SignInNotLive, lockLiveSignInRoot } from './signIn.js';

/** Handoff codes are consumed within one redirect hop; a short TTL bounds the
 *  replay window without risking a legitimate slow round-trip. */
const HANDOFF_TTL_MS = 2 * 60 * 1000; // 2 minutes

const sha256 = (v: string): string => createHash('sha256').update(v).digest('hex');

/** Constant-time equality over two hex-encoded SHA-256 digests. */
function hashesEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  // Different-length buffers can't be timing-safe-compared; unequal length is
  // already a definite mismatch.
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export interface IssueLoginCodeArgs {
  login?: HadronJwtPayload['login'];
  userId: string;
  /** Portal-local path to land on after the cookie is seated. */
  redirect: string;
  /** Whether THIS callback created the user row — an onboarding hint the portal
   *  branches on (spec 048: nothing is provisioned off it server-side). */
  isNew: boolean;
  /**
   * Raw browser nonce the portal set as an HttpOnly cookie at login start
   * (GitHub flow, via `client_state`). Hashed here. When present, redemption
   * REQUIRES the matching nonce — the session-fixation binding.
   */
  clientState?: string | null;
  /**
   * Pre-computed SHA-256 of the browser nonce (email flow): the nonce was set
   * as a cookie at magic-link REQUEST time and only its hash was persisted on
   * the EmailVerificationToken, so the raw value isn't available at mint time.
   * Takes precedence over `clientState`. Same binding effect at redemption.
   */
  clientStateHash?: string | null;
  /** #1897: the live factor-protected sign-in this code publishes; redemption mints the JWT with its `sid`. */
  signInId?: string | null;
}

/** Mint a `login` handoff code and return the raw opaque value (handed to the
 *  browser once, as `?code=`). */
export async function issueLoginCode(
  args: IssueLoginCodeArgs,
  /** #1897: the transaction a factor-protected code must commit with its sign-in; defaults to the shared client. */
  client: Pick<typeof db, 'authHandoffCode'> = db,
): Promise<string> {
  const rawCode = randomBytes(32).toString('hex'); // 256 bits
  const clientStateHash =
    args.clientStateHash ?? (args.clientState ? sha256(args.clientState) : null);
  await client.authHandoffCode.create({
    data: {
      codeHash: sha256(rawCode),
      kind: 'login',
      loginEvidence: args.login,
      userId: args.userId,
      redirect: args.redirect,
      isNew: args.isNew,
      clientStateHash,
      signInId: args.signInId ?? null,
      expiresAt: new Date(Date.now() + HANDOFF_TTL_MS),
    },
  });
  return rawCode;
}

export interface RedeemedLogin {
  /** #1897: the sign-in root the JWT must carry as `sid`; null for identity-provider and legacy logins. */
  signInId: string | null;
  login?: HadronJwtPayload['login'];
  userId: string;
  redirect: string;
  isNew: boolean;
}

/**
 * Redeem a `login` code. Atomically claims the row (single use), enforces
 * expiry, and — when the code carries a `clientStateHash` — requires the caller
 * to present the matching raw `clientState` (constant-time). Returns null on any
 * failure (unknown / expired / already-redeemed / clientState mismatch) so the
 * caller can answer with a single uninformative error.
 */
export async function redeemLoginCode(
  code: string,
  clientState?: string | null,
): Promise<RedeemedLogin | null> {
  const codeHash = sha256(code);

  // The owner is read unlocked only to know which user authority anchor to take; the claim below
  // re-checks everything under it.
  const probe = await db.authHandoffCode.findUnique({ where: { codeHash }, select: { userId: true } });
  if (!probe) return null;

  // Atomic single-use claim, inside the user authority anchor so a first-passkey cancellation
  // (#1897 / R66) cannot interleave: cancelled first => the root is ended and nothing is published.
  // Exactly one concurrent caller sees count=1.
  const row = await db.$transaction(async (tx) => {
    await lockAuthorityAnchors(tx, [{ kind: 'user', id: probe.userId }], 'shared');
    // Database clock at the moment the row lock is held, not a JS cutoff bound before a lock wait
    // (Ruth P2 on the same shape in /oauth/token, #2116).
    // The row lock is its own earlier statement: an UPDATE that waits on a lock whose holder changed
    // nothing keeps the qualification it evaluated before waiting.
    await tx.$queryRaw`SELECT id FROM auth_handoff_codes WHERE code_hash = ${codeHash} FOR UPDATE`;
    const claimedRows = await tx.$executeRaw`
      UPDATE auth_handoff_codes SET redeemed_at = (clock_timestamp() AT TIME ZONE 'UTC')
      WHERE code_hash = ${codeHash} AND kind = 'login' AND redeemed_at IS NULL
        AND expires_at > (clock_timestamp() AT TIME ZONE 'UTC')`;
    if (claimedRows !== 1) return null;
    const claimed = await tx.authHandoffCode.findUnique({ where: { codeHash } });
    if (!claimed) return null; // unreachable after a successful claim, but keeps types honest
    if (claimed.signInId) {
      try { await lockLiveSignInRoot(tx, claimed.signInId, claimed.userId); }
      catch (error) { if (error instanceof SignInNotLive) return null; throw error; }
    }
    return claimed;
  });
  if (!row) return null;

  // Session-fixation binding: if the code was minted with a browser nonce, the
  // redeemer MUST present it. A missing/mismatched nonce means the browser
  // finishing login is not the one that started it — reject.
  if (row.clientStateHash) {
    if (!clientState || !hashesEqual(row.clientStateHash, sha256(clientState))) {
      return null;
    }
  }

  return { userId: row.userId, redirect: row.redirect ?? '/', isNew: row.isNew, signInId: row.signInId,
    login: row.loginEvidence as HadronJwtPayload['login'] ?? undefined };
}

export interface IssueExchangeStartArgs {
  userId: string;
  orgId: string;
  /** Portal-local return path after the mailbox-connect OAuth round-trip. */
  redirect: string;
  /**
   * Email provider the nonce authorizes (`ms-exchange`, `gmail`, …). Baked
   * into the stored kind so a nonce minted at one provider's start route
   * cannot be redeemed at another provider's authorize route — the #506
   * org-ADMIN approval is provider-specific. Omitted ⇒ the legacy unbound
   * kind (pre-#580 rows; kept so the helpers stay usable standalone).
   */
  provider?: string;
  /**
   * Which door started the flow (#2897). `graphql` ends on the server-hosted done page instead of the portal. Carried
   * in the stored kind, never in `redirect`, so a caller-chosen redirect string cannot pick the origin. Omitted ⇒ the
   * portal start (`POST /auth/{provider}/start`), whose rows keep the kind they always had.
   */
  origin?: ExchangeStartOrigin;
}

/** Who started a mailbox-connect flow (#2897). */
export type ExchangeStartOrigin = 'portal' | 'graphql';

/** Lifetime of a start nonce, exposed so the GraphQL start can report when its URL stops working. */
export const EXCHANGE_START_TTL_MS = HANDOFF_TTL_MS;

/** The stored kind for a mailbox-connect start nonce. */
function exchangeStartKind(provider?: string, origin: ExchangeStartOrigin = 'portal'): string {
  const base = provider ? `exchange_start:${provider}` : 'exchange_start';
  return origin === 'graphql' ? `${base}:graphql` : base;
}

/** Mint an `exchange_start` nonce and return the raw opaque value. */
export async function issueExchangeStartNonce(args: IssueExchangeStartArgs): Promise<string> {
  const rawCode = randomBytes(32).toString('hex');
  await db.authHandoffCode.create({
    data: {
      codeHash: sha256(rawCode),
      kind: exchangeStartKind(args.provider, args.origin),
      userId: args.userId,
      orgId: args.orgId,
      redirect: args.redirect,
      expiresAt: new Date(Date.now() + HANDOFF_TTL_MS),
    },
  });
  return rawCode;
}

export interface RedeemedExchangeStart {
  userId: string;
  orgId: string;
  redirect: string;
  origin: ExchangeStartOrigin;
}

/** Redeem an `exchange_start` nonce (atomic single-use + expiry, bound to
 *  the provider it was minted for). Returns null on unknown / expired /
 *  already-redeemed / wrong provider. */
export async function redeemExchangeStartNonce(
  code: string,
  provider?: string,
): Promise<RedeemedExchangeStart | null> {
  const codeHash = sha256(code);
  // Both origins redeem at the same provider-bound authorize route; the kind tells them apart afterwards.
  const kinds = [exchangeStartKind(provider, 'portal'), exchangeStartKind(provider, 'graphql')];
  const claim = await db.authHandoffCode.updateMany({
    where: { codeHash, kind: { in: kinds }, redeemedAt: null, expiresAt: { gt: new Date() } },
    data: { redeemedAt: new Date() },
  });
  if (claim.count !== 1) return null;

  const row = await db.authHandoffCode.findUnique({ where: { codeHash } });
  if (!row || !row.orgId) return null;
  return {
    userId: row.userId,
    orgId: row.orgId,
    redirect: row.redirect ?? '/',
    origin: row.kind === kinds[1] ? 'graphql' : 'portal',
  };
}

/**
 * Read an `exchange_start` nonce WITHOUT consuming it (#2908): the connect interstitial shows who is asking to connect
 * what before the single-use claim. Same predicate as {@link redeemExchangeStartNonce} (provider-bound kind, unredeemed,
 * unexpired), so a peek that succeeds is a nonce a redeem could still claim. Null for every refusal shape.
 */
export async function peekExchangeStartNonce(
  code: string,
  provider: string,
): Promise<RedeemedExchangeStart | null> {
  const kinds = [exchangeStartKind(provider, 'portal'), exchangeStartKind(provider, 'graphql')];
  const row = await db.authHandoffCode.findFirst({
    where: { codeHash: sha256(code), kind: { in: kinds }, redeemedAt: null, expiresAt: { gt: new Date() } },
  });
  if (!row || !row.orgId) return null;
  return {
    userId: row.userId,
    orgId: row.orgId,
    redirect: row.redirect ?? '/',
    origin: row.kind === kinds[1] ? 'graphql' : 'portal',
  };
}

/** Domain label of the interstitial token key: derived from JWT_SECRET, never the secret itself, never shared with another HMAC. */
const CONNECT_INTERSTITIAL_KEY_LABEL = 'hadron:connect-interstitial:v1';

/**
 * The per-page token of the connect interstitial (#2908): HMAC over the provider and the SHA-256 of the nonce, keyed
 * by HMAC(JWT_SECRET, {@link CONNECT_INTERSTITIAL_KEY_LABEL}). It binds the POST to a page this server rendered for
 * this nonce at this provider; a token for one nonce or provider fails for another.
 */
export function connectInterstitialToken(provider: string, nonce: string): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET is required for the connect interstitial');
  const key = createHmac('sha256', secret).update(CONNECT_INTERSTITIAL_KEY_LABEL).digest();
  return createHmac('sha256', key).update(JSON.stringify([provider, sha256(nonce)])).digest('hex');
}

/** Constant-time check of a presented interstitial token; false for anything that is not the exact token. */
export function connectInterstitialTokenValid(provider: string, nonce: string, presented: unknown): boolean {
  if (typeof presented !== 'string') return false;
  return hashesEqual(connectInterstitialToken(provider, nonce), presented);
}
