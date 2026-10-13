/**
 * "Whoever manages the App" for agent tasks (cor:agt:050:09) and their alarms
 * and availability (cor:agt:060:08, :09), as cor:acl:010:01 defines it since
 * Holger's ruling of 2026-10-10 (team chat #7790, re-routed in #7821; #1731):
 *
 *   - the App's user-owner;
 *   - any `owner`-role AppMember, with the same rights as `App.ownerUserId`
 *     ("a company may have turn-over and needs to maintain multiple owners");
 *   - a live ADMIN / OWNER of an org-owned App's org;
 *   - a platform ADMIN / OWNER, including a user-owned App (#1734).
 *
 * This replaces the strict reading (#1713, Rook's P1-1) that excluded the last
 * two arms. Its first reason is gone: `joinApp` never hands out `owner` since
 * #1714/#1718 (self-join is opt-in, and its role is never `owner`), so an
 * owner-role row is always granted by a manager, never self-granted. Its second
 * is overruled: platform admins may do everything except read personal and
 * private memories they don't own or hold a share for.
 *
 * Kept from the strict predicate: it is identity-scoped, so never under
 * impersonation, and a principal with no user (an App key) never manages. The
 * platform arm uses the shared #1734 predicate; it does not grant an App key
 * or an impersonated user management authority.
 *
 * `ctx.roles` is read as given. The task writes pass the transaction context,
 * whose platform roles `withAuthorizedTx` re-reads from the user row, so a
 * stale token's role grants nothing.
 */

import { canBypassUserOwnership } from './platformAdminBypass.js';
import type { PrismaClient } from '../../generated/prisma/index.js';
import { LIVE_ORG_MEMBERSHIP } from './liveOrgMembership.js';

/** The caller fields this predicate reads — a structural slice of the GraphQL Context. */
export type AppManagerCaller = {
  db: Pick<PrismaClient, 'orgMember' | 'appMember'>;
  userId?: string;
  impersonation?: unknown;
  roles?: readonly string[];
};

/**
 * Does the caller manage this App (cor:acl:010:01, #7790)? Pass a transaction
 * client in `ctx.db` to evaluate under the caller's transaction (#1713 review,
 * Diego P2-A); the task writes also hold the caller's AppMember row FOR SHARE
 * there, so a demotion can't commit between this check and the write.
 */
export async function managesApp(
  ctx: AppManagerCaller,
  app: { id: string; organizationId: string | null; ownerUserId: string | null },
): Promise<boolean> {
  if (!ctx.userId || ctx.impersonation) return false;
  if (canBypassUserOwnership(ctx, 'app')) return true;
  // Branch on the ownership CLASS first (findings:org-xor-owner-null-comparison-bypass).
  if (app.ownerUserId !== null && ctx.userId === app.ownerUserId) return true;
  if (app.ownerUserId === null && app.organizationId !== null) {
    const admin = await ctx.db.orgMember.findFirst({
      where: {
        organizationId: app.organizationId,
        userId: ctx.userId,
        ...LIVE_ORG_MEMBERSHIP,
        role: { in: ['ADMIN', 'OWNER'] },
      },
      select: { userId: true },
    });
    if (admin) return true;
  }
  const owner = await ctx.db.appMember.findUnique({
    where: { appId_userId: { appId: app.id, userId: ctx.userId } },
    select: { role: true },
  });
  return owner?.role === 'owner';
}

/**
 * The people who manage this App, as a LIST, nearest first (#1761, cor:agt:050:25;
 * cor:dmo:050:12). The same arms as {@link managesApp}, so a root task's alarm
 * chain and the acknowledgement gate cannot drift apart:
 *
 *   1. the App's user-owner;
 *   2. every `owner`-role AppMember, by user id;
 *   3. for an org-owned App, every live ADMIN / OWNER of its org, by user id.
 *
 * Deliberately NOT the platform-admin arm: `managesApp` admits a platform ADMIN
 * as a caller, but enumerating every platform admin into every App's alarm
 * chain would wake people who have no part in the App. Deleted users are left
 * out; each person appears once, at their nearest position. Pass a transaction
 * client to read under the caller's transaction.
 */
export async function appManagerUserIds(
  db: Pick<PrismaClient, 'orgMember' | 'appMember'>,
  app: { id: string; organizationId: string | null; ownerUserId: string | null },
): Promise<string[]> {
  const out: string[] = [];
  if (app.ownerUserId) out.push(app.ownerUserId);
  const owners = await db.appMember.findMany({
    where: { appId: app.id, role: 'owner', user: { deletedAt: null } },
    select: { userId: true },
    orderBy: { userId: 'asc' },
  });
  out.push(...owners.map((o) => o.userId));
  if (app.ownerUserId === null && app.organizationId !== null) {
    const admins = await db.orgMember.findMany({
      where: {
        organizationId: app.organizationId,
        ...LIVE_ORG_MEMBERSHIP,
        role: { in: ['ADMIN', 'OWNER'] },
        user: { deletedAt: null },
      },
      select: { userId: true },
      orderBy: { userId: 'asc' },
    });
    out.push(...admins.map((a) => a.userId));
  }
  return [...new Set(out)];
}
