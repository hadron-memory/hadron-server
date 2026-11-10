/**
 * #3789 (Grants S2a-read): `grant(ref:)` and `grants`. Read only, and only by a BOUND WORKER SESSION in its own App. #3800 adds `myGrants`: a signed-in PERSON's own grants across Apps. The row
 * scope lives in src/lib/grants/read.ts (to be shared with the run tool of #3710, which does not exist yet); this file is the CALLER gate, and a failed gate is an
 * empty page / null, never an error, so it discloses nothing and answers exactly as a missing row does.
 * No MCP tool: Holger's rule (2026-10-31), "Agents: yes, Workers: no". No writer exists on any surface.
 */
import { appKeyCaller } from '../../../lib/appKeyScopes/scopes.js';
import { requirePersonAsThemselves } from '../../../lib/auth/personAsThemselves.js';
import { isRunPrincipal } from '../../../lib/auth/runPrincipal.js';
import { getGrantForWorker, listGrantsForPerson, listGrantsForWorker, type GrantReader } from '../../../lib/grants/read.js';
import { currentActor } from '../../../lib/requestActor.js';
import { clampListTake, type Context } from './resolvers.helpers.js';
import { loadApp, resolveTaskActor } from './resolvers.agentTask.js';

/**
 * The worker this request is, in the App that worker belongs to, or null. A worker session driven by a person: not an App
 * key, not a run (a run carries an App and maybe a user but is not a session), not an impersonated session, and the worker
 * is live (not retired) in a live App the person can still drive (`resolveTaskActor`, the one gate every worker read shares).
 */
export async function resolveGrantReader(ctx: Context): Promise<GrantReader | null> {
  const bound = currentActor();
  if (!bound.workerId || !ctx.userId) return null;
  if (ctx.impersonation || appKeyCaller(ctx) || isRunPrincipal(ctx)) return null;
  const worker = await ctx.db.worker.findUnique({ where: { id: bound.workerId }, select: { appId: true } });
  if (!worker) return null;
  const app = await loadApp(ctx, worker.appId);
  if (!app) return null;
  const actor = await resolveTaskActor(ctx, app);
  if (!actor || actor.kind !== 'worker' || actor.workerId !== bound.workerId) return null;
  return { appId: app.id, workerId: bound.workerId };
}

/**
 * #3800: the person this request is, for their OWN grants across Apps, or null. A signed-in person (`ctx.userId`) acting as
 * themselves: not an App key, not a run, not an impersonated session, and not a worker session (a worker reads its own App's
 * grants through `grants`; a stand-in is not the person). The caller gate only; the row scope is `listGrantsForPerson`.
 */
export async function resolveGrantPerson(ctx: Context): Promise<string | null> {
  // The shared person gate (a bespoke one drifted, #3800 §10): a worker-bound session row, an ambiguous actor and a refused
  // binding are worker shapes too. An App key carries no userId (appKeyCaller), so it is refused as having no user.
  // Only the gate's OWN refusal (the sentinel below) is the empty page; an unexpected failure (a lookup outage) propagates,
  // so it never reads as "this person has no grants".
  const refusal = new Error('not a person');
  try {
    return await requirePersonAsThemselves(ctx, () => refusal);
  } catch (e) {
    if (e === refusal) return null;
    throw e;
  }
}

export const grantQueries = {
  grant: async (_p: unknown, { ref }: { ref: string }, ctx: Context) => {
    const reader = await resolveGrantReader(ctx);
    return reader ? getGrantForWorker(ctx.db, reader, ref) : null;
  },
  grants: async (_p: unknown, { limit, offset }: { limit?: number | null; offset?: number | null }, ctx: Context) => {
    const reader = await resolveGrantReader(ctx);
    if (!reader) return { items: [], total: 0 };
    return listGrantsForWorker(ctx.db, reader, { take: clampListTake(limit), skip: Math.max(0, offset ?? 0) });
  },
  myGrants: async (_p: unknown, { limit, offset }: { limit?: number | null; offset?: number | null }, ctx: Context) => {
    const userId = await resolveGrantPerson(ctx);
    if (!userId) return { items: [], total: 0 };
    return listGrantsForPerson(ctx.db, userId, { take: clampListTake(limit), skip: Math.max(0, offset ?? 0) });
  },
};
