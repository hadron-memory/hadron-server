/**
 * resolveMemoryRef — convert an inbound entity-reference string
 * (ID, bare URN, or prefixed URN) to a definite memory ID.
 *
 * Spec: 007-entity-id-or-urn / contracts/resolution-helpers.md.
 *
 * Six input forms all resolve to the same row:
 *   - "abc123…"                             (raw 32-hex-char ID)
 *   - "org-foo:family-recipes"              (bare URN, DB form)
 *   - "hrn:memory:org-foo::family-recipes"  (canonical fully qualified URN)
 *   - "urn:memory:org-foo::family-recipes"  (legacy fully qualified URN)
 *   - "hrn:memory:org-foo:family-recipes"   (like canonical fully qualified URN, but missing the double colon)
 *   - "urn:memory:org-foo:family-recipes"   (legacy fully qualified URN)
 *
 * Soft-deleted memories return MemoryNotFoundError by default, matching
 * the existing convention. Pass `{ includeDeleted: true }` when the
 * caller needs to operate on a row regardless of `deletedAt` (e.g.,
 * `deleteMemory` re-deletes for FR-014 idempotency).
 */

import type { PrismaClient } from '../../generated/prisma/index.js';
import { isId as isIdFunc } from './shape.js';
import { parseUrnInput, assertFullyQualifiedUrn, normalizeUrnForLookup } from '../urn.js';
import { MemoryNotFoundError } from '../asset/gate.js';

export async function resolveMemoryRef(
  db: Pick<PrismaClient, 'memory'>,
  ref: string,
  options?: { includeDeleted?: boolean },
): Promise<{ id: string }> {
  const isId = isIdFunc(ref);
  if (!isId) {
    // Non-ID inputs MUST be fully-qualified URNs (spec 022).
    assertFullyQualifiedUrn(ref, 'memory');
  }
  const where = isId
    ? { id: ref }
      // ID inputs look up by PK directly. For a URN, strip any `hrn/urn:<type>:`
      // prefix (parseUrnInput) and collapse canonical `::` hierarchy separators to
      // legacy `:` (normalizeUrnForLookup) so the DB lookup matches
      // pre-spec-021-migrated rows. Normalization is a no-op on an ID (no colons to
      // collapse), so the ID path skips it entirely.
    : { urn: normalizeUrnForLookup(parseUrnInput(ref).value) };
  // findFirst (not findUnique) so the soft-delete exclusion can live in the
  // query: the `{ id }` / `{ urn }` selector is still unique-backed, and
  // `deletedAt: null` filters out soft-deleted rows unless the caller opts in.
  const memory = await db.memory.findFirst({
    where: {
      ...where,
      ...(options?.includeDeleted ? {} : { deletedAt: null }),
    },
    select: { id: true },
  });
  if (!memory) {
    throw new MemoryNotFoundError(ref);
  }
  return { id: memory.id };
}
