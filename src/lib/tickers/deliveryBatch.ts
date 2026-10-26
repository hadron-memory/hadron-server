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

import type { Context } from '../../api/graphql/schema/resolvers.helpers.js';
import { getAccessibleMemoryIds } from '../../api/graphql/schema/resolvers.helpers.js';
import { collectRegisterRows } from '../resolveRegister.js';
import { mentionTokenOf } from '../mentionToken.js';
import { reachEnvelopeOf, mentionReachSql } from '../mentionReach.js';
import { renderBatch, type BatchMessage } from '../messaging/renderBatch.js';
import { Prisma } from '../../generated/prisma/index.js';
import { batchTiming, loadDeliverySettings } from './batchTiming.js';
import { holderAccess, mayRead, type AppLike } from './dueWakes.js';
import { batchKeyOf, type BatchProof } from './wakeProof.js';
import { standbyAdmitsSql, workerStandby } from './standby.js';
import { s7Available } from './s7Availability.js';

export const DELIVERY_BATCHES_PAGE_DEFAULT = 20;
export const DELIVERY_BATCHES_PAGE_MAX = 200;
/** A global batch selects at most ten; no channel can contribute an eleventh.
 * Count all reached rows before this cap so overflow is exact without loading their bodies. */
const ELIGIBLE_READ_LIMIT = 10;

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

type Row = { seq: number; content: string | null; data: unknown; created_at: Date; oldest_posted_at: Date; total_eligible: bigint };

const oneLine = (s: string): string => s.replace(/\r\n|[\r\n\u2028\u2029]/g, ' ');

/**
 * The batches due now for the workers registered on `hostId`. `ctx` is the caller (a host key); the caller's reading
 * right is one of the two readers a channel must pass.
 *
 * SELF MODE (R57, cor:agt:080:22): `hostId` null selects exactly one worker, `workerIds: [self]`, WITHOUT the host-registration
 * join (a worker no host launches is still entitled to its own batches). The caller's gate (a live session of that very
 * worker) is the resolver's and runs before this; every other rule is the same pipeline.
 */
export type DeliverySelectionArgs = {
  ctx: Context; app: AppLike; hostId: string | null; now?: Date;
  workerIds?: string[] | null; first?: number | null; after?: string | null;
};
export type EligibleDeliveryChannel = { channelId: string; incarnation: number; mark: number; predicate: Prisma.Sql };
/** `standby` is set only for a worker on standby (S7): the RENDERER alone applies it (standbyAdmitsSql), so the reach/authority
 * `predicate` above stays complete for S5's pending enumeration, which keeps the held messages for its classifier. */
export type EligibleDeliveryWorker = {
  workerId: string; workerName: string; channels: EligibleDeliveryChannel[];
  standby: { headWorkerId: string; token: string } | null;
};

/** Shared authority/eligibility core for rendered batches and complete metadata enumeration.
 * Predicates are server-local SQL, never a transport DTO. Neither path may widen the selected channels or reparse reach.
 * Entry authentication and a consistent transaction/snapshot are the caller's responsibility.
 */
