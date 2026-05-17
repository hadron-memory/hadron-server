/**
 * updateMemoryMemberRole — spec 023-app-shape US4 (T053).
 *
 * Updates the role on an existing MemoryMember row. Enforces:
 *   - MemoryNotFoundForMemberError if the memory is absent or
 *     soft-deleted (MemoryMember rows can outlive the memory in
 *     edge cases — never let an update succeed against a tombstone).
 *   - InvalidMemoryClassForMemberError if the memory is not
 *     group-class (FR-027; mirrors addMemoryMember).
 *   - MemoryMemberNotFoundError if the row doesn't exist (use
 *     addMemoryMember to upsert instead).
 *   - **FR-038 last-owner protection**: demoting the sole remaining
 *     owner to writer/reader is rejected with LastOwnerProtectedError.
 *     A group-class Memory must always have ≥1 owner; the path to
 *     fully empty one is to delete the Memory.
 *
 * Flow & race-safety:
 *   1. Pre-read the memory + the current MemoryMember row inside
 *      the transaction. The memory read enforces the entity-status
 *      invariants; the member read is needed for the FR-038 logic
 *      (we only run the owner-count check when demoting an existing
 *      owner) and to raise a clean MemoryMemberNotFoundError.
 *   2. Run the count + update inside a SERIALIZABLE transaction so
 *      two concurrent self-demotes can't both observe ownerCount > 1
 *      and both succeed (write-skew protection).
 *   3. A row that's concurrently deleted *between* the pre-read and
 *      the update surfaces as Prisma's P2025 ("record to update not
 *      found") — caught and mapped to the typed error.
 */

import {
  Prisma,
  type PrismaClient,
  type MemoryMemberRole,
  type MemoryMember,
} from '../../generated/prisma/index.js';
import {
  InvalidMemoryClassForMemberError,
  MemoryNotFoundForMemberError,
} from './addMemoryMember.js';

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
  return db.$transaction(
    async (tx) => {
      // Entity-status invariants (mirrors addMemoryMember). The
      // GraphQL guard `requireMemoryMemberOwner` covers these for
      // user-driven calls, but a controller-level caller (jobs,
      // tests, future code) can reach this function directly — so
      // enforce here too rather than trusting the upstream guard.
      const memory = await tx.memory.findUnique({
        where: { id: args.memoryId },
        select: { class: true, deletedAt: true },
      });
      if (!memory || memory.deletedAt) {
        throw new MemoryNotFoundForMemberError(args.memoryId);
      }
      if (memory.class !== 'group') {
        throw new InvalidMemoryClassForMemberError(args.memoryId, memory.class);
      }
      const current = await tx.memoryMember.findUnique({
        where: {
          memoryId_userId: { memoryId: args.memoryId, userId: args.userId },
        },
        select: { role: true },
      });
      if (!current) {
        throw new MemoryMemberNotFoundError(args.memoryId, args.userId);
      }
      // FR-038: refuse to demote the sole remaining owner. Under
      // SERIALIZABLE isolation two concurrent self-demotes can't
      // both observe ownerCount > 1 — one will fail with 40001 on
      // commit and Prisma will surface that as a transient error
      // the caller can retry.
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
          data: {
            role: args.role,
            updatedBy: args.actorId,
          },
        });
      } catch (e) {
        // Race: a concurrent revoke between the pre-read and the
        // update would surface as P2025 here. Map to the typed error.
        if (
          e instanceof Prisma.PrismaClientKnownRequestError &&
          e.code === 'P2025'
        ) {
          throw new MemoryMemberNotFoundError(args.memoryId, args.userId);
        }
        throw e;
      }
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
}
