/**
 * updateMemoryShareRole — spec 023-app-shape US3 (T041).
 *
 * Updates the role on an existing MemoryShare row. Rejects with a
 * typed not-found error if the row doesn't exist (use
 * createMemoryShare to upsert).
 *
 * The caller-authority guard lives in the resolver; see
 * `createMemoryShare.ts` for the policy context.
 */

import type { PrismaClient, MemoryShareRole } from '../../generated/prisma/index.js';

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
): Promise<{ memoryId: string; granteeId: string; role: MemoryShareRole }> {
  const existing = await db.memoryShare.findUnique({
    where: {
      memoryId_granteeId: { memoryId: args.memoryId, granteeId: args.granteeId },
    },
    select: { memoryId: true },
  });
  if (!existing) {
    throw new MemoryShareNotFoundError(args.memoryId, args.granteeId);
  }
  await db.memoryShare.update({
    where: {
      memoryId_granteeId: { memoryId: args.memoryId, granteeId: args.granteeId },
    },
    data: { role: args.role, updatedBy: args.actorId },
  });
  return {
    memoryId: args.memoryId,
    granteeId: args.granteeId,
    role: args.role,
  };
}
