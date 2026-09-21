/**
 * #1177 — the provenance fingerprint a generated skill file records.
 *
 * The first 16 hex characters of SHA-256 over the FIVE inputs the file is made
 * from — node id, source URN, name, description, body, in that order — NUL-
 * separated so a boundary shift cannot collide (`"ab"+"c"` and `"a"+"bc"` must
 * differ). It was four until #1235 added the id at the front (§4a); this
 * paragraph said four for one commit after that stopped being true (@codex).
 *
 * Deliberately NOT a content-only hash: the description is the TRIGGER, so an
 * edit to it must read as stale; the source is included so a hand-edited
 * provenance line naming a different node reads as a local edit rather than
 * pairing the file with a node it was never rendered from; and the id is
 * included so re-pointing a file at another node cannot read as untouched.
 *
 * Every input is present in the file itself — the id as the header's `id=`
 * key — which is what lets a reader recompute this from the file alone and
 * detect a hand edit without the server.
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

/**
 * The provenance fingerprint. 16 hex chars — half a SHA-256, as the Go side writes.
 *
 * `id` is FIRST and is part of the hash (#1235 / §4a, reversed onto this shape
 * by @codex on cli#624 and @copilot independently on #1234). Left out, editing
 * ONLY the header id keeps `hash(file) === headerHash`, so the file reads as
 * untouched while pairing to a DIFFERENT node — `stale` rather than
 * `locally-edited`, and therefore overwritten despite A1.
 *
 * An EMPTY id hashes as the empty string; it is NOT skipped. That is the
 * convention half of a cross-repo contract, and it is the kind two implementers
 * each decide reasonably and differently — so it is pinned rather than left to
 * taste. The reason is uniformity: the function has ONE shape with no branch,
 * so there is no "does an absent id count?" question for a second
 * implementation to answer differently and no way to be half-right.
 *
 * It is explicitly NOT a legacy-compatibility mechanism, and an earlier draft
 * of this comment claimed it was — that a pre-§4a file "stays self-consistent".
 * It does not: prefixing `"" + NUL` changes the digest, so a file written
 * before §4a does not recompute to its own stored header hash and would
 * classify `locally-edited` (@copilot and @codex both caught this on PR #1249,
 * independently, and the measurement is `4b02a08bb1efbaad` vs
 * `283c6ac5b51c3cd7` over identical inputs).
 *
 * That consequence is real and is RULED IRRELEVANT rather than unnoticed:
 * already-exported skill files are not a factor (@Holger, 2026-09-21), which
 * is comfortable to rely on today for a concrete reason — `hadron skill export`,
 * the only thing that writes a `hash=` header, has not shipped (hadron-cli#621
 * is open), so no such file exists anywhere. The rule is kept for the
 * uniformity above; the legacy argument for it was simply wrong.
 *
 * Pinned against the Go reference by `skilldoc.idHash.parity.test.ts` using the
 * vectors @Jonas published with hadron-cli#650, so the two halves are known to
 * agree BEFORE the fixture-driven A2 gate runs — a disagreement then surfaces
 * as one mismatched constant rather than as a parity failure nobody can
 * localise.
 */
export function hash(
  id: string,
  source: string,
  name: string,
  description: string,
  content: string,
): string {
  const d = normalizeDescription(description);
  const c = normalizeBody(content);
  return createHash('sha256')
    .update(`${id}\0${source}\0${name}\0${d}\0${c}`, 'utf8')
    .digest('hex')
    .slice(0, 16);
}
