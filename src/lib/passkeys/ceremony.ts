/**
 * #1631 S2a: DB-backed ceremony state. A ceremony is opened by one browser for
 * one purpose and can be consumed once; a JWT is never proof of it. Expiry and
 * consumption read the database clock at the statement (clock_timestamp, never the
 * transaction-start CURRENT_TIMESTAMP: a lock wait in the caller's transaction can cross expiry), and the consume runs inside the caller's
 * transaction, so a later refusal rolls it back.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { verifyAssertionOverChallenge, type AssertionParts, type VerifierCredential } from '../signing/verify.js';

export type CeremonyPurpose = 'SIGN_IN' | 'STEP_UP_ONLY' | 'REGISTER';

/** Open a ceremony for the browser identified by `browserNonceHash`. */
export async function createCeremony(
  tx: Prisma.TransactionClient,
  input: { purpose: CeremonyPurpose; browserNonceHash: string; ttlSeconds: number } & ({ challengeHash: string } | { challengeIsId: true }),
): Promise<{ id: string }> {
  if (!/^[0-9a-f]{64}$/.test(input.browserNonceHash)) throw new Error('browser nonce hash must be 64 lowercase hex');
  if (!Number.isInteger(input.ttlSeconds) || input.ttlSeconds < 1) throw new Error('ttlSeconds must be a positive integer');
  const id = randomBytes(32).toString('base64url');
  // challengeIsId: the challenge is the id's own random bytes, so the server stores only its hash.
  const bound = 'challengeIsId' in input && input.challengeIsId ? createHash('sha256').update(Buffer.from(id, 'base64url')).digest('hex')
    : 'challengeHash' in input ? input.challengeHash : undefined;
  // A ceremony without a challenge binding could be consumed by an assertion over ANY challenge: refuse to mint one.
  if (!bound || !/^[0-9a-f]{64}$/.test(bound)) throw new Error('a ceremony must be bound to its challenge (64 lowercase hex)');
  const challengeHash = bound;
  await tx.$executeRaw`INSERT INTO passkey_ceremonies (id, purpose, browser_nonce_hash, challenge_hash, expires_at)
    VALUES (${id}, ${input.purpose}, ${input.browserNonceHash}, ${challengeHash},
            (clock_timestamp() AT TIME ZONE 'UTC') + make_interval(secs => ${input.ttlSeconds}))`;
  return { id };
}

/**
 * Consume once. False for an unknown, expired, already-consumed, foreign-browser
 * or wrong-purpose ceremony; the caller must not distinguish them to the client.
 * A mismatch leaves the ceremony unconsumed.
 */
export async function consumeCeremony(
  tx: Prisma.TransactionClient,
  input: { id: string; browserNonceHash: string; purpose: CeremonyPurpose },
): Promise<boolean> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`UPDATE passkey_ceremonies
     SET consumed_at = (clock_timestamp() AT TIME ZONE 'UTC')
   WHERE id = ${input.id} AND consumed_at IS NULL
     AND browser_nonce_hash = ${input.browserNonceHash} AND purpose = ${input.purpose}
     AND expires_at > (clock_timestamp() AT TIME ZONE 'UTC')
   RETURNING id`;
  return rows.length === 1;
}

const sha256Hex = (b: Uint8Array | Buffer) => createHash('sha256').update(b).digest('hex');

/** What the caller loaded, without row locks, and verified against. */
export interface CeremonyCredential extends VerifierCredential {
  passkeyId: string;
  ownerId: string;
}

/**
 * The immutable snapshot a successful verification vouches for. `decideCeremonyAssertion`
 * compares it to the locked row, so a credential revoked, re-owned or advanced between
 * verify and decide is refused.
 */
export interface VerifiedAssertion {
  passkeyId: string;
  ownerId: string;
  credentialId: Buffer;
  publicKeyFingerprint: string;
  priorCounter: number;
  newCounter: number;
  challengeHash: string;
}

/**
 * Pure crypto, run OUTSIDE the write transaction (#1631 PR1a): `webauthn.get`, user
 * verification required, exact RP ID and origin allowlist, over the challenge the server
 * issued. Throws `SignatureVerificationError` with no detail for the client.
 */
export async function verifyCeremonyAssertion(a: {
  assertion: AssertionParts;
  credential: CeremonyCredential;
  expectedChallenge: Buffer;
  rpId: string;
  origins: string[];
}): Promise<{ newCounter: number; snapshot: VerifiedAssertion }> {
  const { newCounter } = await verifyAssertionOverChallenge({
    assertion: a.assertion, credential: a.credential, challenge: a.expectedChallenge, rpId: a.rpId, origins: a.origins,
  });
  return {
    newCounter,
    snapshot: {
      passkeyId: a.credential.passkeyId,
      ownerId: a.credential.ownerId,
      credentialId: a.credential.credentialId,
      publicKeyFingerprint: sha256Hex(a.credential.publicKey),
      priorCounter: Number(a.credential.counter),
      newCounter,
      challengeHash: sha256Hex(a.expectedChallenge),
    },
  };
}

/**
 * The deciding step, in the CALLER's transaction. The caller has already taken the user
 * authority anchor and rechecked the live owner; this takes no anchor and starts no
 * transaction. Order: lock and revalidate the credential row against the verified snapshot,
 * only then consume the ceremony, then advance the counter. Null is the one uniform refusal
 * and leaves the ceremony unconsumed.
 */
export async function decideCeremonyAssertion(
  tx: Prisma.TransactionClient,
  d: { ceremonyId: string; browserNonceHash: string; purpose: CeremonyPurpose; verified: VerifiedAssertion },
): Promise<{ ownerId: string; passkeyId: string } | null> {
  const v = d.verified;
  const [row] = await tx.$queryRaw<Array<{ id: string; owner_id: string; public_key: Buffer; counter: bigint; revoked_at: Date | null }>>`
    SELECT id, owner_id, public_key, counter, revoked_at FROM passkey_credentials
     WHERE credential_id = ${v.credentialId} FOR UPDATE`;
  if (!row || row.id !== v.passkeyId || row.owner_id !== v.ownerId || row.revoked_at !== null) return null;
  if (sha256Hex(row.public_key) !== v.publicKeyFingerprint || Number(row.counter) !== v.priorCounter) return null;
  // WebAuthn: a zero counter on both sides means the authenticator keeps none; otherwise it must advance.
  if ((v.newCounter > 0 || v.priorCounter > 0) && v.newCounter <= v.priorCounter) return null;
  const bound = await tx.$queryRaw<Array<{ challenge_hash: string | null }>>`
    SELECT challenge_hash FROM passkey_ceremonies WHERE id = ${d.ceremonyId} FOR UPDATE`;
  if (bound.length !== 1) return null;
  // Fail closed: a ceremony with no recorded challenge binding never matches (and is never consumed here).
  if (bound[0].challenge_hash === null || bound[0].challenge_hash !== v.challengeHash) return null;
  if (!(await consumeCeremony(tx, { id: d.ceremonyId, browserNonceHash: d.browserNonceHash, purpose: d.purpose }))) return null;
  await tx.$executeRaw`UPDATE passkey_credentials
     SET last_used_at = GREATEST(COALESCE(last_used_at, registered_at), (clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3)),
         counter = GREATEST(counter, ${BigInt(v.newCounter)})
   WHERE id = ${row.id}`;
  return { ownerId: row.owner_id, passkeyId: row.id };
}
