/** Standing Agent-manager read reach (Holger #8995, #1808).
 * This is the manager arm only; installed/licensed App reach stays in the
 * existing App fold. Candidate Agent pointers and memory tenants must match.
 */
import type { PrismaClient } from '../../generated/prisma/index.js';
import { LIVE_ORG_MEMBERSHIP } from './liveOrgMembership.js';

export async function getManagedSystemMemoryIds(
  db: PrismaClient,
  userId: string,
  onlyMemoryId?: string,
  restrictToOrgId?: string,
): Promise<string[]> {
  if (!userId) return [];
  const memberships = await db.orgMember.findMany({
    where: { userId, ...LIVE_ORG_MEMBERSHIP, role: { in: ['ADMIN', 'OWNER'] }, ...(restrictToOrgId ? { organizationId: restrictToOrgId } : {}) },
    select: { organizationId: true },
  });
  const orgIds = memberships.map(member => member.organizationId);
  const agents = await db.agent.findMany({
    where: {
      deletedAt: null,
      systemMemoryId: onlyMemoryId ?? { not: null },
      OR: [
        ...(orgIds.length ? [{ organizationId: { in: orgIds }, ownerUserId: null }] : []),
        // Support impersonation is one-org only, never a user's ownership.
        ...(!restrictToOrgId ? [{ ownerUserId: userId, organizationId: null }] : []),
      ],
    },
    select: { systemMemoryId: true, organizationId: true, ownerUserId: true },
  });
  if (!agents.length) return [];
  const memories = await db.memory.findMany({
    where: {
      class: 'system', deletedAt: null,
      OR: agents.map(agent => ({ id: agent.systemMemoryId!, organizationId: agent.organizationId, ownerUserId: agent.ownerUserId })),
    },
    select: { id: true },
  });
  return memories.map(memory => memory.id);
}
