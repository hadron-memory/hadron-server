/**
 * "Whoever manages the App" for agent tasks (#1705, cor:agt:050:09), in the
 * STRICT cor:acl:010:01 reading: the owner of a user-owned App, or a live
 * ADMIN / OWNER of an org-owned App's (live) org. Holger, team chat #7495, as
 * cor:agt:050:09 r2 cites it; Ada confirmed this reading on the #1713 review
 * round (Holger may still override).
 *
 * Deliberately NOT `callerManagesAppMembers` (resolvers.mutation.app.ts),
 * whose two extra arms are wrong for tasks (Rook, #1713 §10 review, P1-1):
 *   - an `owner`-role AppMember: self-grantable wherever an App's Agent lists
 *     `owner` first in `memberRoles`, because `joinApp` is open self-service
 *     and hands the joiner `memberRoles[0]` — so any stranger who knows the
 *     App's id could manage every task in it;
 *   - platform ADMIN/OWNER on every org App: platform staff managing a
 *     customer team's work, cross-tenant.
 * Nothing a caller can grant themselves reaches this predicate.
 */

import type { PrismaClient } from '../../generated/prisma/index.js';
import { LIVE_ORG_MEMBERSHIP } from './liveOrgMembership.js';

/** The caller fields this predicate reads — a structural slice of the GraphQL Context. */
export type AppManagerCaller = {
  db: Pick<PrismaClient, 'orgMember'>;
  userId?: string;
  impersonation?: unknown;
};

/**
 * Does the caller manage this App, strictly (cor:acl:010:01)? Identity-scoped,
 * so never under impersonation; a principal with no user (an App key) never
 * does. Pass a transaction client in `ctx.db` to evaluate under the caller's
 * transaction (#1713 review, Diego P2-A).
 */
export async function managesAppStrict(
  ctx: AppManagerCaller,
  app: { organizationId: string | null; ownerUserId: string | null },
): Promise<boolean> {
  if (!ctx.userId || ctx.impersonation) return false;
  // Branch on the ownership CLASS first (findings:org-xor-owner-null-comparison-bypass).
  if (app.ownerUserId !== null) return ctx.userId === app.ownerUserId;
  if (app.organizationId === null) return false;
  const admin = await ctx.db.orgMember.findFirst({
    where: {
      organizationId: app.organizationId,
      userId: ctx.userId,
      ...LIVE_ORG_MEMBERSHIP,
      role: { in: ['ADMIN', 'OWNER'] },
    },
    select: { userId: true },
  });
  return admin !== null;
}
