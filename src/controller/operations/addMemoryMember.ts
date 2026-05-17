/**
 * addMemoryMember — spec 023-app-shape US4 (T051).
 *
 * Adds (or upserts) a row in the MemoryMember table — a symmetric
 * team-membership grant on a group-class Memory.
 *
 * Invariants enforced (spec 023):
 *   - **FR-027** class scoping: Memory MUST have class = 'group'.
 *     Other classes throw InvalidMemoryClassForMemberError.
 *   - **FR-028** role: `reader` | `writer` | `owner` (enforced by
 *     the Prisma enum).
 *
 * **Caller-authority guard** lives in the resolver (v1 rule: caller
 * MUST be an existing owner of the Memory; the bootstrap case where
 * the creator becomes the first owner is handled by createMemory).
 *
 * Idempotent on the (memoryId, userId) PK — if a row already exists,
 * its role is updated to the supplied value rather than the call
 * throwing.
 */

import type {
  PrismaClient,
  MemoryMemberRole,
  MemoryMember,
} from '../../generated/prisma/index.js';

export class InvalidMemoryClassForMemberError extends Error {
  constructor(memoryId: string, actualClass: string) {
    super(
      `Memory ${memoryId} has class='${actualClass}'; MemoryMember applies ` +
        `only to group-class memories (spec 023 FR-027).`,
    );
    this.name = 'InvalidMemoryClassForMemberError';
  }
}

export class MemoryNotFoundForMemberError extends Error {
  constructor(memoryId: string) {
    super(`Memory ${memoryId} does not exist or has been deleted.`);
    this.name = 'MemoryNotFoundForMemberError';
  }
}

export class MemoryMemberUserMissingError extends Error {
  constructor(userId: string) {
    super(`User ${userId} does not exist.`);
    this.name = 'MemoryMemberUserMissingError';
  }
}

export async function addMemoryMember(
  db: PrismaClient,
  args: {
    memoryId: string;
    userId: string;
    role: MemoryMemberRole;
    /** Actor identity recorded in `createdBy`. */
    actorId: string;
  },
): Promise<MemoryMember> {
  const memory = await db.memory.findUnique({
    where: { id: args.memoryId },
    select: { id: true, class: true, deletedAt: true },
  });
  if (!memory || memory.deletedAt) {
    throw new MemoryNotFoundForMemberError(args.memoryId);
  }
  if (memory.class !== 'group') {
    throw new InvalidMemoryClassForMemberError(args.memoryId, memory.class);
  }
  // Confirm the user exists so a stale userId reference produces a
  // clear error instead of an FK-constraint failure deeper down.
  const user = await db.user.findUnique({
    where: { id: args.userId },
    select: { id: true, deletedAt: true },
  });
  if (!user || user.deletedAt) {
    throw new MemoryMemberUserMissingError(args.userId);
  }
  return db.memoryMember.upsert({
    where: {
      memoryId_userId: { memoryId: args.memoryId, userId: args.userId },
    },
    create: {
      memoryId: args.memoryId,
      userId: args.userId,
      role: args.role,
      createdBy: args.actorId,
    },
    update: {
      role: args.role,
      updatedBy: args.actorId,
    },
  });
}
