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
import { isId } from './shape.js';
import { parseUrnInput, assertFullyQualifiedUrn, normalizeUrnForLookup } from '../urn.js';
import { MemoryNotFoundError } from '../asset/gate.js';

export async function resolveMemoryRef(
  db: Pick<PrismaClient, 'memory'>,
  ref: string,
  options?: { includeDeleted?: boolean },
): Promise<{ id: string }> {
  const idInput = isId(ref);
  if (!idInput) {
    // Non-ID inputs MUST be fully-qualified URNs (spec 022).
    assertFullyQualifiedUrn(ref, 'memory');
  }
  // ID inputs look up by PK directly. For a URN, strip any `hrn/urn:<type>:`
  // prefix (parseUrnInput) and collapse canonical `::` hierarchy separators to
  // legacy `:` (normalizeUrnForLookup) so the DB lookup matches
  // pre-spec-021-migrated rows. Normalization is a no-op on an ID (no colons to
  // collapse), so the ID path skips it entirely.
  const where = idInput
    ? { id: ref }
    : { urn: normalizeUrnForLookup(parseUrnInput(ref).value) };
  const memory = await db.memory.findUnique({
    where,
    select: { id: true, deletedAt: true },
  });
  if (!memory || (!options?.includeDeleted && memory.deletedAt)) {
    throw new MemoryNotFoundError(ref);
  }
  return { id: memory.id };
}
