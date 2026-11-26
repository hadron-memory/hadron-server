/** #3253 / ruling0089 A (cor:dmo:050:09, cor:dmo:060:09): subscription reach shares one read predicate. */
import type { Prisma } from '../../generated/prisma/index.js';
import { orgRoleAtLeast } from './orgRole.js';

/**
 * Classes a subscription never reaches — the gate's `notIn` list, exported so the
 * effectiveAccess audit arm (#329) reuses the SAME list instead of hand-copying it:
 * the audit mirrors the gate by construction, and a new excluded class cannot appear
 * on one side only (the #1440 lesson, restated as code rather than convention).
 */
export const SUBSCRIPTION_EXCLUDED_CLASSES = ['personal', 'private', 'group', 'system'] as const;

/**
 * Classes a live CONTRIBUTOR+ subscription may WRITE once the read scope above
 * admits the row: ordinary shared knowledge only. Shared by every copy of the
 * write arm — requireMemoryWriteAccess's subscription arm,
 * getSubscribedWritableMemoryIds, and the #329 effectiveAccess audit — the same
 * mirroring-by-construction SUBSCRIPTION_EXCLUDED_CLASSES gives the read side
 * (#5309 review: the last hand-copied class predicate, now one list).
 *
 * `knowledge` is the only member by construction, not by accident: an app-class
 * row always carries an appId (chk_memory_class_app_id), which the read scope's
 * `appId: null` already keeps out, and the excluded list keeps every other
 * class out — so no second class is both reachable and writable today. A class
 * joins this list only together with the gate change that admits it.
 */
export const SUBSCRIPTION_WRITE_CLASSES = ['knowledge'] as const;

/**
 * Ordinary shared memories reached through an org's live subscription. Keep this identical for canonical reads
 * and Agent links: neither activation (a blended-graph flag) nor a license adds a check that read does not make.
 * Empty organization ids fail closed through Prisma's `in: []`, never an omitted filter.
 */
export function subscribedMemoryWhere(orgIds: readonly string[]): Prisma.MemoryWhereInput {
  return {
    class: { notIn: [...SUBSCRIPTION_EXCLUDED_CLASSES] },
    appId: null,
    userMemoryOfAgentId: null,
    subscriptions: { some: { organizationId: { in: [...orgIds] }, deletedAt: null } },
  };
}

/**
 * The Agent's org, not the caller's orgs, supplies the cross-tenant link. Called inside the attach transaction,
 * after the Agent/Memory authority anchors and row locks. Lock first, THEN judge the current row: an unsubscribe
 * or downgrade that won the lock is observed, and one arriving later waits until the item write commits.
 * This is the last deciding row lock; the outer transaction already holds the Agent and Memory stable.
 */
export async function subscribedAgentMemoryAdmitted(
  db: Pick<Prisma.TransactionClient, '$queryRaw' | 'memory'>,
  agentOrgId: string | null,
  memoryId: string,
  role: 'read' | 'read-write',
): Promise<boolean> {
  if (agentOrgId == null) return false;
  await db.$queryRaw`
    SELECT id FROM memory_subscriptions
    WHERE memory_id = ${memoryId} AND organization_id = ${agentOrgId} FOR SHARE`;
  const memory = await db.memory.findFirst({
    where: { id: memoryId, deletedAt: null, ...subscribedMemoryWhere([agentOrgId]) },
    select: {
      subscriptions: { where: { organizationId: agentOrgId }, select: { role: true } },
    },
  });
  const subscription = memory?.subscriptions[0];
  return subscription != null && (role === 'read' || orgRoleAtLeast(subscription.role, 'CONTRIBUTOR'));
}
