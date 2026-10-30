// Due wakes and acknowledgement — #1748 (Tickers S2, epic #1659; plan hrn:node:hadronmemory.com:hadron-server:design:named-heartbeats §6.1).
//
// WHO MAY READ (cor:agt:080:22): the worker's holder, whoever manages the App,
// and (#1749, S3) an App key holding the attention:deliver scope. Under
// impersonation nobody holds or manages anything. A holder reads the workers
// they hold; a manager reads every worker of the App; a scoped key reads the
// workers of its own App through current host-registration scope: its own host
// only, or workers registered on no host for a non-host key. Former-host keys
// fail closed. This is App-derived reach (never personal memory), with session-bound keys refused. Which channels a wake shows
// is the two-reader gate in src/lib/tickers/dueWakes.ts.
//
// ACKNOWLEDGING (cor:agt:080:17): only the requester named in the proof; the
// reading right is re-checked at acknowledgement.

import { GraphQLError } from 'graphql';
import { Prisma } from '../../../generated/prisma/index.js';
import type { Context } from './resolvers.helpers.js';
import { actorManagesApp, loadApp, resolveParticipatedApp, resolveTaskActor, taskError, type TaskApp } from './resolvers.agentTask.js';
import { currentActor } from '../../../lib/requestActor.js';
import { resolveAppRef } from '../../../lib/entityRef/appRef.js';
import { resolveWorkerRef } from '../../../lib/entityRef/workerRef.js';
import { computeDueWakes } from '../../../lib/tickers/dueWakes.js';
import { acknowledgeWakes } from '../../../lib/tickers/acknowledge.js';
import type { WakeProof } from '../../../lib/tickers/wakeProof.js';
import { liveCaller } from '../../../lib/tickers/liveCaller.js';
import { appKeyCaller, refuseSessionBound, requireKeyScope } from '../../../lib/appKeyScopes/scopes.js';
import { lockAuthorityAnchors, type AuthorityAnchor } from '../../../lib/auth/authorityAnchors.js';
import { legacyWakeKeyScope, authorizeLegacyWakeWorkers } from '../../../lib/tickers/wakeKeyScope.js';
import { generateId } from '../../../lib/id.js';
import { recordStopConsumerDeclaration, UNHOSTED_LANE } from '../../../lib/stopSignals/delivery.js';

type Reader = { manager: boolean; userId: string | null };

/** `TASK:<id>:<event>`, the event lower-kebab: `TASK:t1:assigned`, `TASK:t1:child-finished`. */
export const taskReasonRef = (taskId: string, event: string): string => `TASK:${taskId}:${event.toLowerCase().replace(/_/g, '-')}`;

async function readerFor(ctx: Context, app: TaskApp, actor: Awaited<ReturnType<typeof resolveParticipatedApp>>['actor']): Promise<Reader> {
  // Concealed like any App the caller cannot reach: no oracle, and no key or impersonated session reads wakes here.
  // Nor does a worker's session: it is the worker, not the person behind it, and a holder's reading right is theirs
  // as a person (cor:agt:080:22). A worker that could read its holder's other workers could also silence them.
  if (!ctx.userId || ctx.impersonation || actor.kind === 'worker') throw taskError('APP_NOT_FOUND', 'App not found.');
  return { manager: await actorManagesApp(ctx, app, actor), userId: ctx.userId };
}

/** The anchors every authority-revoking writer of an App takes exclusively (a scope, a key, the App itself). */
const appAnchors = (app: TaskApp): AuthorityAnchor[] => [
  { kind: 'app', id: app.id },
  ...(app.organizationId ? [{ kind: 'org' as const, id: app.organizationId }] : []),
  ...(app.ownerUserId ? [{ kind: 'user' as const, id: app.ownerUserId }] : []),
];

/** The last gate of an App key's read: scope held now, under the shared anchor; records the read in the same transaction. */
async function decideKeyAnswer(ctx: Context, app: TaskApp, key: { appKeyId: string; appId: string }, workerCount: number, authorize: (tx: Prisma.TransactionClient) => Promise<void>): Promise<void> {
  await ctx.db.$transaction(async (tx) => {
    await lockAuthorityAnchors(tx, appAnchors(app), 'shared');
    await authorize(tx);
    await tx.appKeyWakeRead.create({ data: { id: generateId(), appKeyId: key.appKeyId, appId: app.id, workerCount } });
  });
}

