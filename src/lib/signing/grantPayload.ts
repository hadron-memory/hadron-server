/**
 * #3649 slice A (cor:acl:140:09): the grant signature payload, the exact bytes a person's passkey signs (as the SHA-256
 * WebAuthn challenge) to activate ONE grant.
 *
 *   hadron-grant-signature-v1
 *   grant <grant id>
 *   version <record version>
 *   terms-hash <64 lowercase hex>
 *   request <signing request id>
 *
 * UTF-8, LF after every line including the last. A prefix of its own, never node signing's `hadron-signature-v3`
 * (`payload.ts`), so a grant signature never completes a node request and a node signature never activates a grant.
 * The issuer is not in the payload: the signer becomes the issuer (cor:acl:140:04), and the signature names its
 * signer. One grant per payload; a selection is a later version with its own prefix (ruling 0255, item 19).
 * The bytes are pinned by the conformance fixture (`grantSignature.fixture.json`).
 */
import { isGrantToken } from '../grants/terms.js';
import { UnsupportedSignaturePayloadError } from './payload.js';

export const GRANT_SIGNATURE_PAYLOAD_V1 = 'hadron-grant-signature-v1';
export type GrantSignaturePayloadVersion = typeof GRANT_SIGNATURE_PAYLOAD_V1;

/** The grant payload version new grant signing requests pin. */
export const CURRENT_GRANT_SIGNATURE_PAYLOAD_VERSION: GrantSignaturePayloadVersion = GRANT_SIGNATURE_PAYLOAD_V1;

export interface GrantSignaturePayloadInput {
  grantId: string;
  /** The grant record's version as the person was shown it. */
  recordVersion: number;
  /** `grantTermsHash` of the terms as the person was shown them. */
  termsHash: string;
  /** The signing request's id: 22 unpadded base64url characters (`newSigningRequestId`). */
  requestId: string;
}

/** The exact payload bytes for `version` (cor:acl:140:09). A bad line is refused, never repaired. */
export function grantSignaturePayloadBytes(version: string, input: GrantSignaturePayloadInput): Buffer {
  if (version !== GRANT_SIGNATURE_PAYLOAD_V1) throw new UnsupportedSignaturePayloadError(version);
  if (!isGrantToken(input.grantId)) {
    throw new Error('grant id must be one token');
  }
  if (!Number.isSafeInteger(input.recordVersion) || input.recordVersion < 1) {
    throw new Error('record version must be a positive integer');
  }
  if (!/^[0-9a-f]{64}$/.test(input.termsHash)) throw new Error('terms hash must be 64 lowercase hex');
  if (!/^[A-Za-z0-9_-]{22}$/.test(input.requestId)) throw new Error('request id must be 22 unpadded base64url characters');
  return Buffer.from(
    `${GRANT_SIGNATURE_PAYLOAD_V1}\ngrant ${input.grantId}\nversion ${input.recordVersion}\n`
    + `terms-hash ${input.termsHash}\nrequest ${input.requestId}\n`, 'utf8');
}
