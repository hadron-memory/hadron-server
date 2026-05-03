/**
 * Active-status predicate for AgentSubscription. Per spec
 * 005-agent-subscription FR-004 + data-model.md §"Active-status definition":
 *
 *   activatedAt IS NOT NULL
 *     AND revokedAt IS NULL
 *     AND (expiresAt IS NULL OR expiresAt > now())
 *
 * 008-agent-installation generalized this to the shared `isLifecycleActive`
 * helper (used by both AgentSubscription and the new AgentOrgGrant). This
 * file's `isActiveAgentSubscription` keeps the named export for callers
 * that pre-date 008.
 */

import { isLifecycleActive, type LifecycleLike } from './lifecycle.js';

export function isActiveAgentSubscription(sub: LifecycleLike, now: Date = new Date()): boolean {
  return isLifecycleActive(sub, now);
}
