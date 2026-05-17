/**
 * updateMemoryMemberRole — spec 023-app-shape US4 (T053).
 *
 * Updates the role on an existing MemoryMember row. Enforces:
 *   - MemoryMemberNotFoundError if the row doesn't exist (use
 *     addMemoryMember to upsert instead).
 *   - **FR-038 last-owner protection**: demoting the sole remaining
 *     owner to writer/reader is rejected with LastOwnerProtectedError.
 *     A group-class Memory must always have ≥1 owner; the path to
 *     fully empty one is to delete the Memory.
 *
 * Race-safe: rather than a pre-check (which would be racy against
 * concurrent removes), the update runs directly and Prisma's P2025
 * "record to update not found" is translated to the typed error.
 * The last-owner protection runs as a count-based check inside a
 * transaction so the count + update are atomic.
 */

import {
  Prisma,
  type PrismaClient,
  type MemoryMemberRole,
  type MemoryMember,
} from '../../generated/prisma/index.js';

export class MemoryMemberNotFoundError extends Error {
  constructor(memoryId: string, userId: string) {
    super(
      `No MemoryMember row exists for (memoryId=${memoryId}, userId=${userId}).`,
    );
    this.name = 'MemoryMemberNotFoundError';
  }
}

export class LastOwnerProtectedError extends Error {
  constructor(memoryId: string) {
    super(
      `Cannot remove or demote the sole remaining owner of group memory ${memoryId} ` +
        `(spec 023 FR-038). To fully empty the memory, delete it instead.`,
    );
    this.name = 'LastOwnerProtectedError';
  }
}

export async function updateMemoryMemberRole(
  db: PrismaClient,
  args: {
    memoryId: string;
    userId: string;
    role: MemoryMemberRole;
    actorId: string;
  },
): Promise<MemoryMember> {
  return db.$transaction(async (tx) => {
    const current = await tx.memoryMember.findUnique({
      where: { memoryId_userId: { memoryId: args.memoryId, userId: args.userId } },
      select: { role: true },
    });
    if (!current) {
      throw new MemoryMemberNotFoundError(args.memoryId, args.userId);
    }
    // FR-038: refuse to demote the sole remaining owner.
    if (current.role === 'owner' && args.role !== 'owner') {
      const ownerCount = await tx.memoryMember.count({
        where: { memoryId: args.memoryId, role: 'owner' },
      });
      if (ownerCount <= 1) {
        throw new LastOwnerProtectedError(args.memoryId);
      }
    }
    try {
      return await tx.memoryMember.update({
        where: {
          memoryId_userId: { memoryId: args.memoryId, userId: args.userId },
        },
        data: { role: args.role, updatedBy: args.actorId },
      });
    } catch (e) {
      // Race: a concurrent revoke between the count check and the
      // update would surface as P2025 here. Map to the typed error.
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2025'
      ) {
        throw new MemoryMemberNotFoundError(args.memoryId, args.userId);
      }
      throw e;
    }
  });
}
