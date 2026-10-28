/** Standing Agent-manager read reach (Holger #8995, #1808).
 * This is the manager arm only; installed/licensed App reach stays in the
 * existing App fold. Candidate Agent pointers and memory tenants must match.
 */
import type { Prisma, PrismaClient } from '../../generated/prisma/index.js';
import { lockAuthorityAnchors } from './authorityAnchors.js';
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
 *  - a platform ADMIN/OWNER, for every Agent, on exactly that row (a live Agent's `systemMemoryId`, tenant matched),
 *    decided on the actor's live roles, not only the request's.
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
  // The request's roles are a claim from authentication; the platform arm is decided on the actor's LIVE roles too
  // (Gene on #2233), so a demotion or deletion committed since then is honoured. Inside a write transaction that holds
  // the actor's user anchor (lockInstallAuthorityFirst), this read is ordered after any such revoker.
  const actor = await db.user.findUnique({ where: { id: principal.userId }, select: { roles: true, deletedAt: true } });
  if (!actor || actor.deletedAt || !(actor.roles.includes('ADMIN') || actor.roles.includes('OWNER'))) return false;
  const [memory, agent] = await Promise.all([
    db.memory.findFirst({ where: { id: memoryId, class: 'system', deletedAt: null }, select: { organizationId: true, ownerUserId: true } }),
    db.agent.findFirst({ where: { systemMemoryId: memoryId, deletedAt: null }, select: { organizationId: true, ownerUserId: true } }),
  ]);
  return memory !== null && agent !== null &&
    agent.organizationId === memory.organizationId && agent.ownerUserId === memory.ownerUserId;
}

/**
 * #2206 (Gene's BLIND P2 on #2233; Xan's parity ruling): the authority a write to an Agent's own system memory depends
 * on, taken FIRST in the writer's transaction (before any memory, node or loc lock), the way an install memory's is:
 * the anchors its revokers hold exclusively (the Agent, its tenant, the actor, whose platform roles `updateUserRoles`
 * changes under the actor's user anchor), then the rows they change, FOR SHARE. Every transport's deciding recheck
 * inside that transaction (GraphQL's `assertMemoryWriteStateStable`, MCP's `assertLockedMemoryWriteAccess`, both
 * through {@link canManageAgentSystemMemory}, which reads live roles and memberships) is therefore ordered after any
 * demotion, deletion or Agent transfer that committed first. A no-op (false) for any other memory, including a system
 * row no live Agent points at, which nobody manages.
 */
export async function lockAgentDefinitionAuthority(
  tx: Prisma.TransactionClient,
  actorUserId: string | null,
  memoryIds: string | readonly string[],
): Promise<boolean> {
  const ids = [...new Set(typeof memoryIds === 'string' ? [memoryIds] : memoryIds)];
  const agents = await tx.agent.findMany({
    where: { systemMemoryId: { in: ids }, deletedAt: null },
    select: { id: true, organizationId: true, ownerUserId: true },
    orderBy: { id: 'asc' },
  });
  if (agents.length === 0) return false;
  // One acquisition for every end, so a move between two definitions takes its anchors in the one global order.
  await lockAuthorityAnchors(tx, [
    ...agents.flatMap((agent) => [
      { kind: 'agent' as const, id: agent.id },
      ...(agent.organizationId ? [{ kind: 'org' as const, id: agent.organizationId }] : []),
      ...(agent.ownerUserId ? [{ kind: 'user' as const, id: agent.ownerUserId }] : []),
    ]),
    ...(actorUserId ? [{ kind: 'user' as const, id: actorUserId }] : []),
  ], 'shared');
  for (const agent of agents) await tx.$queryRaw`SELECT id FROM agents WHERE id = ${agent.id} FOR SHARE`;
  if (actorUserId) {
    await tx.$queryRaw`SELECT id FROM users WHERE id = ${actorUserId} FOR SHARE`;
    for (const orgId of [...new Set(agents.map((a) => a.organizationId).filter((o): o is string => o !== null))].sort()) {
      await tx.$queryRaw`SELECT 1 FROM org_members WHERE organization_id = ${orgId} AND user_id = ${actorUserId} FOR SHARE`;
    }
  }
  return true;
}