export async function loadDeliveryEligibility(args: DeliverySelectionArgs): Promise<{ workers: EligibleDeliveryWorker[]; nextAfter: string | null }> {
  const { ctx, app, hostId } = args;
  const db = ctx.db;
  const first = Math.min(Math.max(args.first ?? DELIVERY_BATCHES_PAGE_DEFAULT, 1), DELIVERY_BATCHES_PAGE_MAX);

  let registrationId: string | null = null;
  if (hostId === null) {
    if (!args.workerIds || args.workerIds.length !== 1) throw new Error('self mode selects exactly one worker');
  } else {
    const registration = await db.hostRegistration.findFirst({ where: { appId: app.id, hostId, lostAt: null }, select: { id: true } });
    if (!registration) return { workers: [], nextAfter: null };
    registrationId = registration.id;
  }
  const workers = await db.worker.findMany({
    where: {
      appId: app.id,
      retiredAt: null,
      ...(registrationId ? { launchableVia: { some: { registrationId } } } : {}),
      AND: [
        ...(args.workerIds ? [{ id: { in: args.workerIds } }] : []),
        ...(args.after ? [{ id: { gt: args.after } }] : []),
      ],
    },
    orderBy: { id: 'asc' },
    take: first + 1,
    select: { id: true, name: true, heldByUserId: true, reportsToWorkerId: true, wakeSettings: { select: { isolatedUntil: true } } },
  });
  const hasMore = workers.length > first;
  const page = workers.slice(0, first);
  const nextAfter = hasMore ? page[page.length - 1]!.id : null;
  if (page.length === 0) return { workers: [], nextAfter };

  const callerIds = await getAccessibleMemoryIds(ctx);
  const holderCache = new Map<string, Set<string> | 'all' | null>();
  const selected: EligibleDeliveryWorker[] = [];

  for (const w of page) {
    const token = mentionTokenOf(w.name);
    if (!token) continue;
    // R85: a live isolation drops the worker before any channel scan. Chat batches and ordinary wakes only; the S6 notice lane is not here.
    if (s7Available() && w.wakeSettings?.isolatedUntil && w.wakeSettings.isolatedUntil.getTime() > (args.now ?? new Date()).getTime()) continue;
    const rows = (await collectRegisterRows(db, { workerId: w.id }))?.rows ?? [];
    const channelIds = [...new Set(rows.filter(r => r.role !== 'POST').map(r => r.channelId))];
    if (channelIds.length === 0) continue;
    const standbyState = w.reportsToWorkerId ? await workerStandby(db, w.id) : { onStandby: false, headWorkerId: null };
    const channels = await loadDeliveryChannelPolicy(ctx, app, w, { callerIds, holderCache, channelIds });
    const [seen, delivered] = await Promise.all([
      db.channelReadState.findMany({ where: { workerId: w.id, channelId: { in: channelIds } }, select: { channelId: true, lastSeenSeq: true } }),
      db.workerDeliveryChannel.findMany({ where: { workerId: w.id, channelId: { in: channelIds } } }),
    ]);

    const eligibleChannels: EligibleDeliveryChannel[] = [];
    for (const ch of channels) {
      const d = delivered.find(x => x.channelId === ch.id);
      const mark = d && d.channelIncarnation === ch.incarnation ? d.deliveredThroughSeq : 0;
      const lo = Math.max(seen.find(x => x.channelId === ch.id)?.lastSeenSeq ?? 0, mark);
      if (ch.lastSeq <= lo) continue;
      eligibleChannels.push({ channelId: ch.id, incarnation: ch.incarnation, mark,
        predicate: Prisma.sql`n.message_channel_id = ${ch.id}
          AND n.node_type = 'chat-message' AND n.deleted_at IS NULL AND n.seq > ${lo}
          AND (n.data -> 'authorWorkerId') IS DISTINCT FROM ${JSON.stringify(w.id)}::jsonb
          AND ${mentionReachSql(Prisma.sql`n.data`, Prisma.sql`${[token]}::text[]`)}` });
    }
    selected.push({ workerId: w.id, workerName: w.name, channels: eligibleChannels,
      standby: standbyState.onStandby ? { headWorkerId: standbyState.headWorkerId!, token } : null });
  }
  return { workers: selected, nextAfter };
}

/** Current channel policy shared by rendering and BOTH proof-ack arms.
 * Deliberately ignores read/delivery marks: a repeated ack still has authority
 * after its own mark moved. The caller supplies a fresh transaction context.
 */
export async function loadDeliveryChannelPolicy(
  ctx: Context,
  app: AppLike,
  worker: { id: string; heldByUserId: string | null },
  readers?: { callerIds: string[] | null; holderCache: Map<string, Set<string> | 'all' | null>; channelIds: string[] },
) {
  const callerIds = readers ? readers.callerIds : await getAccessibleMemoryIds(ctx);
  const holder = worker.heldByUserId
    ? await holderAccess(ctx, app, worker.heldByUserId, readers?.holderCache ?? new Map())
    : 'all';
  const rows = readers ? [] : (await collectRegisterRows(ctx.db, { workerId: worker.id }))?.rows ?? [];
  const channelIds = readers?.channelIds ?? [...new Set(rows.filter(r => r.role !== 'POST').map(r => r.channelId))];
  if (!channelIds.length) return [];
  const channels = await ctx.db.channel.findMany({
    where: { id: { in: channelIds }, deletedAt: null },
    select: { id: true, memoryId: true, lastSeq: true, incarnation: true, memory: { select: { isEncrypted: true } } },
  });
  return channels.filter(c => !c.memory.isEncrypted
    && (callerIds === null || callerIds.includes(c.memoryId)) && mayRead(holder, c.memoryId));
}

