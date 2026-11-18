/**
 * #1632 / cor:dmo:130:01 — the signature payload: the exact bytes a passkey
 * signs over (as the SHA-256 WebAuthn challenge).
 *
 * v3 is the only payload a server builds or verifies (Holger, R80):
 *
 *   hadron-signature-v3
 *   node <stable node id>
 *   approval-hash <64 lowercase hex>
 *   request <signing request id>
 *
 * UTF-8, LF after every line including the last. The request line is the
 * stored id verbatim: 128 CSPRNG bits as 22 unpadded base64url characters
 * (#10392), so one signature can never serve another request. The bytes are
 * pinned by the conformance fixture (`signaturePayload.v3.fixture.*`).
 * `hadron-signature-v1` is no longer produced and no verifier accepts it; a
 * request still open with a v1 pin at the v3 deploy ends stale (R81,
 * cor:dmo:130:03 S19). `hadron-signature-v2` is retired (#9837).
 */
import { createHash } from 'node:crypto';

export const SIGNATURE_PAYLOAD_V3 = 'hadron-signature-v3';
export type SignaturePayloadVersion = typeof SIGNATURE_PAYLOAD_V3;

/** The payload version new requests pin. */
export const CURRENT_SIGNATURE_PAYLOAD_VERSION: SignaturePayloadVersion = SIGNATURE_PAYLOAD_V3;

export interface SignaturePayloadInput {
  nodeId: string;
  approvalHash: string;
  /** The signing request's id: v3's request line (22 unpadded base64url characters). */
  requestId?: string;
}

/** Thrown for a payload version this server cannot build: never silently substituted. */
export class UnsupportedSignaturePayloadError extends Error {
  constructor(readonly version: string) {
    super(`Signature payload version ${version} is not supported by this server`);
  }
}

/** The exact payload bytes for `version` (cor:dmo:130:01). */
export function signaturePayloadBytes(version: string, input: SignaturePayloadInput): Buffer {
  if (!/^[0-9a-f]{64}$/.test(input.approvalHash)) throw new Error('approval hash must be 64 lowercase hex');
  if (!input.nodeId || /[\r\n]/.test(input.nodeId)) throw new Error('node id must be a single non-empty line');
  if (version !== SIGNATURE_PAYLOAD_V3) throw new UnsupportedSignaturePayloadError(version);
  // A bad request line is refused, never repaired: re-encoding or trimming would sign bytes the fixture does not pin.
  if (!input.requestId || !/^[A-Za-z0-9_-]{22}$/.test(input.requestId)) {
    throw new Error('request id must be 22 unpadded base64url characters');
  }
  return Buffer.from(
    `${SIGNATURE_PAYLOAD_V3}\nnode ${input.nodeId}\napproval-hash ${input.approvalHash}\nrequest ${input.requestId}\n`, 'utf8');
}

/** The WebAuthn challenge: the 32 raw bytes of SHA-256 over the payload bytes. */
export function signatureChallenge(payload: Buffer): Buffer {
  return createHash('sha256').update(payload).digest();
}
