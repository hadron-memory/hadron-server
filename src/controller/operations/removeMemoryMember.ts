/**
 * removeMemoryMember — spec 023-app-shape US4 (T052).
 *
 * Deletes a MemoryMember row. Enforces **FR-038 last-owner
 * protection**: removing the sole remaining owner is rejected with
 * LastOwnerProtectedError. A group-class Memory must always have ≥1
 * owner; to fully empty one, delete the Memory instead.
 *
 * **Idempotent on missing rows** regardless of (would-be) role:
 * absence-at-call-time AND concurrent-deletion both succeed silently.
 * The caller can't observe the difference between "row was never
 * there" and "row was just removed by someone else," which matches
 * the user-facing contract (the desired end state is reached either
 * way).
 *
 * **FR-031** preserved: removing the last non-owner does NOT delete
 * the Memory — the row persists with its remaining owner(s).
 *
 * Race-safety:
 *   - SERIALIZABLE transaction so two concurrent owner-removals
 *     can't both observe ownerCount > 1 and both commit (write-skew
 *     protection — without this READ COMMITTED would let both pass).
 *   - P2025 from the delete (row removed between pre-read and
 *     delete) is caught and folded into the idempotent path.
 */

import { Prisma, type PrismaClient } from '../../generated/prisma/index.js';
import { LastOwnerProtectedError } from './updateMemoryMemberRole.js';

export async function removeMemoryMember(
  db: PrismaClient,
  args: { memoryId: string; userId: string },
): Promise<{ memoryId: string; userId: string }> {
  await db.$transaction((tx) => removeMemoryMemberInTx(tx, args),
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  return { memoryId: args.memoryId, userId: args.userId };
}

/** Transaction body for callers that already hold the authority anchor. */
export async function removeMemoryMemberInTx(
  tx: Prisma.TransactionClient,
  args: Parameters<typeof removeMemoryMember>[1],
): Promise<{ memoryId: string; userId: string }> {
  const target = await tx.memoryMember.findUnique({
    where: {
      memoryId_userId: { memoryId: args.memoryId, userId: args.userId },
    },
    select: { role: true },
  });
  if (!target) return args; // idempotent — no row, no-op.

  if (target.role === 'owner') {
    const ownerCount = await tx.memoryMember.count({
      where: { memoryId: args.memoryId, role: 'owner' },
    });
    if (ownerCount <= 1) {
      throw new LastOwnerProtectedError(args.memoryId);
    }
  }

  try {
    await tx.memoryMember.delete({
      where: {
        memoryId_userId: { memoryId: args.memoryId, userId: args.userId },
      },
    });
  } catch (e) {
    // Concurrent delete between pre-read and our delete surfaces
    // as P2025. Fold into the idempotent path — the desired end
    // state (row absent) is already reached.
    if (
      e instanceof Prisma.PrismaClientKnownRequestError &&
      e.code === 'P2025'
    ) {
      return args;
    }
    throw e;
  }
  return { memoryId: args.memoryId, userId: args.userId };
}