export async function loadDeliveryBatches(args: DeliverySelectionArgs): Promise<LoadedBatchPage> {
  const { workers, nextAfter } = await loadDeliveryEligibility(args);
  if (!workers.length) return { batches: [], nextAfter };
  const now = args.now ?? new Date();
  const settings = await loadDeliverySettings(args.ctx.db, args.app.id);
  const batches: LoadedBatch[] = [];
  for (const w of workers) {
    const messages: BatchMessage[] = [];
    let totalEligible = 0;
    let oldestPostedAt: Date | null = null;
    const incarnationOf = new Map<string, number>();
    const markOf = new Map<string, number>();
    for (const ch of w.channels) {
      incarnationOf.set(ch.channelId, ch.incarnation);
      markOf.set(ch.channelId, ch.mark);
      const eligible = await eligibleMessages(args.ctx.db, ch, w.standby);
      messages.push(...eligible.messages);
      totalEligible += eligible.totalEligible;
      if (eligible.oldestPostedAt && (!oldestPostedAt || eligible.oldestPostedAt < oldestPostedAt)) {
        oldestPostedAt = eligible.oldestPostedAt;
      }
    }
    if (messages.length === 0) continue;

    // Timing follows every eligible post, not only the seq-prefix body sample.
    const timing = batchTiming(settings, { oldestPostedAt: oldestPostedAt! });
    if (timing.deliverAfter.getTime() > now.getTime()) continue;

    const out = renderBatch({ workerName: w.workerName, messages, totalEligible });
    // The range starts right after the delivered mark: the messages below the first rendered one that do not reach the worker
    // (its own posts, chatter) are covered by the acknowledgement, and no eligible one above the last rendered one is.
    const ranges: LoadedBatchRange[] = out.ranges.map((r) => ({
      ...r, incarnation: incarnationOf.get(r.channelId)!, fromSeq: markOf.get(r.channelId)! + 1,
    }));
    batches.push({
      workerId: w.workerId,
      workerName: w.workerName,
      text: out.text,
      renderHash: out.renderHash,
      batchKey: batchKeyOf({
        workerId: w.workerId, renderHash: out.renderHash,
        channels: ranges.map((r) => ({ channelId: r.channelId, incarnation: r.incarnation, from: r.fromSeq, through: r.throughSeq, seqs: r.seqs })),
      }),
      deliverAfter: timing.deliverAfter,
      busyDeadline: timing.busyDeadline,
      interrupt: false,
      ranges,
      overflow: out.overflow,
    });
  }
  return { batches, nextAfter };
}

/** One admission definition for rendering and exact counting. Both use the same alias and snapshot. */
function admittedDeliveryPredicate(ch: EligibleDeliveryChannel, standby: EligibleDeliveryWorker['standby']): Prisma.Sql {
  return Prisma.sql`(${ch.predicate})
    ${standby ? Prisma.sql`AND ${standbyAdmitsSql(Prisma.sql`n.data`, Prisma.sql`${[standby.token]}::text[]`, standby.headWorkerId)}` : Prisma.empty}`;
}

function admittedDeliveryRows(ch: EligibleDeliveryChannel, standby: EligibleDeliveryWorker['standby']): Prisma.Sql {
  return Prisma.sql`SELECT n.id, n.seq, n.created_at,
    MIN(n.created_at) OVER() AS oldest_posted_at, COUNT(*) OVER() AS total_eligible
    FROM nodes n WHERE ${admittedDeliveryPredicate(ch, standby)}`;
}

