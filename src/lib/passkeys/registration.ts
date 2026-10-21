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
import { createHash, randomBytes } from 'node:crypto';
import { verifyRegistrationResponse, type RegistrationResponseJSON } from '@simplewebauthn/server';
import { isoCBOR } from '@simplewebauthn/server/helpers';
import { Prisma, type PrismaClient } from '../../generated/prisma/index.js';
import { generateId } from '../id.js';
import { lockAuthorityAnchors } from '../auth/authorityAnchors.js';
import { encryptToken } from '../tokenCrypto.js';
import type { AssertionParts } from '../signing/verify.js';
import { verifyCeremonyAssertion, type VerifiedAssertion } from './ceremony.js';
import { consumeFreshSignIn, FRESH_SIGN_IN_MAX_AGE_SECONDS } from './freshSignIn.js';
import { issueCancelToken } from './cancel.js';

const HEX64 = /^[0-9a-f]{64}$/;
const sha256Hex = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
/** WebAuthn algorithms a credential may use (cor:aut:040:05: ES256, RS256). */
const ALGORITHMS = [-7, -257];

/** cor:aut:040:07: 72 hours by default; a deployment may lengthen it, never shorten it. */
export const MIN_FIRST_WINDOW_HOURS = 72;
export const LABEL_MAX_LENGTH = 64;

/** The first-passkey window length, from `PASSKEY_FIRST_WINDOW_HOURS`. Throws (at mount, so at boot) on a bad value. */
export function firstPasskeyWindowHours(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.PASSKEY_FIRST_WINDOW_HOURS;
  if (raw === undefined) return MIN_FIRST_WINDOW_HOURS;
  const hours = /^[0-9]+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isSafeInteger(hours) || hours < MIN_FIRST_WINDOW_HOURS) {
    throw new Error(`PASSKEY_FIRST_WINDOW_HOURS must be an integer of at least ${MIN_FIRST_WINDOW_HOURS} (cor:aut:040:07)`);
  }
  return hours;
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
  if (!HEX64.test(input.ceremonyNonceHash) || !HEX64.test(input.signInBrowserHash)) return null;
  // The identity source is the browser's fresh sign-in and nothing else. Exactly one row may qualify (Rook Q2.1).
  const qualifying = (tx: Pick<PrismaClient, '$queryRaw'>) => tx.$queryRaw<Array<{ user_id: string }>>`
    SELECT user_id FROM fresh_sign_ins
     WHERE browser_nonce_hash = ${input.signInBrowserHash} AND confirmed_at IS NOT NULL AND consumed_at IS NULL
       AND signed_in_at >= (clock_timestamp() AT TIME ZONE 'UTC') - make_interval(secs => ${FRESH_SIGN_IN_MAX_AGE_SECONDS})`;
  const peek = await qualifying(db);
  if (peek.length !== 1) return null;
  const userId = peek[0].user_id;
  return db.$transaction(async (tx) => {
    await lockAuthorityAnchors(tx, [{ kind: 'user', id: userId }], 'exclusive');
    const user = await liveUser(tx, userId);
    if (!user || (await unrevokedCredentialIds(tx, userId)).length > 0) return null;
    if (!(await lockOpenCeremony(tx, input.ceremonyId, input.ceremonyNonceHash))) return null;
    const recheck = await qualifying(tx);
    if (recheck.length !== 1 || recheck[0].user_id !== userId) return null;
    // Nothing is written before this point, so every refusal above leaves the sign-in unspent.
    const spent = await consumeFreshSignIn(tx, { browserNonceHash: input.signInBrowserHash, actingUserId: userId, purpose: 'register' });
    if (!spent) throw new RegistrationRefused();
    const userHandle = randomBytes(32);
    await tx.$executeRaw`UPDATE passkey_ceremonies SET user_id = ${userId}, kind = 'first', registration_method = ${spent.method},
        sign_in_browser_hash = ${input.signInBrowserHash}, user_handle = ${userHandle}
      WHERE id = ${input.ceremonyId}`;
    return { userId, handle: user.handle, userHandle, excludeCredentialIds: [] };
  }).catch(refusedAsNull);
}

