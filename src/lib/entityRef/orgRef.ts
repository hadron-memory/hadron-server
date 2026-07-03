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
): Promise<{ id: string }> {
  if (!isId(ref)) {
    // Non-ID inputs MUST be fully-qualified URNs (spec 022).
    assertFullyQualifiedUrn(ref, 'org');
  }
  const normalized = normalizeUrnForLookup(parseUrnInput(ref).value);
  const where = isId(normalized) ? { id: normalized } : { urn: normalized };
  const org = await db.organization.findUnique({
    where,
    select: { id: true, deletedAt: true },
  });
  if (!org || org.deletedAt) {
    throw new OrganizationNotFoundError(ref);
  }
  return { id: org.id };
}
