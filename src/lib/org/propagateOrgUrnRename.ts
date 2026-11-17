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
 * such rows instead of stranding them. `validateOrgRoot` guarantees an org URN
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
  options?: { createdBy?: string | null },
): Promise<void> {
  if (oldOrgUrn === newOrgUrn) return;

  // #1079 — record what each child USED to be called, BEFORE rewriting it.
  //
  // Ordering is the whole of it: the UPDATE below derives the new urn from the
  // old one, so once it has run the old value is gone and unrecoverable. These
  // INSERTs therefore run first, in the same transaction, and each mirrors its
  // UPDATE's WHERE clause EXACTLY — an alias recorded for a row the UPDATE
  // skips would claim a rename that never happened, and a row rewritten without
  // an alias is the silent 404 this map exists to prevent. If those two
  // predicates ever drift, they drift into one of those two bugs.
  //
  // This arm matters more than its size suggests: an org rename is the widest
  // rename there is, so it is the one that orphans a whole tenancy's published
  // URNs at once — including every node URN, which carries its memory's slug.
  //
  // ON CONFLICT keeps a rename back and forth from accumulating duplicate rows,
  // which would read as an ambiguous alias and start refusing a URN that
  // resolves to exactly one entity.
  const createdBy = options?.createdBy ?? null;
  // `replace(urn, '::', ':')` normalizes the alias KEY the way
  // `normalizeUrnForLookup` does for a bare stored urn (PR #1080 review,
  // Copilot P2). Rows may still hold the canonical `::` spelling from the
  // spec-021 migration window, while every resolver queries the single-colon
  // form — so an un-normalized key would be stored somewhere nothing ever looks.
  // Bulk SQL cannot call the TypeScript normalizer, hence the inline mirror.
  // #3196: created_at is written explicitly as UTC. The column is a naive
  // timestamp holding UTC, and its DEFAULT CURRENT_TIMESTAMP would land as the
  // session's wall time, hours off under a non-UTC session.
  await tx.$executeRaw`
    INSERT INTO urn_aliases (id, urn, entity_type, entity_id, reason, replaced_by_urn, created_by, created_at)
    SELECT gen_random_uuid()::text, replace(m.urn, '::', ':'), 'MEMORY'::"UrnAliasEntityType", m.id,
           'ORG_RENAME_CASCADE'::"UrnAliasReason",
           replace(${newOrgUrn} || substr(m.urn, strpos(m.urn, ':')), '::', ':'), ${createdBy},
           (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::timestamp(3)
    FROM memories m
    WHERE m.organization_id = ${organizationId} AND strpos(m.urn, ':') > 0
      AND NOT starts_with(m.urn, ${newOrgUrn} || ':')
    ON CONFLICT (urn, entity_type, entity_id)
      DO UPDATE SET replaced_by_urn = EXCLUDED.replaced_by_urn
  `;
  await tx.$executeRaw`
    INSERT INTO urn_aliases (id, urn, entity_type, entity_id, reason, replaced_by_urn, created_by, created_at)
    SELECT gen_random_uuid()::text, replace(a.urn, '::', ':'), 'AGENT'::"UrnAliasEntityType", a.id,
           'ORG_RENAME_CASCADE'::"UrnAliasReason",
           replace(${newOrgUrn} || substr(a.urn, strpos(a.urn, ':')), '::', ':'), ${createdBy},
           (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::timestamp(3)
    FROM agents a
    WHERE a.organization_id = ${organizationId} AND strpos(a.urn, ':') > 0
      AND NOT starts_with(a.urn, ${newOrgUrn} || ':')
    ON CONFLICT (urn, entity_type, entity_id)
      DO UPDATE SET replaced_by_urn = EXCLUDED.replaced_by_urn
  `;
  await tx.$executeRaw`
    INSERT INTO urn_aliases (id, urn, entity_type, entity_id, reason, replaced_by_urn, created_by, created_at)
    SELECT gen_random_uuid()::text, replace(ap.urn, '::', ':'), 'APP'::"UrnAliasEntityType", ap.id,
           'ORG_RENAME_CASCADE'::"UrnAliasReason",
           replace(${newOrgUrn} || substr(ap.urn, strpos(ap.urn, ':')), '::', ':'), ${createdBy},
           (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::timestamp(3)
    FROM apps ap
    WHERE ap.organization_id = ${organizationId} AND strpos(ap.urn, ':') > 0
      AND NOT starts_with(ap.urn, ${newOrgUrn} || ':')
    ON CONFLICT (urn, entity_type, entity_id)
      DO UPDATE SET replaced_by_urn = EXCLUDED.replaced_by_urn
  `;

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
