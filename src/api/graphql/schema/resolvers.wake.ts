// Due wakes and acknowledgement — #1748 (Tickers S2, epic #1659; plan hrn:node:hadronmemory.com:hadron-server:design:named-heartbeats §6.1).
//
// WHO MAY READ (cor:agt:080:22, this slice): the worker's holder, and whoever
// manages the App. A bare App key is concealed as "App not found" until S3 adds
// the attention:deliver scope and its session-binding refusal. Under
// impersonation nobody holds or manages anything. A holder reads the workers
// they hold; a manager reads every worker of the App. Which channels a wake
// shows is the two-reader gate in src/lib/tickers/dueWakes.ts.
//
// ACKNOWLEDGING (cor:agt:080:17): only the requester named in the proof; the
// reading right is re-checked at acknowledgement.

import { GraphQLError } from 'graphql';
import { Prisma } from '../../../generated/prisma/index.js';
import type { Context } from './resolvers.helpers.js';
import { actorManagesApp, loadApp, resolveParticipatedApp, resolveTaskActor, taskError, type TaskApp } from './resolvers.agentTask.js';
import { currentActor } from '../../../lib/requestActor.js';
import { resolveWorkerRef } from '../../../lib/entityRef/workerRef.js';
import { computeDueWakes } from '../../../lib/tickers/dueWakes.js';
import { acknowledgeWakes } from '../../../lib/tickers/acknowledge.js';
import type { WakeProof } from '../../../lib/tickers/wakeProof.js';
import { liveCaller } from '../../../lib/tickers/liveCaller.js';

type Reader = { manager: boolean; userId: string };

async function readerFor(ctx: Context, app: TaskApp, actor: Awaited<ReturnType<typeof resolveParticipatedApp>>['actor']): Promise<Reader> {
  // Concealed like any App the caller cannot reach: no oracle, and no key or impersonated session reads wakes here.
  // Nor does a worker's session: it is the worker, not the person behind it, and a holder's reading right is theirs
  // as a person (cor:agt:080:22). A worker that could read its holder's other workers could also silence them.
  if (!ctx.userId || ctx.impersonation || actor.kind === 'worker') throw taskError('APP_NOT_FOUND', 'App not found.');
  return { manager: await actorManagesApp(ctx, app, actor), userId: ctx.userId };
}

export async function dueWakesFor(
  requestCtx: Context,
  a: { appRef: string; workerRefs?: string[] | null; first?: number | null; after?: string | null },
) {
  // Live platform roles: a manager arm taken from an old credential would widen the worker set (Diego P2-1).
  const ctx = (await liveCaller(requestCtx)) ?? (() => { throw taskError('APP_NOT_FOUND', 'App not found.'); })();
  const { app, actor } = await resolveParticipatedApp(ctx, a.appRef);
  const reader = await readerFor(ctx, app, actor);
  let only: string[] | null = null;
  if (a.workerRefs && a.workerRefs.length > 0) {
    // A ref that does not resolve, or names a worker the caller may not read, is simply absent: no existence oracle.
    const resolved = await Promise.all(a.workerRefs.map((r) => resolveWorkerRef(ctx.db, r).then((x) => x.id, () => null)));
    only = resolved.filter((id): id is string => id !== null);
  }
  const result = await computeDueWakes({
    ctx, app, reader, requester: { userId: reader.userId }, workerIds: only, first: a.first, after: a.after,
  });
  if (result.budgetNotice) await postBudgetNotice(ctx, app, result.budgetNotice);

  const workerIds = [...new Set([...result.wakes.map((w) => w.workerId), ...result.dormant.map((d) => d.workerId)])];
  const workers = new Map((await ctx.db.worker.findMany({ where: { id: { in: workerIds } } })).map((w) => [w.id, w]));
  const channelIds = [...new Set(result.wakes.flatMap((w) => w.wake.channels.map((c) => c.channelId)))];
  const channels = new Map((await ctx.db.channel.findMany({ where: { id: { in: channelIds } } })).map((c) => [c.id, c]));
  const tickerIds = [...new Set(result.wakes.flatMap((w) => w.wake.reasons.flatMap((r) => (r.kind === 'TICK' ? [r.tickerId] : []))))];
  const tickers = new Map((await ctx.db.ticker.findMany({ where: { id: { in: tickerIds } } })).map((t) => [t.id, t]));

  return {
    status: result.status,
    withheld: result.withheld,
    wakes: result.wakes.map((w) => ({
      worker: workers.get(w.workerId)!,
      reasons: w.wake.reasons.map((r) => ({ kind: r.kind, ticker: r.kind === 'TICK' ? tickers.get(r.tickerId) ?? null : null })),
      channels: w.wake.channels.map((c) => ({
        channel: channels.get(c.channelId)!,
        fromSeq: c.fromSeq,
        throughSeq: c.throughSeq,
        latestMentionSeq: c.latestMentionSeq,
      })),
      unread: w.wake.unread,
      unreadMentions: w.wake.unreadMentions,
      availability: w.availability,
      proof: w.proof,
    })),
    dormant: result.dormant.map((d) => ({ worker: workers.get(d.workerId)!, mentions: d.mentions })),
    pageInfo: { hasNextPage: result.nextAfter !== null, endCursor: result.nextAfter },
  };
}

