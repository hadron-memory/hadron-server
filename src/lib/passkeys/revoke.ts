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
import type { PrismaClient } from '../../generated/prisma/index.js';
import type { AssertionParts } from '../signing/verify.js';

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
  throw new Error('not implemented');
}

/** Bind a REVOKE ceremony to the user of this browser's one fresh identity-provider sign-in. */
export async function bindRevokeByIdp(
  db: PrismaClient,
  input: { ceremonyId: string; ceremonyNonceHash: string; signInBrowserHash: string },
): Promise<RevokeBinding | null> {
  throw new Error('not implemented');
}

/** Revoke the owner's passkey named by `targetCredentialId`, consuming the bound ceremony. */
export async function finishRevoke(
  db: PrismaClient,
  input: { ceremonyId: string; ceremonyNonceHash: string; signInBrowserHash: string | null; targetCredentialId: Buffer },
): Promise<{ passkeyId: string; windowCancelled: boolean } | null> {
  throw new Error('not implemented');
}
