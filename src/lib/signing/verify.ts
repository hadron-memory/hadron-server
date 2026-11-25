/**
 * #1632 / cor:aut:040:06, cor:dmo:130:04 — server-side verification of a
 * signing assertion with @simplewebauthn/server (DAQ, 2026-10-06; pinned
 * exact). The credential, never the authenticator's userHandle, says who
 * signed. Note (Bindi): 14.0.3 does no low-S check, so an ES256 signature is
 * malleable and must never serve as a dedupe key.
 */
import { createHash } from 'node:crypto';
import { verifyAuthenticationResponse } from '@simplewebauthn/server';
import { signatureChallenge, signaturePayloadBytes, type SignaturePayloadInput } from './payload.js';
import { SigningNotConfiguredError } from './config.js';
import { grantSignaturePayloadBytes, type GrantSignaturePayloadInput } from './grantPayload.js';
import { GRANT_SELECTION_PAYLOAD_V1, grantSelectionPayloadBytes } from './grantSelectionPayload.js';

export interface AssertionParts {
  authenticatorData: Buffer;
  clientDataJson: Buffer;
  signature: Buffer;
}

export interface VerifierCredential {
  credentialId: Buffer;
  /** COSE-encoded public key, as registered. */
  publicKey: Buffer;
  counter: bigint;
}

/** The assertion did not verify. Deliberately carries no detail for the caller. */
export class SignatureVerificationError extends Error {
  constructor(readonly reason: string) {
    super('The signature did not verify');
  }
}

const b64url = (b: Buffer) => b.toString('base64url');

function responseJson(credentialId: Buffer, a: AssertionParts) {
  return {
    id: b64url(credentialId),
    rawId: b64url(credentialId),
    type: 'public-key' as const,
    clientExtensionResults: {},
    response: {
      authenticatorData: b64url(a.authenticatorData),
      clientDataJSON: b64url(a.clientDataJson),
      signature: b64url(a.signature),
    },
  };
}

/**
 * Full verification over an exact challenge: user verification required, the
 * exact RP ID, an origin from the exact allowlist, `webauthn.get`. Shared by
 * signing (challenge derived from the payload) and ceremony sign-in (#1631,
 * challenge issued by the server). Returns the authenticator's new counter.
 */
export async function verifyAssertionOverChallenge(args: {
  assertion: AssertionParts;
  credential: VerifierCredential;
  challenge: Buffer;
  rpId: string;
  origins: string[];
}): Promise<{ newCounter: number }> {
  if (args.origins.length === 0) throw new SigningNotConfiguredError('SIGNING_CEREMONY_ORIGINS is not set');
  let result;
  try {
    result = await verifyAuthenticationResponse({
      response: responseJson(args.credential.credentialId, args.assertion),
      expectedChallenge: b64url(args.challenge),
      expectedOrigin: args.origins,
      expectedRPID: args.rpId,
      expectedType: 'webauthn.get',
      credential: {
        id: b64url(args.credential.credentialId),
        publicKey: new Uint8Array(args.credential.publicKey),
        counter: Number(args.credential.counter),
      },
      requireUserVerification: true,
    });
  } catch (e) {
    throw new SignatureVerificationError(e instanceof Error ? e.message : String(e));
  }
  if (!result.verified || !result.authenticationInfo.userVerified) throw new SignatureVerificationError('not verified');
  return { newCounter: result.authenticationInfo.newCounter };
}

/** Signing completion: the challenge is derived from the pinned payload. */
export async function verifySigningAssertion(args: {
  assertion: AssertionParts;
  credential: VerifierCredential;
  payload: Buffer;
  rpId: string;
  origins: string[];
}): Promise<{ newCounter: number }> {
  return verifyAssertionOverChallenge({ ...args, challenge: signatureChallenge(args.payload) });
}

/** A stored signature record, as re-verification needs it. */
export interface StoredSignature extends AssertionParts, SignaturePayloadInput {
  id: string;
  payloadVersion: string;
}

const REVERIFY_CACHE_MAX = 10_000;
const reverifyCache = new Map<string, boolean>();

/** The cache key binds the record to its exact assertion bytes (SEC-3). */
function cacheKey(record: StoredSignature, rpId: string): string {
  const h = createHash('sha256');
  for (const part of [record.authenticatorData, record.clientDataJson, record.signature]) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(part.length);
    h.update(len).update(part);
  }
  return `${record.id}:${rpId}:${h.digest('hex')}`;
}

/**
 * Re-verification on read (cor:dmo:130:04 "invalid"): the stored assertion
 * against the stored public key, the challenge rebuilt from the record's own
 * pinned payload, the RP ID hash, UV and `webauthn.get`. The origin was
 * enforced at completion and is not re-checked, so an allowlist change never
 * turns historical signatures invalid (#1632 contract note, gap 6). Any
 * failure, including an unbuildable payload version, is `false`: invalid.
 */
