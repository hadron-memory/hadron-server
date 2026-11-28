import { computeContentHash } from './contentHash.js';

/**
 * Spec 032 — the abstractOriginHash partial-update matrix of hadron_update_node, as one rule (#340 runs it twice: on the
 * pre-lock probe for a replace, and again under the row lock on the joined body for an append or prepend, so the two
 * paths cannot drift). `undefined` keeps the stored hash, `null` clears it, a string sets it. `storedAbstract` and
 * `nextContent` are PLAINTEXT (FR-009).
 */
export function deriveAbstractOriginHash(
  normalizedAbstract: string | null | undefined,
  abstractStillAccurate: boolean | undefined,
  storedAbstract: string | null,
  nextContent: string | null | undefined,
): string | null | undefined {
  if (normalizedAbstract === undefined) {
    // #1126 — the caller's assertion that the EXISTING abstract survives
    // this edit. Row 2 (content updated, abstract absent) arms staleness
    // on purpose, and that is right by default: the server cannot know
    // whether an abstract written against the old content still describes
    // the new one. `abstractStillAccurate` is the caller saying they
    // checked — so this re-fingerprints the abstract already on the node
    // against the content this call is writing, exactly as re-saving that
    // identical text would (row 4). It writes no text of its own.
    //
    // Guarded on the node ACTUALLY having an abstract: FR-006/FR-007 hold
    // that no abstract means no hash, and an unguarded assertion here
    // would mint a ghost hash on an abstract-less node — a fingerprint
    // for a thing that does not exist, which later reads would compare
    // against and quietly trust.
    const hasStoredAbstract =
      typeof storedAbstract === 'string' && storedAbstract.trim() !== '';
    if (abstractStillAccurate === true && hasStoredAbstract) {
      // computeContentHash(null) is null, so clearing content through this
      // path lands on FR-007's "abstract but no content ⇒ no hash" rather
      // than needing its own branch.
      return computeContentHash(nextContent ?? null);
    } else {
      return undefined;
    }
  } else if (normalizedAbstract === null) {
    return null;
  } else {
    // `abstract` supplied: this already re-fingerprints against the new
    // content, so `abstractStillAccurate` is redundant here and ignored
    // rather than rejected — both spellings mean the same thing and the
    // outcome is identical either way.
    return computeContentHash(nextContent ?? null);
  }
}
