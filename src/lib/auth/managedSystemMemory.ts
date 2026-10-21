/** Standing Agent-manager read reach (Holger #8995, #1808).
 * This is the manager arm only; installed/licensed App reach stays in the
 * existing App fold. Candidate Agent pointers and memory tenants must match.
 */
import type { PrismaClient } from '../../generated/prisma/index.js';
import { LIVE_ORG_MEMBERSHIP } from './liveOrgMembership.js';
import { isRunPrincipal } from './runPrincipal.js';

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

/**
 * #2206 (cor:dmo:050:13): may this principal WRITE `memoryId` as whoever manages the Agent it is the system memory of?
 * The one write predicate GraphQL and MCP share for an Agent's own system memory:
 *  - the managers {@link getManagedSystemMemoryIds} already decides (a live org ADMIN/OWNER of an org-owned Agent, the
 *    owner of a user-owned one), with the same live-Agent, pointer and tenant match;
 *  - a platform ADMIN/OWNER, for every Agent, on exactly that row (a live Agent's `systemMemoryId`, tenant matched).
 * Never through App participation, and never for a principal that is not the user acting as themselves: an
 * impersonation, an AppRun (it carries its on-behalf-of user's id) or a credential with no user is refused before any
 * arm. An App's install memory is never an Agent's `systemMemoryId`, so it is out of reach here by construction.
 */
export async function canManageAgentSystemMemory(
  db: PrismaClient,
  principal: { userId?: string | null; roles?: readonly string[] | null; impersonation?: unknown; clientId?: string | null },
  memoryId: string,
): Promise<boolean> {
  if (!principal.userId || principal.impersonation || isRunPrincipal(principal)) return false;
  if ((await getManagedSystemMemoryIds(db, principal.userId, memoryId)).includes(memoryId)) return true;
  if (!(principal.roles?.includes('ADMIN') || principal.roles?.includes('OWNER'))) return false;
  const [memory, agent] = await Promise.all([
    db.memory.findFirst({ where: { id: memoryId, class: 'system', deletedAt: null }, select: { organizationId: true, ownerUserId: true } }),
    db.agent.findFirst({ where: { systemMemoryId: memoryId, deletedAt: null }, select: { organizationId: true, ownerUserId: true } }),
  ]);
  return memory !== null && agent !== null &&
    agent.organizationId === memory.organizationId && agent.ownerUserId === memory.ownerUserId;
}
