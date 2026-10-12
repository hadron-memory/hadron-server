/** #1807: standing user read grants for a live Agent system memory.
 * Reuse the licensed App fold; subscriptions and public flags grant nothing.
 * The manager arm preserves the existing Agent ownership gate.
 */
import type { PrismaClient } from '../../generated/prisma/index.js';
import { READ, type GrantWithCaps } from '@hadron-memory/access-control';
import { resolveUserApps } from '../../auth/user-app-resolution.js';
import { getAppMemoryAccess } from '../../mcp/access-control.js';
import { getManagedSystemMemoryIds } from './managedSystemMemory.js';
import { LIVE_ORG_MEMBERSHIP } from './liveOrgMembership.js';

export async function systemMemoryReadGrants(
  db: PrismaClient,
  principal: { userId?: string | null; roles?: readonly string[]; impersonation?: { orgId: string } | null },
  memoryId: string,
): Promise<GrantWithCaps[]> {
  if (!principal.userId) return [];
  const memory = await db.memory.findFirst({
    where: { id: memoryId, class: 'system', deletedAt: null },
    select: { organizationId: true, ownerUserId: true },
  });
  if (!memory) return [];
  const agent = await db.agent.findFirst({
    where: { systemMemoryId: memoryId, deletedAt: null },
    select: { organizationId: true, ownerUserId: true },
  });
  // Invalid historical pointer ownership is not an admission path.
  if (!agent || agent.organizationId !== memory.organizationId || agent.ownerUserId !== memory.ownerUserId) return [];
  if (principal.impersonation && agent.organizationId !== principal.impersonation.orgId) return [];
  const grants: GrantWithCaps[] = [];
  const managed = (await getManagedSystemMemoryIds(db, principal.userId, memoryId, principal.impersonation?.orgId)).includes(memoryId);
  if (agent.ownerUserId !== null) {
    if (managed && !principal.impersonation) {
      grants.push({ source: 'MEMORY_PRINCIPAL', role: 'owner', via: null, caps: READ });
    }
    return grants;
  }
  if (!agent.organizationId) return [];
  const org = await db.organization.findFirst({ where: { id: agent.organizationId, deletedAt: null }, select: { urn: true } });
  if (!org) return [];
  if (!principal.impersonation && (principal.roles?.includes('ADMIN') || principal.roles?.includes('OWNER'))) {
    grants.push({ source: 'PLATFORM_ROLE', role: principal.roles.includes('OWNER') ? 'OWNER' : 'ADMIN', via: null, caps: READ });
  }
  if (managed) {
    // Attribution only: authority was decided by the shared manager helper.
    const member = await db.orgMember.findFirst({
      where: { organizationId: agent.organizationId, userId: principal.userId, ...LIVE_ORG_MEMBERSHIP },
      select: { role: true },
    });
    if (member) grants.push({ source: 'ORG_ROLE', role: member.role, via: org.urn, caps: READ });
  }
  if (principal.impersonation) return grants;
  for (const app of await resolveUserApps(principal.userId, db)) {
    // This is the same licensed, lifecycle-checked fold used by the read gates.
    if (!(await getAppMemoryAccess(db, app.id, { callerUserId: principal.userId, includeTeamSpace: false })).has(memoryId)) continue;
    const [row, member] = await Promise.all([
      db.app.findUnique({ where: { id: app.id }, select: { urn: true } }),
      db.appMember.findUnique({ where: { appId_userId: { appId: app.id, userId: principal.userId } }, select: { role: true } }),
    ]);
    grants.push({ source: 'APP_MEMBER', role: member?.role ?? 'member', via: row?.urn ?? app.id, caps: READ });
  }
  return grants;
}
