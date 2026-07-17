/**
 * resolveAgentRef — convert an entity-reference string to a
 * definite agent ID. See `memoryRef.ts` for the convention.
 *
 * Agents are URN-primary in practice today; ID-acceptance exists
 * for uniformity with the convention.
 */

import type { PrismaClient } from '../../generated/prisma/index.js';
import { isId as isIdFunc } from './shape.js';
import { parseUrnInput, assertFullyQualifiedUrn, normalizeUrnForLookup } from '../urn.js';
import { AgentNotFoundError } from './errors.js';
import { resolveLegacyAlias } from './legacyAlias.js';

export async function resolveAgentRef(
  db: Pick<PrismaClient, 'agent'>,
  ref: string,
  options?: { includeDeleted?: boolean },
): Promise<{ id: string }> {
  const isId = isIdFunc(ref);
  if (!isId) {
    // Non-ID inputs MUST be fully-qualified URNs (spec 022).
    assertFullyQualifiedUrn(ref, 'agent');
  }
  // ID → PK lookup; URN → normalized (prefix stripped, `::` collapsed to `:`).
  // Normalization is a no-op on an ID, so the ID path skips it.
  const lookupUrn = isId ? null : normalizeUrnForLookup(parseUrnInput(ref).value);
  const where = lookupUrn === null ? { id: ref } : { urn: lookupUrn };
  // findFirst + `deletedAt: null` so the soft-delete exclusion lives in the
  // query (the `{ id }` / `{ urn }` selector is still unique-backed). Excluded
  // by default; `{ includeDeleted: true }` opts in (matches memoryRef).
  const deletedFilter = options?.includeDeleted ? {} : { deletedAt: null as null };
  const agent = await db.agent.findFirst({
    where: { ...where, ...deletedFilter },
    select: { id: true },
  });
  if (agent) {
    return { id: agent.id };
  }
  // #697 stored-alias-map fallback — see memoryRef. Inert until migration.
  if (lookupUrn !== null) {
    const aliased = resolveLegacyAlias(
      ref,
      await db.agent.findMany({
        where: { legacyUrn: lookupUrn, ...deletedFilter },
        select: { id: true },
        take: 2,
      }),
    );
    if (aliased) return aliased;
  }
  throw new AgentNotFoundError(ref);
}