/**
 * An App key at a wake surface (#1749, cor:aut:010:04). In this order, so that what a key learns never depends on
 * something it does not hold: its own App only (a foreign App is "not found"), the scope read from the database now,
 * then the session refusal. Returns the App and the check to run again inside the issuing transaction, where the
 * App's authority anchor is held shared: the revoker of the scope, the key or the App takes it exclusively.
 */
async function keyEntry(ctx: Context, key: { appKeyId: string; appId: string }, appRef: string) {
  let app: TaskApp | null = null;
  try {
    const { id } = await resolveAppRef(ctx.db, appRef);
    app = id === key.appId ? await loadApp(ctx, id) : null;
  } catch {
    app = null;
  }
  if (!app || app.deletedAt || app.uninstalledAt) throw taskError('APP_NOT_FOUND', 'App not found.');
  await requireKeyScope(ctx.db, key, 'attention:deliver');
  refuseSessionBound(ctx);
  const scope = await legacyWakeKeyScope(ctx.db, key);
  const held = app;
  return {
    app: held,
    hostId: scope.hostId,
    workerWhere: scope.where,
    authorize: async (tx: Prisma.TransactionClient, workerIds: string[]) => {
      await lockAuthorityAnchors(tx, appAnchors(held), 'shared');
      if (!(await authorizeLegacyWakeWorkers(tx, key, scope.hostId, workerIds))) {
        throw taskError('WORKER_NOT_FOUND', 'Worker not found. Read the due wakes again.');
      }
    },
  };
}

/** #2169: whether a call's `accepts` lists STOP. An unknown kind is refused by the SDL enum, so only the list is read here. */
const acceptsStop = (accepts: readonly string[] | null | undefined): boolean => !!accepts && accepts.includes('STOP');

