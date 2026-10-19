/** #2021 / cor:agt:050:26 — S1 metadata becomes a complete S5 pending set, never a rendered batch. */
import type { Prisma } from '../../generated/prisma/index.js';
import { withoutRequestCaches, type Context } from '../../api/graphql/schema/resolvers.helpers.js';
import { loadDeliveryEligibility } from './deliveryBatch.js';
import { enumeratePendingDelivery, type PendingDeliveryArgs } from './pendingDelivery.js';
import { deliveryHealthSnapshot, type CompletePendingDeliverySnapshot } from './deliveryHealthRead.js';
import type { DeliveryMessage } from './deliveryWait.js';

export type PendingSnapshotArgs = {
  ctx: Context; app: PendingDeliveryArgs['app']; hostId: string | null;
  workerId: string; asOf: Date; first?: number;
};
const incomplete = (): never => { throw new Error('DELIVERY_PENDING_INCOMPLETE'); };

/**
 * Internal read seam AFTER the caller's existing App and S1 host/self authority gates.
 * The caller owns a REPEATABLE READ / SERIALIZABLE transaction and must consume the
 * projection in that same snapshot; this helper opens no transaction or public gate.
 * Start at the first page and exhaust it at one fixed asOf. Drop request caches and
 * bind every eligibility read to tx. Incomplete history remains unavailable, including
 * failed later pages; timing/overflow never removes messages or certifies policy time.
 */
export async function loadPendingDeliverySnapshot(tx: Prisma.TransactionClient, args: PendingSnapshotArgs): Promise<CompletePendingDeliverySnapshot> {
  if (typeof (tx as unknown as { $transaction?: unknown }).$transaction === 'function') throw new Error('DELIVERY_SNAPSHOT_REQUIRED');
  const [isolation] = await tx.$queryRaw<Array<{ isolation: string }>>`SELECT current_setting('transaction_isolation') AS isolation`;
  if (!isolation || !['repeatable read', 'serializable'].includes(isolation.isolation)) throw new Error('DELIVERY_SNAPSHOT_REQUIRED');
  if (!args.workerId || !(args.asOf instanceof Date) || !Number.isFinite(args.asOf.getTime())) incomplete();
  // Copy the time once; later caller mutation cannot change the pages' scope.
  const asOf = new Date(args.asOf.getTime());
  const ctx = withoutRequestCaches(args.ctx, tx);
  const messages: DeliveryMessage[] = [];
  const identities = new Set<string>();
  const cursors = new Set<string>();
  let after: string | null = null;
  do {
    const page = await enumeratePendingDelivery({ ctx, app: args.app, hostId: args.hostId,
      workerIds: [args.workerId], now: asOf, first: args.first, after });
    if (!Array.isArray(page.items) || typeof page.complete !== 'boolean' ||
        (page.complete ? page.nextAfter !== null : typeof page.nextAfter !== 'string' || !page.nextAfter || !page.items.length)) incomplete();
    for (const item of page.items) {
      const key = JSON.stringify([item.channelId, item.incarnation, item.seq]);
      if (item.workerId !== args.workerId || !item.channelId || !Number.isSafeInteger(item.incarnation) || item.incarnation < 0 ||
          !Number.isSafeInteger(item.seq) || item.seq < 1 || !(item.dueSince instanceof Date) || !Number.isFinite(item.dueSince.getTime()) ||
          item.dueSince > asOf || identities.has(key)) incomplete();
      identities.add(key);
      messages.push({ workerId: item.workerId, channelId: item.channelId, channelIncarnation: item.incarnation,
        seq: item.seq, dueSince: new Date(item.dueSince.getTime()) });
    }
    if (page.complete) return { complete: true, asOf, messages };
    after = page.nextAfter!;
    if (cursors.has(after)) incomplete();
    cursors.add(after);
  } while (after);
  return incomplete();
}

/** S13/internal consumer facade: enumeration and canonical health share exactly the same authorized snapshot. */
export async function loadDeliveryHealthSnapshot(tx: Prisma.TransactionClient, args: PendingSnapshotArgs & { limit?: number }) {
  const pending = await loadPendingDeliverySnapshot(tx, args);
  const eligible = await loadDeliveryEligibility({ ctx: withoutRequestCaches(args.ctx, tx), app: args.app,
    hostId: args.hostId, workerIds: [args.workerId], first: 1, now: pending.asOf });
  const visibleChannelIds = eligible.workers.find(w => w.workerId === args.workerId)?.channels.map(c => c.channelId) ?? [];
  return deliveryHealthSnapshot(tx, { appId: args.app.id, workerId: args.workerId, asOf: pending.asOf, pending,
    visibleChannelIds, limit: args.limit });
}
