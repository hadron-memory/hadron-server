/**
 * #1631 PR2 (cor:aut:040:02, 05, 06, 07): registering a passkey, in two steps of one ceremony.
 *
 * - **Bind (the options step).** The step begins here, so this is where a fresh sign-in is measured and spent
 *   (cor:aut:040:09). It decides who registers and which kind of passkey, and binds both to the REGISTER ceremony,
 *   set once (Rook's §10, #1631 6316353964):
 *   - a **first** passkey: the user comes only from the ONE confirmed, unspent, fresh sign-in on this browser's
 *     `hadron_ceremony_browser` cookie (two qualifying rows refuse); the user must hold no unrevoked passkey;
 *   - a **later** passkey: the user is the owner of the vouching passkey, whose assertion over this ceremony's
 *     challenge (type `webauthn.get`, user verification, this deployment's RP ID and origin, the enrollment RP ID)
 *     is decided under the owner's anchor; a voucher in its cooling-off window refuses (cor:aut:040:02 S4).
 *   No bearer credential, cookie session or request field ever names the user.
 * - **Finish.** The creation response (type `webauthn.create`, user verification, RP ID, origin, ES256 or RS256) is
 *   verified outside any transaction; then, under the user's anchor: the kind is rechecked, the ceremony consumed
 *   (both browser cookies must match its binding), the credential inserted with its enrollment RP ID and, for a first
 *   passkey, its cooling-off window and cancel token, and the notice written to the outbox in the same transaction.
 *
 * Every refusal is null, and the caller answers one uniform 403.
 */
import type { RegistrationResponseJSON } from '@simplewebauthn/server';
import type { PrismaClient } from '../../generated/prisma/index.js';
import type { AssertionParts } from '../signing/verify.js';

/** cor:aut:040:07: 72 hours by default; a deployment may lengthen it, never shorten it. */
export const MIN_FIRST_WINDOW_HOURS = 72;
export const LABEL_MAX_LENGTH = 64;

/** The first-passkey window length, from `PASSKEY_FIRST_WINDOW_HOURS`. Throws (at mount, so at boot) on a bad value. */
export function firstPasskeyWindowHours(env: NodeJS.ProcessEnv = process.env): number {
  throw new Error('not implemented');
}

export interface RegistrationBinding {
  userId: string;
  /** The user's handle, shown on the page before the WebAuthn prompt (Rook Q2.3) and used as the WebAuthn user name. */
  handle: string;
  userHandle: Buffer;
  /** The user's unrevoked credential ids, for `excludeCredentials`. */
  excludeCredentialIds: Buffer[];
}

/** Bind a REGISTER ceremony to a first passkey for the one fresh sign-in on this browser. */
export async function bindFirstRegistration(
  db: PrismaClient,
  input: { ceremonyId: string; ceremonyNonceHash: string; signInBrowserHash: string },
): Promise<RegistrationBinding | null> {
  throw new Error('not implemented');
}

/** Bind a REGISTER ceremony to a later passkey, vouched for by an assertion from an existing passkey. */
export async function bindLaterRegistration(
  db: PrismaClient,
  input: { ceremonyId: string; ceremonyNonceHash: string; vouch: AssertionParts & { credentialId: Buffer }; rpId: string; origins: string[] },
): Promise<RegistrationBinding | null> {
  throw new Error('not implemented');
}

export interface RegisteredPasskey {
  passkeyId: string;
  userId: string;
  kind: 'first' | 'later';
}

/** Finish a bound REGISTER ceremony with the browser's creation response. */
export async function finishRegistration(
  db: PrismaClient,
  input: {
    ceremonyId: string; ceremonyNonceHash: string; signInBrowserHash: string | null;
    response: RegistrationResponseJSON; label: string; rpId: string; origins: string[]; windowHours: number;
  },
): Promise<RegisteredPasskey | null> {
  throw new Error('not implemented');
}
