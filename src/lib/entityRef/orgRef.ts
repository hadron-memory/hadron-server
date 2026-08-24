/**
 * resolveOrgRef — convert an entity-reference string to a definite
 * organization ID. See `memoryRef.ts` for the convention.
 *
 * Organizations are URN-primary in practice; ID-acceptance exists
 * for uniformity with the convention.
 *
 * Per spec 022 (FR-001 / FR-019 amendment to spec 007), inputs that
 * are NOT ID-shaped MUST be fully-qualified URNs. Relative-form
 * inputs throw `UrnNotQualifiedError` BEFORE the DB lookup runs.
 */

import type { PrismaClient } from '../../generated/prisma/index.js';
import { isId as isIdFunc } from './shape.js';
import { parseUrnInput, assertFullyQualifiedUrn, normalizeUrnForLookup } from '../urn.js';
import { OrganizationNotFoundError } from './errors.js';
import { resolveLegacyAlias } from './legacyAlias.js';
import { findLiveUrnAliasTargets } from '../urnAlias.js';

export async function resolveOrgRef(
  db: Pick<PrismaClient, 'organization' | 'urnAlias'>,
  ref: string,
  options?: { includeDeleted?: boolean },
): Promise<{ id: string }> {
  const isId = isIdFunc(ref);
  if (!isId) {
    // Non-ID inputs MUST be fully-qualified URNs (spec 022).
    assertFullyQualifiedUrn(ref, 'org');
  }
  // ID → PK lookup; URN → normalized (prefix stripped, `::` collapsed to `:`).
  // Normalization is a no-op on an ID, so the ID path skips it.
  const where = isId
    ? { id: ref }
    : { urn: normalizeUrnForLookup(parseUrnInput(ref).value) };
  // findFirst + `deletedAt: null` so the soft-delete exclusion lives in the
  // query (the `{ id }` / `{ urn }` selector is still unique-backed). Excluded
  // by default; `{ includeDeleted: true }` opts in (matches memoryRef).
  const org = await db.organization.findFirst({
    where: { ...where, ...(options?.includeDeleted ? {} : { deletedAt: null }) },
    select: { id: true },
  });
  if (org) {
    return { id: org.id };
  }
  // #1079 rename map. Organization is the ONE renameable entity with no
  // `legacy_urn` column — it was outside the #697 v1→v2 migration, so before
  // this map an org rename had no alias mechanism at all, and it is the widest
  // rename there is: `propagateOrgUrnRename` rewrites the denormalized org
  // prefix on every Memory, Agent and App the org owns, so one org rename
  // orphaned every published URN in the tenancy at once.
  //
  // No `legacy_urn` arm to merge here, so no dedupe is needed — but the
  // ambiguity rule still applies, because an org URN freed by a rename can be
  // taken by a new org and the old one may have been renamed more than once.
  if (!isId) {
    const lookupUrn = normalizeUrnForLookup(parseUrnInput(ref).value);
    const aliased = resolveLegacyAlias(
      ref,
      await findLiveUrnAliasTargets(db, 'ORGANIZATION', lookupUrn, (ids) =>
        // findMany, not findFirst: a findFirst can only ever return one row, which
        // would silently satisfy the ambiguity check instead of tripping it —
        // picking an arbitrary org for a URN that names two.
        db.organization.findMany({
          where: { id: { in: ids }, ...(options?.includeDeleted ? {} : { deletedAt: null }) },
          select: { id: true },
          take: 2,
        }),
      ),
    );
    if (aliased) return aliased;
  }
  throw new OrganizationNotFoundError(ref);
}
