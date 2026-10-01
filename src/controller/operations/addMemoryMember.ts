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
 *   - **FR-038** last-owner protection: the idempotent path can't be
 *     used to silently demote the sole remaining owner — throws
 *     LastOwnerProtectedError. The owner-count check + upsert run in
 *     one SERIALIZABLE transaction so two concurrent self-demotes
 *     can't both pass the count check (write-skew protection).
 *
 * **Caller-authority guard** lives in the resolver (v1 rule: caller
 * MUST be an existing owner of the Memory; the bootstrap case where
 * the creator becomes the first owner is handled by createMemory).
 *
 * Idempotent on the (memoryId, userId) PK — if a row already exists,
 * its role is updated to the supplied value (subject to FR-038).
 */

import {
  Prisma,
  type PrismaClient,
  type MemoryMemberRole,
  type MemoryMember,
} from '../../generated/prisma/index.js';
import { LastOwnerProtectedError } from './updateMemoryMemberRole.js';

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
    /** Resolver gate repeated after the transfer fence, before the upsert. */
    authorizeLocked?: (tx: Prisma.TransactionClient) => Promise<void>;
  },
): Promise<MemoryMember> {
  const preflightMemory = await db.memory.findUnique({
    where: { id: args.memoryId },
    select: { class: true, deletedAt: true },
  });
  if (!preflightMemory || preflightMemory.deletedAt) {
    throw new MemoryNotFoundForMemberError(args.memoryId);
  }
  if (preflightMemory.class !== 'group') {
    throw new InvalidMemoryClassForMemberError(args.memoryId, preflightMemory.class);
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
  return db.$transaction((tx) => addMemoryMemberInTx(tx, args),
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

/** Transaction body for callers that already hold the authority anchor. */
export async function addMemoryMemberInTx(
  tx: Prisma.TransactionClient,
  args: Parameters<typeof addMemoryMember>[1],
): Promise<MemoryMember> {
  // The transfer resets the old member set under Memory FOR UPDATE. Its
  // FK wait alone does not revoke a pre-authorized insert: lock and re-run
  // the owner gate before this transaction can create a new member.
  await tx.$queryRaw`SELECT id FROM memories WHERE id = ${args.memoryId} FOR SHARE`;
  await args.authorizeLocked?.(tx);
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
  // FR-038: refuse to demote the sole remaining owner via the
  // idempotent upsert path. Only relevant when the requested role
  // is not `owner` — adding/keeping `owner` can never reduce the
  // owner count.
  if (args.role !== 'owner') {
    const current = await tx.memoryMember.findUnique({
      where: {
        memoryId_userId: {
          memoryId: args.memoryId,
          userId: args.userId,
        },
      },
      select: { role: true },
    });
    if (current?.role === 'owner') {
      const ownerCount = await tx.memoryMember.count({
        where: { memoryId: args.memoryId, role: 'owner' },
      });
      if (ownerCount <= 1) {
        throw new LastOwnerProtectedError(args.memoryId);
      }
    }
  }
  return tx.memoryMember.upsert({
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
