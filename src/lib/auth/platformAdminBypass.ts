import { isRunPrincipal } from './runPrincipal.js';
import type { PrismaClient } from '../../generated/prisma/index.js';

/** #1734: platform authority never crosses identity/privacy or impersonation gates. */
export type PlatformCaller = {
  userId?: string;
  roles?: readonly string[] | null;
  impersonation?: unknown;
  clientId?: string | null;
};

export type TenantResourceKind = 'app' | 'memory' | 'agent';

/** A missing or unrecognized class cannot establish a non-private audience. */
export function isNonStrictMemoryClass(memoryClass?: string): boolean {
  return ['system', 'app', 'knowledge', 'group'].includes(memoryClass ?? '');
}

/**
 * The caller must be a user acting directly. User-owned Agents are explicitly
 * outside #1734 (Ada's provisional scope ruling, team chat #8878). Memory
 * callers must supply the class: personal/private never get a role bypass.
 */
export function canBypassUserOwnership(
  caller: PlatformCaller,
  kind: TenantResourceKind,
  memoryClass?: string,
): boolean {
  if (!caller.userId || caller.impersonation || isRunPrincipal(caller) || kind === 'agent') return false;
  if (kind === 'memory' && !isNonStrictMemoryClass(memoryClass)) return false;
  return !!(caller.roles?.includes('ADMIN') || caller.roles?.includes('OWNER'));
}

/** Agent.systemMemoryId is a scalar reference, not a Prisma relation. */
export async function userOwnedAgentSystemMemoryIds(
  db: Pick<PrismaClient, 'agent'>,
  memoryIds?: readonly string[],
): Promise<Set<string>> {
  if (memoryIds?.length === 0) return new Set();
  const agents = await db.agent.findMany({
    where: { ownerUserId: { not: null }, systemMemoryId: memoryIds ? { in: [...memoryIds] } : { not: null } },
    select: { systemMemoryId: true },
  });
  return new Set(agents.flatMap(agent => agent.systemMemoryId ? [agent.systemMemoryId] : []));
}

/** #8898: a user-owned Agent's system memory stays with its definition. */
export async function canBypassMemoryOwnership(
  db: Pick<PrismaClient, 'agent'>,
  caller: PlatformCaller,
  memory: { id?: string; class?: string; ownerUserId: string | null },
  protectedSystemMemoryIds?: ReadonlySet<string>,
): Promise<boolean> {
  if (!canBypassUserOwnership(caller, 'memory', memory.class)) return false;
  if (memory.class !== 'system' || memory.ownerUserId === null) return true;
  if (!memory.id) return false;
  const protectedIds = protectedSystemMemoryIds ?? await userOwnedAgentSystemMemoryIds(db, [memory.id]);
  return !protectedIds.has(memory.id);
}
