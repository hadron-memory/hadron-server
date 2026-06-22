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
 * mirrors {@link sanitizeLocAtom} / {@link deriveEdgeLoc} exactly so a
 * prod-backfilled loc and a runtime-created loc agree (asserted by a parity
 * test). Keep the two in lockstep — and keep this pure ASCII (no Unicode
 * normalization) so plain Postgres `regexp_replace` can reproduce it.
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
