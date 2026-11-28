/**
 * Who manages a memory a grant names (hrn:node:hadronmemory.com:specs:cor:acl:140:02): the signer of a `memory.read` grant's
 * named-memory form, and of every `memory.write` grant, must manage EVERY memory the grant names (Holger, 2026-11-27: "Owner of
 * each named memory"; earlier, "Only the memory's manager").
 *
 * An Agent's system memory is managed by whoever manages that Agent (cor:dmo:050:13); every other memory by the memory gate's own
 * ADMIN rule (`requireMemoryManageAccess`), which for a personal or private memory is its owner alone. Moved here from the
 * per-automation read grant's resolver (#2883), which #5404 retired; the rule is unchanged.
 */
import { GraphQLError } from 'graphql';
import type { Prisma } from '../../generated/prisma/index.js';
import { managesAgent } from '../auth/appManagement.js';
import { requireMemoryManageAccess, type Context } from '../../api/graphql/schema/resolvers.helpers.js';

/** What {@link managesGrantMemory} reads of the memory. */
export const MANAGED_MEMORY_SELECT = {
  id: true, class: true, userId: true, organizationId: true, ownerUserId: true, userMemoryOfAgentId: true, createdBy: true,
} as const;

export type ManagedMemory = Prisma.MemoryGetPayload<{ select: typeof MANAGED_MEMORY_SELECT }>;

/** True when the caller manages `memory`. A refusal of the shared gate is false; any other error propagates. */
export async function managesGrantMemory(
  ctx: Context,
  memory: ManagedMemory,
  prefetchedAgents?: readonly { organizationId: string | null; ownerUserId: string | null }[],
): Promise<boolean> {
  if (memory.class === 'system') {
    const agents = prefetchedAgents ?? await ctx.db.agent.findMany({
      where: { systemMemoryId: memory.id, deletedAt: null, organizationId: memory.organizationId, ownerUserId: memory.ownerUserId },
      select: { organizationId: true, ownerUserId: true },
    });
    for (const agent of agents) if (await managesAgent(ctx, agent)) return true;
    return false;
  }
  try { await requireMemoryManageAccess(ctx, memory); return true; } catch (e) {
    if (e instanceof GraphQLError && e.extensions.code === 'FORBIDDEN') return false;
    throw e;
  }
}
