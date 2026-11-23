import type { PrismaClient } from '../../generated/prisma/index.js';
import type { AuthContext } from '../../middleware/auth.js';
import { canReadMemory } from '../../mcp/access-control.js';

/**
 * #2040, #4689 (ruling A, Holger 2026-11-23; hrn:node:hadronmemory.com:specs:cor:agt:010:01): may a run principal follow
 * a URN include into this memory? Same organization as the run, not deleted, not encrypted, and readable by the
 * principal. The ONE rule: adoption records a partial present only when it holds, and an executed run splices a foreign
 * include only when it holds (`runIncludeFollower` in src/lib/includes/resolveNodeContent.ts), so what runs is what was
 * adopted. Anything else is absent, the same as a missing target.
 */
export async function partialMemoryFollowable(
  db: PrismaClient, principal: AuthContext, organizationId: string | null | undefined,
  mem: { id: string; organizationId: string | null; isEncrypted: boolean; deletedAt: Date | null } | null,
): Promise<boolean> {
  return !!mem && !!organizationId && !mem.deletedAt && !mem.isEncrypted && mem.organizationId === organizationId
    && await canReadMemory(db, principal, mem.id);
}
