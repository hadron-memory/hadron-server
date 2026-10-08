/**
 * "Whoever manages the App" — ONE definition, shared by App member management
 * (`ensureAppMember` / `removeAppMember`) and agent tasks (#1705, cor:agt:050:09).
 *
 * Holger's ruling, recorded on epic hadron-server#1704 (team chat #7489 and in
 * conversation with Anne, 2026-10-08): "owner + admins", implemented by this
 * existing helper so member management and tasks cannot drift. It is broader
 * than cor:acl:010:01's wording (it also counts platform admins on org-owned
 * Apps and `owner`-role AppMembers); aligning the spec text is Vera's.
 *
 * Moved here from resolvers.mutation.app.ts unchanged; T2/T3/T6 reuse it.
 */

import type { PrismaClient } from '../../generated/prisma/index.js';
import { LIVE_ORG_MEMBERSHIP } from './liveOrgMembership.js';

/** The caller fields this predicate reads — a structural slice of the GraphQL Context. */
export type AppManagerCaller = {
  db: Pick<PrismaClient, 'orgMember' | 'appMember'>;
  userId?: string;
  roles?: readonly string[];
};

/**
 * Can the caller manage this App's members by ROLE alone — independent of any
 * target user? Platform ADMIN/OWNER for an ORG-owned App, the user-owner of a
 * user-owned App, an org ADMIN/OWNER of the App's org, or an owner-role
 * AppMember. spec 047 (blocker 3): the platform-admin bypass applies ONLY to an
 * org-owned App (a user-owned App is strictly owner-only). Shared by
 * ensureAppMember + removeAppMember so the role gate is evaluated BEFORE the
 * target user is resolved — a non-authorized caller can't turn user-ref
 * resolution into an existence oracle (#816 review).
 */
export async function callerManagesAppMembers(
  ctx: AppManagerCaller,
  app: { ownerUserId: string | null; organizationId: string | null },
  resolvedAppId: string,
): Promise<boolean> {
  const isPlatformAdmin = ctx.roles?.includes('ADMIN') || ctx.roles?.includes('OWNER');
  if (isPlatformAdmin && app.ownerUserId === null) return true;
  const isAppOwnerUser = app.ownerUserId !== null && !!ctx.userId && ctx.userId === app.ownerUserId;
  if (isAppOwnerUser) return true;
  if (app.organizationId) {
    const orgMember = await ctx.db.orgMember.findFirst({
      where: {
        organizationId: app.organizationId,
        userId: ctx.userId ?? '',
        ...LIVE_ORG_MEMBERSHIP,
        role: { in: ['ADMIN', 'OWNER'] },
      },
    });
    if (orgMember) return true;
  }
  const ownerMember = ctx.userId
    ? await ctx.db.appMember.findUnique({
        where: { appId_userId: { appId: resolvedAppId, userId: ctx.userId } },
      })
    : null;
  return ownerMember?.role === 'owner';
}
