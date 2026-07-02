import type { Prisma } from '../../generated/prisma/index.js';

/**
 * Rewrite the denormalized org-slug prefix on every Memory, Agent and App URN
 * owned by an organization after its own URN is renamed (issue #337).
 *
 * An org's URN is baked into each child's `urn` column at creation. The
 * canonical form is `<orgUrn>::<slug>`, but legacy rows may store the pre-021
 * single-colon form `<orgUrn>:<slug>` (`normalizeUrnForLookup` collapses
 * `::`→`:`).
 *
 * **Scope by foreign key, not by matching the current org URN.** Every row we
 * rewrite is selected purely by `organization_id`, and the prefix we strip is
 * "everything up to the first colon" — not `<currentOrgUrn>:`. This is the fix
 * for a real drift bug: if a child row's prefix ever diverges from the org's
 * live URN (e.g. a rename that predated this cascade, or a direct DB edit), a
 * prefix-matched rewrite keyed on the *current* org URN would skip that row
 * forever, and every subsequent rename would widen the gap. FK-scoping heals
 * such rows instead of stranding them. `validateOrgSlug` guarantees an org URN
 * never contains a colon, so the first colon is an unambiguous org→slug
 * boundary; keeping everything from that colon onward preserves the `::` vs
 * legacy `:` form verbatim.
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

  // One bulk UPDATE per table, scoped to this org's rows by `organization_id`
  // alone. `strpos(urn, ':')` is the 1-based index of the first colon (the
  // org→slug boundary); `substr(urn, that)` keeps the colon and everything
  // after it verbatim (`::slug` stays `::slug`, legacy `:slug` stays `:slug`),
  // so prepending the new org URN rewrites ANY stale prefix — including one
  // that no longer matches the org's live URN. The `strpos > 0` guard skips
  // any malformed colon-less URN.
  //
  // `NOT starts_with(urn, ${newOrgUrn}:)` skips rows already at the target
  // prefix (PR #456 review): the rewrite is idempotent for them, so touching
  // them only burns a no-op write — MVCC dead tuple, WAL, and churn on the
  // `@unique` urn index. An org URN never contains a colon, so the trailing
  // `:` makes this an exact-boundary check: a row is skipped only when its
  // prefix already equals newOrgUrn (i.e. genuinely correct), never a row
  // that merely shares a leading substring.
  // Table/column names are the Prisma @@map targets.
  await tx.$executeRaw`
    UPDATE memories
    SET urn = ${newOrgUrn} || substr(urn, strpos(urn, ':'))
    WHERE organization_id = ${organizationId} AND strpos(urn, ':') > 0
      AND NOT starts_with(urn, ${newOrgUrn} || ':')
  `;
  await tx.$executeRaw`
    UPDATE agents
    SET urn = ${newOrgUrn} || substr(urn, strpos(urn, ':'))
    WHERE organization_id = ${organizationId} AND strpos(urn, ':') > 0
      AND NOT starts_with(urn, ${newOrgUrn} || ':')
  `;
  await tx.$executeRaw`
    UPDATE apps
    SET urn = ${newOrgUrn} || substr(urn, strpos(urn, ':'))
    WHERE organization_id = ${organizationId} AND strpos(urn, ':') > 0
      AND NOT starts_with(urn, ${newOrgUrn} || ':')
  `;
}
