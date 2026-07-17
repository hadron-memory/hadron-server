/**
 * URN grammar-v2 online migration — the PURE slug planner (#697, Task A).
 *
 * The v2 memory/agent/app URN is `<root>:<slug>` — a SINGLE slug atom (so a node
 * URN `<root>:<mem>:<loc…>` parses with `mem` as one atom, per `cor:urn:010:01`).
 *
 * Two authorities feed the v2 URN, and they come from DIFFERENT places:
 *
 *   - **root** — the owner principal — is taken from the row's OWNER FK
 *     (`organizationId` → org name, or `ownerUserId` → user handle), NOT from the
 *     stored URN string. A row's stored URN root can diverge from its real owner
 *     (observed in prod-shaped data: `shadowbrush.com:mealplan` owned by org
 *     `baragaun.com`), so the FK is authoritative and this planner never guesses
 *     the root. The backfill supplies it.
 *   - **slug** — the terminal `:`-atom of the stored URN — is what this pure
 *     module extracts, applying the "keep terminal atom" rule (2026-07-17):
 *       `<org>:<slug>`                     → slug=`<slug>`        (byte-identical)
 *       `@<handle>:<slug>`                 → slug=`<slug>`        (drop the `@`)
 *       `<org>:<agent>-system`            → slug=`<agent>-system` (already 1 atom)
 *       `<org>:<agent>:app-user:<id>`     → slug=`<id>`          (terminal atom)
 *       `<org>:<app>:<agent>:app-mem:<s>` → slug=`<s>`
 *
 * The full old URN survives in `legacyUrn`, so the collapsed structure — and a
 * root that got re-homed onto the real owner — stays resolvable.
 */

/** The three v2 entity types this migration re-roots (single-atom slug shapes). */
export type EntityUrnType = 'mem' | 'agent' | 'app';

/** The string-derived pieces of a v1 URN (the root comes from the owner FK). */
export interface SlugPlan {
  /** The desired v2 slug — the terminal atom of the v1 URN (kept when free). */
  desiredSlug: string;
  /**
   * The author-derived collision disambiguator for {@link mintLocalSlug}: the
   * agent/app segment of a compound marker URN (so an alias reads `<id>-<agent>`),
   * or null for a simple 2-atom URN (the caller falls back to the root).
   */
  authorRootHint: string | null;
}

/**
 * Extract the v2 slug + collision hint from a stored **bare v1 URN** (see the
 * module doc). Pure; throws `Error` only on a structurally impossible input
 * (empty, single-atom, or an empty inner atom) so the caller can record it as a
 * per-row `urnMigrationFailedReason` rather than crash the sweep. A leading `@`
 * (user-owner sigil) is tolerated and ignored — the owner comes from the FK.
 */
export function planV2Slug(bareV1Urn: string): SlugPlan {
  const urn = bareV1Urn.trim();
  if (urn.length === 0) throw new Error('empty URN');

  const body = urn.startsWith('@') ? urn.slice(1) : urn;
  const atoms = body.split(':');
  if (atoms.length < 2 || atoms.some((a) => a.length === 0)) {
    throw new Error(`malformed v1 URN "${bareV1Urn}" (need <root>:<…>:<slug>)`);
  }

  const desiredSlug = atoms[atoms.length - 1]!;
  // Compound marker URNs (>2 atoms) carry an agent/app segment at index 1; use
  // it as the collision disambiguator. Simple 2-atom forms have none.
  const authorRootHint = atoms.length > 2 ? atoms[1]! : null;

  return { desiredSlug, authorRootHint };
}
