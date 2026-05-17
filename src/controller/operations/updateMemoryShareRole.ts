/**
 * updateMemoryShareRole — spec 023-app-shape US3 (T041).
 *
 * Updates the role on an existing MemoryShare row. Rejects with a
 * typed not-found error if the row doesn't exist (use
 * createMemoryShare to upsert).
 *
 * The caller-authority guard lives in the resolver; see
 * `createMemoryShare.ts` for the policy context.
 *
 * Race-safe: rather than a pre-check (which would be racy with a
 * concurrent revoke), the update runs directly and Prisma's P2025
 * "record to update not found" gets translated to the typed error.
 */

import {
  Prisma,
  type PrismaClient,
  type MemoryShareRole,
  type MemoryShare,
} from '../../generated/prisma/index.js';

export class MemoryShareNotFoundError extends Error {
  constructor(memoryId: string, granteeId: string) {
    super(
      `No MemoryShare row exists for (memoryId=${memoryId}, granteeId=${granteeId}).`,
    );
    this.name = 'MemoryShareNotFoundError';
  }
}

export async function updateMemoryShareRole(
  db: PrismaClient,
  args: {
    memoryId: string;
    granteeId: string;
    role: MemoryShareRole;
    actorId: string;
  },
): Promise<MemoryShare> {
  try {
    return await db.memoryShare.update({
      where: {
        memoryId_granteeId: { memoryId: args.memoryId, granteeId: args.granteeId },
      },
      data: { role: args.role, updatedBy: args.actorId },
    });
  } catch (e) {
    if (
      e instanceof Prisma.PrismaClientKnownRequestError &&
      e.code === 'P2025'
    ) {
      throw new MemoryShareNotFoundError(args.memoryId, args.granteeId);
    }
    throw e;
  }
}
