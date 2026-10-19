// S1 (#2017) — ready-to-deliver batches for the workers of ONE host (cor:agt:080:22–:26).
//
// WHO MAY READ: an App key that holds BOTH attention:deliver and a live host:operate scope bound to a host (the host id is
// the key's, never the request's), carries no session, and acts in its own App. A bare App-wide attention:deliver key keeps
// dueWakes and is refused here (cor:agt:080:22, R4). The decision is re-made inside the transaction that records the read,
// under the App's authority anchor held shared, so a revoked scope, key or registration refuses from its next call. Every
// read writes a host-key use row (action 'deliver') in that same transaction.
//
// The batch is DERIVED (src/lib/tickers/deliveryBatch.ts); its id is a signed proof (src/lib/tickers/batchProof.ts).

import type { Prisma } from '../../../generated/prisma/index.js';
import type { Context } from './resolvers.helpers.js';
import { loadApp, taskError, type TaskApp } from './resolvers.agentTask.js';
import { currentActor } from '../../../lib/requestActor.js';
import { resolveAppRef } from '../../../lib/entityRef/appRef.js';
import { resolveWorkerRef } from '../../../lib/entityRef/workerRef.js';
import { appKeyCaller, refuseSessionBound, requireKeyScope } from '../../../lib/appKeyScopes/scopes.js';
import { lockAuthorityAnchors, type AuthorityAnchor } from '../../../lib/auth/authorityAnchors.js';
import { keyHostId, recordHostKeyUse, type HostKey } from '../../../lib/hostOperations/hostKey.js';
import { liveCaller } from '../../../lib/tickers/liveCaller.js';
import { batchProofPayload, loadDeliveryBatches } from '../../../lib/tickers/deliveryBatch.js';
import { signBatchProof } from '../../../lib/tickers/wakeProof.js';

const appAnchors = (app: TaskApp): AuthorityAnchor[] => [
  { kind: 'app', id: app.id },
  ...(app.organizationId ? [{ kind: 'org' as const, id: app.organizationId }] : []),
  ...(app.ownerUserId ? [{ kind: 'user' as const, id: app.ownerUserId }] : []),
];

const hostScopeRequired = () =>
  taskError('APP_KEY_SCOPE_REQUIRED', 'Delivery batches need an App key that holds attention:deliver and host:operate for one host.');

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

export const deliveryBatchQueries = {
  deliveryBatches: async (
    _: unknown,
    a: { appRef: string; workerRefs?: string[] | null; first?: number | null; after?: string | null },
    requestCtx: Context,
  ) => {
    const ctx = (await liveCaller(requestCtx)) ?? (() => { throw taskError('APP_NOT_FOUND', 'App not found.'); })();
    const { app, host, authorize } = await batchKeyEntry(ctx, a.appRef);
    let only: string[] | null = null;
    if (a.workerRefs && a.workerRefs.length > 0) {
      // A ref that does not resolve, or names a worker not on this host, is simply absent: no existence oracle.
      const resolved = await Promise.all(a.workerRefs.map((r) => resolveWorkerRef(ctx.db, r).then((x) => x.id, () => null)));
      only = resolved.filter((id): id is string => id !== null);
    }
    const now = new Date();
    const page = await loadDeliveryBatches({ ctx, app, hostId: host.hostId, now, workerIds: only, first: a.first, after: a.after });
    // The answer is decided under the App's anchor on EVERY path (an empty page still carries cursors), and the read is
    // recorded in the same transaction, so it is recorded exactly when it is allowed to be returned.
    await ctx.db.$transaction(async (tx) => {
      await authorize(tx);
      await recordHostKeyUse(tx, host, 'deliver', { count: page.batches.length });
    });
    const workers = new Map((await ctx.db.worker.findMany({ where: { id: { in: page.batches.map((b) => b.workerId) } } })).map((w) => [w.id, w]));
    const channelIds = [...new Set(page.batches.flatMap((b) => b.ranges.map((r) => r.channelId)))];
    const channels = new Map((await ctx.db.channel.findMany({ where: { id: { in: channelIds } } })).map((c) => [c.id, c]));
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
  },
};
