/**
 * Idempotent auto-provisioning of an AgentSubscription. Per spec
 * 005-agent-subscription FR-002 + research.md §R-6.
 *
 * Called from any session-creation path that has both `userId` and
 * `agentId` resolved (concretely: the GraphQL `startSession` resolver
 * and the MCP session-start tool path). Pure read paths do NOT
 * auto-provision.
 *
 * Idempotency comes from the composite PRIMARY KEY: one
 * `INSERT … ON CONFLICT (user_id, agent_id) DO NOTHING`. It is race-safe
 * under concurrent first contacts and, unlike the earlier upsert plus a
 * caught P2002, it never errors inside a caller's transaction (where a
 * caught P2002 would leave the transaction aborted, 25P02; #1581 review).
 * The conflict target is the composite PK only, so a future unique
 * constraint (e.g. a billing-side `stripeSubscriptionId`) still raises
 * rather than being silently swallowed. An existing row is left untouched:
 * a REVOKED subscription stays revoked.
 *
 * Forward-warning: when billing lands and activation becomes deferred
 * (activatedAt = null until payment), the race semantics need a fresh
 * look. The race-loser currently inherits the winner's `activatedAt`,
 * which is fine while activation is unconditional but may not be when
 * activation state can diverge between concurrent callers.
 */

import { Prisma, type PrismaClient } from '../../generated/prisma/index.js';

export async function ensureAgentSubscription(
  db: Pick<PrismaClient, '$executeRaw'> | Prisma.TransactionClient,
  userId: string,
  agentId: string,
): Promise<void> {
  // #1581 review (Atilla): a single statement that cannot fail on the
  // composite key, because this now runs INSIDE the caller's transaction
  // (startChat provisions in the chat transaction). A caught P2002 there
  // leaves Postgres in "current transaction is aborted" (25P02), so the old
  // upsert-and-catch idempotency broke the chat. The conflict target is the
  // composite PK only, so any future unique constraint still raises rather
  // than being swallowed (the scoping the old catch had).
  await db.$executeRaw`
    INSERT INTO agent_subscriptions (user_id, agent_id, activated_at)
    VALUES (${userId}, ${agentId}, now())
    ON CONFLICT (user_id, agent_id) DO NOTHING`;
}