export async function signatureRecordVerifies(record: StoredSignature, credential: VerifierCredential, rpId: string): Promise<boolean> {
  const key = cacheKey(record, rpId);
  const hit = reverifyCache.get(key);
  if (hit !== undefined) return hit;
  let ok = false;
  try {
    const payload = signaturePayloadBytes(record.payloadVersion, record);
    const origin = JSON.parse(record.clientDataJson.toString('utf8'))?.origin;
    if (typeof origin === 'string') {
      const result = await verifyAuthenticationResponse({
        response: responseJson(credential.credentialId, record),
        expectedChallenge: b64url(signatureChallenge(payload)),
        expectedOrigin: origin,
        expectedRPID: rpId,
        expectedType: 'webauthn.get',
        credential: { id: b64url(credential.credentialId), publicKey: new Uint8Array(credential.publicKey), counter: 0 },
        requireUserVerification: true,
      });
      ok = result.verified && result.authenticationInfo.userVerified;
    }
  } catch {
    ok = false;
  }
  if (reverifyCache.size >= REVERIFY_CACHE_MAX) reverifyCache.delete(reverifyCache.keys().next().value!);
  reverifyCache.set(key, ok);
  return ok;
}

/** A stored grant signature record, as re-verification needs it (#3649 slice D). */
export interface StoredGrantSignature extends AssertionParts, GrantSignaturePayloadInput {
  id: string;
  payloadVersion: string;
  /**
   * #5001: for a record signed as part of a selection, the touch record's KEPT signed item list (grant id, version, terms hash, in
   * signed order). The bytes are rebuilt from it and never from the grants as they are now; the record's own grant, version and
   * terms hash must be one of those items. Absent for a one-grant record: a selection-version record without it is invalid, and a
   * one-grant record never reaches the selection builder.
   */
  selection?: { selectionId: string; items: Array<{ grantId: string; version: number; termsHash: string }> };
}

/** The payload bytes a stored grant record signed, by its payload version; a throw (or null) means the record cannot verify. */
function storedGrantPayload(record: StoredGrantSignature): Buffer | null {
  if (record.payloadVersion === GRANT_SELECTION_PAYLOAD_V1) {
    const sel = record.selection;
    if (!sel || !sel.items.some((i) => i.grantId === record.grantId && i.version === record.recordVersion && i.termsHash === record.termsHash)) return null;
    return grantSelectionPayloadBytes(record.payloadVersion, {
      selectionId: sel.selectionId, items: sel.items.map((i) => ({ grantId: i.grantId, recordVersion: i.version, termsHash: i.termsHash })),
    });
  }
  // The one-grant builder refuses every other version, so a selection record can never be judged as v1.
  if (record.selection) return null;
  return grantSignaturePayloadBytes(record.payloadVersion, record);
}

/**
 * #3649 slice D (cor:acl:140:07; cor:dmo:130:04 "invalid" mirror): re-verification of a stored GRANT signature on read.
 * The same checks as {@link signatureRecordVerifies}, with the challenge rebuilt from the record's own pins (grant,
 * version, terms hash, request) by the grant payload builder, so a node assertion never verifies here and the reverse.
 * Unlike the node cache, the key binds the rebuilt payload bytes as well as the assertion bytes: a pin altered after a
 * cached read re-verifies (and fails) instead of reusing the earlier verdict. Any failure is `false`: invalid.
 */
export async function grantSignatureRecordVerifies(record: StoredGrantSignature, credential: VerifierCredential, rpId: string): Promise<boolean> {
  let payload: Buffer;
  try {
    const built = storedGrantPayload(record);
    if (!built) return false;
    payload = built;
  } catch {
    return false;
  }
  const h = createHash('sha256');
  for (const part of [payload, record.authenticatorData, record.clientDataJson, record.signature, credential.publicKey]) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(part.length);
    h.update(len).update(part);
  }
  const key = `grant:${record.id}:${rpId}:${h.digest('hex')}`;
  const hit = reverifyCache.get(key);
  if (hit !== undefined) return hit;
  let ok = false;
  try {
    const origin = JSON.parse(record.clientDataJson.toString('utf8'))?.origin;
    if (typeof origin === 'string') {
      const result = await verifyAuthenticationResponse({
        response: responseJson(credential.credentialId, record),
        expectedChallenge: b64url(signatureChallenge(payload)),
        expectedOrigin: origin,
        expectedRPID: rpId,
        expectedType: 'webauthn.get',
        credential: { id: b64url(credential.credentialId), publicKey: new Uint8Array(credential.publicKey), counter: 0 },
        requireUserVerification: true,
      });
      ok = result.verified && result.authenticationInfo.userVerified;
    }
  } catch {
    ok = false;
  }
  if (reverifyCache.size >= REVERIFY_CACHE_MAX) reverifyCache.delete(reverifyCache.keys().next().value!);
  reverifyCache.set(key, ok);
  return ok;
}

/** Test seam: forget cached verdicts. */
export function clearSignatureVerifyCache(): void {
  reverifyCache.clear();
}
