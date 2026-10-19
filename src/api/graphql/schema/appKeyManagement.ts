/** #1744 / cor:dmo:050:05: App credential inventory and issuance share the manager predicate. */
import type { Prisma } from '../../../generated/prisma/index.js';
import { managesApp } from '../../../lib/auth/appManagement.js';
import { authorizationDenied } from '../../../lib/auth/authorizationDenied.js';
import type { Context } from './resolvers.helpers.js';

type KeyApp = { id: string; organizationId: string | null; ownerUserId: string | null };

/** Only whoever manages the App, as themselves, may see or manage its keys. */
export async function requireAppKeyManager(ctx: Context, app: KeyApp): Promise<void> {
  if (!(await managesApp(ctx, app))) throw authorizationDenied();
}

/**
 * Hold the caller's deciding memberships through the key write. Called after authority
 * anchors and owner/App rows, before re-reading managesApp on the transaction client.
 * A demotion or removal that committed first is seen; one arriving later waits for commit.
 */
export async function lockAppKeyManagerMemberships(tx: Prisma.TransactionClient, ctx: Context, app: KeyApp): Promise<void> {
  if (!ctx.userId) return;
  await tx.$queryRaw`SELECT user_id FROM app_members WHERE app_id = ${app.id} AND user_id = ${ctx.userId} FOR SHARE`;
  if (app.organizationId) {
    await tx.$queryRaw`SELECT user_id FROM org_members WHERE organization_id = ${app.organizationId} AND user_id = ${ctx.userId} FOR SHARE`;
  }
}
