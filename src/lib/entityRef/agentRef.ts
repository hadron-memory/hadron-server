/**
 * resolveAgentRef — convert an entity-reference string to a
 * definite agent ID. See `memoryRef.ts` for the convention.
 *
 * Agents are URN-primary in practice today; ID-acceptance exists
 * for uniformity with the convention.
 */

import type { PrismaClient } from '../../generated/prisma/index.js';
import { isId } from './shape.js';
import { parseUrnInput, assertFullyQualifiedUrn, normalizeUrnForLookup } from '../urn.js';
import { AgentNotFoundError } from './errors.js';

export async function resolveAgentRef(
  db: Pick<PrismaClient, 'agent'>,
  ref: string,
): Promise<{ id: string }> {
  const idInput = isId(ref);
  if (!idInput) {
    // Non-ID inputs MUST be fully-qualified URNs (spec 022).
    assertFullyQualifiedUrn(ref, 'agent');
  }
  // ID → PK lookup; URN → normalized (prefix stripped, `::` collapsed to `:`).
  // Normalization is a no-op on an ID, so the ID path skips it.
  const where = idInput
    ? { id: ref }
    : { urn: normalizeUrnForLookup(parseUrnInput(ref).value) };
  const agent = await db.agent.findUnique({
    where,
    select: { id: true, deletedAt: true },
  });
  if (!agent || agent.deletedAt) {
    throw new AgentNotFoundError(ref);
  }
  return { id: agent.id };
}
