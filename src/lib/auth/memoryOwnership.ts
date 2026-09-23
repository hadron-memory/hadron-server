import type { Prisma } from '../../generated/prisma/index.js';

/**
 * Select a memory whose identity owner is somebody other than the viewer.
 *
 * Memory has two independent user-owner axes (#1217): `userId` is authoritative
 * for personal/private classes, while `ownerUserId` is the class-independent
 * tenant owner and is authoritative only for the remaining classes. Keeping the
 * class split here prevents ADMIN/OWNER carve-outs from denying a strict owner
 * merely because another user owns the memory's tenant namespace.
 *
 * Use this below `NOT` when constructing the platform-admin readable set.
 */
export function foreignIdentityScopedMemoryFilter(
  viewerUserId: string | null | undefined,
): Prisma.MemoryWhereInput {
  const viewer = viewerUserId ?? '__none__';
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