/** Bind a REGISTER ceremony to a later passkey, vouched for by an assertion from an existing passkey. */
export async function bindLaterRegistration(
  db: PrismaClient,
  input: { ceremonyId: string; ceremonyNonceHash: string; vouch: AssertionParts & { credentialId: Buffer }; rpId: string; origins: string[] },
): Promise<RegistrationBinding | null> {
  if (!HEX64.test(input.ceremonyNonceHash) || clientDataType(input.vouch.clientDataJson) !== 'webauthn.get') return null;
  const [row] = await db.$queryRaw<Array<{ id: string; owner_id: string; public_key: Buffer; counter: bigint; revoked_at: Date | null; enrollment_rp_id: string }>>`
    SELECT id, owner_id, public_key, counter, revoked_at, enrollment_rp_id FROM passkey_credentials WHERE credential_id = ${input.vouch.credentialId}`;
  // cor:aut:040:06 / #2202: a credential enrolled under another RP ID never vouches, before any crypto.
  if (!row || row.revoked_at !== null || row.enrollment_rp_id !== input.rpId) return null;
  let verified: VerifiedAssertion;
  try {
    ({ snapshot: verified } = await verifyCeremonyAssertion({
      assertion: { authenticatorData: input.vouch.authenticatorData, clientDataJson: input.vouch.clientDataJson, signature: input.vouch.signature },
      credential: { passkeyId: row.id, ownerId: row.owner_id, credentialId: input.vouch.credentialId, publicKey: row.public_key, counter: row.counter },
      expectedChallenge: Buffer.from(input.ceremonyId, 'base64url'), rpId: input.rpId, origins: input.origins,
    }));
  } catch { return null; }
  return db.$transaction(async (tx) => {
    await lockAuthorityAnchors(tx, [{ kind: 'user', id: verified.ownerId }], 'exclusive');
    const user = await liveUser(tx, verified.ownerId);
    if (!user || !(await lockVoucher(tx, verified))) return null;
    if (!(await lockOpenCeremony(tx, input.ceremonyId, input.ceremonyNonceHash))) return null;
    await tx.$executeRaw`UPDATE passkey_credentials
       SET last_used_at = GREATEST(COALESCE(last_used_at, registered_at), (clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3)),
           counter = GREATEST(counter, ${BigInt(verified.newCounter)})
     WHERE id = ${verified.passkeyId}`;
    const userHandle = randomBytes(32);
    await tx.$executeRaw`UPDATE passkey_ceremonies SET user_id = ${verified.ownerId}, kind = 'later',
        vouch_passkey_id = ${verified.passkeyId}, user_handle = ${userHandle}
      WHERE id = ${input.ceremonyId}`;
    return { userId: verified.ownerId, handle: user.handle, userHandle, excludeCredentialIds: await unrevokedCredentialIds(tx, verified.ownerId) };
  });
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
  if (!HEX64.test(input.ceremonyNonceHash) || (input.signInBrowserHash !== null && !HEX64.test(input.signInBrowserHash))) return null;
  const label = input.label.trim();
  if (!label || label.length > LABEL_MAX_LENGTH || /[\u0000-\u001f\u007f]/.test(label)) return null;
  const [bound] = await db.$queryRaw<Array<{ user_id: string; kind: 'first' | 'later'; user_handle: Buffer; vouch_passkey_id: string | null; sign_in_browser_hash: string | null }>>`
    SELECT user_id, kind, user_handle, vouch_passkey_id, sign_in_browser_hash FROM passkey_ceremonies
     WHERE id = ${input.ceremonyId} AND purpose = 'REGISTER' AND user_id IS NOT NULL AND consumed_at IS NULL`;
  if (!bound) return null;
  // Rook Q1.1: a first passkey's ceremony carries a spent fresh sign-in, so finish needs that browser too.
  if (bound.kind === 'first' && input.signInBrowserHash !== bound.sign_in_browser_hash) return null;
  if (clientDataType(Buffer.from(input.response.response?.clientDataJSON ?? '', 'base64url')) !== 'webauthn.create') return null;
  // cor:aut:040:05: a credential the client reports as not discoverable is refused (the options require one).
  if ((input.response.clientExtensionResults as { credProps?: { rk?: unknown } } | undefined)?.credProps?.rk === false) return null;
  let info: NonNullable<Awaited<ReturnType<typeof verifyRegistrationResponse>>['registrationInfo']>;
  try {
    const v = await verifyRegistrationResponse({
      response: input.response, expectedChallenge: input.ceremonyId, expectedOrigin: input.origins, expectedRPID: input.rpId,
      requireUserVerification: true, supportedAlgorithmIDs: ALGORITHMS,
    });
    if (!v.verified || !v.registrationInfo || !v.registrationInfo.userVerified) return null;
    info = v.registrationInfo;
  } catch { return null; }
  const credentialId = Buffer.from(info.credential.id, 'base64url');
  const publicKey = Buffer.from(info.credential.publicKey);
  const algorithm = coseAlgorithm(publicKey);
  if (algorithm === null || !ALGORITHMS.includes(algorithm) || credentialId.length === 0) return null;

  return db.$transaction(async (tx) => {
    await lockAuthorityAnchors(tx, [{ kind: 'user', id: bound.user_id }], 'exclusive');
    if (!(await liveUser(tx, bound.user_id))) return null;
    if (bound.kind === 'first') {
      // cor:aut:040:02: still the user's first. A parallel ceremony that finished first makes this one a refusal.
      if ((await unrevokedCredentialIds(tx, bound.user_id)).length > 0) return null;
    } else {
      const ok = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM passkey_credentials
        WHERE id = ${bound.vouch_passkey_id} AND owner_id = ${bound.user_id} AND revoked_at IS NULL AND ${outOfWindow} FOR SHARE`;
      if (ok.length !== 1) return null;
    }
    // Deployment-unique, revoked credentials included: never re-register an id.
    if ((await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM passkey_credentials WHERE credential_id = ${credentialId}`).length > 0) return null;
    const consumed = await tx.$queryRaw<Array<{ id: string }>>`UPDATE passkey_ceremonies SET consumed_at = (clock_timestamp() AT TIME ZONE 'UTC')
      WHERE id = ${input.ceremonyId} AND purpose = 'REGISTER' AND browser_nonce_hash = ${input.ceremonyNonceHash}
        AND consumed_at IS NULL AND expires_at > (clock_timestamp() AT TIME ZONE 'UTC') AND user_id = ${bound.user_id}
        AND (kind <> 'first' OR sign_in_browser_hash = ${input.signInBrowserHash})
      RETURNING id`;
    if (consumed.length !== 1) return null;
    // Past this point every statement either succeeds or throws, so a refusal never leaves the ceremony half-spent.
    const passkeyId = generateId();
    const first = bound.kind === 'first';
    const [method] = await tx.$queryRaw<Array<{ registration_method: string | null }>>`
      SELECT registration_method FROM passkey_ceremonies WHERE id = ${input.ceremonyId}`;
    await tx.$executeRaw`INSERT INTO passkey_credentials
      (id, owner_id, credential_id, public_key, algorithm, user_handle, enrollment_rp_id, label, registered_at, counter,
       transports, backup_eligible, backed_up, registration_method, window_ends_at)
      VALUES (${passkeyId}, ${bound.user_id}, ${credentialId}, ${publicKey}, ${algorithm}, ${bound.user_handle}, ${input.rpId}, ${label},
        (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::timestamp(3), 0, ${info.credential.transports ?? []}::text[],
        ${info.credentialDeviceType === 'multiDevice'}, ${info.credentialDeviceType === 'multiDevice' && info.credentialBackedUp},
        ${first ? method.registration_method : null},
        CASE WHEN ${first} THEN (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::timestamp(3) + make_interval(hours => ${input.windowHours}::int) END)`;
    const cancelTokenEnc = first ? encryptToken(await issueCancelToken(tx, passkeyId)) : null;
    await tx.$executeRaw`INSERT INTO passkey_registration_notices (id, passkey_id, user_id, kind, cancel_token_enc)
      VALUES (${generateId()}, ${passkeyId}, ${bound.user_id}, ${bound.kind}, ${cancelTokenEnc})`;
    return { passkeyId, userId: bound.user_id, kind: bound.kind };
  });
}

