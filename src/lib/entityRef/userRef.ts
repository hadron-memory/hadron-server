/**
 * resolveUserRef — convert an entity-reference string to a definite user ID.
 * See `orgRef.ts` for the convention.
 *
 * A user is addressed as `hrn:user:<handle>` (spec cor:urn:010:01): a single
 * hierarchy segment, the user's unique `handle`. A bare ID is also accepted for
 * uniformity with the other entity-ref resolvers. Per spec 022, a non-ID input
 * MUST be a fully-qualified URN (`UrnNotQualifiedError` before the DB lookup).
 *
 * A user with no `handle` has no `hrn:user:` address, so the only way to reach
 * such a row here is by bare ID.
 */

import type { PrismaClient } from '../../generated/prisma/index.js';
import { isId } from './shape.js';
import { parseUrnInput, assertFullyQualifiedUrn, normalizeUrnForLookup } from '../urn.js';
import { UserNotFoundError } from './errors.js';

export async function resolveUserRef(
  db: Pick<PrismaClient, 'user'>,
  ref: string,
): Promise<{ id: string }> {
  if (!isId(ref)) {
    // Non-ID inputs MUST be fully-qualified URNs (spec 022).
    assertFullyQualifiedUrn(ref, 'user');
  }
  const value = normalizeUrnForLookup(parseUrnInput(ref).value);
  // Users have no `urn` column — the non-ID lookup key is the unique handle.
  const where = isId(value) ? { id: value } : { handle: value };
  const user = await db.user.findUnique({
    where,
    select: { id: true, deletedAt: true },
  });
  if (!user || user.deletedAt) {
    throw new UserNotFoundError(ref);
  }
  return { id: user.id };
}
