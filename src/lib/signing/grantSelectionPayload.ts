/**
 * #5001 slice 1 (cor:acl:140:09, The Selection Grammar): the selection payload, the exact bytes one passkey touch
 * signs (as the SHA-256 WebAuthn challenge) to activate a selection of grants.
 *
 *   hadron-grant-selection-signature-v1
 *   selection <selection id>
 *   grant <grant id>
 *   version <record version>
 *   terms-hash <64 lowercase hex>
 *   ...one such three-line item per grant, ascending by the grant id's bytes
 *
 * UTF-8, LF after every line including the last. Its own prefix, never `hadron-grant-signature-v1` (`grantPayload.ts`)
 * or node signing's `hadron-signature-v3`, so none of the three stands in for another. The `selection` line plays the
 * part the `request` line plays in v1: a signature made for one selection cannot complete another or a one-grant
 * request. Items are sorted here, by byte value, so the bytes never depend on the order the grants were asked for;
 * a repeat, an empty list or more than the cap is refused, never repaired. The bytes are pinned by
 * `grantSelectionSignature.fixture.json`.
 */
import { isGrantToken } from '../grants/terms.js';
import { UnsupportedSignaturePayloadError } from './payload.js';

export const GRANT_SELECTION_PAYLOAD_V1 = 'hadron-grant-selection-signature-v1';
export type GrantSelectionPayloadVersion = typeof GRANT_SELECTION_PAYLOAD_V1;

/** The selection payload version new selection requests pin. */
export const CURRENT_GRANT_SELECTION_PAYLOAD_VERSION: GrantSelectionPayloadVersion = GRANT_SELECTION_PAYLOAD_V1;

/** The most grants one selection holds (cor:acl:140:09; Decided, Holger, 2026-11-24, hadron-server#5001). */
export const GRANT_SELECTION_CAP = 25;

export interface GrantSelectionItem {
  grantId: string;
  /** The grant record's version as the person was shown it. */
  recordVersion: number;
  /** `grantTermsHash` of the terms as the person was shown them. */
  termsHash: string;
}

export interface GrantSelectionPayloadInput {
  /** The selection signing request's id: 22 unpadded base64url characters. */
  selectionId: string;
  items: readonly GrantSelectionItem[];
}

/** The items in the order the payload writes them: ascending by the grant id's bytes (visible ASCII: code units). */
export function sortedSelectionItems<T extends { grantId: string }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => (a.grantId < b.grantId ? -1 : a.grantId > b.grantId ? 1 : 0));
}

/** The exact payload bytes for `version` (cor:acl:140:09). A bad line is refused, never repaired. */
export function grantSelectionPayloadBytes(version: string, input: GrantSelectionPayloadInput): Buffer {
  if (version !== GRANT_SELECTION_PAYLOAD_V1) throw new UnsupportedSignaturePayloadError(version);
  if (typeof input.selectionId !== 'string' || !/^[A-Za-z0-9_-]{22}$/.test(input.selectionId)) {
    throw new Error('selection id must be 22 unpadded base64url characters');
  }
  if (!Array.isArray(input.items) || input.items.length === 0) throw new Error('a selection holds at least one grant');
  if (input.items.length > GRANT_SELECTION_CAP) throw new Error(`a selection holds at most ${GRANT_SELECTION_CAP} grants`);
  const seen = new Set<string>();
  for (const i of input.items) {
    if (!isGrantToken(i.grantId)) throw new Error('grant id must be one token');
    if (seen.has(i.grantId)) throw new Error('a grant appears once in a selection');
    seen.add(i.grantId);
    if (!Number.isSafeInteger(i.recordVersion) || i.recordVersion < 1) throw new Error('record version must be a positive integer');
    if (typeof i.termsHash !== 'string' || !/^[0-9a-f]{64}$/.test(i.termsHash)) throw new Error('terms hash must be 64 lowercase hex');
  }
  const lines = sortedSelectionItems(input.items)
    .map((i) => `grant ${i.grantId}\nversion ${i.recordVersion}\nterms-hash ${i.termsHash}\n`).join('');
  return Buffer.from(`${GRANT_SELECTION_PAYLOAD_V1}\nselection ${input.selectionId}\n${lines}`, 'utf8');
}
