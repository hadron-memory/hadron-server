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
  await db.$executeRaw`DELETE FROM fresh_sign_ins
    WHERE created_at < (clock_timestamp() AT TIME ZONE 'UTC') - make_interval(hours => ${FRESH_SIGN_IN_RETENTION_HOURS}::int)`;
}

async function insertLeg(
  db: PrismaClient,
  input: { userId: string; method: FreshSignInMethod; browserNonceHash: string; secret: string; proved: boolean },
): Promise<void> {
  if (!HEX64.test(input.browserNonceHash)) throw new Error('browser nonce hash must be 64 lowercase hex');
  // signed_in_at: any non-null value asks the guard to stamp the database clock; null leaves the email leg unproved.
  await db.$executeRaw`INSERT INTO fresh_sign_ins (id, user_id, method, browser_nonce_hash, leg_hash, expires_at, signed_in_at)
    VALUES (${generateId()}, ${input.userId}, ${input.method}, ${input.browserNonceHash}, ${sha256Hex(input.secret)},
            (clock_timestamp() AT TIME ZONE 'UTC') + make_interval(secs => ${FRESH_SIGN_IN_LEG_TTL_SECONDS}),
            CASE WHEN ${input.proved} THEN (clock_timestamp() AT TIME ZONE 'UTC') END)`;
}

/**
 * An IdP callback proved `userId`: record an unconfirmed row bound to the ceremony browser and return the leg id,
 * which travels only in the callback's redirect to the confirm page.
 */
export async function recordIdpSignIn(
  db: PrismaClient,
  input: { userId: string; method: Exclude<FreshSignInMethod, 'email'>; browserNonceHash: string },
): Promise<{ legId: string }> {
  const legId = randomBytes(32).toString('base64url');
  await insertLeg(db, { ...input, secret: legId, proved: true });
  return { legId };
}

/** Open an email leg for a live user: the returned token goes only into the email. Nothing is proved yet. */
export async function startEmailSignIn(
  db: PrismaClient,
  input: { userId: string; browserNonceHash: string },
): Promise<{ token: string }> {
  const token = randomBytes(32).toString('base64url');
  await insertLeg(db, { ...input, method: 'email', secret: token, proved: false });
  return { token };
}

/**
 * Confirm a leg from the browser that holds both halves. False is the one uniform refusal (unknown leg, other
 * browser, already confirmed, expired, the wrong channel, or a user who is no longer live); a refusal changes nothing. For the email
 * leg this POST is the identity proof, so it also sets `signed_in_at` (Vera, #1631 6309336028).
 */
export async function confirmFreshSignIn(
  db: PrismaClient,
  input: { legSecret: string; browserNonceHash: string; channel: 'idp' | 'email' },
): Promise<boolean> {
  if (!HEX64.test(input.browserNonceHash) || input.legSecret.length === 0) return false;
  // #1631 PR2 (Rook 6316353964): an IdP leg id arrives only in its cookie and an emailed token only in its form,
  // so neither secret can stand in for the other's channel.
  const emailChannel = input.channel === 'email';
  const rows = await db.$queryRaw<Array<{ id: string }>>`UPDATE fresh_sign_ins f
     SET signed_in_at = COALESCE(f.signed_in_at, clock_timestamp() AT TIME ZONE 'UTC'),
         confirmed_at = clock_timestamp() AT TIME ZONE 'UTC'
   WHERE f.leg_hash = ${sha256Hex(input.legSecret)} AND f.browser_nonce_hash = ${input.browserNonceHash}
     AND f.confirmed_at IS NULL AND f.expires_at > (clock_timestamp() AT TIME ZONE 'UTC')
     AND (f.method = 'email') = ${emailChannel}
     AND EXISTS (SELECT 1 FROM users u WHERE u.id = f.user_id AND u.deleted_at IS NULL)
   RETURNING f.id`;
  return rows.length === 1;
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
  if (!HEX64.test(input.browserNonceHash)) return null;
  const rows = await tx.$queryRaw<Array<{ id: string; method: FreshSignInMethod }>>`UPDATE fresh_sign_ins
     SET consumed_at = clock_timestamp() AT TIME ZONE 'UTC', consumed_for = ${input.purpose}
   WHERE id = (
     SELECT id FROM fresh_sign_ins
      WHERE browser_nonce_hash = ${input.browserNonceHash} AND user_id = ${input.actingUserId}
        AND confirmed_at IS NOT NULL AND consumed_at IS NULL
        AND signed_in_at >= (clock_timestamp() AT TIME ZONE 'UTC') - make_interval(secs => ${FRESH_SIGN_IN_MAX_AGE_SECONDS})
        AND (${input.purpose} <> 'revoke' OR method <> 'email')
      ORDER BY signed_in_at DESC
      LIMIT 1
      FOR UPDATE)
     AND consumed_at IS NULL
   RETURNING id, method`;
  return rows[0] ?? null;
}

/**
 * #1631 PR2 (Uma's UX read): is there ONE confirmed, unspent, fresh sign-in on this browser, and for how much longer?
 * For the register page to show step 1 as done. Spends nothing and names no user.
 */
export async function peekFreshSignIn(
  db: PrismaClient,
  input: { browserNonceHash: string },
): Promise<{ method: FreshSignInMethod; secondsLeft: number } | null> {
  if (!HEX64.test(input.browserNonceHash)) return null;
  const rows = await db.$queryRaw<Array<{ method: FreshSignInMethod; seconds_left: number }>>`
    SELECT method, EXTRACT(EPOCH FROM (signed_in_at + make_interval(secs => ${FRESH_SIGN_IN_MAX_AGE_SECONDS})
      - (clock_timestamp() AT TIME ZONE 'UTC')))::int AS seconds_left
      FROM fresh_sign_ins
     WHERE browser_nonce_hash = ${input.browserNonceHash} AND confirmed_at IS NOT NULL AND consumed_at IS NULL
       AND signed_in_at >= (clock_timestamp() AT TIME ZONE 'UTC') - make_interval(secs => ${FRESH_SIGN_IN_MAX_AGE_SECONDS})`;
  return rows.length === 1 ? { method: rows[0].method, secondsLeft: Math.max(0, rows[0].seconds_left) } : null;
}
