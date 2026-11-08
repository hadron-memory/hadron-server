/**
 * #2925 / ruling0112 / #3360 (hrn:node:hadronmemory.com:specs:cor:agt:050:23): the one read-only arm by which a
 * headless run of an App reads that App's roster and tasks — only while the run's root trigger (its automation)
 * holds a live team snapshot grant. Moved out of resolvers.agentTask unchanged (#3360) so the worker read gate
 * (`requireWorkerReadAccess`, `workerReadableWhere`) consults the SAME predicate without a resolver import cycle.
 * Callers that need it judged under the App's authority anchors run it inside that transaction (`inRunTeamReadTx`);
 * on a bare client its locking reads are point-in-time.
 */
import type { Context } from '../../api/graphql/schema/resolvers.helpers.js';
import { rootTriggerOfRun } from '../automationReadGrant.js';
import { RUN_CLIENT_PREFIX, isRunPrincipal } from './runPrincipal.js';

/** The App columns the arm judges (a structural subset of `TaskApp` and the worker gate's `AppRow`). */
export type RunTeamApp = { id: string; organizationId: string | null; deletedAt?: Date | null };

/** #2925 / ruling0112: read-only own-App run arm, evaluated again inside the read's anchors. */
export async function runMayReadTeam(ctx: Context, app: RunTeamApp): Promise<boolean> {
  if (!isRunPrincipal(ctx) || ctx.impersonation || app.deletedAt || ctx.appId !== app.id) return false;
  if (!ctx.organizationId || !await ctx.db.organization.findFirst({ where: { id: ctx.organizationId, deletedAt: null }, select: { id: true } })) return false;
  const rows = await ctx.db.$queryRaw<Array<{ app_id: string; status: string; organization_id: string; user_id: string | null }>>`
    SELECT app_id, status::text AS status, organization_id, user_id FROM app_runs WHERE id = ${ctx.clientId!.slice(RUN_CLIENT_PREFIX.length)} FOR SHARE`;
  const run = rows[0];
  const bound = rows.length === 1 && run!.app_id === app.id && run!.status === 'RUNNING'
    && (app.organizationId === null || app.organizationId === run!.organization_id) && run!.organization_id === ctx.organizationId && (run!.user_id ?? undefined) === (ctx.userId ?? undefined);
  if (!bound) return false;
  const root = await rootTriggerOfRun(ctx.db, ctx.clientId!.slice(RUN_CLIENT_PREFIX.length));
  if (!root) return false;
  // A locking read detects a revoke/delete committed while this RepeatableRead reader waited for anchors.
  // Advisory exclusion alone does not refresh an already-established snapshot (#3350).
  const trigger = root.kind === 'SCHEDULE'
    ? await ctx.db.$queryRaw<Array<{ id: string }>>`SELECT id FROM agent_schedules WHERE id = ${root.id} AND app_id = ${app.id} AND deleted_at IS NULL FOR SHARE`
    : await ctx.db.$queryRaw<Array<{ id: string }>>`SELECT id FROM agent_webhooks WHERE id = ${root.id} AND app_id = ${app.id} AND deleted_at IS NULL FOR SHARE`;
  if (trigger.length !== 1) return false;
  const grants = await ctx.db.$queryRaw<Array<{ id: string }>>`SELECT id FROM app_automation_team_snapshot_grants
    WHERE app_id = ${app.id} AND trigger_kind = ${root.kind} AND trigger_id = ${root.id} AND revoked_at IS NULL FOR SHARE`;
  return grants.length === 1;
}
