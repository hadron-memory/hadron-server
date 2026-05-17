/**
 * revokeMemoryShare — spec 023-app-shape US3 (T040).
 *
 * Deletes a MemoryShare row. Per spec 023 FR-022, revocation takes
 * effect on the next read — there's no "deactivated" state, just a
 * row delete.
 *
 * Idempotent: succeeds whether or not the row exists.
 *
 * The caller-authority guard lives in the resolver (the same rule as
 * createMemoryShare: caller MUST be the principal in v1). See the
 * note in `createMemoryShare.ts` for the broader policy context.
 */

import type { PrismaClient } from '../../generated/prisma/index.js';

export async function revokeMemoryShare(
  db: PrismaClient,
  args: { memoryId: string; granteeId: string },
): Promise<{ memoryId: string; granteeId: string }> {
  await db.memoryShare.deleteMany({
    where: { memoryId: args.memoryId, granteeId: args.granteeId },
  });
  return { memoryId: args.memoryId, granteeId: args.granteeId };
}
