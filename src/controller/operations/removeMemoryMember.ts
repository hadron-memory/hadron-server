/**
 * removeMemoryMember — spec 023-app-shape US4 (T052).
 *
 * Deletes a MemoryMember row. Enforces **FR-038 last-owner
 * protection**: removing the sole remaining owner is rejected with
 * LastOwnerProtectedError. A group-class Memory must always have ≥1
 * owner; to fully empty one, delete the Memory instead.
 *
 * Idempotent for non-owner removals: succeeds whether or not the
 * row exists.
 *
 * **FR-031** preserved: removing the last non-owner does NOT delete
 * the Memory — the row persists with its remaining owner(s).
 *
 * Race-safe via a transaction: the owner-count check + delete are
 * atomic so two concurrent calls can't both succeed in removing the
 * last owner.
 */

import type { PrismaClient } from '../../generated/prisma/index.js';
import { LastOwnerProtectedError } from './updateMemoryMemberRole.js';

export async function removeMemoryMember(
  db: PrismaClient,
  args: { memoryId: string; userId: string },
): Promise<{ memoryId: string; userId: string }> {
  await db.$transaction(async (tx) => {
    const target = await tx.memoryMember.findUnique({
      where: { memoryId_userId: { memoryId: args.memoryId, userId: args.userId } },
      select: { role: true },
    });
    if (!target) return; // idempotent — no row, no-op.

    if (target.role === 'owner') {
      const ownerCount = await tx.memoryMember.count({
        where: { memoryId: args.memoryId, role: 'owner' },
      });
      if (ownerCount <= 1) {
        throw new LastOwnerProtectedError(args.memoryId);
      }
    }

    await tx.memoryMember.delete({
      where: {
        memoryId_userId: { memoryId: args.memoryId, userId: args.userId },
      },
    });
  });
  return { memoryId: args.memoryId, userId: args.userId };
}
