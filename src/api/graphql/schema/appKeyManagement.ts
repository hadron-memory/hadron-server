/** #1744 / cor:dmo:050:05: App credential inventory and issuance share the manager predicate. */
import type { Prisma } from '../../../generated/prisma/index.js';
import { managesApp } from '../../../lib/auth/appManagement.js';
import { authorizationDenied } from '../../../lib/auth/authorizationDenied.js';
import { requirePersonOnlyAct } from '../../../lib/auth/personAsThemselves.js';
import { currentActor } from '../../../lib/requestActor.js';
import type { Context } from './resolvers.helpers.js';

type KeyApp = { id: string; organizationId: string | null; ownerUserId: string | null };

/**
 * Only whoever manages the App may see or manage its keys.
 * Listing and revoking: the bound-worker refusal here stays until S3b of #2483, which admits an instructed worker
 * through S1's shared check (hrn:node:hadronmemory.com:specs:cor:dmo:050:12 S6: listing and revoking are allowed on
 * an instruction). Minting and rotating are person-only and go through {@link requireAppKeyIssuer} instead.
 * Use the authenticated actor, not App participation: org admins need no AppMember row.
 */
export async function requireAppKeyManager(ctx: Context, app: KeyApp): Promise<void> {
  if (currentActor().workerId) throw authorizationDenied();
  if (!(await managesApp(ctx, app))) throw authorizationDenied();
}

/**
 * #3277: minting (`createAppKey`) and rotating (`regenerateAppKey`) an App key are PERSON-ONLY
 * (hrn:node:hadronmemory.com:specs:cor:dmo:050:12, ruling 0098 A): the one person gate first, so a worker session in
 * any shape (header binding, session row, ambiguous actor, refused binding), a run principal, an impersonation and an
 * App key are refused, with the same `Forbidden` as before; then the manager check.
 */
export async function requireAppKeyIssuer(ctx: Context, app: KeyApp, act: 'app-key.mint' | 'app-key.rotate'): Promise<void> {
  await requirePersonOnlyAct(ctx, act, authorizationDenied);
  await requireAppKeyManager(ctx, app);
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
