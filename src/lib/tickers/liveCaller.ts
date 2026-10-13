// The caller as the database knows them NOW — #1748 cycle 1 (Diego P2-1, P2-2, P2-6).
//
// A request's `ctx.roles` come from the credential presented, which can be older
// than a demotion. Anything that expands what a caller may see or stamp beyond
// "their own" (a manager reads every worker's wakes; a manager's post is
// budget-exempt for good) reloads the platform roles from the user row first, as
// `withAuthorizedTx` does for writes, and drops the request's memoized access
// decisions. An impersonated caller has no platform roles by design.

import type { Prisma } from '../../generated/prisma/index.js';
import { withoutRequestCaches, type Context } from '../../api/graphql/schema/resolvers.helpers.js';

/** The caller with live roles and no memoized decisions, or null when the user is gone. */
export async function liveCaller(ctx: Context, tx?: Prisma.TransactionClient): Promise<Context | null> {
  const base = withoutRequestCaches(ctx, tx);
  if (!ctx.userId) return base;
  const user = await base.db.user.findUnique({ where: { id: ctx.userId }, select: { roles: true, deletedAt: true } });
  if (!user || user.deletedAt) return null;
  return { ...base, roles: ctx.impersonation ? [] : user.roles };
}
