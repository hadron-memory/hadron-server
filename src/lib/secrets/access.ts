/** Shared App-secret reach and management gates (#3997, #3999; cor:sec:020:02). */
import type { Context } from '../../api/graphql/schema/resolvers.helpers.js';
import { isAppParticipant } from '../../api/graphql/schema/resolvers.helpers.js';
import { isRunPrincipal } from '../auth/runPrincipal.js';
import { managesApp } from '../auth/appManagement.js';
import { authorizationDenied } from '../auth/authorizationDenied.js';
type AppSecretRow = { id: string; organizationId: string | null; ownerUserId: string | null };

/** The App when it is live (not deleted, not uninstalled); null otherwise. */
export async function loadLiveApp(ctx: Context, appId: string): Promise<AppSecretRow | null> {
  const app = await ctx.db.app.findUnique({
    where: { id: appId },
    select: { id: true, organizationId: true, ownerUserId: true, deletedAt: true, uninstalledAt: true },
  });
  if (!app || app.deletedAt || app.uninstalledAt) return null;
  return app;
}

/**
 * The caller as a MEMBER of a live App (cor:sec:020:02): a person acting as themselves who participates in the App. An
 * App key (no user), an impersonated session and a run are not members and see and change nothing. Returns the App row,
 * or null. A bound worker session is its driving person's session, so it passes when that person is a member.
 */
export async function appMember(ctx: Context, appId: string): Promise<AppSecretRow | null> {
  if (!ctx.userId || ctx.appKeyId || ctx.impersonation || isRunPrincipal(ctx)) return null;
  const app = await loadLiveApp(ctx, appId);
  if (!app) return null;
  return (await isAppParticipant(ctx, app)) ? app : null;
}

export async function requireAppMember(ctx: Context, appId: string): Promise<AppSecretRow> {
  const app = await appMember(ctx, appId);
  if (!app) throw authorizationDenied();
  return app;
}

/** Whoever manages the live App, as a person acting as themselves (cor:dmo:050:12). */
export async function appManager(ctx: Context, appId: string): Promise<AppSecretRow | null> {
  if (!ctx.userId || ctx.appKeyId || ctx.impersonation || isRunPrincipal(ctx)) return null;
  const app = await loadLiveApp(ctx, appId);
  if (!app) return null;
  return (await managesApp(ctx, app)) ? app : null;
}

/** The authority anchors an App secret write depends on: the App, and its organization when it has one. */
export function appAnchors(app: AppSecretRow) {
  return [
    { kind: 'app' as const, id: app.id },
    ...(app.organizationId ? [{ kind: 'org' as const, id: app.organizationId }] : []),
  ];
}

