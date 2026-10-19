// S1 (#2017, cor:agt:080:22–:26) — the ready-to-deliver batches for the workers of ONE host.
//
// Loading and eligibility only. The text is src/lib/messaging/renderBatch.ts's (the only renderer); the signed id and the
// acknowledgement are src/lib/tickers/wakeProof.ts and acknowledge.ts (slice b); the host-key gate is the resolver's.
// Nothing here writes, and nothing here is a proof: a batch is DERIVED from the marks and the stored messages every time
// it is read (D-2026-10-16-001), so a crash before the acknowledgement re-derives the same ranges and text.
//
// WHO SEES WHAT (cor:agt:080:23): a worker is included only when it is registered, live, on this host's registration; a
// channel only when BOTH the worker's holder and the caller may read its memory; a channel of an ENCRYPTED memory is
// omitted entirely (Holger's ruling, decisions:2026-10-18-holger-rulings-to-vera): its text is never carried here. A
// message is eligible when it REACHES the worker (src/lib/mentionReach.ts, the one S4 predicate) and lies above both the
// read position and the delivered-through mark of the channel's current incarnation.

import { createHash } from 'node:crypto';
import type { Context } from '../../api/graphql/schema/resolvers.helpers.js';
import { getAccessibleMemoryIds } from '../../api/graphql/schema/resolvers.helpers.js';
import { collectRegisterRows } from '../resolveRegister.js';
import { mentionTokenOf } from '../mentionToken.js';
import { reachEnvelopeOf, reachesWorker } from '../mentionReach.js';
import { renderBatch, type BatchMessage } from '../messaging/renderBatch.js';
import { Prisma } from '../../generated/prisma/index.js';
import { batchTiming, loadDeliverySettings } from './batchTiming.js';
import { holderAccess, mayRead, type AppLike } from './dueWakes.js';

export const DELIVERY_BATCHES_PAGE_DEFAULT = 50;
export const DELIVERY_BATCHES_PAGE_MAX = 200;
/** Eligible messages read per channel per batch: renderBatch takes at most 10, one more tells it whether anything overflows. */
const ELIGIBLE_READ_LIMIT = 200;

export type LoadedBatchRange = { channelId: string; incarnation: number; fromSeq: number; throughSeq: number; seqs: number[] };

export type LoadedBatch = {
  workerId: string;
  workerName: string;
  text: string;
  renderHash: string;
  /** Stable across reads while the eligible messages are unchanged; NOT a proof (the signed id is slice b's). */
  batchKey: string;
  deliverAfter: Date;
  busyDeadline: Date;
  interrupt: false;
  ranges: LoadedBatchRange[];
  overflow: number;
};

export type LoadedBatchPage = { batches: LoadedBatch[]; nextAfter: string | null };

type Row = { seq: number; content: string | null; data: unknown; created_at: Date };

const oneLine = (s: string): string => s.replace(/\r\n|[\r\n\u2028\u2029]/g, ' ');

/**
 * The batches due now for the workers registered on `hostId`. `ctx` is the caller (a host key); the caller's reading
 * right is one of the two readers a channel must pass.
 */
