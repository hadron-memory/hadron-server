// #2109 — App.viewerManages: the caller's own "do I manage this App" fact.
//
// The decision is the shared managesApp fold (src/lib/auth/appManagement.ts),
// batched. Nothing here restates the arms. What this file adds is the PRINCIPAL
// rule for a read-time fact (a pure App key, an impersonated session, a headless
// run and a worker-bound request are not the direct user, so they read false)
// and request-local batching with fresh role and App reads.

import { currentActor, currentActorAmbiguity } from '../../../lib/requestActor.js';
import { isRunPrincipal } from '../../../lib/auth/runPrincipal.js';
import { managesAppBatch } from '../../../lib/auth/appManagement.js';
import type { Context } from './resolvers.helpers.js';

const APP_CHUNK = 500;

type Batch = { ids: Set<string>; done: Promise<Map<string, boolean>> };

/** Per request and per caller (the Context is built per request): never module- or user-global. */
export interface ViewerManagesCache {
  facts: Map<string, Promise<boolean>>;
  batch: Batch | null;
  actor: Promise<{ roles: string[] } | null> | null;
}

/** Is this request the direct user acting for themself (cor:dmo:050:12)? */
function isDirectUser(ctx: Context): boolean {
  return !!ctx.userId
    && !ctx.impersonation
    && !isRunPrincipal(ctx)
    && currentActor().workerId === null
    && currentActorAmbiguity() === null
    && !ctx.sessionBindingRefused;
}

async function evaluate(ctx: Context, cache: ViewerManagesCache, ids: string[]): Promise<Map<string, boolean>> {
  // Live platform roles, read once per request: a token's roles are a snapshot.
  const actor = await (cache.actor ??= ctx.db.user
    .findUnique({ where: { id: ctx.userId! }, select: { roles: true, deletedAt: true } })
    .then((u) => (u && !u.deletedAt ? { roles: u.roles as string[] } : null)));
  const result = new Map<string, boolean>(ids.map((id) => [id, false]));
  if (!actor) return result;
  const caller = { db: ctx.db, userId: ctx.userId, impersonation: ctx.impersonation, roles: actor.roles };
  for (let i = 0; i < ids.length; i += APP_CHUNK) {
    // Fresh identity, ownership and liveness: not a projection the caller supplied.
    const apps = await ctx.db.app.findMany({
      where: { id: { in: ids.slice(i, i + APP_CHUNK) }, deletedAt: null },
      select: { id: true, organizationId: true, ownerUserId: true },
    });
    for (const [id, manages] of await managesAppBatch(caller, apps)) result.set(id, manages);
  }
  return result;
}

export function loadViewerManages(ctx: Context, appId: string): Promise<boolean> {
  if (!isDirectUser(ctx)) return Promise.resolve(false);
  const cache = (ctx.viewerManagesCache ??= { facts: new Map(), batch: null, actor: null });
  const hit = cache.facts.get(appId);
  if (hit) return hit;
  let batch = cache.batch;
  if (!batch) {
    const ids = new Set<string>();
    // Flush after the current synchronous resolver pass, so every App a list
    // or nested read selects in that pass shares one set of queries.
    const created: Batch = {
      ids,
      done: Promise.resolve().then(() => {
        cache.batch = null;
        return evaluate(ctx, cache, [...ids]);
      }),
    };
    cache.batch = created;
    batch = created;
  }
  batch.ids.add(appId);
  const pending = batch.done.then((facts) => facts.get(appId) ?? false);
  cache.facts.set(appId, pending);
  return pending;
}
