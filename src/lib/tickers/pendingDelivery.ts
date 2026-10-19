/** Complete S4 pending metadata for S5/S13; no renderer/body cap and no policy-clock inference.
 * Aggregate every page at the same now using one consistent authorized DB snapshot before claiming a complete snapshot.
 * A cursor is a scoped position, never authority: every page reuses the loader's security/eligibility core.
 */
import { createHash } from 'node:crypto';
import { Prisma } from '../../generated/prisma/index.js';
import { batchTiming, loadDeliverySettings } from './batchTiming.js';
import { loadDeliveryEligibility, type DeliverySelectionArgs, type EligibleDeliveryWorker } from './deliveryBatch.js';

export type PendingDeliveryItem = {
  workerId: string; channelId: string; incarnation: number; seq: number; dueSince: Date;
  state: 'due' | 'withheld'; withheldReason: 'timing' | null;
};
export type PendingDeliveryPage = { items: PendingDeliveryItem[]; complete: boolean; nextAfter: string | null };
export type PendingDeliveryArgs = Omit<DeliverySelectionArgs, 'after' | 'now'> & { now: Date; after?: string | null };
export const PENDING_DELIVERY_PAGE_DEFAULT = 200;
export const PENDING_DELIVERY_PAGE_MAX = 1000;
type Cursor = { v: 1; scope: string; workerId: string; channelId: string; incarnation: number; seq: number };
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const invalidCursor = (): never => { throw new Error('Invalid after cursor for pending delivery.'); };

export async function enumeratePendingDelivery(args: PendingDeliveryArgs): Promise<PendingDeliveryPage> {
  if (args.hostId === null && args.workerIds?.length !== 1) throw new Error('self mode selects exactly one worker');
  const now = args.now;
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error('Invalid pending delivery now.');
  if (args.first != null && !Number.isSafeInteger(args.first)) throw new Error('Invalid pending delivery first.');
  const first = Math.min(PENDING_DELIVERY_PAGE_MAX, Math.max(1, args.first ?? PENDING_DELIVERY_PAGE_DEFAULT));
  const scope = createHash('sha256').update(JSON.stringify([
    args.app.id, args.hostId, args.workerIds == null ? null : [...new Set(args.workerIds)].sort(), now.getTime(),
    args.ctx.userId ?? null, args.ctx.appKeyId ?? null, args.ctx.sessionId ?? null,
  ])).digest('hex');
  let cursor: Cursor | null = null;
  if (args.after) {
    if (args.after.length > 4096) invalidCursor();
    try {
      const bytes = Buffer.from(args.after, 'base64url');
      if (bytes.toString('base64url') !== args.after) invalidCursor();
      const c = JSON.parse(bytes.toString('utf8')) as Cursor;
      if (c.v !== 1 || c.scope !== scope || typeof c.workerId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(c.workerId) ||
          typeof c.channelId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(c.channelId) ||
          !Number.isSafeInteger(c.incarnation) || c.incarnation < 0 || !Number.isSafeInteger(c.seq) || c.seq < 1) invalidCursor();
      if (args.workerIds != null && !args.workerIds.includes(c.workerId)) invalidCursor();
      cursor = c;
    } catch { invalidCursor(); }
  }
  const items: PendingDeliveryItem[] = [];
  let settings: Awaited<ReturnType<typeof loadDeliverySettings>> | undefined;
  const consume = async (worker: EligibleDeliveryWorker, after: Cursor | null) => {
    if (!worker.channels.length) return;
    settings ??= await loadDeliverySettings(args.ctx.db, args.app.id);
    // Timing is anchored on the oldest eligible post of the whole worker, even when resuming mid-channel/page.
    let oldest: Date | null = null;
    for (const channel of worker.channels) {
      const rows = await args.ctx.db.$queryRaw<Array<{ oldest: Date | null }>>(Prisma.sql`
        SELECT MIN(n.created_at) AS oldest FROM nodes n WHERE ${channel.predicate}`);
      const at = rows[0]?.oldest;
      if (at && (!oldest || at < oldest)) oldest = at;
    }
    if (!oldest) return;
    const withheld = batchTiming(settings, { oldestPostedAt: oldest }).deliverAfter > now;
    for (const channel of [...worker.channels].sort((a,b) => compare(a.channelId,b.channelId))) {
      if (after && compare(channel.channelId, after.channelId) < 0) continue;
      if (after && channel.channelId === after.channelId && channel.incarnation !== after.incarnation) invalidCursor();
      const floor = after && channel.channelId === after.channelId ? Prisma.sql`AND n.seq > ${after.seq}` : Prisma.empty;
      const rows = await args.ctx.db.$queryRaw<Array<{ seq: number; posted_at: Date }>>(Prisma.sql`
        SELECT n.seq::int AS seq, n.created_at AS posted_at
        FROM nodes n WHERE ${channel.predicate} ${floor}
        ORDER BY n.seq LIMIT ${first + 1 - items.length}`);
      for (const row of rows) items.push({ workerId: worker.workerId, channelId: channel.channelId, incarnation: channel.incarnation,
        seq: row.seq, dueSince: row.posted_at, state: withheld ? 'withheld' : 'due', withheldReason: withheld ? 'timing' : null });
      if (items.length > first) return;
    }
  };
  if (cursor) {
    const resumed = await loadDeliveryEligibility({ ...args, now, workerIds: [cursor.workerId], first: 1, after: null });
    for (const worker of resumed.workers) await consume(worker, cursor);
  }
  let afterWorker = cursor?.workerId ?? null;
  while (items.length <= first) {
    const page = await loadDeliveryEligibility({ ...args, now, first: 200, after: afterWorker });
    for (const worker of page.workers) {
      await consume(worker, null);
      if (items.length > first) break;
    }
    if (items.length > first || !page.nextAfter) break;
    afterWorker = page.nextAfter;
  }
  const complete = items.length <= first;
  const pageItems = items.slice(0, first);
  const last = pageItems.at(-1);
  const nextAfter = complete || !last ? null : Buffer.from(JSON.stringify({ v: 1, scope, workerId: last.workerId,
    channelId: last.channelId, incarnation: last.incarnation, seq: last.seq } satisfies Cursor)).toString('base64url');
  return { items: pageItems, complete, nextAfter };
}
