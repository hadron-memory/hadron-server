/**
 * Delete a dependency edge between two Agents. Per spec 008-agent-installation
 * FR-005 / User Story 3.
 *
 * Existing Apps that already installed the imported Agent are unaffected —
 * removing the AgentImport row only stops *future* installations of the
 * parent from cascading the dep.
 *
 * The mutation is idempotent: deleting a row that doesn't exist is a no-op.
 * Authorization happens at the GraphQL resolver layer (ADMIN/OWNER of the
 * parent Agent's owning org).
 */

import type { PrismaClient, Prisma } from '../../generated/prisma/index.js';

export async function removeAgentImport(
  db: PrismaClient,
  parentAgentId: string,
  importedAgentId: string,
): Promise<void> {
  try {
    await db.agentImport.delete({
      where: {
        parentAgentId_importedAgentId: {
          parentAgentId,
          importedAgentId,
        },
      },
    });
  } catch (e: unknown) {
    // Idempotent: missing row (P2025) → no-op. Any other error (DB
    // connectivity, unexpected constraint violation, permission issue)
    // surfaces so the caller knows the delete didn't actually happen.
    if (
      typeof e === 'object' &&
      e !== null &&
      (e as Prisma.PrismaClientKnownRequestError).code === 'P2025'
    ) {
      return;
    }
    throw e;
  }
}
