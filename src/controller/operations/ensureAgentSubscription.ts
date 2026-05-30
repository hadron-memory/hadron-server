/**
 * Idempotent auto-provisioning of an AgentSubscription. Per spec
 * 005-agent-subscription FR-002 + research.md §R-6.
 *
 * Called from any session-creation path that has both `userId` and
 * `agentId` resolved (concretely: the GraphQL `startSession` resolver
 * and the MCP session-start tool path). Pure read paths do NOT
 * auto-provision.
 *
 * Idempotency comes from the composite UNIQUE primary key. Prisma's
 * `upsert` is not race-safe under concurrent first-contacts (two
 * transactions can both observe "no row" and both INSERT, with one
 * raising P2002 — see prisma/prisma#15028). Since `update: {}` is a
 * no-op, catching P2002 lands us in exactly the post-condition the
 * function promises: a single row exists for (userId, agentId).
 */

import { Prisma, type PrismaClient } from '../../generated/prisma/index.js';

export async function ensureAgentSubscription(
  db: PrismaClient,
  userId: string,
  agentId: string,
): Promise<void> {
  try {
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
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      return;
    }
    throw err;
  }
}
