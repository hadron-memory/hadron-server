import { canBypassUserOwnership, userOwnedAgentSystemMemoryIds, type PlatformCaller } from './platformAdminBypass.js';
import type { Prisma, PrismaClient } from '../../generated/prisma/index.js';

/**
 * Select a memory whose identity owner is somebody other than the viewer.
 *
 * Memory has two independent user-owner axes (#1217): `userId` is authoritative
 * for personal/private classes, while `ownerUserId` is the class-independent
 * tenant owner and is authoritative only for the remaining classes. Keeping the
 * class split here prevents ADMIN/OWNER carve-outs from denying a strict owner
 * merely because another user owns the memory's tenant namespace.
 *
 * Use below `NOT` on discovery surfaces. #1734 removes the tenant-owner
 * restriction for direct platform admins; #8898 retains the user-owned Agent
 * definition boundary. Protected system ids are fetched once per query.
 */
export async function foreignIdentityScopedMemoryFilter(
  viewerUserId: string | null | undefined,
  caller?: PlatformCaller,
  db?: Pick<PrismaClient, 'agent'>,
): Promise<Prisma.MemoryWhereInput> {
  const viewer = viewerUserId ?? '__none__';
  if (caller && db && canBypassUserOwnership(caller, 'memory', 'knowledge')) {
    const protectedIds = await userOwnedAgentSystemMemoryIds(db);
    return { OR: [
      { class: { in: ['personal', 'private'] }, userId: { not: viewer } },
      { class: 'system', id: { in: [...protectedIds] }, ownerUserId: { not: viewer } },
    ] };
  }
  return {
    OR: [
      {
        class: { in: ['personal', 'private'] },
        userId: { not: viewer },
      },
      {
        AND: [
          { class: { notIn: ['personal', 'private'] } },
          { ownerUserId: { not: null } },
          { ownerUserId: { not: viewer } },
        ],
      },
    ],
  };
}
