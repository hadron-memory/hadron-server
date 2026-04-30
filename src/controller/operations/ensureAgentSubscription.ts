/**
 * Idempotent auto-provisioning of an AgentSubscription. Per spec
 * 005-agent-subscription FR-002 + research.md §R-6.
 *
 * Called from any session-creation path that has both `userId` and
 * `agentId` resolved (concretely: the GraphQL `startSession` resolver
 * and the MCP session-start tool path). Pure read paths do NOT
 * auto-provision.
 *
 * Idempotency comes from the composite UNIQUE primary key plus
 * Prisma's `upsert`: concurrent first-contact requests for the same
 * (userId, agentId) converge on a single row.
 */

import type { PrismaClient } from '../../generated/prisma/index.js';

export async function ensureAgentSubscription(
  db: PrismaClient,
  userId: string,
  agentId: string,
): Promise<void> {
  await db.agentSubscription.upsert({
    where: { userId_agentId: { userId, agentId } },
    create: {
      userId,
      agentId,
      // v1 default: activate immediately on creation since billing is
      // out of scope. A future spec adding billing introduces a
      // deferred-activation path (activatedAt = null until payment).
      activatedAt: new Date(),
    },
    update: {},
  });
}