export async function dueWakesFor(
  requestCtx: Context,
  a: { appRef: string; workerRefs?: string[] | null; first?: number | null; after?: string | null; accepts?: string[] | null },
) {
  const key = appKeyCaller(requestCtx);
  // Live platform roles: a manager arm taken from an old credential would widen the worker set (Diego P2-1).
  const ctx = (await liveCaller(requestCtx)) ?? (() => { throw taskError('APP_NOT_FOUND', 'App not found.'); })();
  let app: TaskApp;
  let reader: Reader;
  let authorize: ((tx: Prisma.TransactionClient, workerIds: string[]) => Promise<void>) | undefined;
  let workerWhere: Prisma.WorkerWhereInput | undefined;
  let selectedWorkerIds: string[] = [];
  let keyHostId: string | null = null;
  if (key) {
    ({ app, authorize, workerWhere, hostId: keyHostId } = await keyEntry(ctx, key, a.appRef));
    reader = { manager: true, userId: null };
  } else {
    const resolved = await resolveParticipatedApp(ctx, a.appRef);
    app = resolved.app;
    reader = await readerFor(ctx, app, resolved.actor);
  }
  let only: string[] | null = null;
  if (a.workerRefs && a.workerRefs.length > 0) {
    // A ref that does not resolve, or names a worker the caller may not read, is simply absent: no existence oracle.
    const resolved = await Promise.all(a.workerRefs.map((r) => resolveWorkerRef(ctx.db, r).then((x) => x.id, () => null)));
    only = resolved.filter((id): id is string => id !== null);
  }
  const result = await computeDueWakes({
    ctx, app, reader, requester: key ? { appKeyId: key.appKeyId } : { userId: reader.userId! },
    workerIds: only, first: a.first, after: a.after, authorize, workerWhere, acceptsStop: acceptsStop(a.accepts),
    onWorkersSelected: ids => { selectedWorkerIds = ids; },
  });

  const workerIds = [...new Set([...result.wakes.map((w) => w.workerId), ...result.dormant.map((d) => d.workerId)])];
  // An App key's answer is decided under the App's authority anchor on EVERY path, not only when a wake is issued:
  // dormant-only, nothing-due and empty pages carry worker names, mention counts and cursors too (N4, Diego, Riana).
  // The same transaction writes the audit row (key, App, workers shown, time), so a read is recorded exactly when it
  // is allowed to be returned (cor:agt:080:23).
  if (key) await decideKeyAnswer(ctx, app, key, workerIds.length, tx => authorize!(tx, selectedWorkerIds));
  // #2169 (R95): a call that takes stop notices declares the lane it serves, once its own answer is authorized. Written
  // whether or not anything is due, because an idle consumer is still a serving one.
  // Only a call that read the lane from its start to its end: no workerRefs, no `after` (a tail page skipped the prefix) and no
  // next page (#2432 BLIND, LOCAL). A lane larger than one page (max 200) cannot declare; the consumer asks for `first: 200`.
  const wholeLane = !(a.workerRefs && a.workerRefs.length > 0) && !a.after && result.nextAfter === null;
  if (acceptsStop(a.accepts) && wholeLane) await declareStopLane(ctx, app, key ? { hostId: keyHostId } : reader.manager ? { hostId: null } : null);
  // The budget notice is posted by the platform itself, once a day per App, whoever's read triggered it: a person's or an
  // App key's (#1791, cor:agt:080:15). Posted only once an App key's answer is decided: a read that is refused posts nothing (Rook #1799).
  if (result.budgetNotice) await postBudgetNotice(ctx, app, result.budgetNotice);
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
      reasons: w.wake.reasons.map((r) => ({
        kind: r.kind,
        ticker: r.kind === 'TICK' ? tickers.get(r.tickerId) ?? null : null,
        // #2790: a TICK reason's own oldest unacknowledged tick, worked out in this read; null for every other kind.
        tickDueAt: r.kind === 'TICK' ? w.tickDueAt.get(r.tickerId) ?? null : null,
        // #1708: the task is gated in computeDueWakes (a reader of the App's tasks only), so it is shown as is.
        task: r.kind === 'TASK'
          ? { id: r.taskId, eventId: r.eventId, chainIndex: r.chainIndex, event: r.event, title: r.title, handle: r.handle, ref: taskReasonRef(r.taskId, r.event), ...(r.standbyHeld ? { standbyHeld: r.standbyHeld } : {}) }
          : null,
        // #2022: a stop notice concerns the worker itself; whoever may read its wakes sees it.
        ...(r.kind === 'STOP'
          ? { stop: { eventId: r.eventId, signalId: r.signalId, level: STOP_LEVEL_ENUM[r.level], notice: r.notice.toUpperCase(), interrupt: r.interrupt } }
          : {}),
      })),
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
      anchorAt: w.timing.anchorAt,
      deliverAfter: w.timing.deliverAfter,
      busyDeadline: w.timing.busyDeadline,
    })),
    dormant: result.dormant.map((d) => ({ worker: workers.get(d.workerId)!, mentions: d.mentions })),
    pageInfo: { hasNextPage: result.nextAfter !== null, endCursor: result.nextAfter },
  };
}

/**
 * #2169: the lane a declaring call serves. A host key serves its own live registration; a non-host key and a person who
 * manages the App (who reads every worker) serve `unhosted`. A person who only holds some workers declares nothing: their
 * partial view is not a lane, and a declaration from them would open the set guard for workers they cannot reach.
 */
async function declareStopLane(ctx: Context, app: TaskApp, serves: { hostId: string | null } | null): Promise<void> {
  if (!serves) return;
  let lane: string = UNHOSTED_LANE;
  if (serves.hostId) {
    const reg = await ctx.db.hostRegistration.findFirst({ where: { appId: app.id, hostId: serves.hostId, lostAt: null }, select: { id: true } });
    if (!reg) return;
    lane = reg.id;
  }
  await recordStopConsumerDeclaration(ctx.db, app.id, lane, new Date());
}