/** One notice per App per UTC day (cor:agt:080:15). Claimed atomically; best-effort, never fails the read. */
async function postBudgetNotice(ctx: Context, app: TaskApp, n: { appId: string; day: Date; withheld: number }): Promise<void> {
  try {
    const claimed = await ctx.db.$executeRaw(Prisma.sql`
      INSERT INTO app_wake_days (app_id, day, wakes, notice_posted_at) VALUES (${n.appId}, ${n.day.toISOString().slice(0, 10)}::date, 0, now() AT TIME ZONE 'utc')
      ON CONFLICT (app_id, day) DO UPDATE SET notice_posted_at = now() AT TIME ZONE 'utc'
      WHERE app_wake_days.notice_posted_at IS NULL`);
    if (claimed === 0) return;
    const { teamChatMutations } = await import('./resolvers.teamChat.js');
    await teamChatMutations.createTeamChatMessage(
      {},
      {
        appRef: app.id,
        body:
          `This App's daily wake budget is spent: ${n.withheld} wake${n.withheld === 1 ? ' is' : 's are'} waiting until tomorrow (UTC). ` +
          'Mentions by whoever manages the App still go through. Whoever manages the App can raise the budget.',
        replyToSeq: null,
        sessionRef: null,
      },
      ctx,
    );
  } catch (e) {
    // A failed post must not use up the day's one notice: hand the claim back so the next read tries again.
    await ctx.db.$executeRaw`UPDATE app_wake_days SET notice_posted_at = NULL WHERE app_id = ${n.appId} AND day = ${n.day.toISOString().slice(0, 10)}::date`.catch(() => undefined);
    console.warn('[tickers] wake-budget notice failed:', e instanceof Error ? e.message : e);
  }
}

export async function acknowledgeWakesFor(requestCtx: Context, a: { proofs: string[] }) {
  if (!requestCtx.userId || requestCtx.impersonation) throw new GraphQLError('Not authorized.', { extensions: { code: 'UNAUTHENTICATED' } });
  const userId = requestCtx.userId;
  // A worker's session may not acknowledge: that would let it silence the workers its holder holds (cor:agt:080:17).
  if (currentActor().workerId) {
    throw new GraphQLError('A worker cannot acknowledge wakes; the person behind it does, as themselves.', { extensions: { code: 'WAKE_ACK_FORBIDDEN' } });
  }
  return acknowledgeWakes({
    ctx: requestCtx,
    requester: { userId },
    proofs: a.proofs,
    // Decided INSIDE the acknowledgement's transaction, on `txCtx` (platform roles re-read under the authority anchors
    // of every App in the batch), with the holder's row and the caller's memberships held, so a release, a demotion,
    // an uninstall or an ownership change that commits first is seen and one that comes later waits.
    mayReadWorker: async (p: WakeProof, tx: Prisma.TransactionClient, txCtx: Context) => {
      const app = await loadApp(txCtx, p.appId);
      if (!app || app.deletedAt || app.uninstalledAt) return false;
      await tx.$queryRaw`SELECT 1 FROM app_members WHERE app_id = ${app.id} AND user_id = ${userId} FOR SHARE`;
      if (app.organizationId) await tx.$queryRaw`SELECT 1 FROM org_members WHERE organization_id = ${app.organizationId} AND user_id = ${userId} FOR SHARE`;
      const actor = await resolveTaskActor(txCtx, app);
      if (!actor || actor.kind === 'worker') return false;
      const rows = await tx.$queryRaw<Array<{ held_by_user_id: string | null }>>`SELECT held_by_user_id FROM workers WHERE id = ${p.workerId} FOR SHARE`;
      if (await actorManagesApp(txCtx, app, actor)) return true;
      return rows[0]?.held_by_user_id === userId;
    },
  });
}

export const wakeQueries = {
  dueWakes: (_: unknown, a: { appRef: string; workerRefs?: string[] | null; first?: number | null; after?: string | null }, ctx: Context) =>
    dueWakesFor(ctx, a),
};

export const wakeMutations = {
  acknowledgeWakes: (_: unknown, a: { proofs: string[] }, ctx: Context) => acknowledgeWakesFor(ctx, a),
};
