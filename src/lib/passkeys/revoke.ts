/**
 * #1631 PR3 (cor:aut:040:08): an owner revokes one of their passkeys, interactively, in two steps of one ceremony.
 *
 * - **Prove (bind).** The owner proves who they are with either an assertion from another of their unrevoked passkeys
 *   (a passkey still in its cooling-off window may prove; 040:08 sets no window exclusion) or this browser's ONE fresh
 *   sign-in with an identity provider, never a magic link (040:08, 040:09; `consumeFreshSignIn` refuses email for
 *   'revoke'). The REVOKE ceremony is bound to the owner and the proof, set once. No bearer credential, cookie session
 *   or request field ever names the user.
 * - **Revoke (finish).** Under the owner's anchor: the ceremony is consumed (both browser cookies for an identity-
 *   provider proof); the target must be the owner's own, unrevoked, and never the passkey that proved this ceremony;
 *   a passkey prover must still be unrevoked. `revoked_at` is the platform clock the passkey guard requires; a first
 *   passkey still in its window is closed as 'cancelled' (the passkey CHECK forces it), so its pending signatures read
 *   cancelled. A revocation here ends no sign-in: 040:08 rules that for the cancel link only.
 *
 * Every refusal is null, and the caller answers one uniform 403.
 */
import type { Prisma, PrismaClient } from '../../generated/prisma/index.js';
import type { AssertionParts } from '../signing/verify.js';
import { lockAuthorityAnchors } from '../auth/authorityAnchors.js';
import { verifyCeremonyAssertion, type VerifiedAssertion } from './ceremony.js';
import { consumeFreshSignIn, FRESH_SIGN_IN_MAX_AGE_SECONDS } from './freshSignIn.js';
import { clientDataType, liveUser, lockOpenCeremony, lockVoucher } from './registration.js';

const HEX64 = /^[0-9a-f]{64}$/;

/** A passkey as the revocation page shows it to its owner after the proof. */
export interface OwnerPasskey {
  passkeyId: string;
  credentialId: Buffer;
  label: string;
  registeredAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  inWindow: boolean;
  /** The passkey that proved this ceremony; it can't be revoked by it. */
  prover: boolean;
}

export interface RevokeBinding { userId: string; passkeys: OwnerPasskey[] }

/** Bind a REVOKE ceremony to the owner of the passkey whose assertion proves it. */
export async function bindRevokeByPasskey(
  db: PrismaClient,
  input: { ceremonyId: string; ceremonyNonceHash: string; proof: AssertionParts & { credentialId: Buffer }; rpId: string; origins: string[] },
): Promise<RevokeBinding | null> {
  if (!HEX64.test(input.ceremonyNonceHash) || clientDataType(input.proof.clientDataJson) !== 'webauthn.get') return null;
  const [row] = await db.$queryRaw<Array<{ id: string; owner_id: string; public_key: Buffer; counter: bigint; revoked_at: Date | null; enrollment_rp_id: string }>>`
    SELECT id, owner_id, public_key, counter, revoked_at, enrollment_rp_id FROM passkey_credentials WHERE credential_id = ${input.proof.credentialId}`;
  // cor:aut:040:06 / #2202: a credential enrolled under another RP ID never proves, before any crypto.
  if (!row || row.revoked_at !== null || row.enrollment_rp_id !== input.rpId) return null;
  let verified: VerifiedAssertion;
  try {
    ({ snapshot: verified } = await verifyCeremonyAssertion({
      assertion: { authenticatorData: input.proof.authenticatorData, clientDataJson: input.proof.clientDataJson, signature: input.proof.signature },
      credential: { passkeyId: row.id, ownerId: row.owner_id, credentialId: input.proof.credentialId, publicKey: row.public_key, counter: row.counter },
      expectedChallenge: Buffer.from(input.ceremonyId, 'base64url'), rpId: input.rpId, origins: input.origins,
    }));
  } catch { return null; }
  return db.$transaction(async (tx) => {
    await lockAuthorityAnchors(tx, [{ kind: 'user', id: verified.ownerId }], 'exclusive');
    if (!(await liveUser(tx, verified.ownerId)) || !(await lockVoucher(tx, verified, { requireOutOfWindow: false }))) return null;
    if (!(await lockOpenCeremony(tx, input.ceremonyId, input.ceremonyNonceHash, 'REVOKE'))) return null;
    await tx.$executeRaw`UPDATE passkey_credentials
       SET last_used_at = GREATEST(COALESCE(last_used_at, registered_at), (clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3)),
           counter = GREATEST(counter, ${BigInt(verified.newCounter)})
     WHERE id = ${verified.passkeyId}`;
    await tx.$executeRaw`UPDATE passkey_ceremonies SET user_id = ${verified.ownerId}, kind = 'revoke', vouch_passkey_id = ${verified.passkeyId}
      WHERE id = ${input.ceremonyId}`;
    return { userId: verified.ownerId, passkeys: await ownerPasskeys(tx, verified.ownerId, verified.passkeyId) };
  });
}