/**
 * One notice per App per UTC day (cor:agt:080:15), posted AS THE PLATFORM (#1791): a system author, so the reader's own
 * rights (a key cannot post in chat) decide nothing. Best-effort, never fails the read. The day's claim is taken INSIDE the
 * notice's own append transaction, so the claim and the message commit together or not at all: an App with no live team
 * chat takes no claim, a failed post leaves none, and a process exit between the two cannot use up the day's notice.
 */
async function postBudgetNotice(ctx: Context, app: TaskApp, n: { appId: string; day: Date; withheld: number }): Promise<void> {
  const dayLit = n.day.toISOString().slice(0, 10);
  try {
    // Already posted today: the common case on a spent App, answered by one cheap read. The claim below is still the gate.
    const today = await ctx.db.appWakeDay.findFirst({ where: { appId: n.appId, day: n.day }, select: { noticePostedAt: true } });
    if (today?.noticePostedAt) return;
    // Lazy: resolvers.teamChat imports a long chain of resolvers.
    const { postSystemNotice } = await import('./resolvers.teamChat.js');
    await postSystemNotice(
      ctx.db,
      app.id,
      `This App's daily wake budget is spent: ${n.withheld} wake${n.withheld === 1 ? ' is' : 's are'} waiting until tomorrow (UTC). ` +
        'Mentions by whoever manages the App still go through. Whoever manages the App can raise the budget.',
      async (tx) =>
        (await tx.$executeRaw(Prisma.sql`
          INSERT INTO app_wake_days (app_id, day, wakes, notice_posted_at) VALUES (${n.appId}, ${dayLit}::date, 0, now() AT TIME ZONE 'utc')
          ON CONFLICT (app_id, day) DO UPDATE SET notice_posted_at = now() AT TIME ZONE 'utc'
          WHERE app_wake_days.notice_posted_at IS NULL`)) > 0,
    );
  } catch (e) {
    console.warn('[tickers] wake-budget notice failed:', e instanceof Error ? e.message : e);
  }
}

export async function acknowledgeWakesFor(requestCtx: Context, a: { proofs: string[] }) {
  const key = appKeyCaller(requestCtx);
  if (key) return acknowledgeAsKey(requestCtx, key, a.proofs);
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

/**
 * An App key acknowledging (#1749). The same order as the read: scope from the database, then the session refusal,
 * and in the transaction, with the App's anchor held, the scope again, the proof's App being the key's own, and the
 * worker being one of it. The proof names the key; another key of the App, or a person, is the wrong requester.
 */
async function acknowledgeAsKey(requestCtx: Context, key: { appKeyId: string; appId: string }, proofs: string[]) {
  await requireKeyScope(requestCtx.db, key, 'attention:deliver');
  refuseSessionBound(requestCtx);
  const scope = await legacyWakeKeyScope(requestCtx.db, key);
  return acknowledgeWakes({
    ctx: requestCtx,
    requester: { appKeyId: key.appKeyId },
    proofs,
    prepareWorkers: async (tx, batch) => {
      if (batch.some(p => p.appId !== key.appId) || !(await authorizeLegacyWakeWorkers(tx, key, scope.hostId, batch.map(p => p.workerId)))) {
        throw taskError('WAKE_PROOF_REQUESTER_MISMATCH', 'This wake proof was issued to someone else.');
      }
    },
    mayReadWorker: async (p: WakeProof, tx: Prisma.TransactionClient) => {
      if (p.appId !== key.appId) return false;
      return authorizeLegacyWakeWorkers(tx, key, scope.hostId, [p.workerId]);
    },
  });
}

/** #2022 — a stop level as its SDL enum value. */
const STOP_LEVEL_ENUM = { 'pause-dispatch': 'PAUSE_DISPATCH', pause: 'PAUSE', halt: 'HALT' } as const;

export const wakeQueries = {
  dueWakes: (_: unknown, a: { appRef: string; workerRefs?: string[] | null; first?: number | null; after?: string | null; accepts?: string[] | null }, ctx: Context) =>
    dueWakesFor(ctx, a),
};

export const wakeMutations = {
  acknowledgeWakes: (_: unknown, a: { proofs: string[] }, ctx: Context) => acknowledgeWakesFor(ctx, a),
};
