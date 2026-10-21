// S1 (#2017) — one host's batches, or a live session's own worker (cor:agt:080:22–:26, R57).
//
// WHO MAY READ: an App key that holds BOTH attention:deliver and a live host:operate scope bound to a host (the host id is
// the key's, never the request's), carries no session, and acts in its own App. A bare App-wide attention:deliver key keeps
// dueWakes and is refused here (cor:agt:080:22, R4). The decision is re-made inside the transaction that records the read,
// under the App's authority anchor held shared, so a revoked scope, key or registration refuses from its next call. Every
// host read writes a host-key use row (action 'deliver') in that same transaction. R57 self calls use the validated
// session's own worker, recheck ownership/liveness in the transaction, and record reads in app_log instead.
//
// The batch is DERIVED (src/lib/tickers/deliveryBatch.ts); its id is a signed proof (src/lib/tickers/batchProof.ts).

import type { Prisma } from '../../../generated/prisma/index.js';
import type { Context } from './resolvers.helpers.js';
import { withAuthorizedTx } from './authorizedTx.js';
import { mayStillDriveWorkerApp } from '../../../lib/teamAttention.js';
import { ownsSession, appPrincipalMayWriteSession } from '../../../lib/sessionOwnership.js';
import { isSessionLive, loadLastEventBySession } from '../../../lib/sessionActivity.js';
import { loadApp, taskError, type TaskApp } from './resolvers.agentTask.js';
import { currentActor } from '../../../lib/requestActor.js';
import { resolveAppRef } from '../../../lib/entityRef/appRef.js';
import { resolveWorkerRef } from '../../../lib/entityRef/workerRef.js';
import { appKeyCaller, refuseSessionBound, requireKeyScope } from '../../../lib/appKeyScopes/scopes.js';
import { lockAuthorityAnchors, type AuthorityAnchor } from '../../../lib/auth/authorityAnchors.js';
import { recordNoTeamChannelMiss, stampTeamChannelChecks } from '../../../lib/channelReadState.js';
import { keyHostId, recordHostKeyUse, recordHostKeyUseApart, type HostKey } from '../../../lib/hostOperations/hostKey.js';
import { liveCaller } from '../../../lib/tickers/liveCaller.js';
import { batchProofPayload, loadDeliveryBatches, loadDeliveryChannelPolicy } from '../../../lib/tickers/deliveryBatch.js';
import { signBatchProof, type BatchProof } from '../../../lib/tickers/wakeProof.js';
import { acknowledgeBatchProofs, type BatchAck } from '../../../lib/tickers/acknowledge.js';

const appAnchors = (app: TaskApp): AuthorityAnchor[] => [
  { kind: 'app', id: app.id },
  ...(app.organizationId ? [{ kind: 'org' as const, id: app.organizationId }] : []),
  ...(app.ownerUserId ? [{ kind: 'user' as const, id: app.ownerUserId }] : []),
];

const hostScopeRequired = () =>
  taskError('APP_KEY_SCOPE_REQUIRED', 'Delivery batches need an App key that holds attention:deliver and host:operate for one host.');

/** Refusals use an apart write, after the deciding transaction rolled back.
 * Both transports enter here once; adapters must not record another use.
 */
async function recordingBatchRefusal<T>(ctx: Context, call: () => Promise<T>): Promise<T> {
  try { return await call(); }
  catch (error) {
    const key = appKeyCaller(ctx);
    const code = (error as { extensions?: { code?: unknown } } | null)?.extensions?.code;
    if (key && typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(code)) {
      await recordHostKeyUseApart(ctx.db, key, 'deliver', { refusedCode: code });
    }
    throw error;
  }
}

/**
 * The gate outside any transaction, in the order that makes what a key learns independent of what it does not hold: a
 * key; the key's own App (a foreign one is "not found"); both scopes read now; no session; no worker identity. Returns the
 * key as its host and the re-check to run again inside the deciding transaction.
 */