/** Bind a REVOKE ceremony to the user of this browser's one fresh identity-provider sign-in. */
export async function bindRevokeByIdp(
  db: PrismaClient,
  input: { ceremonyId: string; ceremonyNonceHash: string; signInBrowserHash: string },
): Promise<RevokeBinding | null> {
  if (!HEX64.test(input.ceremonyNonceHash) || !HEX64.test(input.signInBrowserHash)) return null;
  // The browser's ONE confirmed fresh sign-in names the user (as for registration); a magic link never revokes.
  const qualifying = (tx: Pick<PrismaClient, '$queryRaw'>) => tx.$queryRaw<Array<{ user_id: string; method: string }>>`
    SELECT user_id, method FROM fresh_sign_ins
     WHERE browser_nonce_hash = ${input.signInBrowserHash} AND confirmed_at IS NOT NULL AND consumed_at IS NULL
       AND signed_in_at >= (clock_timestamp() AT TIME ZONE 'UTC') - make_interval(secs => ${FRESH_SIGN_IN_MAX_AGE_SECONDS})`;
  const peek = await qualifying(db);
  if (peek.length !== 1 || peek[0].method === 'email') return null;
  const userId = peek[0].user_id;
  return db.$transaction(async (tx) => {
    await lockAuthorityAnchors(tx, [{ kind: 'user', id: userId }], 'exclusive');
    if (!(await liveUser(tx, userId))) return null;
    if (!(await lockOpenCeremony(tx, input.ceremonyId, input.ceremonyNonceHash, 'REVOKE'))) return null;
    const recheck = await qualifying(tx);
    if (recheck.length !== 1 || recheck[0].user_id !== userId || recheck[0].method === 'email') return null;
    const spent = await consumeFreshSignIn(tx, { browserNonceHash: input.signInBrowserHash, actingUserId: userId, purpose: 'revoke' });
    if (!spent) throw new Error('fresh sign-in changed under the anchor');
    await tx.$executeRaw`UPDATE passkey_ceremonies SET user_id = ${userId}, kind = 'revoke', registration_method = ${spent.method},
        sign_in_browser_hash = ${input.signInBrowserHash}
      WHERE id = ${input.ceremonyId}`;
    return { userId, passkeys: await ownerPasskeys(tx, userId, null) };
  });
}

