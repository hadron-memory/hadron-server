import { isId } from '../../../lib/entityRef/shape.js';
import { AppNotFoundError, AmbiguousLegacyUrnError } from '../../../lib/entityRef/errors.js';
import { assertFullyQualifiedUrn, parseUrnInput } from '../../../lib/urn.js';
import { pageTake } from '../pageBounds.js';
/** #3350 / ruling 0112 amended: one automation's team snapshot grant, never an App-wide permission. */
import { authorizationDenied } from '../../../lib/auth/authorizationDenied.js';
import { managesApp } from '../../../lib/auth/appManagement.js';
import { requirePersonAsThemselves, requirePersonOnlyAct } from '../../../lib/auth/personAsThemselves.js';
import { resolveAppRef } from '../../../lib/entityRef/appRef.js';
import { withAuthorizedTx } from './authorizedTx.js';
import type { Context } from './resolvers.js';

const denied = () => authorizationDenied();
const APP_SELECT = { id: true, organizationId: true, ownerUserId: true } as const;
type App = { id: string; organizationId: string | null; ownerUserId: string | null };
const anchors = (app: App) => [
  { kind: 'app' as const, id: app.id },
  ...(app.organizationId ? [{ kind: 'org' as const, id: app.organizationId }] : []),
  ...(app.ownerUserId ? [{ kind: 'user' as const, id: app.ownerUserId }] : []),
];
async function person(ctx: Context, giving = false) {
  if (ctx.appKeyId) throw denied();
  // Revoke/list worker refusal is AS BUILT, NOT RULED: same instruction-arm gap as the memory read grant.
  return giving ? requirePersonOnlyAct(ctx, 'grant.give', denied) : requirePersonAsThemselves(ctx, denied);
}
async function appOf(ctx: Context, ref: string) {
  let id: string;
  if (!isId(ref)) {
    try { assertFullyQualifiedUrn(ref, 'app'); parseUrnInput(ref); } catch { throw denied(); }
  }
  try { id = (await resolveAppRef(ctx.db, ref)).id; } catch (e) {
    if (e instanceof AppNotFoundError || e instanceof AmbiguousLegacyUrnError) throw denied();
    throw e; // A database or programming fault is not an authorization refusal.
  }
  const app = await ctx.db.app.findFirst({ where: { id, deletedAt: null, uninstalledAt: null }, select: APP_SELECT });
  if (!app) throw denied();
  return app;
}
async function manager(ctx: Context, observed: App) {
  const app = await ctx.db.app.findFirst({ where: { id: observed.id, deletedAt: null, uninstalledAt: null }, select: APP_SELECT });
  if (!app || app.organizationId !== observed.organizationId || app.ownerUserId !== observed.ownerUserId || !await managesApp(ctx, app)) throw denied();
}
async function triggerLive(ctx: Context, appId: string, kind: string, id: string) {
  const where = { id, appId, deletedAt: null };
  const trigger = kind === 'SCHEDULE' ? await ctx.db.agentSchedule.findFirst({ where, select: { id: true } })
    : kind === 'WEBHOOK' ? await ctx.db.agentWebhook.findFirst({ where, select: { id: true } }) : null;
  if (!trigger) throw denied();
}

export const runTeamSnapshotMutations = {
  setAutomationTeamSnapshotGrant: async (_: unknown, input: { appRef: string; triggerKind: string; triggerId: string }, ctx: Context) => {
    const actorUserId = await person(ctx, true);
    const app = await appOf(ctx, input.appRef);
    return withAuthorizedTx(ctx, anchors(app), async c => {
      await person(c, true);
      await manager(c, app);
      await triggerLive(c, app.id, input.triggerKind, input.triggerId);
    }, async tx => {
      const where = { appId: app.id, triggerKind: input.triggerKind, triggerId: input.triggerId, revokedAt: null };
      const live = await tx.appAutomationTeamSnapshotGrant.findFirst({ where });
      if (live) return live;
      const row = await tx.appAutomationTeamSnapshotGrant.create({ data: {
        appId: app.id, triggerKind: input.triggerKind, triggerId: input.triggerId, grantedBy: actorUserId,
      } });
      await tx.appAutomationTeamSnapshotGrantEvent.create({ data: {
        appId: app.id, triggerKind: row.triggerKind, triggerId: row.triggerId, grantId: row.id, action: 'GRANT', actorUserId,
      } });
      return row;
    }, { lockMode: 'exclusive' });
  },
  revokeAutomationTeamSnapshotGrant: async (_: unknown, { id }: { id: string }, ctx: Context) => {
    const actorUserId = await person(ctx);
    const row = await ctx.db.appAutomationTeamSnapshotGrant.findUnique({ where: { id }, include: { app: { select: APP_SELECT } } });
    if (!row) throw denied();
    return withAuthorizedTx(ctx, anchors(row.app), async c => { await person(c); await manager(c, row.app); }, async tx => {
      const ended = await tx.appAutomationTeamSnapshotGrant.updateMany({ where: { id, revokedAt: null }, data: { revokedAt: new Date(), revokedBy: actorUserId } });
      if (ended.count === 1) await tx.appAutomationTeamSnapshotGrantEvent.create({ data: {
        appId: row.appId, triggerKind: row.triggerKind, triggerId: row.triggerId, grantId: id, action: 'REVOKE', actorUserId,
      } });
      return tx.appAutomationTeamSnapshotGrant.findUniqueOrThrow({ where: { id } });
    }, { lockMode: 'exclusive' });
  },
};
export const runTeamSnapshotQueries = {
  automationTeamSnapshotGrants: async (_: unknown, input: { appRef: string; includeRevoked?: boolean | null; limit?: number | null; offset?: number | null }, ctx: Context) => {
    await person(ctx);
    const app = await appOf(ctx, input.appRef);
    return withAuthorizedTx(ctx, anchors(app), async c => { await person(c); await manager(c, app); }, async tx => {
      const where = { appId: app.id, ...(input.includeRevoked ? {} : { revokedAt: null }) };
      const take = pageTake(input.limit), skip = Math.max(0, input.offset ?? 0);
      const total = await tx.appAutomationTeamSnapshotGrant.count({ where });
      const items = take === 0 ? [] : await tx.appAutomationTeamSnapshotGrant.findMany({
        where, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take, skip,
      });
      return { items, total, hasMore: skip + items.length < total };
    });
  },
};
