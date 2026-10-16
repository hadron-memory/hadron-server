/**
 * #1632 / cor:dmo:130:01 — the signature payload: the exact bytes a passkey
 * signs over (as the SHA-256 WebAuthn challenge).
 *
 * v1 is the S0 contract (src/lib/signaturePayload.fixture.{json,md}, #1629):
 *
 *   hadron-signature-v1
 *   node <stable node id>
 *   approval-hash <64 lowercase hex>
 *
 * UTF-8, LF after every line including the last. Production signing writes v3
 * (the v1 lines under its own prefix plus a request-id line, #10392), whose
 * bytes and fixture are S2b-2's; until then asking for v3 is a loud error, not
 * a guess. `hadron-signature-v2` is retired and never accepted (#9837).
 */
import { createHash } from 'node:crypto';

export const SIGNATURE_PAYLOAD_V1 = 'hadron-signature-v1';
export const SIGNATURE_PAYLOAD_V3 = 'hadron-signature-v3';
export type SignaturePayloadVersion = typeof SIGNATURE_PAYLOAD_V1 | typeof SIGNATURE_PAYLOAD_V3;

/** The payload version new requests pin. v1 until S2b-2 lands v3. */
export const CURRENT_SIGNATURE_PAYLOAD_VERSION: SignaturePayloadVersion = SIGNATURE_PAYLOAD_V1;

export interface SignaturePayloadInput {
  nodeId: string;
  approvalHash: string;
  /** Required by v3 (S2b-2); v1 has no request line. */
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
  if (version !== SIGNATURE_PAYLOAD_V1) throw new UnsupportedSignaturePayloadError(version);
  return Buffer.from(`${SIGNATURE_PAYLOAD_V1}\nnode ${input.nodeId}\napproval-hash ${input.approvalHash}\n`, 'utf8');
}

/** The WebAuthn challenge: the 32 raw bytes of SHA-256 over the payload bytes. */
export function signatureChallenge(payload: Buffer): Buffer {
  return createHash('sha256').update(payload).digest();
}