/** Revoke the owner's passkey named by `targetCredentialId`, consuming the bound ceremony. */
export async function finishRevoke(
  db: PrismaClient,
  input: { ceremonyId: string; ceremonyNonceHash: string; signInBrowserHash: string | null; targetCredentialId: Buffer },
): Promise<{ passkeyId: string; windowCancelled: boolean } | null> {
  if (!HEX64.test(input.ceremonyNonceHash) || (input.signInBrowserHash !== null && !HEX64.test(input.signInBrowserHash))) return null;
  const [bound] = await db.$queryRaw<Array<{ user_id: string; vouch_passkey_id: string | null; sign_in_browser_hash: string | null }>>`
    SELECT user_id, vouch_passkey_id, sign_in_browser_hash FROM passkey_ceremonies
     WHERE id = ${input.ceremonyId} AND purpose = 'REVOKE' AND kind = 'revoke' AND user_id IS NOT NULL AND consumed_at IS NULL`;
  if (!bound) return null;
  // An identity-provider proof was spent at the prove step; finishing needs that same browser.
  if (bound.vouch_passkey_id === null && input.signInBrowserHash !== bound.sign_in_browser_hash) return null;
  return db.$transaction(async (tx) => {
    await lockAuthorityAnchors(tx, [{ kind: 'user', id: bound.user_id }], 'exclusive');
    if (!(await liveUser(tx, bound.user_id))) return null;
    if (bound.vouch_passkey_id !== null) {
      const prover = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM passkey_credentials
        WHERE id = ${bound.vouch_passkey_id} AND owner_id = ${bound.user_id} AND revoked_at IS NULL FOR SHARE`;
      if (prover.length !== 1) return null;
    }
    const [target] = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM passkey_credentials
      WHERE credential_id = ${input.targetCredentialId} AND owner_id = ${bound.user_id} AND revoked_at IS NULL FOR UPDATE`;
    // "Another" passkey: the prover never revokes itself through its own ceremony (cor:aut:040:08).
    if (!target || target.id === bound.vouch_passkey_id) return null;
    const consumed = await tx.$queryRaw<Array<{ id: string }>>`UPDATE passkey_ceremonies SET consumed_at = (clock_timestamp() AT TIME ZONE 'UTC')
      WHERE id = ${input.ceremonyId} AND purpose = 'REVOKE' AND browser_nonce_hash = ${input.ceremonyNonceHash}
        AND consumed_at IS NULL AND expires_at > (clock_timestamp() AT TIME ZONE 'UTC') AND user_id = ${bound.user_id}
        AND (vouch_passkey_id IS NOT NULL OR sign_in_browser_hash = ${input.signInBrowserHash})
      RETURNING id`;
    if (consumed.length !== 1) return null;
    // revoked_at is the platform clock the passkey guard requires (the transaction's). A first passkey whose window
    // is still open at that time closes as cancelled, at the same instant; the passkey CHECK forces exactly that.
    const [done] = await tx.$queryRaw<Array<{ window_outcome: string | null }>>`UPDATE passkey_credentials SET
        revoked_at = (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::timestamp(3),
        window_outcome = CASE WHEN window_ends_at > (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::timestamp(3) AND window_outcome IS NULL
          THEN 'cancelled' ELSE window_outcome END,
        window_ended_at = CASE WHEN window_ends_at > (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::timestamp(3) AND window_outcome IS NULL
          THEN (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::timestamp(3) ELSE window_ended_at END
      WHERE id = ${target.id}
      RETURNING window_outcome`;
    return { passkeyId: target.id, windowCancelled: done.window_outcome === 'cancelled' };
  });
}

/** The owner's passkeys, as the revocation page lists them after the proof. */
async function ownerPasskeys(tx: Prisma.TransactionClient, userId: string, proverId: string | null): Promise<OwnerPasskey[]> {
  const rows = await tx.$queryRaw<Array<{ id: string; credential_id: Buffer; label: string; registered_at: Date; last_used_at: Date | null;
    revoked_at: Date | null; in_window: boolean }>>`
    SELECT id, credential_id, label, registered_at, last_used_at, revoked_at,
           (revoked_at IS NULL AND window_outcome IS NULL AND window_ends_at > (clock_timestamp() AT TIME ZONE 'UTC')) AS in_window
      FROM passkey_credentials WHERE owner_id = ${userId} ORDER BY registered_at DESC, id DESC`;
  return rows.map((r) => ({
    passkeyId: r.id, credentialId: Buffer.from(r.credential_id), label: r.label, registeredAt: r.registered_at,
    lastUsedAt: r.last_used_at, revokedAt: r.revoked_at, inWindow: r.in_window, prover: r.id === proverId,
  }));
}