/** Thrown inside a transaction to roll back a step that had already written; surfaced as null. */
class RegistrationRefused extends Error {}
const refusedAsNull = (err: unknown) => { if (err instanceof RegistrationRefused) return null; throw err; };

/** The live user's handle, or null. */
async function liveUser(tx: Prisma.TransactionClient, userId: string): Promise<{ handle: string } | null> {
  return tx.user.findFirst({ where: { id: userId, deletedAt: null }, select: { handle: true } });
}

async function unrevokedCredentialIds(tx: Prisma.TransactionClient, userId: string): Promise<Buffer[]> {
  const rows = await tx.$queryRaw<Array<{ credential_id: Buffer }>>`
    SELECT credential_id FROM passkey_credentials WHERE owner_id = ${userId} AND revoked_at IS NULL ORDER BY registered_at`;
  return rows.map((r) => Buffer.from(r.credential_id));
}

/** Lock an open, unbound REGISTER ceremony of this browser, or report it absent. */
async function lockOpenCeremony(tx: Prisma.TransactionClient, ceremonyId: string, ceremonyNonceHash: string): Promise<boolean> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM passkey_ceremonies
    WHERE id = ${ceremonyId} AND purpose = 'REGISTER' AND browser_nonce_hash = ${ceremonyNonceHash}
      AND consumed_at IS NULL AND user_id IS NULL AND expires_at > (clock_timestamp() AT TIME ZONE 'UTC')
    FOR UPDATE`;
  return rows.length === 1;
}

/**
 * A passkey that is not in its cooling-off window: it never had one, or its window ended normally (ran out, or ended
 * early). A window ended by cancellation leaves the passkey revoked, which the callers check separately.
 */
const outOfWindow = Prisma.sql`(window_ends_at IS NULL OR window_outcome IN ('ran-out', 'ended-early')
  OR (window_outcome IS NULL AND window_ends_at <= (clock_timestamp() AT TIME ZONE 'UTC')))`;

/** Lock the voucher and revalidate it against what the assertion verified (as decideCeremonyAssertion does). */
async function lockVoucher(tx: Prisma.TransactionClient, v: VerifiedAssertion): Promise<boolean> {
  const [row] = await tx.$queryRaw<Array<{ id: string; owner_id: string; public_key: Buffer; counter: bigint }>>`
    SELECT id, owner_id, public_key, counter FROM passkey_credentials
     WHERE credential_id = ${v.credentialId} AND revoked_at IS NULL AND ${outOfWindow} FOR UPDATE`;
  if (!row || row.id !== v.passkeyId || row.owner_id !== v.ownerId) return false;
  if (sha256Hex(row.public_key) !== v.publicKeyFingerprint || Number(row.counter) !== v.priorCounter) return false;
  // WebAuthn: a zero counter on both sides means the authenticator keeps none; otherwise it must advance.
  return !((v.newCounter > 0 || v.priorCounter > 0) && v.newCounter <= v.priorCounter);
}

/** The clientDataJSON `type`, checked explicitly so a creation and an assertion never stand in for each other. */
function clientDataType(clientDataJson: Uint8Array): string | null {
  try {
    const t = (JSON.parse(Buffer.from(clientDataJson).toString('utf8')) as { type?: unknown }).type;
    return typeof t === 'string' ? t : null;
  } catch { return null; }
}

/** The COSE `alg` (label 3) of a credential public key, or null. */
function coseAlgorithm(publicKey: Uint8Array): number | null {
  try {
    const key = isoCBOR.decodeFirst<Map<number, unknown>>(new Uint8Array(publicKey));
    const alg = key.get(3);
    return typeof alg === 'number' ? alg : null;
  } catch { return null; }
}
