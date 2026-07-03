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
import { isId } from './shape.js';
import { parseUrnInput, assertFullyQualifiedUrn, normalizeUrnForLookup } from '../urn.js';
import { OrganizationNotFoundError } from './errors.js';

export async function resolveOrgRef(
  db: Pick<PrismaClient, 'organization'>,
  ref: string,
  options?: { includeDeleted?: boolean },
): Promise<{ id: string }> {
  const idInput = isId(ref);
  if (!idInput) {
    // Non-ID inputs MUST be fully-qualified URNs (spec 022).
    assertFullyQualifiedUrn(ref, 'org');
  }
  // ID → PK lookup; URN → normalized (prefix stripped, `::` collapsed to `:`).
  // Normalization is a no-op on an ID, so the ID path skips it.
  const where = idInput
    ? { id: ref }
    : { urn: normalizeUrnForLookup(parseUrnInput(ref).value) };
  // findFirst + `deletedAt: null` so the soft-delete exclusion lives in the
  // query (the `{ id }` / `{ urn }` selector is still unique-backed). Excluded
  // by default; `{ includeDeleted: true }` opts in (matches memoryRef).
  const org = await db.organization.findFirst({
    where: { ...where, ...(options?.includeDeleted ? {} : { deletedAt: null }) },
    select: { id: true },
  });
  if (!org) {
    throw new OrganizationNotFoundError(ref);
  }
  return { id: org.id };
}
