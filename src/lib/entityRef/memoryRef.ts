/**
 * resolveMemoryRef — convert an inbound entity-reference string
 * (ID, bare URN, or prefixed URN) to a definite memory ID.
 *
 * Spec: 007-entity-id-or-urn / contracts/resolution-helpers.md.
 *
 * Three input forms all resolve to the same row:
 *   - "abc123…"                            (raw 32-hex-char ID)
 *   - "org-foo:family-recipes"             (bare URN, DB form)
 *   - "urn:memory:org-foo:family-recipes"  (prefixed URN, external form)
 *
 * Soft-deleted memories return MemoryNotFoundError by default, matching
 * the existing convention. Pass `{ includeDeleted: true }` when the
 * caller needs to operate on a row regardless of `deletedAt` (e.g.,
 * `deleteMemory` re-deletes for FR-014 idempotency).
 */

import type { PrismaClient } from '../../generated/prisma/index.js';
import { isId } from './shape.js';
import { parseUrnInput, assertFullyQualifiedUrn } from '../urn.js';
import { MemoryNotFoundError } from '../asset/gate.js';

export async function resolveMemoryRef(
  db: Pick<PrismaClient, 'memory'>,
  urn: string,
  options?: { includeDeleted?: boolean },
): Promise<{ id: string }> {
  if (!isId(urn)) {
    // Non-ID inputs MUST be fully-qualified URNs (spec 022).
    assertFullyQualifiedUrn(urn, 'memory');
  }
  // Strip a `urn:<type>:` prefix if present. parseUrnInput returns
  // the bare value; for already-bare input it returns the input
  // unchanged.
  const normalized = parseUrnInput(urn).value;
  const where = isId(normalized) ? { id: normalized } : { urn: normalized };
  const memory = await db.memory.findUnique({
    where,
    select: { id: true, deletedAt: true },
  });
  if (!memory || (!options?.includeDeleted && memory.deletedAt)) {
    throw new MemoryNotFoundError(urn);
  }
  return { id: memory.id };
}