export async function batchKeyEntry(ctx: Context, appRef: string): Promise<{ app: TaskApp; host: HostKey; authorize: (tx: Prisma.TransactionClient) => Promise<void> }> {
  const key = appKeyCaller(ctx);
  if (!key) throw taskError('HOST_KEY_REQUIRED', 'Delivery batches are read by a host, with its App key.');
  let app: TaskApp | null = null;
  try {
    const { id } = await resolveAppRef(ctx.db, appRef);
    app = id === key.appId ? await loadApp(ctx, id) : null;
  } catch {
    app = null;
  }
  if (!app || app.deletedAt || app.uninstalledAt) throw taskError('APP_NOT_FOUND', 'App not found.');
  await requireKeyScope(ctx.db, key, 'attention:deliver');
  const hostId = await keyHostId(ctx.db, key);
  if (!hostId) throw hostScopeRequired();
  refuseSessionBound(ctx);
  if (currentActor().workerId) throw taskError('APP_KEY_SESSION_BOUND', 'A host key does not act as a worker. Send no session.');
  const held = app;
  return {
    app: held,
    host: { ...key, hostId },
    authorize: async (tx) => {
      await lockAuthorityAnchors(tx, appAnchors(held), 'shared');
      await requireKeyScope(tx, key, 'attention:deliver');
      if ((await keyHostId(tx, key)) !== hostId) throw hostScopeRequired();
      // The registration this host still holds, read FOR SHARE so a loss that commits first is seen and one after waits.
      const reg = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM host_registrations WHERE app_id = ${held.id} AND host_id = ${hostId} AND lost_at IS NULL FOR SHARE`;
      if (reg.length === 0) throw hostScopeRequired();
    },
  };
}

/** R57: identity comes from the validated request binding, never a requested worker or an admin role. */
async function ownBatchSession(ctx: Context, expectedAppId?: string, lock = false) {
  if (!ctx.sessionId || ctx.sessionBindingRefused || ctx.impersonation) throw taskError('SESSION_NOT_FOUND', 'Session not found.');
  const initial = await ctx.db.session.findUnique({ where: { id: ctx.sessionId } });
  if (!initial || initial.deletedAt || !ownsSession(ctx, initial)) throw taskError('SESSION_NOT_FOUND', 'Session not found.');
  if (expectedAppId && initial.appId !== expectedAppId) throw taskError('APP_NOT_FOUND', 'App not found.');
  if (lock) {
    if (ctx.userId && initial.appId) await ctx.db.$queryRaw`SELECT user_id FROM app_members WHERE app_id = ${initial.appId} AND user_id = ${ctx.userId} FOR SHARE`;
    // Existing session protocol: authority/App, then Worker, then Session. End/rebind that wins is re-read below.
    if (initial.workerId) await ctx.db.$queryRaw`SELECT id FROM workers WHERE id = ${initial.workerId} FOR SHARE`;
    await ctx.db.$queryRaw`SELECT id FROM sessions WHERE id = ${initial.id} FOR SHARE`;
  }
  const session = await ctx.db.session.findUnique({ where: { id: initial.id } });
  if (!session || session.deletedAt || !ownsSession(ctx, session)) throw taskError('SESSION_NOT_FOUND', 'Session not found.');
  if (session.appId !== initial.appId || session.workerId !== initial.workerId) throw taskError('SESSION_NOT_LIVE', 'Session binding changed.');
  if (!ctx.userId) {
    const key = ctx.appKeyId ? await ctx.db.appKey.findUnique({ where: { id: ctx.appKeyId } }) : null;
    if (!key || key.revokedAt || key.appId !== session.appId || !(await appPrincipalMayWriteSession(ctx.db, ctx, session))) {
      throw taskError('SESSION_NOT_FOUND', 'Session not found.');
    }
  }
  const events = await loadLastEventBySession(ctx.db as never, [session.id]);
  if (!isSessionLive(session, events.get(session.id), new Date())) throw taskError('SESSION_NOT_LIVE', 'Session is not live.');
  const worker = session.workerId ? await ctx.db.worker.findUnique({ where: { id: session.workerId } }) : null;
  if (!worker || worker.retiredAt || worker.appId !== session.appId) throw taskError('WORKER_NOT_FOUND', 'Worker not found.');
  if (!(await mayStillDriveWorkerApp(ctx, worker.appId))) throw taskError('APP_NOT_FOUND', 'App not found.');
  return { session, worker };
}

async function selfBatches(ctx: Context, a: { appRef: string; workerRefs?: string[] | null }) {
  const initial = await ownBatchSession(ctx);
  let appId: string;
  try { appId = (await resolveAppRef(ctx.db, a.appRef)).id; } catch { throw taskError('APP_NOT_FOUND', 'App not found.'); }
  if (appId !== initial.session.appId) throw taskError('APP_NOT_FOUND', 'App not found.');
  const app = await loadApp(ctx, appId);
  if (!app || app.deletedAt || app.uninstalledAt) throw taskError('APP_NOT_FOUND', 'App not found.');
  if (a.workerRefs?.length) {
    for (const ref of a.workerRefs) {
      const id = await resolveWorkerRef(ctx.db, ref).then(r => r.id, () => null);
      if (id !== initial.worker.id) throw taskError('WORKER_NOT_FOUND', 'Worker not found.');
    }
  }
  let noTeamStamp: string | null = null;
  const result = await withAuthorizedTx(ctx, appAnchors(app), async () => undefined, async (tx, txCtx) => {
    const { session, worker } = await ownBatchSession(txCtx, app.id, true);
    if (worker.id !== initial.worker.id) throw taskError('WORKER_NOT_FOUND', 'Worker not found.');
    const now = new Date();
    const page = await loadDeliveryBatches({ ctx: txCtx, app, hostId: null, workerIds: [worker.id], now });
    // Re-check the clock after loading too: a long read must not return after its promised expiry.
    await ownBatchSession(txCtx, app.id);
    // #2138 §3.1: the inbox read through the worker's own session is a check of its App's team channel, empty or not.
    // A miss is logged AFTER this transaction, best-effort: a failed diagnostic write must never abort a valid read.
    if ((await stampTeamChannelChecks(tx, worker.id)) === 0) noTeamStamp = session.id;
    await tx.appLogEntry.create({ data: { appId: app.id, sessionId: session.id, level: 'INFO', message: 'delivery.batch.read', detail: { workerId: worker.id, count: page.batches.length } } });
    const channels = new Map((await tx.channel.findMany({ where: { id: { in: page.batches.flatMap(b => b.ranges.map(r => r.channelId)) } } })).map(c => [c.id, c]));
    return {
      batches: page.batches.map(b => ({
        id: signBatchProof({ v: 1, kind: 'batch-proof', appId: app.id, workerId: worker.id, hostId: null, requester: { sessionId: session.id },
          channels: b.ranges.map(r => ({ channelId: r.channelId, incarnation: r.incarnation, from: r.fromSeq, through: r.throughSeq, seqs: r.seqs })),
          renderHash: b.renderHash, batchKey: b.batchKey, issuedAt: now.getTime() }),
        worker, text: b.text, deliverAfter: b.deliverAfter, busyDeadline: b.busyDeadline, interrupt: b.interrupt,
        ranges: b.ranges.map(r => ({ channel: channels.get(r.channelId)!, incarnation: r.incarnation, fromSeq: r.fromSeq, throughSeq: r.throughSeq, seqs: r.seqs })), overflow: b.overflow,
      })), pageInfo: { hasNextPage: false, endCursor: null },
    };
  });
  if (noTeamStamp) await recordNoTeamChannelMiss(ctx.db, { appId: app.id, sessionId: noTeamStamp });
  return result;
}

export const deliveryBatchQueries = {
  deliveryBatches: async (
    _: unknown,
    a: { appRef: string; workerRefs?: string[] | null; first?: number | null; after?: string | null },
    requestCtx: Context,
  ) => recordingBatchRefusal(requestCtx, async () => {
    const ctx = (await liveCaller(requestCtx)) ?? (() => { throw taskError('APP_NOT_FOUND', 'App not found.'); })();
    if (ctx.sessionBindingRefused && !appKeyCaller(ctx)) throw taskError('SESSION_NOT_LIVE', 'The named session is not live or cannot bind.');
    if (ctx.sessionId && (!appKeyCaller(ctx) || !(await keyHostId(ctx.db, appKeyCaller(ctx)!)))) return selfBatches(ctx, a);
    const { app, host, authorize } = await batchKeyEntry(ctx, a.appRef);
    let only: string[] | null = null;
    if (a.workerRefs && a.workerRefs.length > 0) {
      // A ref that does not resolve, or names a worker not on this host, is simply absent: no existence oracle.
      const resolved = await Promise.all(a.workerRefs.map((r) => resolveWorkerRef(ctx.db, r).then((x) => x.id, () => null)));
      only = resolved.filter((id): id is string => id !== null);
    }
    // Select workers, channel policy, rendered text and audit under the deciding
    // authority protocol, using its cache-free transaction context throughout.
    return withAuthorizedTx(ctx, appAnchors(app), async txCtx => authorize(txCtx.db), async (tx, txCtx) => {
      const now = new Date();
      const currentApp = await loadApp(txCtx, app.id);
      if (!currentApp || currentApp.deletedAt || currentApp.uninstalledAt) throw taskError('APP_NOT_FOUND', 'App not found.');
      const page = await loadDeliveryBatches({ ctx: txCtx, app: currentApp, hostId: host.hostId, now, workerIds: only, first: a.first, after: a.after });
      await recordHostKeyUse(tx, host, 'deliver', { count: page.batches.length });
      const workers = new Map((await tx.worker.findMany({ where: { id: { in: page.batches.map((b) => b.workerId) } } })).map((w) => [w.id, w]));
      const channelIds = [...new Set(page.batches.flatMap((b) => b.ranges.map((r) => r.channelId)))];
      const channels = new Map((await tx.channel.findMany({ where: { id: { in: channelIds } } })).map((c) => [c.id, c]));
      return {
        batches: page.batches.map((b) => ({
          id: signBatchProof(batchProofPayload(b, { appId: app.id, hostId: host.hostId, appKeyId: host.appKeyId, now })),
          worker: workers.get(b.workerId)!,
          text: b.text,
          deliverAfter: b.deliverAfter,
          busyDeadline: b.busyDeadline,
          interrupt: b.interrupt,
          ranges: b.ranges.map((r) => ({ channel: channels.get(r.channelId)!, incarnation: r.incarnation, fromSeq: r.fromSeq, throughSeq: r.throughSeq, seqs: r.seqs })),
          overflow: b.overflow,
        })),
        pageInfo: { hasNextPage: page.nextAfter !== null, endCursor: page.nextAfter },
      };
    });
  }),
};

async function currentBatchChannels(
  ctx: Context, app: TaskApp, worker: { id: string; heldByUserId: string | null }, proof: BatchProof,
): Promise<boolean> {
  const channels = new Set((await loadDeliveryChannelPolicy(ctx, app, worker)).map(c => c.id));
  return proof.channels.every(c => channels.has(c.channelId));
}

/**
 * Acknowledge typed batches (cor:agt:080:16/:17). Only the key the id names, with the authority re-derived INSIDE the
 * transaction (after the worker's wake lock) under the App's anchor: both scopes held now, the key still the same host,
 * the host's registration live, and the worker still one of its registered workers. Records the use like a read does.
 * `through` (one batch only) acknowledges a prefix: only the listed channels move, each to its listed rendered seq.
 */
export const deliveryBatchMutations = {
  acknowledgeDeliveryBatches: async (
    _: unknown,
    a: { batchIds: string[]; through?: Array<{ channelId: string; seq: number }> | null },
    requestCtx: Context,
  ) => recordingBatchRefusal(requestCtx, async () => {
    const key = appKeyCaller(requestCtx);
    if (requestCtx.sessionBindingRefused && !key) throw taskError('SESSION_NOT_LIVE', 'The named session is not live or cannot bind.');
    if (requestCtx.sessionId && (!key || !(await keyHostId(requestCtx.db, key)))) {
      const ctx = await liveCaller(requestCtx);
      if (!ctx) throw taskError('SESSION_NOT_FOUND', 'Session not found.');
      const own = await ownBatchSession(ctx);
      if (a.through?.length && a.batchIds.length !== 1) throw taskError('BAD_USER_INPUT', 'through applies to exactly one batch.');
      return acknowledgeBatchProofs({ ctx, requester: { sessionId: own.session.id },
        acks: a.batchIds.map(proof => ({ proof, ...(a.through?.length ? { through: a.through } : {}) })),
        mayAckBatch: async (p, tx, txCtx) => {
          if (p.appId !== own.session.appId || p.workerId !== own.worker.id || p.hostId !== null) return false;
          try {
            const live = await ownBatchSession(txCtx, p.appId, true);
            if (live.session.id !== own.session.id || live.worker.id !== p.workerId) return false;
            const app = await loadApp(txCtx, p.appId);
            if (!app || app.deletedAt || app.uninstalledAt) return false;
            return await currentBatchChannels(txCtx, app, live.worker, p);
          } catch { return false; }
        },
      });
    }
    if (!key) throw taskError('HOST_KEY_REQUIRED', 'Delivery batches are acknowledged by a host, with its App key.');
    if (a.through && a.through.length > 0 && a.batchIds.length !== 1) {
      throw taskError('BAD_USER_INPUT', 'through applies to exactly one batch; acknowledge a partial batch on its own.');
    }
    await requireKeyScope(requestCtx.db, key, 'attention:deliver');
    refuseSessionBound(requestCtx);
    if (currentActor().workerId) throw taskError('APP_KEY_SESSION_BOUND', 'A host key does not act as a worker. Send no session.');
    // Match the self arm's accepted no-op, but every host call still owes a
    // use record. No proof callback runs for [], so authorize and record here.
    if (a.batchIds.length === 0) {
      const { app, host, authorize } = await batchKeyEntry(requestCtx, key.appId);
      return withAuthorizedTx(requestCtx, appAnchors(app), txCtx => authorize(txCtx.db), async tx => {
        await recordHostKeyUse(tx, host, 'deliver', { count: 0 });
        return { acknowledged: 0, unchanged: 0 };
      });
    }
    const acks: BatchAck[] = a.batchIds.map((proof) => ({ proof, ...(a.through && a.through.length > 0 ? { through: a.through } : {}) }));
    return acknowledgeBatchProofs({
      ctx: requestCtx,
      requester: { appKeyId: key.appKeyId },
      acks,
      mayAckBatch: async (p: BatchProof, tx: Prisma.TransactionClient, txCtx: Context) => {
        if (p.appId !== key.appId) return false;
        // A self proof (hostId null) is never a host key's to acknowledge (R57).
        if (p.hostId === null) return false;
        const app = await loadApp(txCtx, p.appId);
        if (!app || app.deletedAt || app.uninstalledAt) return false;
        await lockAuthorityAnchors(tx, appAnchors(app), 'shared');
        try {
          await requireKeyScope(tx, key, 'attention:deliver');
        } catch {
          return false;
        }
        if ((await keyHostId(tx, key)) !== p.hostId) return false;
        const rows = await tx.$queryRaw<Array<{ ok: number }>>`
          SELECT 1 AS ok
          FROM host_registrations r
          JOIN host_registration_workers rw ON rw.registration_id = r.id
          JOIN workers w ON w.id = rw.worker_id
          WHERE r.app_id = ${p.appId} AND r.host_id = ${p.hostId} AND r.lost_at IS NULL
            AND rw.worker_id = ${p.workerId} AND w.retired_at IS NULL
          FOR SHARE OF r`;
        if (rows.length === 0) return false;
        const worker = await tx.worker.findUnique({ where: { id: p.workerId } });
        if (!worker || !(await currentBatchChannels(txCtx, app, worker, p))) return false;
        await recordHostKeyUse(tx, { appKeyId: key.appKeyId, appId: key.appId, hostId: p.hostId }, 'deliver', { count: p.channels.reduce((n, c) => n + c.seqs.length, 0) });
        return true;
      },
    });
  }),
};
