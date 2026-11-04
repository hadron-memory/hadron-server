/** #3382: invocation-local membership data for existing manager predicates.
 * The gates still decide; this only batches their live org-role reads. A new
 * instance is built for EACH admission/filter evaluation, never shared across
 * transaction/lock boundaries or across users. withoutRequestCaches strips it.
 */
import type { PrismaClient, Role } from '../../generated/prisma/index.js';
import { LIVE_ORG_MEMBERSHIP } from './liveOrgMembership.js';

/** Internal query-input batch, never a list/result cap (#3382). */
export const MANAGER_PREDICATE_BATCH_SIZE = 32;
export function* managerPredicateBatches<T>(items: readonly T[]): Generator<T[]> {
  for (let i = 0; i < items.length; i += MANAGER_PREDICATE_BATCH_SIZE) {
    yield items.slice(i, i + MANAGER_PREDICATE_BATCH_SIZE);
  }
}

type RoleCaller = {
  userId?: string;
  managerOrgRoleCache?: { userId: string | undefined; roles: ReadonlyMap<string, Role | null> };
};

/** undefined means not prefetched; null means the live membership was absent. */
export function cachedManagerOrgRole(ctx: RoleCaller, orgId: string): Role | null | undefined {
  return ctx.managerOrgRoleCache?.userId === ctx.userId ? ctx.managerOrgRoleCache?.roles.get(orgId) : undefined;
}

export async function withManagerOrgRoles<T extends RoleCaller & { db: Pick<PrismaClient, 'orgMember'> }>(
  ctx: T, orgIds: readonly string[],
): Promise<T> {
  const ids = [...new Set(orgIds)];
  const roles = new Map<string, Role | null>(ids.map(id => [id, null]));
  if (ctx.userId) for (const batch of managerPredicateBatches(ids)) {
    const rows = await ctx.db.orgMember.findMany({
      where: { organizationId: { in: batch }, userId: ctx.userId, ...LIVE_ORG_MEMBERSHIP },
      select: { organizationId: true, role: true },
    });
    for (const row of rows) roles.set(row.organizationId, row.role);
  }
  return { ...ctx, managerOrgRoleCache: { userId: ctx.userId, roles } };
}
