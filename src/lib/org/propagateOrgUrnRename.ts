import type { Prisma } from '../../generated/prisma/index.js';

/**
 * Rewrite the denormalized org-slug prefix on every Memory, Agent and App URN
 * owned by an organization after its own URN is renamed (issue #337).
 *
 * An org's URN is baked into each child's `urn` column at creation. The
 * canonical form is `<orgUrn>::<slug>`, but legacy rows may store the pre-021
 * single-colon form `<orgUrn>:<slug>` (`normalizeUrnForLookup` collapses
 * `::`→`:`). An org URN never itself contains a colon, so **`<orgUrn>:` (single
 * colon) is an unambiguous boundary that matches BOTH forms** — replacing it
 * with `<newOrgUrn>:` preserves whatever follows verbatim (`:slug` stays
 * `::slug`, `slug` stays `:slug`), so canonical and legacy URNs both rewrite
 * correctly.
 *
 * Only these three tables store a URN string — Node/Edge URNs and installed-agent
 * URNs are composed on read and self-heal once the parents are fixed. Each table
 * is one bulk `UPDATE` (O(1) round-trips, not O(N) per child) inside the caller's
 * transaction, so the org rename and the child rewrite commit (or roll back)
 * together; a rewritten URN colliding with a `@unique` row aborts the whole
 * rename.
 */
export async function propagateOrgUrnRename(
  tx: Prisma.TransactionClient,
  organizationId: string,
  oldOrgUrn: string,
  newOrgUrn: string,
): Promise<void> {
  if (oldOrgUrn === newOrgUrn) return;

  const oldBoundary = `${oldOrgUrn}:`; // single colon — matches `::` and legacy `:`
  const newBoundary = `${newOrgUrn}:`;
  const fromPos = oldBoundary.length + 1; // 1-based SUBSTRING start, just past the boundary

  // One bulk UPDATE per table. `starts_with(urn, boundary)` is an exact prefix
  // match (no LIKE wildcard escaping, no integer length arg); `organization_id`
  // scopes to this org's own rows. The substring position is cast to int because
  // the driver binds JS numbers as bigint, which `substring(text, int)` rejects.
  // Table/column names are the Prisma @@map targets.
  await tx.$executeRaw`
    UPDATE memories
    SET urn = ${newBoundary} || SUBSTRING(urn, ${fromPos}::int)
    WHERE organization_id = ${organizationId} AND starts_with(urn, ${oldBoundary})
  `;
  await tx.$executeRaw`
    UPDATE agents
    SET urn = ${newBoundary} || SUBSTRING(urn, ${fromPos}::int)
    WHERE organization_id = ${organizationId} AND starts_with(urn, ${oldBoundary})
  `;
  await tx.$executeRaw`
    UPDATE apps
    SET urn = ${newBoundary} || SUBSTRING(urn, ${fromPos}::int)
    WHERE organization_id = ${organizationId} AND starts_with(urn, ${oldBoundary})
  `;
}
