/**
 * Edge-loc derivation (spec 037 — first-class edges).
 *
 * Every Edge needs a memory-unique `loc` (its identity + URN suffix), but most
 * creation paths don't author one: the migration backfill of existing rows,
 * Git sync (frontmatter historically carried only `rel:`), `cloneMemory`, and
 * the `hadron_create_edge` tool. For those, we DERIVE a loc deterministically from the
 * endpoints + name so that:
 *   - it is unique exactly where the old `(source, target, name)` triple was
 *     (node locs are unique within a memory, so source/target locs identify the
 *     endpoints), and
 *   - re-running it (a re-sync) produces the SAME loc → sync stays idempotent.
 *
 * The migration SQL in `prisma/migrations/*_edge_first_class/migration.sql`
 * mirrors {@link sanitizeLocAtom} / {@link deriveEdgeLoc} for every name EXCEPT
 * one with a non-BMP code point (an emoji) BETWEEN alphanumerics (#4583):
 * Postgres replaces such a character with ONE `-`, the flagless JS regex below
 * with TWO (one per UTF-16 unit). The migration is applied history and no loc
 * is ever rewritten, so both spellings exist in databases: the migrated edges
 * carry {@link sanitizeLocAtomCodePoint}'s, edges created at runtime since carry
 * {@link sanitizeLocAtom}'s. Runtime derivation keeps its spelling; code that
 * LOOKS UP an existing derived edge also accepts the other one
 * ({@link deriveEdgeLocAlternates}, {@link rekeyDerivedEdgeLoc}, and
 * `derivedEdgeLocForUpsert` in `edgeLocLookup.ts`). Keep this pure ASCII (no
 * Unicode normalization) so plain Postgres `regexp_replace` can reproduce it.
 */

/** Atoms are `:`-separated; must start/end alphanumeric, charset below, ≤64. */
const ATOM_MAX_LENGTH = 64;

/**
 * Coerce arbitrary text (an edge name) into a single valid loc atom: replace
 * any char outside `[A-Za-z0-9._-]` with `-`, trim to alphanumeric ends, cap at
 * 64 chars, and fall back to `rel` when nothing usable remains. The result is
 * guaranteed to satisfy `validateLoc`'s per-atom rule.
 */
export function sanitizeLocAtom(input: string | null | undefined): string {
  // Replace out-of-charset chars (including the `:` separator) with `-`.
  let s = (input ?? '').replace(/[^A-Za-z0-9._-]/g, '-');
  // Atoms must begin and end with a letter or digit.
  s = s.replace(/^[^A-Za-z0-9]+/, '').replace(/[^A-Za-z0-9]+$/, '');
  if (s.length > ATOM_MAX_LENGTH) {
    // Re-trim a trailing non-alnum the cap may have exposed.
    s = s.slice(0, ATOM_MAX_LENGTH).replace(/[^A-Za-z0-9]+$/, '');
  }
  return s.length > 0 ? s : 'rel';
}

/**
 * {@link sanitizeLocAtom} as the historical `edge_first_class` migration computed it (#4583): the out-of-charset
 * replacement is per Unicode CODE POINT (the `u` flag), as Postgres `regexp_replace` does it, so `a😀b` is `a-b`,
 * not `a--b`. Everything after the replacement is ASCII, so the trims, the 64 cap and the `rel` fallback are
 * identical. Used only to RECOGNIZE locs the migration wrote; nothing derives a NEW loc with it.
 */
export function sanitizeLocAtomCodePoint(input: string | null | undefined): string {
  let s = (input ?? '').replace(/[^A-Za-z0-9._-]/gu, '-');
  s = s.replace(/^[^A-Za-z0-9]+/, '').replace(/[^A-Za-z0-9]+$/, '');
  if (s.length > ATOM_MAX_LENGTH) {
    s = s.slice(0, ATOM_MAX_LENGTH).replace(/[^A-Za-z0-9]+$/, '');
  }
  return s.length > 0 ? s : 'rel';
}

/**
 * Derive an edge loc from its endpoints + name:
 * `<sourceLoc>:<sanitize(name|'rel')>:<targetLoc>`.
 *
 * `sourceLoc` / `targetLoc` are already-valid node locs (validated on node
 * create), so only the free-form name needs sanitizing; the composed result is
 * a valid multi-atom loc by construction. Deterministic — same inputs always
 * yield the same loc.
 */
export function deriveEdgeLoc(
  sourceLoc: string,
  name: string | null | undefined,
  targetLoc: string,
): string {
  return `${sourceLoc}:${sanitizeLocAtom(name)}:${targetLoc}`;
}

/**
 * The OTHER spelling of the derived loc (#4583): what the historical migration wrote for the same endpoints and name,
 * when that differs from {@link deriveEdgeLoc}'s. Empty for every name whose two spellings agree, which is every name
 * without a non-BMP code point between alphanumerics, so for those nothing about a lookup changes.
 */
export function deriveEdgeLocAlternates(
  sourceLoc: string,
  name: string | null | undefined,
  targetLoc: string,
): string[] {
  const alternate = `${sourceLoc}:${sanitizeLocAtomCodePoint(name)}:${targetLoc}`;
  return alternate === deriveEdgeLoc(sourceLoc, name, targetLoc) ? [] : [alternate];
}

/**
 * Re-derive a DERIVED edge's loc for new endpoints, in the spelling it already carries (#4583), or null when `loc` is
 * not the loc derived from the old endpoints and this name (an authored loc, which a move leaves alone).
 *
 * Keeping the spelling is what stops a pair of twins (the migrated and the runtime loc of one relationship, which
 * the lookups deliberately tolerate) from landing on ONE loc and violating the (loc, memory) unique: each keeps its
 * own. The runtime spelling goes to the runtime spelling, as before; the migrated one to the migrated one.
 */
export function rekeyDerivedEdgeLoc(
  loc: string,
  oldSourceLoc: string,
  name: string | null | undefined,
  oldTargetLoc: string,
  newSourceLoc: string,
  newTargetLoc: string,
): string | null {
  if (loc === deriveEdgeLoc(oldSourceLoc, name, oldTargetLoc)) return deriveEdgeLoc(newSourceLoc, name, newTargetLoc);
  if (deriveEdgeLocAlternates(oldSourceLoc, name, oldTargetLoc).includes(loc)) {
    return `${newSourceLoc}:${sanitizeLocAtomCodePoint(name)}:${newTargetLoc}`;
  }
  return null;
}
