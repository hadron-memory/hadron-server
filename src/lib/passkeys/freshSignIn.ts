/**
 * #1631 PR1b slice 2 (cor:aut:040:09): the fresh-sign-in record a passkey ceremony consumes.
 *
 * A fresh sign-in proves who the person is to ONE ceremony browser and signs them in to nothing: no JWT, no
 * handoff code, no session. Two halves must meet before it counts (Ruth's §10 condition 1, #1631 6309332208):
 *
 * - the leg secret (an IdP leg's id, minted at the callback; the email leg's token, sent only to the inbox), which
 *   only the browser that FINISHED the identity proof holds; and
 * - the `hadron_ceremony_browser` cookie, which only the browser that STARTED the leg holds (stored as SHA-256).
 *
 * Confirm needs both, so a leg started in one browser and finished in another confirms in neither. Consume then
 * spends one confirmed row for the acting user, no more than 10 minutes after the identity proof, and never a
 * magic link for `revoke`. Times are written by the guard trigger from the database clock.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { Prisma, PrismaClient } from '../../generated/prisma/index.js';
import { generateId } from '../id.js';

export type FreshSignInMethod = 'github' | 'google' | 'apple' | 'email';
export type FreshSignInPurpose = 'register' | 'end-window' | 'revoke';

/** cor:aut:040:09: no more than 10 minutes old, measured from the identity proof, when the step begins. */
export const FRESH_SIGN_IN_MAX_AGE_SECONDS = 10 * 60;
/** How long a leg may wait for its confirmation. Never longer than `LOGIN_STATE_TTL_MS` or the browser cookie. */
export const FRESH_SIGN_IN_LEG_TTL_SECONDS = 15 * 60;
/** Rows are disposable after this (Vera, #1631 6309336028: retention is a server choice). */
export const FRESH_SIGN_IN_RETENTION_HOURS = 24;

const sha256Hex = (v: string) => createHash('sha256').update(v).digest('hex');
const HEX64 = /^[0-9a-f]{64}$/;

/** Delete rows older than the retention window. Called lazily from the leg start routes. */
export async function sweepFreshSignIns(db: PrismaClient): Promise<void> {
  throw new Error('not implemented');
}

/**
 * An IdP callback proved `userId`: record an unconfirmed row bound to the ceremony browser and return the leg id,
 * which travels only in the callback's redirect to the confirm page.
 */
export async function recordIdpSignIn(
  db: PrismaClient,
  input: { userId: string; method: Exclude<FreshSignInMethod, 'email'>; browserNonceHash: string },
): Promise<{ legId: string }> {
  throw new Error('not implemented');
}

/** Open an email leg for a live user: the returned token goes only into the email. Nothing is proved yet. */
export async function startEmailSignIn(
  db: PrismaClient,
  input: { userId: string; browserNonceHash: string },
): Promise<{ token: string }> {
  throw new Error('not implemented');
}

/**
 * Confirm a leg from the browser that holds both halves. False is the one uniform refusal (unknown leg, other
 * browser, already confirmed, expired, or a user who is no longer live); a refusal changes nothing. For the email
 * leg this POST is the identity proof, so it also sets `signed_in_at` (Vera, #1631 6309336028).
 */
export async function confirmFreshSignIn(
  db: PrismaClient,
  input: { legSecret: string; browserNonceHash: string },
): Promise<boolean> {
  throw new Error('not implemented');
}

/**
 * Spend one confirmed fresh sign-in, in the CALLER's transaction. The caller has already taken the user authority
 * anchor for `actingUserId` and rechecked the live user; this takes no anchor and starts no transaction. It spends
 * the newest qualifying row: same browser, the acting user's own (Ruth's §10 condition 4), confirmed, unspent, at
 * most 10 minutes after its identity proof by the database clock now, and never a magic link for `revoke`. Null is
 * the one uniform refusal; the caller must not distinguish its causes to the client.
 */
export async function consumeFreshSignIn(
  tx: Prisma.TransactionClient,
  input: { browserNonceHash: string; actingUserId: string; purpose: FreshSignInPurpose },
): Promise<{ id: string; method: FreshSignInMethod } | null> {
  throw new Error('not implemented');
}

void sha256Hex; void HEX64; void randomBytes; void generateId;
