/**
 * #1177 — the provenance fingerprint a generated skill file records.
 *
 * The first 16 hex characters of SHA-256 over the four inputs the file is made
 * from — source URN, name, description, body — NUL-separated so a boundary
 * shift cannot collide (`"ab"+"c"` and `"a"+"bc"` must differ).
 *
 * Deliberately NOT a content-only hash: the description is the TRIGGER, so an
 * edit to it must read as stale; and the source is included so a hand-edited
 * provenance line naming a different node reads as a local edit rather than
 * pairing the file with a node it was never rendered from.
 *
 * Every input is present in the file itself, which is what lets a reader
 * recompute this from the file alone and detect a hand edit without the server.
 * That property is the whole reason the normalization has to be byte-faithful
 * (`normalize.ts`), and it is the property @Eli's §8 asks whether to keep.
 *
 * Inputs are hashed in their EXPORTED form — what `render` writes and `parseFile`
 * reads back — so a node whose content is wrapped in blank lines and the file
 * built from it fingerprint identically. Without that, every export would
 * classify as stale against its own header.
 *
 * NOT affected by the YAML encoder: the hash covers the raw description and
 * body, never the rendered frontmatter. That is what makes the Go and TS
 * renderers' different quoting styles (`'use when:'` vs `"use when:"`) a
 * cosmetic difference rather than a parity break — see `render.ts`.
 */

import { createHash } from 'crypto';
import { normalizeBody, normalizeDescription } from './normalize.js';

/** The provenance fingerprint. 16 hex chars — half a SHA-256, as the Go side writes. */
export function hash(source: string, name: string, description: string, content: string): string {
  const d = normalizeDescription(description);
  const c = normalizeBody(content);
  return createHash('sha256')
    .update(`${source}\0${name}\0${d}\0${c}`, 'utf8')
    .digest('hex')
    .slice(0, 16);
}
