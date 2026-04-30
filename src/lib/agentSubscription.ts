/**
 * Active-status predicate for AgentSubscription. Per spec
 * 005-agent-subscription FR-004 + data-model.md §"Active-status definition":
 *
 *   activatedAt IS NOT NULL
 *     AND revokedAt IS NULL
 *     AND (expiresAt IS NULL OR expiresAt > now())
 *
 * This is the predicate every access check uses; centralizing the helper
 * here ensures consistency and makes the rule trivially testable.
 */

type AgentSubscriptionLike = {
  activatedAt: Date | null;
  revokedAt: Date | null;
  expiresAt: Date | null;
};

export function isActiveAgentSubscription(sub: AgentSubscriptionLike, now: Date = new Date()): boolean {
  if (sub.activatedAt === null) return false;
  if (sub.revokedAt !== null) return false;
  if (sub.expiresAt !== null && sub.expiresAt <= now) return false;
  return true;
}
