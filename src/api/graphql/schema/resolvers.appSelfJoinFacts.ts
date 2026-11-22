// #4758 item 5 (follow-up to #4490): the per-App reads `App.selfJoin` makes, batched per request.
//
// Selected on a list of N Apps, the field used to pay a by-id App re-read and a membership read per App. This loader gathers
// every App the current synchronous resolver pass selects (the same-tick batch `loadViewerManages` uses) and reads them with
// ONE App query and ONE membership query per chunk, fresh from the database exactly as before: the re-read is still the
// source of the lifecycle and ownership columns, never the parent row (BLIND P2-2 of #4743). The decision itself
// (`resolveSelfJoinRole`, two reads) is NOT batched here: it is joinApp's own function, called per App that reaches it, and
// a member, an uninstalled App and an unreadable App never reach it.
import type { Context } from './resolvers.helpers.js';

const APP_CHUNK = 500;

export interface SelfJoinApp {
  id: string;
  organizationId: string | null;
  ownerUserId: string | null;
  deletedAt: Date | null;
  uninstalledAt: Date | null;
}
export interface SelfJoinFacts { app: SelfJoinApp; isMember: boolean }

type Batch = { ids: Set<string>; done: Promise<Map<string, SelfJoinFacts>> };

/** Per request and per caller (the Context is built per request): never module- or user-global. */
export interface SelfJoinFactsCache {
  facts: Map<string, Promise<SelfJoinFacts | null>>;
  batch: Batch | null;
}

async function evaluate(ctx: Context, userId: string, ids: string[]): Promise<Map<string, SelfJoinFacts>> {
  const out = new Map<string, SelfJoinFacts>();
  for (let i = 0; i < ids.length; i += APP_CHUNK) {
    const chunk = ids.slice(i, i + APP_CHUNK);
    const [apps, members] = await Promise.all([
      ctx.db.app.findMany({ where: { id: { in: chunk } }, select: { id: true, organizationId: true, ownerUserId: true, deletedAt: true, uninstalledAt: true } }),
      ctx.db.appMember.findMany({ where: { appId: { in: chunk }, userId }, select: { appId: true } }),
    ]);
    const member = new Set(members.map((m) => m.appId));
    for (const app of apps) out.set(app.id, { app, isMember: member.has(app.id) });
  }
  return out;
}

/** The fresh App row and the caller's membership for one App; null when the App does not exist. Requires `ctx.userId`. */
export function loadSelfJoinFacts(ctx: Context, appId: string): Promise<SelfJoinFacts | null> {
  // #4758: a missing user must never reach the membership read, where `userId: undefined` drops the filter and every App
  // with any member would read isMember true. Refuse here, not only in the field resolver, so no future caller can fail open.
  const userId = ctx.userId;
  if (!userId) return Promise.reject(new Error('loadSelfJoinFacts requires an authenticated user'));
  const cache = (ctx.selfJoinFactsCache ??= { facts: new Map(), batch: null });
  const hit = cache.facts.get(appId);
  if (hit) return hit;
  let batch = cache.batch;
  if (!batch) {
    const ids = new Set<string>();
    const created: Batch = {
      ids,
      done: Promise.resolve().then(() => {
        cache.batch = null;
        return evaluate(ctx, userId, [...ids]);
      }),
    };
    cache.batch = created;
    batch = created;
  }
  batch.ids.add(appId);
  const pending = batch.done.then((facts) => facts.get(appId) ?? null);
  cache.facts.set(appId, pending);
  return pending;
}