export async function loadDeliveryBatches(args: {
  ctx: Context;
  app: AppLike;
  hostId: string;
  now?: Date;
  workerIds?: string[] | null;
  first?: number | null;
  after?: string | null;
}): Promise<LoadedBatchPage> {
  const { ctx, app, hostId } = args;
  const db = ctx.db;
  const now = args.now ?? new Date();
  const first = Math.min(Math.max(args.first ?? DELIVERY_BATCHES_PAGE_DEFAULT, 1), DELIVERY_BATCHES_PAGE_MAX);

  const registration = await db.hostRegistration.findFirst({ where: { appId: app.id, hostId, lostAt: null }, select: { id: true } });
  if (!registration) return { batches: [], nextAfter: null };
  const workers = await db.worker.findMany({
    where: {
      appId: app.id,
      retiredAt: null,
      launchableVia: { some: { registrationId: registration.id } },
      ...(args.workerIds ? { id: { in: args.workerIds } } : {}),
      ...(args.after ? { id: { gt: args.after } } : {}),
    },
    orderBy: { id: 'asc' },
    take: first + 1,
    select: { id: true, name: true, heldByUserId: true },
  });
  const hasMore = workers.length > first;
  const page = workers.slice(0, first);
  const nextAfter = hasMore ? page[page.length - 1]!.id : null;
  if (page.length === 0) return { batches: [], nextAfter };

  const settings = await loadDeliverySettings(db, app.id);
  const callerIds = await getAccessibleMemoryIds(ctx);
  const callerCan = (memoryId: string) => callerIds === null || callerIds.includes(memoryId);
  const holderCache = new Map<string, Set<string> | 'all' | null>();
  const batches: LoadedBatch[] = [];

  for (const w of page) {
    const token = mentionTokenOf(w.name);
    if (!token) continue;
    const holder = w.heldByUserId ? await holderAccess(ctx, app, w.heldByUserId, holderCache) : 'all';
    const rows = (await collectRegisterRows(db, { workerId: w.id }))?.rows ?? [];
    const channelIds = [...new Set(rows.filter((r) => r.role !== 'POST').map((r) => r.channelId))];
    if (channelIds.length === 0) continue;
    const channels = await db.channel.findMany({
      where: { id: { in: channelIds }, deletedAt: null },
      select: { id: true, memoryId: true, lastSeq: true, incarnation: true, memory: { select: { isEncrypted: true } } },
    });
    const [seen, delivered] = await Promise.all([
      db.channelReadState.findMany({ where: { workerId: w.id, channelId: { in: channelIds } }, select: { channelId: true, lastSeenSeq: true } }),
      db.workerDeliveryChannel.findMany({ where: { workerId: w.id, channelId: { in: channelIds } } }),
    ]);

    const messages: BatchMessage[] = [];
    const incarnationOf = new Map<string, number>();
    for (const ch of channels) {
      if (ch.memory.isEncrypted) continue; // ruled: no text for encrypted channels
      if (!callerCan(ch.memoryId) || !mayRead(holder, ch.memoryId)) continue;
      const d = delivered.find((x) => x.channelId === ch.id);
      const mark = d && d.channelIncarnation === ch.incarnation ? d.deliveredThroughSeq : 0;
      const lo = Math.max(seen.find((x) => x.channelId === ch.id)?.lastSeenSeq ?? 0, mark);
      if (ch.lastSeq <= lo) continue;
      incarnationOf.set(ch.id, ch.incarnation);
      const eligible = await eligibleMessages(db, ch, lo, w.id, token);
      messages.push(...eligible);
    }
    if (messages.length === 0) continue;

    const oldest = messages.reduce((a, m) => (m.createdAt < a ? m.createdAt : a), messages[0]!.createdAt);
    const timing = batchTiming(settings, { oldestPostedAt: oldest });
    if (timing.deliverAfter.getTime() > now.getTime()) continue;

    const out = renderBatch({ workerName: w.name, messages });
    const ranges: LoadedBatchRange[] = out.ranges.map((r) => ({ ...r, incarnation: incarnationOf.get(r.channelId)! }));
    batches.push({
      workerId: w.id,
      workerName: w.name,
      text: out.text,
      renderHash: out.renderHash,
      batchKey: createHash('sha256').update(JSON.stringify([w.id, out.renderHash, ranges.map((r) => [r.channelId, r.incarnation, r.seqs])])).digest('hex'),
      deliverAfter: timing.deliverAfter,
      busyDeadline: timing.busyDeadline,
      interrupt: false,
      ranges,
      overflow: out.overflow,
    });
  }
  return { batches, nextAfter };
}

/** The messages of a plaintext channel above `lo` that reach the worker, with their reply parent when it is in the channel. */
async function eligibleMessages(
  db: Context['db'],
  ch: { id: string },
  lo: number,
  workerId: string,
  token: string,
): Promise<BatchMessage[]> {
  const rows = await db.$queryRaw<Row[]>(Prisma.sql`
    SELECT n.seq::int AS seq, n.content, n.data, n.created_at
    FROM nodes n
    WHERE n.message_channel_id = ${ch.id}
      AND n.node_type = 'chat-message'
      AND n.deleted_at IS NULL
      AND n.seq > ${lo}
    ORDER BY n.seq
    LIMIT ${ELIGIBLE_READ_LIMIT * 5}`);
  const eligible = rows.filter((r) => reachesWorker(reachEnvelopeOf(r.data), [workerId], [token])).slice(0, ELIGIBLE_READ_LIMIT);
  const parentSeqs = [...new Set(eligible.map((r) => replyToOf(r.data)).filter((s): s is number => s !== null))];
  const parents = parentSeqs.length === 0 ? [] : await db.$queryRaw<Array<{ seq: number; content: string | null; data: unknown }>>(Prisma.sql`
    SELECT n.seq::int AS seq, n.content, n.data FROM nodes n
    WHERE n.message_channel_id = ${ch.id} AND n.node_type = 'chat-message' AND n.deleted_at IS NULL
      AND n.seq IN (${Prisma.join(parentSeqs)})`);
  const parentOf = new Map(parents.map((p) => [p.seq, p]));
  return eligible.map((r) => {
    const env = (r.data ?? {}) as Record<string, unknown>;
    const parentSeq = replyToOf(r.data);
    const p = parentSeq === null ? undefined : parentOf.get(parentSeq);
    const pEnv = (p?.data ?? {}) as Record<string, unknown>;
    return {
      channelId: ch.id,
      seq: r.seq,
      createdAt: r.created_at,
      authorName: typeof env.authorName === 'string' ? env.authorName : 'unknown',
      body: r.content ?? '',
      parentSeq,
      parent: p ? { seq: p.seq, authorName: typeof pEnv.authorName === 'string' ? pEnv.authorName : 'unknown', excerpt: oneLine(p.content ?? '') } : null,
      mentions: reachEnvelopeOf(r.data).mentions as string[],
    };
  });
}

const replyToOf = (data: unknown): number | null => {
  const v = data && typeof data === 'object' ? (data as Record<string, unknown>).replyToSeq : null;
  return typeof v === 'number' ? v : null;
};
