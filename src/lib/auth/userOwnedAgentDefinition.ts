/**
 * #1787 (cor:dmo:050:13): a user-owned Agent's system memory IS its
 * definition, and a platform admin who may manage the Agent may read it.
 * Identified from the Agent side (`Agent.systemMemoryId`), so the admin's
 * definition-read grant reaches exactly the rows the ruling names and no
 * other user-owned memory.
 */
import type { PrismaClient } from '../../generated/prisma/index.js';

export async function isUserOwnedAgentDefinition(
  db: PrismaClient,
  memoryId: string,
): Promise<boolean> {
  // Live agent only (#1818 review, Xylon note 2): a soft-deleted agent's
  // dangling systemMemoryId must not keep admitting its definition.
  const agent = await db.agent.findFirst({
    where: { systemMemoryId: memoryId, deletedAt: null },
    select: { ownerUserId: true },
  });
  return agent !== null && agent.ownerUserId !== null;
}
