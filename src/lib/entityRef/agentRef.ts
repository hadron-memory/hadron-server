/**
 * resolveAgentRef — convert an entity-reference string to a
 * definite agent ID. See `memoryRef.ts` for the convention.
 *
 * Agents are URN-primary in practice today; ID-acceptance exists
 * for uniformity with the convention.
 */

import type { PrismaClient } from '../../generated/prisma/index.js';
import { isUrn } from './shape.js';
import { parseUrnInput } from '../urn.js';
import { AgentNotFoundError } from './errors.js';

export async function resolveAgentRef(
  db: Pick<PrismaClient, 'agent'>,
  urn: string,
): Promise<{ id: string }> {
  const normalized = parseUrnInput(urn).value;
  const where = isUrn(normalized) ? { urn: normalized } : { id: normalized };
  const agent = await db.agent.findUnique({
    where,
    select: { id: true, deletedAt: true },
  });
  if (!agent || agent.deletedAt) {
    throw new AgentNotFoundError(urn);
  }
  return { id: agent.id };
}