/** Exact pre-cap C7 total for one authorized self selection, at the caller's snapshot/asOf. Never renders or signs. */
export async function loadPendingDeliverySummary(args: DeliverySelectionArgs): Promise<number> {
  if (args.hostId !== null || args.workerIds?.length !== 1) throw new Error('Footer requires one self worker');
  const { workers, nextAfter } = await loadDeliveryEligibility({ ...args, first: 1 });
  if (nextAfter !== null) throw new Error('Incomplete footer selection');
  const now = args.now ?? new Date();
  const settings = await loadDeliverySettings(args.ctx.db, args.app.id);
  let total = 0;
  for (const worker of workers) {
    if (worker.channels.length === 0) continue;
    // Channel predicates are disjoint (each fixes n.message_channel_id); OR counts every reached row once.
    // One plain aggregate avoids per-channel round trips and windowing every row of a large backlog.
    const predicates = worker.channels.map(channel => Prisma.sql`(${admittedDeliveryPredicate(channel, worker.standby)})`);
    const [row] = await args.ctx.db.$queryRaw<Array<{ total: bigint; oldest: Date | null }>>(Prisma.sql`
      SELECT COUNT(*)::bigint AS total, MIN(n.created_at) AS oldest FROM nodes n
      WHERE ${Prisma.join(predicates, ' OR ')}`);
    const count = Number(row?.total);
    if (!Number.isSafeInteger(count) || count < 0) throw new Error('Unsafe footer count');
    if (row.oldest && batchTiming(settings, { oldestPostedAt: row.oldest }).deliverAfter <= now) total += count;
    if (!Number.isSafeInteger(total)) throw new Error('Unsafe footer count');
  }
  return total;
}

/** The messages of a plaintext channel above `lo` that reach the worker, with their reply parent when it is in the channel. */
async function eligibleMessages(db: Context['db'], ch: EligibleDeliveryChannel, standby: EligibleDeliveryWorker['standby']): Promise<{ messages: BatchMessage[]; totalEligible: number; oldestPostedAt: Date | null }> {
  const rows = await db.$queryRaw<Row[]>(Prisma.sql`
    SELECT e.seq::int AS seq, n.content, n.data, e.created_at, e.oldest_posted_at, e.total_eligible
    FROM (${admittedDeliveryRows(ch, standby)}) e JOIN nodes n ON n.id = e.id
    ORDER BY e.seq LIMIT ${ELIGIBLE_READ_LIMIT}`);
  const eligible = rows;
  const parentSeqs = [...new Set(eligible.map((r) => replyToOf(r.data)).filter((s): s is number => s !== null))];
  const parents = parentSeqs.length === 0 ? [] : await db.$queryRaw<Array<{ seq: number; content: string | null; data: unknown }>>(Prisma.sql`
    SELECT n.seq::int AS seq, n.content, n.data FROM nodes n
    WHERE n.message_channel_id = ${ch.channelId} AND n.node_type = 'chat-message' AND n.deleted_at IS NULL
      AND n.seq IN (${Prisma.join(parentSeqs)})`);
  const parentOf = new Map(parents.map((p) => [p.seq, p]));
  const messages: BatchMessage[] = eligible.map((r) => {
    const env = (r.data ?? {}) as Record<string, unknown>;
    const parentSeq = replyToOf(r.data);
    const p = parentSeq === null ? undefined : parentOf.get(parentSeq);
    const pEnv = (p?.data ?? {}) as Record<string, unknown>;
    return {
      channelId: ch.channelId,
      seq: r.seq,
      createdAt: r.created_at,
      authorName: typeof env.authorName === 'string' ? env.authorName : 'unknown',
      body: r.content ?? '',
      parentSeq,
      parent: p ? { seq: p.seq, authorName: typeof pEnv.authorName === 'string' ? pEnv.authorName : 'unknown', excerpt: oneLine(p.content ?? '') } : null,
      mentions: reachEnvelopeOf(r.data).mentions as string[],
    };
  });
  return { messages, totalEligible: Number(rows[0]?.total_eligible ?? 0), oldestPostedAt: rows[0]?.oldest_posted_at ?? null };
}

const replyToOf = (data: unknown): number | null => {
  const v = data && typeof data === 'object' ? (data as Record<string, unknown>).replyToSeq : null;
  return typeof v === 'number' ? v : null;
};

/** The payload the batch's signed id carries (slice b signs it: signBatchProof in wakeProof.ts). */
export function batchProofPayload(
  batch: LoadedBatch,
  who: { appId: string; hostId: string; appKeyId: string; now: Date },
): BatchProof {
  return {
    v: 1,
    kind: 'batch-proof',
    appId: who.appId,
    workerId: batch.workerId,
    hostId: who.hostId,
    requester: { appKeyId: who.appKeyId },
    channels: batch.ranges.map((r) => ({ channelId: r.channelId, incarnation: r.incarnation, from: r.fromSeq, through: r.throughSeq, seqs: r.seqs })),
    renderHash: batch.renderHash,
    batchKey: batch.batchKey,
    issuedAt: who.now.getTime(),
  };
}
