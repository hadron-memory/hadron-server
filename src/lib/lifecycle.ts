/**
 * Shared lifecycle predicate for grant-shaped rows.
 *
 * Both `AgentSubscription` (User↔Agent, from 005) and `AgentOrgGrant`
 * (Org↔Agent, added in 008) share the lifecycle field shape and the same
 * active-status rule:
 *
 *   activatedAt IS NOT NULL
 *     AND revokedAt IS NULL
 *     AND (expiresAt IS NULL OR expiresAt > now())
 *
 * Centralizing the helper here ensures access-control checks stay
 * consistent across both grant types. Per spec 008-agent-installation R-2
 * + data-model.md §"Active-status predicate".
 */

export type LifecycleLike = {
  activatedAt: Date | null;
  revokedAt: Date | null;
  expiresAt: Date | null;
};

export function isLifecycleActive(row: LifecycleLike, now: Date = new Date()): boolean {
  if (row.activatedAt === null) return false;
  if (row.revokedAt !== null) return false;
  if (row.expiresAt !== null && row.expiresAt <= now) return false;
  return true;
}
