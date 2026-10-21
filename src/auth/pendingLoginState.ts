/**
 * Durable pending login state for the first-party auth flows
 * (GitHub / Google / Apple).
 *
 * Replaces the three in-process `pendingStates` Maps in `server.ts`. Those
 * died on every deploy/restart — the provider callback then answered
 * 400 "Invalid or expired state" mid-login, which is the failure mode
 * behind the Apple App Review rejection "the app failed to login with
 * Apple" (Apple's callback is a cross-site form POST after a flow that can
 * involve slow 2FA, so it is the worst-hit of the three). Same bug class
 * as the deploys-sever-MCP-connections finding
 * (`findings:mcp-stale-session-400-vs-404`): in-process state that a
 * browser round-trip depends on must be durable.
 *
 * Contract (unchanged from the Maps beyond durability):
 *   - the start route mints a random `state`, stores
 *     {redirect, returnTo, clientState} against it with a TTL, and sends
 *     the browser to the IdP;
 *   - the callback claims the state SINGLE-USE (atomic delete-by-PK; a
 *     missing row is an invalid state) and rejects expired rows;
 *   - a state minted for one provider can never be claimed by another
 *     provider's callback (the per-provider-Map property, now a column);
 *   - expired rows are lazily swept on every start-route hit, mirroring
 *     the old Maps' O(n) sweep (no new configurable loop).
 */

import { db } from '../integrations/db/client.js';

/**
 * How long a login may sit at the IdP between the start route and the
 * callback. Was 10 minutes in the in-process Maps; raised to 15 to give
 * slow IdP flows (Apple 2FA, account recovery, password-manager detours)
 * headroom — a user slower than the TTL hit the same dead end as a
 * restart. One shared constant for all three providers.
 */
export const LOGIN_STATE_TTL_MS = 15 * 60 * 1000;

/** The first-party login providers that keep pending state here. */
export type LoginProvider = 'github' | 'google' | 'apple';

/** What the start route stores and the callback gets back. */
export interface PendingLoginState {
  /** Portal-local path to land on after login. */
  redirect: string;
  /** Spec 025 FR-007 Option-C server-local return path (cookie flow). */
  returnTo?: string;
  /** #477 session-fixation binding — the portal's browser nonce. */
  clientState?: string;
  /**
   * #1631 PR1b: SHA-256 of the passkey ceremony's browser cookie. Present only on a state the ceremony's sign-in
   * leg minted; its callback records a fresh sign-in and mints no session (never with returnTo/clientState, CHECK).
   */
  ceremonyNonceHash?: string;
}

/** A claimed state, plus when it was minted (for re-authentication checks such as Google's `auth_time`). */
export interface ClaimedLoginState extends PendingLoginState {
  startedAt: Date;
}

/**
 * Persist a freshly minted `state` for `provider` with the shared TTL.
 * Also lazily sweeps expired rows (all providers) — the durable
 * equivalent of the old Maps' sweep-on-start-route-hit, cheap at the
 * /auth/<provider> call rate (a few per minute at peak).
 */
export async function createPendingLoginState(
  state: string,
  provider: LoginProvider,
  data: PendingLoginState,
): Promise<void> {
  await db.pendingLoginState.deleteMany({ where: { expiresAt: { lt: new Date() } } });
  await db.pendingLoginState.create({
    data: {
      state,
      provider,
      redirect: data.redirect,
      returnTo: data.returnTo ?? null,
      clientState: data.clientState ?? null,
      ceremonyNonceHash: data.ceremonyNonceHash ?? null,
      expiresAt: new Date(Date.now() + LOGIN_STATE_TTL_MS),
    },
  });
}

/** Discriminated claim result — `reason` feeds the callback diagnostics. */
export type ClaimResult =
  | { ok: true; pending: ClaimedLoginState }
  | { ok: false; reason: 'state_unknown' | 'state_expired' };

/**
 * Atomically claim (and thereby consume) a pending login state. The
 * provider-scoped conditional delete IS the single-use lock: exactly one
 * concurrent callback deletes the row; every other caller (including a
 * WRONG provider's callback) affects zero rows → invalid. Scoping the
 * delete on provider means a cross-provider submission does NOT burn the
 * rightful provider's in-flight login (PR-894 Codex P2), while the
 * response stays indistinguishable from a never-issued state — no
 * cross-provider oracle. Expiry is checked AFTER the claim so an expired
 * state is also burned.
 */
export async function claimPendingLoginState(
  state: string,
  provider: LoginProvider,
): Promise<ClaimResult> {
  // Read-then-conditionally-delete would be a TOCTOU; instead delete
  // WHERE state AND provider in one statement, then re-read the payload
  // from the returned row. Prisma's `delete` only takes unique filters,
  // so use the raw equivalent: DELETE .. RETURNING.
  const rows = await db.$queryRaw<
    { redirect: string | null; return_to: string | null; client_state: string | null; ceremony_nonce_hash: string | null; created_at: Date; expires_at: Date }[]
  >`
    DELETE FROM pending_login_states
    WHERE state = ${state} AND provider = ${provider}
    RETURNING redirect, return_to, client_state, ceremony_nonce_hash, created_at, expires_at
  `;
  if (rows.length === 0) return { ok: false, reason: 'state_unknown' };
  const row = {
    redirect: rows[0].redirect,
    returnTo: rows[0].return_to,
    clientState: rows[0].client_state,
    expiresAt: rows[0].expires_at,
  };
  if (row.expiresAt.getTime() < Date.now()) return { ok: false, reason: 'state_expired' };
  return {
    ok: true,
    pending: {
      redirect: row.redirect ?? '/',
      returnTo: row.returnTo ?? undefined,
      clientState: row.clientState ?? undefined,
      ceremonyNonceHash: rows[0].ceremony_nonce_hash ?? undefined,
      startedAt: rows[0].created_at,
    },
  };
}
