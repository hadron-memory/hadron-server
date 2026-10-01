import { createHash } from 'crypto';

/**
 * #1591 — the approval hash: a full SHA-256 over what a reader of a node sees,
 * recorded when a revision is approved and recomputed by the verify read.
 *
 * It covers the title (`Node.name`), the abstract and the content, and nothing
 * else (Holger's ruling on #1447, round 3, question 5). A change to loc, tags,
 * role, properties or edges does not change it.
 *
 * The hash is over PLAINTEXT. On an encrypted memory, callers decrypt first.
 *
 * Unrelated to `Node.contentHash` (an 8-hex change detector set by external
 * producers), `Node.abstractOriginHash` (spec 032 staleness) and
 * `Node.revisionContentHash` (#1323's internal drift detector).
 *
 * The CLI computes the same hash in Go, so the serialization is a published
 * contract, pinned byte for byte by `approvalHash.fixture.json`. Any change to
 * it is a new version prefix, never an edit to v1.
 */

/** First line of every v1 serialization. A future format gets a new prefix. */
export const APPROVAL_HASH_VERSION = 'hadron-approval-v1';

/** The fields the approval hash covers, in serialization order. */
export interface ApprovalHashFields {
  /** `Node.name`, the display title. */
  title: string | null;
  abstract: string | null;
  content: string | null;
}

/** CRLF and lone CR become LF; nothing else about the text is altered. */
function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n?/g, '\n');
}

/**
 * One field of the serialization. A null value is the line `<name> null`. A
 * string, including the empty string, is `<name> <byte length>`, a newline,
 * the UTF-8 bytes, and a closing newline. The byte length counts the
 * normalized value, so no content can be mistaken for the next field's header.
 */
function serializeField(name: string, value: string | null): Buffer {
  if (value === null) return Buffer.from(`${name} null\n`, 'utf8');
  const bytes = Buffer.from(normalizeLineEndings(value), 'utf8');
  return Buffer.concat([
    Buffer.from(`${name} ${bytes.length}\n`, 'utf8'),
    bytes,
    Buffer.from('\n', 'utf8'),
  ]);
}

/**
 * The canonical v1 serialization the approval hash is taken over:
 *
 * ```
 * hadron-approval-v1\n
 * title <len>\n<bytes>\n      (or: title null\n)
 * abstract <len>\n<bytes>\n   (or: abstract null\n)
 * content <len>\n<bytes>\n    (or: content null\n)
 * ```
 *
 * Fields always appear, always in this order. Line endings are normalized to
 * LF; there is no Unicode normalization, trimming or case folding.
 */
export function canonicalApprovalBytes(fields: ApprovalHashFields): Buffer {
  return Buffer.concat([
    Buffer.from(`${APPROVAL_HASH_VERSION}\n`, 'utf8'),
    serializeField('title', fields.title),
    serializeField('abstract', fields.abstract),
    serializeField('content', fields.content),
  ]);
}

/** The approval hash: 64 lowercase hex characters of SHA-256 over the v1 serialization. */
export function computeApprovalHash(fields: ApprovalHashFields): string {
  return createHash('sha256').update(canonicalApprovalBytes(fields)).digest('hex');
}
