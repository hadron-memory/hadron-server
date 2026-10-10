/** Identity needed at a strict-owner boundary; administrative roles are irrelevant. */
export interface StrictOwnerPrincipal {
  userId?: string | null;
  impersonation?: unknown;
}

/**
 * Owner-only authority, without an admin or impersonation override
 * (cor:acl:010:02; DT, team chat #6804). For personal/private memories pass
 * Memory.userId, not the independent tenant ownerUserId. Explicit personal
 * shares are a separate grant and are not decided by this predicate.
 */
export function isStrictOwner(
  principal: StrictOwnerPrincipal,
  ownerUserId: string | null | undefined,
): boolean {
  return !principal.impersonation && typeof principal.userId === 'string' &&
    principal.userId.length > 0 && principal.userId === ownerUserId;
}
