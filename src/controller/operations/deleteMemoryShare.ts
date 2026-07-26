/**
 * deleteMemoryShare — spec 023-app-shape US3 (T040), renamed from
 * `revokeMemoryShare` in #785 so the MemoryShare surface reads as plain
 * CRUD (create / update / delete) rather than a bespoke verb.
 *
 * Deletes a MemoryShare row. Per spec 023 FR-022, revocation takes
 * effect on the next read — there's no "deactivated" state, just a
 * row delete.
 *
 * Idempotent: succeeds whether or not the row exists.
 *
 * The caller-authority guard lives in the resolver: the memory's
 * principal may delete ANY grantee's row, and a grantee may delete
 * THEIR OWN row (self-removal / "stop sharing with me", #785) — the
 * same owner-or-self shape `removeMemoryMember` already uses. See the
 * note in `createMemoryShare.ts` for the broader policy context.
 */

import type { PrismaClient } from '../../generated/prisma/index.js';

export async function deleteMemoryShare(
  db: PrismaClient,
  args: { memoryId: string; granteeId: string },
): Promise<{ memoryId: string; granteeId: string }> {
  await db.memoryShare.deleteMany({
    where: { memoryId: args.memoryId, granteeId: args.granteeId },
  });
  return { memoryId: args.memoryId, granteeId: args.granteeId };
}
