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
 * raising P2002 — see prisma/prisma#3242). Since `update: {}` is a
 * no-op, catching P2002 lands us in exactly the post-condition the
 * function promises: a single row exists for (userId, agentId).
 *
 * The catch is scoped to the composite-PK constraint via `err.meta.target`
 * so that any future unique constraint added to AgentSubscription (e.g.
 * a billing-side `@unique([stripeSubscriptionId])`) does NOT get silently
 * swallowed.
 *
 * Forward-warning: when billing lands and activation becomes deferred
 * (activatedAt = null until payment), the race semantics need a fresh
 * look. The race-loser currently inherits the winner's `activatedAt`,
 * which is fine while activation is unconditional but may not be when
 * activation state can diverge between concurrent callers.
 */

import { Prisma, type PrismaClient } from '../../generated/prisma/index.js';

export async function ensureAgentSubscription(
  db: Pick<PrismaClient, 'agentSubscription'>,
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
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === 'P2002' &&
      isCompositePkViolation(err.meta)
    ) {
      return;
    }
    throw err;
  }
}

function isCompositePkViolation(meta: unknown): boolean {
  if (!meta || typeof meta !== 'object' || !('target' in meta)) return false;
  const target = (meta as { target?: unknown }).target;
  if (!Array.isArray(target) || target.length !== 2) return false;
  const fields = new Set(target.map(String));
  // Prisma emits target as field names (camelCase) on @@id; tolerate
  // snake_case mapping as a hedge — the same composite-PK constraint
  // can surface either way across Prisma engine versions.
  return (
    (fields.has('userId') && fields.has('agentId')) ||
    (fields.has('user_id') && fields.has('agent_id'))
  );
}
