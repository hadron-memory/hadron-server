/** #3382: invocation-local membership data for existing manager predicates.
 * The gates still decide; this only batches their live org-role reads. A new
 * instance is built for EACH admission/filter evaluation, never shared across
 * transaction/lock boundaries or across users. withoutRequestCaches strips it.
 */
import type { PrismaClient, Role } from '../../generated/prisma/index.js';
import { LIVE_ORG_MEMBERSHIP } from './liveOrgMembership.js';

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
  const rows = ctx.userId && ids.length ? await ctx.db.orgMember.findMany({
    where: { organizationId: { in: ids }, userId: ctx.userId, ...LIVE_ORG_MEMBERSHIP },
    select: { organizationId: true, role: true },
  }) : [];
  const roles = new Map<string, Role | null>(ids.map(id => [id, null]));
  for (const row of rows) roles.set(row.organizationId, row.role);
  return { ...ctx, managerOrgRoleCache: { userId: ctx.userId, roles } };
}
