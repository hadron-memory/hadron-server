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
import { isId as isIdFunc } from './shape.js';
import { parseUrnInput, assertFullyQualifiedUrn, normalizeUrnForLookup } from '../urn.js';
import { UserNotFoundError, AmbiguousUserRefError } from './errors.js';

export async function resolveUserRef(
  db: Pick<PrismaClient, 'user'>,
  ref: string,
  options?: { includeDeleted?: boolean },
): Promise<{ id: string }> {
  const isId = isIdFunc(ref);
  if (!isId) {
    // Non-ID inputs MUST be fully-qualified URNs (spec 022).
    assertFullyQualifiedUrn(ref, 'user');
  }
  // Users have no `urn` column — the non-ID lookup key is the unique handle.
  // Handles are lowercase-canonical (#325), so lowercase the input for
  // case-insensitive resolution (hrn:user:Holger → the `holger` row).
  // Normalization is a no-op on an ID, so it runs only on the handle path.
  const where = isId
    ? { id: ref }
    : { handle: normalizeUrnForLookup(parseUrnInput(ref).value).toLowerCase() };
  // findFirst + `deletedAt: null` so the soft-delete exclusion lives in the
  // query (the `{ id }` / `{ handle }` selector is still unique-backed). Excluded
  // by default; `{ includeDeleted: true }` opts in (matches memoryRef).
  const user = await db.user.findFirst({
    where: { ...where, ...(options?.includeDeleted ? {} : { deletedAt: null }) },
    select: { id: true },
  });
  if (!user) {
    throw new UserNotFoundError(ref);
  }
  return { id: user.id };
}

/**
 * Superset of {@link resolveUserRef} that ALSO accepts an **email address**
 * (#769). Email is the natural way to name a grantee who is outside your org —
 * you know their address, not their handle — and it is not a legal URN atom /
 * handle (contains `@`), so it never collides with the handle path. Resolution
 * runs server-side against the full user table, so the memory-share mutations
 * can grant to a user the caller can't otherwise see (cross-org personal share).
 *
 * Precedence: an email-shaped, non-scheme-prefixed ref matches the `email`
 * column case-insensitively; everything else (bare ID, handle, `hrn:user:<handle>`
 * URN) falls through to `resolveUserRef`. Throws `UserNotFoundError` on a genuine
 * miss.
 *
 * Email ambiguity (#774 review): `User.email` is only case-sensitively unique and
 * `createAppUser` stores it verbatim, so `Alice@x.com` and `alice@x.com` can both
 * exist. An EXACT (case-sensitive) match always wins; a single case-insensitive
 * match is used; but two accounts differing only by case throw
 * `AmbiguousUserRefError` rather than resolving to an arbitrary one (wrong-grantee
 * hazard on a share).
 */
/**
 * Whether `resolveUserRefOrEmail` would read `ref` as an EMAIL — the one
 * precedence rule, exported so a caller that must treat an email lookup
 * differently (an email is a personal field) cannot restate it and drift.
 */
export function isEmailUserRef(ref: string): boolean {
  const trimmed = ref.trim();
  return trimmed.includes('@') && !/^(hrn|urn):/i.test(trimmed);
}

export async function resolveUserRefOrEmail(
  db: Pick<PrismaClient, 'user'>,
  ref: string,
  options?: { includeDeleted?: boolean },
): Promise<{ id: string }> {
  const trimmed = ref.trim();
  if (isEmailUserRef(trimmed)) {
    const liveOnly = options?.includeDeleted ? {} : { deletedAt: null };
    // Exact (case-sensitive) first — `email` is case-sensitively unique, so this
    // is unambiguous when it hits.
    const exact = await db.user.findFirst({
      where: { email: trimmed, ...liveOnly },
      select: { id: true },
    });
    if (exact) return { id: exact.id };
    // No exact match — fall back to case-insensitive, but reject (never pick
    // arbitrarily) if two accounts differ only by case.
    const matches = await db.user.findMany({
      where: { email: { equals: trimmed, mode: 'insensitive' }, ...liveOnly },
      select: { id: true },
      take: 2,
    });
    if (matches.length === 0) throw new UserNotFoundError(ref);
    if (matches.length > 1) throw new AmbiguousUserRefError(ref);
    return { id: matches[0].id };
  }
  return resolveUserRef(db, trimmed, options);
}
