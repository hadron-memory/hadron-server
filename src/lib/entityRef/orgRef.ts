/**
 * resolveOrgRef — convert an entity-reference string to a definite
 * organization ID. See `memoryRef.ts` for the convention.
 *
 * Organizations are URN-primary in practice; ID-acceptance exists
 * for uniformity with the convention.
 */

import type { PrismaClient } from '../../generated/prisma/index.js';
import { isId } from './shape.js';
import { parseUrnInput } from '../urn.js';
import { OrganizationNotFoundError } from './errors.js';

export async function resolveOrgRef(
  db: Pick<PrismaClient, 'organization'>,
  urn: string,
): Promise<{ id: string }> {
  const normalized = parseUrnInput(urn).value;
  const where = isId(normalized) ? { id: normalized } : { urn: normalized };
  const org = await db.organization.findUnique({
    where,
    select: { id: true, deletedAt: true },
  });
  if (!org || org.deletedAt) {
    throw new OrganizationNotFoundError(urn);
  }
  return { id: org.id };
}
