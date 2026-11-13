/**
 * #3708 (Grants S1c; hrn:node:hadronmemory.com:specs:cor:acl:140:02, ruling 0255 item 2, cor:api:120): `grantActions(appRef:)` and
 * `action(appRef:, ref:)`, the read of the action registry for anyone IN the named App. Read only: no MCP tool, no write surface, no summary.
 *
 * WHO. The App is named, never inferred. Admitted: the shared participation predicate (`resolveTaskActor`, the one predicate task
 * reads use under cor:agt:050:21: a participating person, or a bound worker of that App) AND two added guards, judged BEFORE it: the
 * request is not an impersonated session (the predicate admits an impersonated participant and leaves the check to the write path) and
 * is not a headless run (a run is attributable to an agent, not to a participant; ruling 0255 item 21). An App key has no actor here.
 * Every refusal (no principal, a non-participant, an unknown, malformed or soft-deleted App, another App's or a retired worker, an App
 * key, a run, an impersonated session) is the SAME empty page / null: never an error, so the answer discloses no App and no count.
 */
import { isRunPrincipal } from '../../../lib/auth/runPrincipal.js';
import { getAction, listActions } from '../../../lib/grants/actionRead.js';
import { clampListTake, type Context } from './resolvers.helpers.js';
import { resolveTaskActor } from './resolvers.agentTask.js';
import { resolveLiveApp } from './resolvers.grantManage.js';

/** Whether this request may read the action list of the named App (see the module comment). Never throws a refusal. */
async function mayReadActions(ctx: Context, appRef: unknown): Promise<boolean> {
  if (typeof appRef !== 'string' || appRef.length === 0) return false;
  if (ctx.impersonation || isRunPrincipal(ctx)) return false;
  const app = await resolveLiveApp(ctx, appRef);
  return app !== null && (await resolveTaskActor(ctx, app)) !== null;
}

export const grantActionQueries = {
  grantActions: async (_p: unknown, { appRef, limit, offset }: { appRef: string; limit?: number | null; offset?: number | null }, ctx: Context) => {
    if (!(await mayReadActions(ctx, appRef))) return { items: [], total: 0 };
    return listActions(ctx.db, { take: clampListTake(limit), skip: Math.max(0, offset ?? 0) });
  },
  action: async (_p: unknown, { appRef, ref }: { appRef: string; ref: string }, ctx: Context) => {
    if (!(await mayReadActions(ctx, appRef))) return null;
    return typeof ref === 'string' ? getAction(ctx.db, ref) : null;
  },
};
