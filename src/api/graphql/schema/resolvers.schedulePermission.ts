/**
 * #3483 / cor:agt:010:01 r40: a person's one-time permission for a worker to create one headless trigger.
 * Minting admits only a person signed in to the portal (`portalHumanUserId`, #1328, equal to the caller) who is an
 * org ADMIN of the App: the same authority that could create the trigger themselves, no wider. Accepted limit
 * (D-2026-09-24-004): an agent driving the browser, or anyone replaying the person's sign-in JWT, reads as the person.
 * There is no revoke (a permission lasts 10 minutes) and nothing to present: the create finds the live permission.
 */
import { GraphQLError } from 'graphql';
import { generateId } from '../../../lib/id.js';
import { isRunPrincipal } from '../../../lib/auth/runPrincipal.js';
import { resolveAppRef } from '../../../lib/entityRef/appRef.js';
import { SCHEDULE_PERMISSION_MINUTES, workerShapedCaller } from '../../../lib/automation/scheduleAdmission.js';
import { requireOrgRole, type Context } from './resolvers.helpers.js';
import { assertFullyQualifiedUrn } from '../../../lib/urn.js';
import { resolveWorkerRef } from '../../../lib/entityRef/workerRef.js';

const refused = () => new GraphQLError('Forbidden', { extensions: { code: 'FORBIDDEN' } });

/** The portal person, or a refusal: the one admission for giving and revoking. */
async function requirePortalPerson(ctx: Context): Promise<string> {
  if (!ctx.userId || ctx.portalHumanUserId !== ctx.userId || ctx.impersonation || ctx.appId || ctx.appKeyId
    || ctx.sessionId || ctx.sessionBindingRefused || isRunPrincipal(ctx) || await workerShapedCaller(ctx)) throw refused();
  return ctx.userId;
}

async function adminApp(ctx: Context, appRef: string) {
  const { id } = await resolveAppRef(ctx.db, appRef);
  const app = await ctx.db.app.findFirst({ where: { id, deletedAt: null }, select: { id: true, organizationId: true } });
  if (!app || !app.organizationId) throw new GraphQLError('App not found.', { extensions: { code: 'NOT_FOUND' } });
  await requireOrgRole(ctx, app.organizationId, 'ADMIN');
  return { id: app.id, organizationId: app.organizationId };
}

export const schedulePermissionMutations = {
  giveSchedulePermission: async (
    _: unknown, a: { appRef: string; workerRef: string; entryNodeUrn: string }, ctx: Context,
  ) => {
    const userId = await requirePortalPerson(ctx);
    const app = await adminApp(ctx, a.appRef);
    assertFullyQualifiedUrn(a.entryNodeUrn, 'node');
    let resolved: { id: string } | null = null;
    try { resolved = await resolveWorkerRef(ctx.db, a.workerRef); } catch (e) { if (!(e instanceof Error) || e.name !== 'WorkerNotFoundError') throw e; }
    const worker = resolved ? await ctx.db.worker.findFirst({ where: { id: resolved.id, appId: app.id, retiredAt: null }, select: { id: true } }) : null;
    if (!worker) throw new GraphQLError('Worker not found.', { extensions: { code: 'NOT_FOUND' } });
    const id = generateId();
    // 6a: never two live permissions for one worker and entry node. The advisory lock serializes two mints for the
    // same pair; the live check and the insert then share one transaction. Both times come from the database clock.
    await ctx.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'schedule-permission:' + worker.id + ':' + a.entryNodeUrn}))`;
      const live = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM schedule_permissions
        WHERE worker_id = ${worker.id} AND entry_node_urn = ${a.entryNodeUrn} AND consumed_at IS NULL AND expires_at > clock_timestamp()`;
      if (live.length > 0) {
        throw new GraphQLError('This worker already has a live permission for that entry node. It expires within 10 minutes; use it or wait.', { extensions: { code: 'BAD_USER_INPUT' } });
      }
      await tx.$executeRaw`INSERT INTO schedule_permissions
          (id, app_id, worker_id, entry_node_urn, given_by, given_at, expires_at)
        VALUES (${id}, ${app.id}, ${worker.id}, ${a.entryNodeUrn}, ${userId}, clock_timestamp(), clock_timestamp() + make_interval(mins => ${SCHEDULE_PERMISSION_MINUTES}::int))`;
    });
    return ctx.db.schedulePermission.findUniqueOrThrow({ where: { id } });
  },

};

export const schedulePermissionQueries = {
  schedulePermissions: async (_: unknown, a: { appRef: string }, ctx: Context) => {
    const app = await adminApp(ctx, a.appRef);
    // Live only (unspent and unexpired by the database clock), newest first.
    const live = await ctx.db.$queryRaw<Array<{ id: string }>>`SELECT id FROM schedule_permissions
      WHERE app_id = ${app.id} AND consumed_at IS NULL AND expires_at > now() ORDER BY given_at DESC, id DESC LIMIT 200`;
    const rows = await ctx.db.schedulePermission.findMany({ where: { id: { in: live.map(r => r.id) } } });
    const order = new Map(live.map((r, i) => [r.id, i]));
    return rows.sort((a, b) => order.get(a.id)! - order.get(b.id)!);
  },
};
