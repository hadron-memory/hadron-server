/**
 * Magic-byte verification of an uploaded file against its declared MIME.
 *
 * **Why this exists.** The upload path checks the declared MIME against
 * the allowlist, then checks the stored object's `Content-Type` against
 * the declared one — but the CLIENT set both of those. A browser PUTs the
 * bytes straight to a presigned URL and names their type; nothing looks
 * at the file. So an executable uploaded as `image/png` passed every
 * check, and the allowlist was advisory rather than enforced.
 *
 * That gap matters much more while there is no malware scanner (#896):
 * the allowlist is currently the *only* thing standing between an
 * arbitrary upload and a permanent unauthenticated hotlink, so it needs
 * to mean what it says.
 *
 * **Deliberately not a MIME sniffer.** This does NOT try to identify what
 * a file is. It answers one narrower question — "is this plausibly the
 * type it claims?" — for the allowlisted types only, and abstains
 * otherwise. Abstaining is the right default: a false REJECT breaks a
 * legitimate upload with a confusing error, while a false ACCEPT only
 * leaves us where we already are.
 *
 * Text-ish types are deliberately unverified. `text/plain`, `text/csv`,
 * `text/markdown` and `application/json` have no magic bytes, and any
 * heuristic (valid UTF-8, parses as JSON) would reject legitimate files
 * — a CSV in a non-UTF-8 encoding is still a CSV. They are also the
 * least dangerous: browsers do not execute them, and the hotlink pins
 * `response-content-type`, so they cannot be re-interpreted as HTML.
 */

/**
 * A signature is a list of PARTS that must ALL hold (webp is `RIFF` at 0
 * AND `WEBP` at 8 — a RIFF/WAVE is not a webp). A type maps to a list of
 * ALTERNATIVE signatures, any one of which suffices (zip has three valid
 * leading records). Conflating those two is how a WAVE file first passed
 * as an image here.
 */
type Part = { offset: number; bytes: number[] };
type Signature = Part[];

const SIGNATURES: Record<string, Signature[]> = {
  // %PDF
  'application/pdf': [[{ offset: 0, bytes: [0x25, 0x50, 0x44, 0x46] }]],
  // \x89PNG\r\n\x1a\n
  'image/png': [
    [{ offset: 0, bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] }],
  ],
  // JPEG SOI + marker
  'image/jpeg': [[{ offset: 0, bytes: [0xff, 0xd8, 0xff] }]],
  // RIFF....WEBP — both parts, not either.
  'image/webp': [
    [
      { offset: 0, bytes: [0x52, 0x49, 0x46, 0x46] },
      { offset: 8, bytes: [0x57, 0x45, 0x42, 0x50] },
    ],
  ],
};

/**
 * OOXML (docx/xlsx/pptx) are ZIP containers, so all three share one
 * signature. Verifying "is a zip" is all this layer can honestly do —
 * telling a docx from an xlsx means reading the central directory, which
 * is a parser, not a check. Worth having anyway: it still rejects an
 * executable renamed to .docx.
 *
 * `PK\x03\x04` is a normal archive; `PK\x05\x06` (empty) and `PK\x07\x08`
 * (spanned) are accepted too so an odd-but-valid producer isn't refused.
 */
const ZIP_SIGNATURES: Signature[] = [
  [{ offset: 0, bytes: [0x50, 0x4b, 0x03, 0x04] }],
  [{ offset: 0, bytes: [0x50, 0x4b, 0x05, 0x06] }],
  [{ offset: 0, bytes: [0x50, 0x4b, 0x07, 0x08] }],
];

const OOXML_TYPES = new Set([
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
]);

/** Bytes needed to check every signature above (webp needs 12). */
export const MAGIC_BYTES_WINDOW = 16;

export type ContentTypeVerdict = 'match' | 'mismatch' | 'unverifiable';

/**
 * Evaluate one signature against the bytes we have.
 *
 * Three-valued on purpose. "Too short" is only indeterminate while the
 * bytes we DO have still agree — a 6-byte file starting `MZ` is not an
 * unjudgeable PNG, it is definitively not a PNG, even though PNG's
 * signature is 8 bytes. Comparing over the overlap is what separates
 * "can't tell yet" from "already contradicted".
 */
function evaluate(head: Buffer, signature: Signature): 'match' | 'refuted' | 'truncated' {
  let truncated = false;
  for (const part of signature) {
    for (let i = 0; i < part.bytes.length; i++) {
      const at = part.offset + i;
      if (at >= head.length) {
        truncated = true; // ran out of bytes; nothing so far contradicted
        break;
      }
      if (head[at] !== part.bytes[i]) return 'refuted';
    }
  }
  return truncated ? 'truncated' : 'match';
}

/**
 * Does `head` (the first bytes of the file) look like `declaredMime`?
 *
 * - `match` — the signature is present.
 * - `mismatch` — we know this type's signature and the file lacks it.
 * - `unverifiable` — no signature is known for this type, or the file is
 *   too short to tell. The caller should ALLOW these: see the header on
 *   why abstaining beats guessing.
 */
export function verifyDeclaredContentType(
  head: Buffer | null,
  declaredMime: string,
): ContentTypeVerdict {
  if (!head || head.length === 0) return 'unverifiable';

  const signatures = OOXML_TYPES.has(declaredMime)
    ? ZIP_SIGNATURES
    : SIGNATURES[declaredMime];
  if (!signatures) return 'unverifiable';

  const verdicts = signatures.map((s) => evaluate(head, s));
  // Any alternative fully satisfied ⇒ it is what it claims.
  if (verdicts.includes('match')) return 'match';
  // None satisfied, but one could still be, given more bytes ⇒ abstain.
  if (verdicts.includes('truncated')) return 'unverifiable';
  // Every alternative positively contradicted.
  return 'mismatch';
}
