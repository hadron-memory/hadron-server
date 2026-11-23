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

/** The backfill numbers collisions from 2, so a suffix is a canonical decimal >= 2: no sign, no leading zero. */
const MIGRATED_SUFFIX = /^(?:[2-9]|[1-9][0-9]+)$/;

/**
 * The backfill's collision suffix on `loc` (#4583): when two names between the same endpoints sanitized to one atom,
 * the migration gave the later edge `<base>:N` (N >= 2, `edge_first_class` lines 70-89). Returns `N` as written when
 * `loc` is exactly `<base>:N`, else null. The ONE rule the lookup, the re-key and the census all use, so they cannot
 * disagree about what a suffixed loc is.
 */
export function migratedLocSuffix(loc: string, base: string): string | null {
  if (!loc.startsWith(`${base}:`)) return null;
  const rest = loc.slice(base.length + 1);
  return MIGRATED_SUFFIX.test(rest) ? rest : null;
}

/**
 * Order two canonical suffixes ({@link migratedLocSuffix}) as decimal numbers WITHOUT converting them: the shorter digit
 * string is smaller (no leading zeros), equal lengths compare lexicographically. Exact for any length, where a float
 * rounds `9007199254740993` and `...992` to one value and a string compare puts `10` before `9`.
 */
export function compareMigratedSuffix(a: string, b: string): number {
  return a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);
}

/**
 * The OTHER spelling of the derived loc (#4583): what the historical migration wrote for the same endpoints and name,
 * when that differs from {@link deriveEdgeLoc}'s. At most ONE element (the array is the shape callers iterate, not a
 * promise of more). Empty exactly when the two FINAL sanitized atoms are equal. That is a comparison of outputs, not a
 * rule about where the non-BMP code point sits: an astral character between alphanumerics usually diverges, but the
 * trims and the 64 cap can make the outputs equal again (a leading or trailing one is trimmed) or make them differ
 * (62 `x` then `😀b`: only the one-`-` spelling keeps the `b` inside the cap). So for names with no astral code point,
 * and for those whose outputs happen to agree, a lookup changes nothing.
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
 * own. The runtime spelling goes to the runtime spelling, as before; the migrated one to the migrated one, and a
 * migrated loc's `:N` collision suffix ({@link migratedLocSuffix}) is carried to the new base.
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
  const [oldAlternate] = deriveEdgeLocAlternates(oldSourceLoc, name, oldTargetLoc);
  if (oldAlternate === undefined) return null;
  const newAlternate = `${newSourceLoc}:${sanitizeLocAtomCodePoint(name)}:${newTargetLoc}`;
  if (loc === oldAlternate) return newAlternate;
  // The backfill's collision suffix moves with the edge (a migrated `<alternate>:N`).
  const suffix = migratedLocSuffix(loc, oldAlternate);
  return suffix === null ? null : `${newAlternate}:${suffix}`;
}

/**
 * #2947 — did the caller SUPPLY a loc? One predicate for every writer that records `Edge.locAuthored`, so an empty
 * string is the same answer everywhere: not supplied, so derived. (A caller that omits the loc and one that sends `''`
 * both get the derivation; neither authored anything.)
 */
export function isAuthoredLoc(loc: string | null | undefined): loc is string {
  return loc != null && loc !== '';
}

/**
 * #4813 — the ONE coercion every inline-edge door applies to a caller-supplied loc: `null`, `undefined` and `''` all
 * mean "nothing authored" (so the loc derives at write, cor:dmo:060:03 — `isAuthoredLoc` is the same predicate), and
 * any other value passes through UNCHANGED, to be validated (`validateLocOrThrow`) before any write. Replaces the
 * copy-pasted `edge.loc || null` at the GraphQL node-write resolver and MCP `resolveEdgeRefs`, so the next inline-edge
 * write path cannot re-decide what "empty" means.
 */
export function normalizeAuthoredEdgeLoc(loc: string | null | undefined): string | null {
  return isAuthoredLoc(loc) ? loc : null;
}

/**
 * #2947 (Xabat's backfill rule): whether an edge's `loc` decodes as the derivation grammar
 * `<source loc>:<name atom>:<target loc>` with the edge's OWN name, from any endpoint generation. The sanitized name is
 * one INTERIOR atom of the loc, in either spelling (the runtime one and the historical code-point one, #4583). It is
 * the SHAPE, never a comparison against the current endpoints, so a derived loc a pre-build move left stale still
 * decodes. The migration `20261121160000_edge_loc_provenance` classifies existing rows with the SQL twin of this
 * function (a parity test runs both on the same rows). It is used for that one backfill and its test, never at move time:
 * a move reads the recorded `Edge.locAuthored` flag.
 */
export function edgeLocDecodesAsDerived(loc: string, name: string | null | undefined): boolean {
  const atoms = loc.split(':');
  if (atoms.length < 3) return false;
  const plain = sanitizeLocAtom(name);
  const twin = sanitizeLocAtomCodePoint(name);
  return atoms.slice(1, -1).some((atom) => atom === plain || atom === twin);
}
