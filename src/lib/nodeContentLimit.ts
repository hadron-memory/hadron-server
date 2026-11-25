/**
 * #5019 (Billing A11): the ceiling on one node's caller-supplied content (`hrn:node:hadronmemory.com:specs:cor:dmo:060:19`,
 * Proposed). `NODE_CONTENT_MAX_BYTES` is deployment configuration; unset means no ceiling. A write that would leave a node
 * with more bytes than it is refused with `NODE_CONTENT_TOO_LARGE` and nothing is written. The ceiling applies to every
 * caller of a checking door, platform admins included. Which doors check is listed in `ownerLimits/writeDoorsGuard5016.test.ts`.
 */
import { GraphQLError } from 'graphql';
import { ENVELOPE_OVERHEAD_BYTES, isCiphertext, stripCiphertextPrefix } from './crypto.js';

export const NODE_CONTENT_MAX_BYTES_ERROR =
  'NODE_CONTENT_MAX_BYTES must be a positive whole number of bytes; refusing to boot.';

/** Parse the raw value: unset or empty means no ceiling (null). Anything malformed throws the fixed sentence, never the value. */
export function parseNodeContentMaxBytes(raw: string | undefined): number | null {
  if (raw === undefined || raw === '') return null;
  const value = /^[1-9][0-9]*$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isSafeInteger(value)) throw new Error(NODE_CONTENT_MAX_BYTES_ERROR);
  return value;
}

/** The ceiling in force, read per call; null when there is none. `createServer` has already refused a malformed value. */
export const nodeContentMaxBytes = (): number | null => parseNodeContentMaxBytes(process.env.NODE_CONTENT_MAX_BYTES);

/** The four measured fields, as PLAINTEXT. A null or omitted field counts 0. */
export interface NodeContentFields {
  content?: string | null;
  description?: string | null;
  data?: unknown;
  properties?: unknown;
}

/** A field whose plaintext size is known without its plaintext (`withEncryptedSizes`). */
class SizedField { constructor(readonly bytes: number) {} }
const textBytes = (v: unknown): number => (v == null ? 0 : v instanceof SizedField ? v.bytes : Buffer.byteLength(v as string, 'utf8'));
const jsonBytes = (v: unknown): number => (v == null ? 0 : textBytes(v instanceof SizedField ? v : JSON.stringify(v)));

/** The UTF-8 bytes of the four fields together, JSON ones as serialized. */
export const nodeContentBytes = (f: NodeContentFields): number =>
  textBytes(f.content) + textBytes(f.description) + jsonBytes(f.data) + jsonBytes(f.properties);

/** The node after a partial write: a supplied field as supplied (null clears), an omitted one as stored. */
export function resultingNodeContent(supplied: NodeContentFields, stored: NodeContentFields | null | undefined): NodeContentFields {
  const pick = (k: keyof NodeContentFields): unknown => (supplied[k] !== undefined ? supplied[k] : stored?.[k]);
  return {
    content: pick('content') as string | null | undefined,
    description: pick('description') as string | null | undefined,
    data: pick('data'),
    properties: pick('properties'),
  };
}

/**
 * An at-rest row with each encrypted field replaced by its plaintext SIZE, for a write that touches no encrypted field and so
 * holds no session key. AES-GCM ciphertext is as long as its plaintext, so the envelope gives the exact size.
 */
export function withEncryptedSizes(row: NodeContentFields): NodeContentFields {
  const sized = (base64: string) => new SizedField(Math.max(0, Buffer.byteLength(base64, 'base64') - ENVELOPE_OVERHEAD_BYTES));
  const enc = row.data as { __enc?: unknown } | null | undefined;
  return {
    ...row,
    content: (isCiphertext(row.content) ? sized(stripCiphertextPrefix(row.content)) : row.content) as string | null | undefined,
    data: enc && typeof enc === 'object' && Object.keys(enc).length === 1 && typeof enc.__enc === 'string' ? sized(enc.__enc) : row.data,
  };
}

/** Registered in `CLIENT_ERROR_MAPPINGS` (formatError.ts). The extensions are the contract the CLI and the portal read. */
export class NodeContentTooLargeError extends GraphQLError {
  constructor(maxBytes: number, bytes: number) {
    super(`A node can hold at most ${maxBytes} bytes.`, { extensions: { code: 'NODE_CONTENT_TOO_LARGE', maxBytes, bytes } });
    this.name = 'NodeContentTooLargeError';
  }
}

/** True when a ceiling is set and the fields pass it. */
export function exceedsNodeContentLimit(fields: NodeContentFields): boolean {
  const max = nodeContentMaxBytes();
  return max !== null && nodeContentBytes(fields) > max;
}

/** Refuse a node over the ceiling. Costs nothing when none is set. */
export function assertNodeContentSize(fields: NodeContentFields): void {
  const max = nodeContentMaxBytes();
  if (max === null) return;
  const bytes = nodeContentBytes(fields);
  if (bytes > max) throw new NodeContentTooLargeError(max, bytes);
}

/**
 * What a `writeNodeCore` call does at the ceiling. REQUIRED beside `ownerLimit`, so a new call site states it.
 * - `check`: caller content; the resulting node is measured.
 * - `skip`: the platform composed it, it is a copy, or the door has a limit of its own.
 */
export type NodeSizeCeiling = 'check' | 'skip';
