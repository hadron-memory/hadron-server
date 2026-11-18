import type { PrismaClient } from '../../generated/prisma/index.js';
import { resolveNodeRef } from '../entityRef/nodeRef.js';
import { AmbiguousLegacyUrnError, NodeNotFoundError } from '../entityRef/errors.js';

export type IncludeUrnDb = Pick<PrismaClient, 'node' | 'memory' | 'urnAlias'>;

/**
 * Resolve only identity, using the shared live-address-first, historical memory
 * and moved-node alias rules (cor:urn:030). No authority travels with an alias:
 * each consumer must re-query the returned id with its own access predicate.
 * Missing and ambiguous addresses are the same unavailable include. Database
 * errors propagate; an outage is not a missing target.
 */
export async function includeUrnTarget(db: IncludeUrnDb, urn: string) {
  let id: string;
  try { ({ id } = await resolveNodeRef(db, urn)); }
  catch (error) {
    if (error instanceof NodeNotFoundError || error instanceof AmbiguousLegacyUrnError) return null;
    throw error;
  }
  return db.node.findFirst({
    where: { id, deletedAt: null, memory: { deletedAt: null } },
    select: { id: true, memoryId: true, loc: true },
  });
}
