/**
 * Org-membership WRITE arm for free-standing org memories (#1640, ruling
 * DR = A: an App narrows scope and unlocks access, it never takes away a grant
 * the caller already holds).
 *
 * GraphQL (`requireMemoryWriteAccess`, JWT path) lets a live org CONTRIBUTOR+
 * write an org-owned `knowledge` memory, and a MemoryMember writer/owner write
 * a `group` one (cor:acl:010:01). The MCP gate folded org-readable rows to
 * READ_ONLY, so the same caller, token and memory were refused over MCP and
 * labelled `(read-only)`. The MCP access map now promotes exactly this set, so
 * `canWriteToMemory` and `hadron_list_memories` follow from one answer.
 *
 * Same shape as the GraphQL arm, no wider: free-standing only (`appId` null —
 * an app-scoped row is App-internal, #653), org-owned, not user-owned, not a
 * per-user holding, and membership must be live (a revoked one grants nothing).
 */

import type { PrismaClient } from '../../generated/prisma/index.js';
import { LIVE_ORG_MEMBERSHIP } from './liveOrgMembership.js';

export async function getOrgWritableMemoryIds(
  db: PrismaClient,
  userId: string,
  onlyMemoryId?: string,
): Promise<string[]> {
  // Prisma drops an `undefined` filter, which would read as "every membership".
  if (!userId) return [];

  const free = {
    ...(onlyMemoryId ? { id: onlyMemoryId } : {}),
    deletedAt: null, appId: null, ownerUserId: null, userMemoryOfAgentId: null,
  };

  const contributorOrgs = await db.orgMember.findMany({
    where: { userId, ...LIVE_ORG_MEMBERSHIP, role: { in: ['CONTRIBUTOR', 'ADMIN', 'OWNER'] as never } },
    select: { organizationId: true },
  });
  const orgIds = contributorOrgs.map((m: { organizationId: string }) => m.organizationId);

  const [knowledge, groups] = await Promise.all([
    orgIds.length === 0 ? [] : db.memory.findMany({
      where: { ...free, class: 'knowledge' as never, organizationId: { in: orgIds } },
      select: { id: true },
    }),
    // Group write is MemoryMember writer/owner only; an org role adds nothing.
    db.memory.findMany({
      where: {
        ...free, class: 'group' as never, organizationId: { not: null },
        memberships: { some: { userId, role: { in: ['writer', 'owner'] } } },
      },
      select: { id: true },
    }),
  ]);
  return [...knowledge, ...groups].map((m: { id: string }) => m.id);
}
