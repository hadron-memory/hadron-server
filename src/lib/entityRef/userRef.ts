/**
 * resolveUserRef — convert an entity-reference string to a definite user ID.
 * See `orgRef.ts` for the convention.
 *
 * A user is addressed as `hrn:user:<handle>` (spec cor:urn:010:01): a single
 * hierarchy segment, the user's unique `handle`. A bare ID is also accepted for
 * uniformity with the other entity-ref resolvers.
 *
 * Accepted shapes: a bare ID, the `hrn:user:<handle>` (or legacy `urn:user:`)
 * URN, and — because a user URN is a single segment, like an org — a **bare
 * handle** with no scheme prefix (`assertFullyQualifiedUrn(ref, 'user')` is
 * satisfied by one segment, so the spec-022 qualification gate accepts it).
 * Non-ID, multi-segment, or `loc:`-prefixed inputs are rejected with
 * `UrnNotQualifiedError` before the DB lookup.
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
  const idInput = isId(ref);
  if (!idInput) {
    // Non-ID inputs MUST be fully-qualified URNs (spec 022).
    assertFullyQualifiedUrn(ref, 'user');
  }
  // Users have no `urn` column — the non-ID lookup key is the unique handle.
  // Handles are lowercase-canonical (#325), so lowercase the input for
  // case-insensitive resolution (hrn:user:Holger → the `holger` row).
  // Normalization is a no-op on an ID, so it runs only on the handle path.
  const where = idInput
    ? { id: ref }
    : { handle: normalizeUrnForLookup(parseUrnInput(ref).value).toLowerCase() };
  const user = await db.user.findUnique({
    where,
    select: { id: true, deletedAt: true },
  });
  if (!user || user.deletedAt) {
    throw new UserNotFoundError(ref);
  }
  return { id: user.id };
}
