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
import { resolveLegacyAlias } from './legacyAlias.js';
import { findLiveUrnAliasTargets, dedupeById } from '../urnAlias.js';

type WhereClause = {
  id: string;
  urn?: undefined;
  deletedAt?: null;
} | {
  urn: string;
  id?: undefined;
  deletedAt?: null;
}

export async function resolveMemoryRef(
  db: Pick<PrismaClient, 'memory' | 'urnAlias'>,
  ref: string,
  options?: { includeDeleted?: boolean },
): Promise<{ id: string }> {
  const isId = isIdFunc(ref);
  if (!isId) {
    // Non-ID inputs MUST be fully-qualified URNs (spec 022).
    assertFullyQualifiedUrn(ref, 'memory');
  }
  // ID inputs look up by PK directly. For a URN, strip any `hrn/urn:<type>:`
  // prefix (parseUrnInput) and collapse canonical `::` hierarchy separators to
  // legacy `:` (normalizeUrnForLookup) so the DB lookup matches
  // pre-spec-021-migrated rows. Normalization is a no-op on an ID (no colons to
  // collapse), so the ID path skips it entirely.
  const lookupUrn = isId ? null : normalizeUrnForLookup(parseUrnInput(ref).value);
  const where: WhereClause = lookupUrn === null ? { id: ref } : { urn: lookupUrn };
  // findFirst (not findUnique) so the soft-delete exclusion can live in the
  // query: the `{ id }` / `{ urn }` selector is still unique-backed, and
  // `deletedAt: null` filters out soft-deleted rows UNLESS the caller opts in.
  const deletedFilter = options?.includeDeleted ? {} : { deletedAt: null as null };
  if (!options?.includeDeleted) {
    where.deletedAt = null;
  }
  let memory = await db.memory.findFirst({
    where,
    select: { id: true },
  });
  // A few stored rows still carry the canonical `org::memory` spelling.
  // The flat lookup remains first for existing v2 rows; if it misses, try
  // the canonical storage spelling before consulting historical aliases.
  if (!memory && lookupUrn !== null) {
    memory = await db.memory.findFirst({
      where: { urn: lookupUrn.replace(/:/g, '::'), ...deletedFilter },
      select: { id: true },
    });
  }
  if (memory) {
    return { id: memory.id };
  }
  // #697 stored-alias-map fallback: a URN that missed the primary `urn` lookup
  // may be a LEGACY reference to a row since migrated to v2 — redirect via
  // `legacyUrn`. Inert until the migration populates it (ID inputs skip this).
  if (lookupUrn !== null) {
    // #1079 rename map read ALONGSIDE the #697 column, deduplicated by id:
    // the migration backfilled one from the other, so a bare concat would hand
    // the same row to the ambiguity check twice and refuse a URN that resolves
    // to exactly one memory.
    // This is the arm that keeps published NODE urns alive across a memory
    // rename: a node URN carries its memory's slug and resolves through here.
    const live = (ids: string[]) =>
      db.memory.findMany({
        where: { id: { in: ids }, ...deletedFilter },
        select: { id: true },
      });
    const [legacyRows, aliasRows] = await Promise.all([
      db.memory.findMany({
        where: { legacyUrn: lookupUrn, ...deletedFilter },
        select: { id: true },
        take: 2,
      }),
      findLiveUrnAliasTargets(db, 'MEMORY', lookupUrn, live),
    ]);
    const aliased = resolveLegacyAlias(ref, dedupeById(legacyRows, aliasRows));
    if (aliased) return aliased;
  }
  throw new MemoryNotFoundError(ref);
}
