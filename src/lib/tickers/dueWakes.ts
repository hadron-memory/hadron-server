import { mentionReach, mentionReachSql, reachEnvelopeOf } from '../mentionReach.js';
// dueWakes — #1748, cor:agt:080:08–:15, :22, :23 (plan §4.2, §4.2a, §6.1).
//
// The loading around the pure rule in wakeRule.ts: who the caller may read, the
// two-reader channel gate (R1/B3), dormancy, the wake-rate ceiling and the daily
// budget. Reads only. NOTHING here moves ChannelReadState or the delivery
// record (cor:agt:080:16): `acknowledgeWakes` is the only writer.
//
// WHAT A READ DISCLOSES (cor:agt:080:23): counts and seq ranges, never a body,
// author or mention text. A channel is included only when BOTH the worker and
// the caller may read its host memory; one the caller cannot read is left out
// without a trace, and a wake none of whose channels the caller can read is not
// returned. A worker nobody holds has no reader of its own, so for it the
// caller's reading right is the whole gate.
//
// TASK REASONS (#1708, Task Management T5): task events are the second
// relevance source (src/lib/agentTasks/taskWakes.ts). One rides a wake only
// when the caller may read the App's tasks (cor:agt:050:21) and, for a held
// worker, its holder is still a participant of the App, the same holder test
// the channels pass. They wake at once like a mention, under the same floor
// and budget, and are acknowledged per event through the v2 proof.

import { coveringSignals, timeStoppedWorkers } from '../stopSignals/state.js';
import { pendingStopNotices, type PendingStopNotice } from '../stopSignals/delivery.js';
import { Prisma } from '../../generated/prisma/index.js';
import { batchTiming, loadDeliverySettings } from './batchTiming.js';
import type { Context } from '../../api/graphql/schema/resolvers.helpers.js';
import { getAccessibleMemoryIds, isAppParticipant } from '../../api/graphql/schema/resolvers.helpers.js';
import { loadWorkersActivity } from '../../api/graphql/schema/resolvers.worker.js';
import { recordInEffect } from '../agentTasks/availability.js';
import { collectRegisterRows } from '../resolveRegister.js';
import { loadPendingReasons } from './checkPending.js';
import { decryptNodeFields } from '../nodeCrypto.js';
import { BROADCAST_MENTION_TOKENS, mentionTokenOf } from '../mentionToken.js';
import { onStandbySql, standbyAdmitsSql } from './standby.js';
import { s7Available } from './s7Availability.js';
import { isWorkerDormant, toNaiveUtc } from '../sessionActivity.js';
import {
  relevantMentionCount,
  workerWake,
  type ChannelInput,
  type RoutedMessage,
  type SubscriptionInput,
  type WorkerWake,
} from './wakeRule.js';
import { MAX_PROOF_CHARS, signWakeProof, wakeIdentity, WAKE_PROOF_MAX_AGE_MS, WAKE_PROOF_VERSION, type WakeRequester } from './wakeProof.js';
import { mayReadAppTasks } from '../../api/graphql/schema/resolvers.agentTask.js';
import { withoutRequestCaches } from '../../api/graphql/schema/resolvers.helpers.js';
import { liveTxContext } from '../../api/graphql/schema/authorizedTx.js';
import { lockAuthorityAnchors, type AuthorityAnchor } from '../auth/authorityAnchors.js';
import { pendingTaskWakes, type PendingTaskWake } from '../agentTasks/taskWakes.js';

/**
 * Messages read per channel per page, and the most one request reads from one channel. Scanning goes on past a
 * full page for as long as some worker still has nothing relevant in what was read (cor:agt:080:08), so a backlog
 * of messages that are not for a worker (its own posts, chatter in a mention-only channel) cannot hide the
 * message that is — see `scanChannel`. The ceiling bounds the work, not the correctness of the common case.
 */
export const WAKE_SCAN_ROWS_PER_CHANNEL = 5_000;
export const WAKE_SCAN_MAX_ROWS_PER_CHANNEL = 50_000;
export const DUE_WAKES_PAGE_DEFAULT = 20;
export const DUE_WAKES_PAGE_MAX = 200;
/**
 * #1708 (Colin, Riana P2-2 on #1859): the most task reasons one wake carries. A worker with more pending gets the
 * oldest this many; the rest stay pending and are the next wake once this one is acknowledged (and the floor has
 * passed). Bounds the proof well under the verifier's MAX_PROOF_CHARS; a size guard below enforces the cap itself.
 */
export const WAKE_TASK_REASONS_MAX = 50;

export type DueWakeOut = {
  workerId: string;
  wake: WorkerWake;
  availability: { state: string; reason: string | null; until: Date | null; setAt: Date } | null;
  proof: string;
  /** R63 (#2017): when the wake may be typed and the latest a busy worker may be made to wait, from the earliest waiting reason. */
  timing: { anchorAt: Date; deliverAfter: Date; busyDeadline: Date };
};

export type DueWakesResult = {
  status: 'OK' | 'WAKE_BUDGET_EXHAUSTED';
  withheld: number;
  wakes: DueWakeOut[];
  dormant: Array<{ workerId: string; mentions: number }>;
  nextAfter: string | null;
  /** Set once per UTC day when the budget is spent: the caller posts the notice. */
  budgetNotice: { appId: string; day: Date; withheld: number } | null;
};

/** #2069: the reasons a wake carries that a delivery must name: a mention, one tick of one ticker, one task event. */
const reasonKeys = (wake: WorkerWake): Set<string> =>
  new Set(wake.reasons.map((r) => (r.kind === 'MENTION' ? 'M' : r.kind === 'TICK' ? `T:${r.tickerId}:${r.k}` : r.kind === 'STOP' ? `S:${r.eventId}` : `K:${r.eventId}:${r.chainIndex}`)));
/** True when `fresh` carries a TICK or TASK reason the outstanding wake lacks. A grown mention range alone is not one. */
const absorbsNewReason = (outstanding: WorkerWake, fresh: WorkerWake): boolean => {
  const had = reasonKeys(outstanding);
  return [...reasonKeys(fresh)].some((k) => k !== 'M' && !had.has(k));
};

const tasksOf = (wake: WorkerWake) =>
  wake.reasons.flatMap((r) => (r.kind === 'TASK' ? [{ eventId: r.eventId, chainIndex: r.chainIndex }] : []));

/** #2022 — the wake's stop-signal notice, as the receipt it is acknowledged by (event id, chain position 0). */
const stopsOf = (wake: WorkerWake) =>
  wake.reasons.flatMap((r) => (r.kind === 'STOP' ? [{ eventId: r.eventId, chainIndex: 0 }] : []));
const hasStop = (wake: WorkerWake): boolean => wake.reasons.some((r) => r.kind === 'STOP');

const identityOf = (wake: WorkerWake) => ({
  channels: wake.channels.map((c) => ({ channelId: c.channelId, incarnation: c.incarnation, through: c.throughSeq })),
  ticks: wake.reasons.flatMap((r) => (r.kind === 'TICK' ? [{ tickerId: r.tickerId, k: r.k }] : [])),
  tasks: [...tasksOf(wake), ...stopsOf(wake)],
});

const taskKey = (t: { eventId: string; chainIndex: number }) => `${t.eventId}#${t.chainIndex}`;

/** The wake without its task reasons, or null when nothing else was in it. */
function withoutTasks(wake: WorkerWake): WorkerWake | null {
  const reasons = wake.reasons.filter((r) => r.kind !== 'TASK');
  return reasons.length === 0 ? null : { ...wake, reasons };
}

const utcDay = (d: Date): Date => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

/** The default daily wake budget: roster × (86,400 ÷ default self-subscribe cadence) × 2 (Q11). */
export function defaultWakeBudget(roster: number, selfSubscribeCadenceSeconds: number): number {
  return Math.floor(roster * (86_400 / selfSubscribeCadenceSeconds) * 2);
}

type Reader = { manager: boolean; userId: string | null };

export type AppLike = { id: string; organizationId: string | null; ownerUserId: string | null };

/** Workers of the App the caller may read wakes for: all of them for a manager, else the ones the caller holds. */
async function readableWorkers(
  ctx: Context,
  app: AppLike,
  reader: Reader,
  only: string[] | null,
  after: string | null,
  take: number,
  workerWhere?: Prisma.WorkerWhereInput,
) {
  const where: Prisma.WorkerWhereInput = {
    appId: app.id,
    retiredAt: null,
    ...(reader.manager ? {} : { heldByUserId: reader.userId ?? '__none__' }),
    ...(only ? { id: { in: only } } : {}),
    AND: [...(after ? [{ id: { gt: after } }] : []), ...(workerWhere ? [workerWhere] : [])],
  };
  return ctx.db.worker.findMany({
    where,
    orderBy: { id: 'asc' },
    take,
    select: { id: true, name: true, heldByUserId: true },
  });
}

/** Is the holder a live user who still participates in the App (the register's attendee rule)? */
async function holderParticipates(ctx: Context, app: AppLike, holderId: string): Promise<{ id: string; roles: string[] } | null> {
  const holder = await ctx.db.user.findFirst({ where: { id: holderId, deletedAt: null }, select: { id: true, roles: true } });
  if (!holder) return null;
  const actor: Context = { db: ctx.db, userId: holder.id, roles: holder.roles } as Context;
  return (await isAppParticipant(actor, app)) ? holder : null;
}

export async function holderAccess(
  ctx: Context,
  app: AppLike,
  holderId: string,
  cache: Map<string, Set<string> | 'all' | null>,
): Promise<Set<string> | 'all' | null> {
  if (cache.has(holderId)) return cache.get(holderId)!;
  let result: Set<string> | 'all' | null = null;
  const holder = await ctx.db.user.findFirst({ where: { id: holderId, deletedAt: null }, select: { id: true, roles: true } });
  if (holder) {
    const actor: Context = { db: ctx.db, userId: holder.id, roles: holder.roles };
    // The holder must still be an eligible driver of this App's workers (the register's attendee rule).
    if (await isAppParticipant(actor, app)) {
      const ids = await getAccessibleMemoryIds(actor);
      result = ids === null ? 'all' : new Set(ids);
    }
  }
  cache.set(holderId, result);
  return result;
}

export const mayRead = (set: Set<string> | 'all' | null, memoryId: string): boolean => set === 'all' || (set !== null && set.has(memoryId));

function envelopeOf(data: unknown): RoutedMessage | null {
  if (!data || typeof data !== 'object') return null;
  const e = data as Record<string, unknown>;
  return {
    seq: 0,
    ...reachEnvelopeOf(e),
    managerPost: e.managerPost === true,
    humanAuthored: e.authorSystem !== true && typeof e.authorWorkerId !== 'string' && typeof e.authorUserId === 'string',
  };
}

/** The routing view of messages `(lo, head]` of one channel: plaintext in SQL, encrypted decrypted row by row. */
async function loadMessages(
  db: Context['db'],
  channel: { id: string; memoryId: string; encrypted: boolean },
  lo: number,
  head: number,
  limit: number,
  /** Only the rows that could matter to someone still unmet (plaintext channels; an encrypted row can't be judged in SQL). */
  only?: Watcher[],
): Promise<RoutedMessage[]> {
  if (head <= lo) return [];
  if (!channel.encrypted) {
    const wanted = only && only.length > 0 ? Prisma.sql`AND (${candidatesFor(only)})` : Prisma.empty;
    const rows = await db.$queryRaw<Array<{ seq: number; data: unknown; bw: boolean | null; mp: boolean | null; human: boolean | null; at: Date }>>(Prisma.sql`
      SELECT n.seq::int AS seq,
             jsonb_build_object('authorWorkerId', n.data->'authorWorkerId', 'mentions', n.data->'mentions', 'broadcastWakes', n.data->'broadcastWakes', 'teamTagsVersion', n.data->'teamTagsVersion', 'teamBroadcastWorkerIds', n.data->'teamBroadcastWorkerIds') AS data,
             (n.data->>'broadcastWakes') = 'true' AS bw,
             (n.data->>'managerPost') = 'true' AS mp,
             ((n.data->'authorSystem') IS DISTINCT FROM 'true'::jsonb AND jsonb_typeof(n.data->'authorWorkerId') IS DISTINCT FROM 'string'
               AND jsonb_typeof(n.data->'authorUserId') = 'string') AS human,
             n.created_at AS at
      FROM nodes n
      WHERE n.message_channel_id = ${channel.id}
        AND n.node_type = 'chat-message'
        AND n.deleted_at IS NULL
        AND n.seq > ${lo}
        AND n.seq <= ${head}
        ${wanted}
      ORDER BY n.seq
      LIMIT ${limit}
    `);
    return rows.map((r) => {
      const reach = reachEnvelopeOf(r.data);
      return {
        seq: r.seq,
        ...reach,
        // Preserve the existing plaintext loader for legacy envelopes; S3 stamps are strict.
        broadcastWakes: reach.teamTagsVersion === 1 ? reach.broadcastWakes : r.bw === true,
        managerPost: r.mp === true,
        humanAuthored: r.human === true,
        postedAtMs: new Date(r.at).getTime(),
      };
    });
  }
  const rows = await db.$queryRaw<Array<{ seq: number; data: unknown; at: Date }>>(Prisma.sql`
    SELECT n.seq::int AS seq, n.data, n.created_at AS at
    FROM nodes n
    WHERE n.message_channel_id = ${channel.id}
      AND n.node_type = 'chat-message'
      AND n.deleted_at IS NULL
      AND n.seq > ${lo}
      AND n.seq <= ${head}
    ORDER BY n.seq
    LIMIT ${limit}
  `);
  const out: RoutedMessage[] = [];
  for (const r of rows) {
    let data: unknown = r.data;
    try {
      data = decryptNodeFields({ data: r.data }, { id: channel.memoryId, isEncrypted: true }).data;
    } catch {
      // No session key to read the envelope with: the message counts as unread
      // and nothing more (no author, no mention) — it cannot be routed as a mention.
      data = {};
    }
    const m = envelopeOf(data) ?? { seq: 0, authorWorkerId: null, mentions: [], broadcastWakes: false, managerPost: false };
    out.push({ ...m, seq: r.seq, postedAtMs: new Date(r.at).getTime() });
  }
  return out;
}

/**
 * Someone a channel's messages are read for, with exactly the ways a message can wake them (src/lib/tickers/wakeRule.ts):
 *   immediate  — a direct mention wakes at once, and so does a broadcast the server stamped `broadcastWakes`;
 *   subCovers  — an enabled ticker covers the channel, so any mention (direct or broadcast) counts at the next tick;
 *   subAll     — and an ALL ticker covers it on an entry that is not mention-only, so any message not their own counts.
 * A worker for whom none holds is not watched.
 */
/** `standbyHead` is set for a worker on standby: only a direct mention from a person or that head can wake it (ticks are not due). */
type Watcher = { floor: number; workerId: string; tokens: string[]; immediate: boolean; subCovers: boolean; subAll: boolean; standbyHead?: string | null };

const BROADCAST = BROADCAST_MENTION_TOKENS as readonly string[];

/** Could `m` become (part of) a wake for this watcher? The scan's stopping rule: it must be a real path to one, not a superset. */
function mattersTo(m: RoutedMessage, w: Watcher): boolean {
  if (m.authorWorkerId === w.workerId) return false;
  const direct = m.mentions.some((t) => w.tokens.includes(t));
  if (w.standbyHead) return direct && (m.humanAuthored === true || m.authorWorkerId === w.standbyHead);
  if (m.teamTagsVersion === 1) {
    if ((w.immediate || w.subCovers) && mentionReach(m, w.tokens, [w.workerId]) !== null) return true;
  } else {
    const broadcast = !direct && m.mentions.some((t) => BROADCAST.includes(t));
    if (w.immediate && (direct || (broadcast && m.broadcastWakes))) return true;
    if (w.subCovers && (direct || broadcast)) return true;
  }
  return w.subAll;
}

/** The SQL twin of {@link mattersTo}, for the rows still worth fetching: one OR-ed term per unmet watcher. */
function candidatesFor(unmet: Watcher[]): Prisma.Sql {
  const terms = unmet.map((w) => {
    if (w.standbyHead) return standbyAdmitsSql(Prisma.sql`n.data`, Prisma.sql`${w.tokens}::text[]`, w.standbyHead);
    const notOwn = Prisma.sql`(n.data->>'authorWorkerId') IS DISTINCT FROM ${w.workerId}`;
    const parts: Prisma.Sql[] = [];
    if (w.immediate || w.subCovers) {
      parts.push(Prisma.sql`((n.data->'teamTagsVersion') = '1'::jsonb AND ${mentionReachSql(Prisma.sql`n.data`, Prisma.sql`${w.tokens}::text[]`, Prisma.sql`${[w.workerId]}::text[]`)})`);
      const legacy: Prisma.Sql[] = [Prisma.sql`jsonb_exists_any(n.data->'mentions', ${w.tokens}::text[])`];
      if (w.subCovers) legacy.push(Prisma.sql`jsonb_exists_any(n.data->'mentions', ${[...BROADCAST]}::text[])`);
      if (w.immediate) legacy.push(Prisma.sql`(jsonb_exists_any(n.data->'mentions', ${[...BROADCAST]}::text[]) AND (n.data->>'broadcastWakes') = 'true')`);
      parts.push(Prisma.sql`((n.data->'teamTagsVersion') IS DISTINCT FROM '1'::jsonb AND (${Prisma.join(legacy, ' OR ')}))`);
    }
    if (w.subAll) parts.push(Prisma.sql`TRUE`);
    return Prisma.sql`(${notOwn} AND (${Prisma.join(parts, ' OR ')}))`;
  });
  return Prisma.join(terms, ' OR ');
}

/**
 * Read a channel from `lo`, a page at a time. The first page is everything; while it comes back full and some watcher
 * has nothing that matters to them in what was read, the next pages are fetched in SQL for exactly the rows that could
 * matter to the watchers still unmet (a mention of them or a broadcast; or a message that is not their own), starting
 * at the lowest unmet floor. So a backlog of unrelated chatter can neither hide the message that matters (Diego P2-5)
 * nor, because the filter is applied in the database and not by counting rows read, push the threshold out to a larger
 * number: the scan ends when every watcher is met or the channel has no more candidates. `maxRows` bounds the rows
 * RETURNED (each a candidate for someone); an encrypted channel cannot be filtered in SQL and is bounded by it as rows read.
 */
async function scanChannel(
  db: Context['db'],
  channel: { id: string; memoryId: string; encrypted: boolean },
  lo: number,
  head: number,
  watchers: Watcher[],
  scan: { pageRows: number; maxRows: number },
): Promise<RoutedMessage[]> {
  const out: RoutedMessage[] = [];
  let cursor = lo;
  let only: Parameters<typeof loadMessages>[5];
  for (;;) {
    const page = await loadMessages(db, channel, cursor, head, scan.pageRows, only);
    out.push(...page);
    if (page.length < scan.pageRows || out.length >= scan.maxRows) return out;
    const unmet = watchers.filter((w) => !out.some((m) => m.seq > w.floor && mattersTo(m, w)));
    if (unmet.length === 0) return out;
    cursor = Math.max(page[page.length - 1]!.seq, Math.min(...unmet.map((w) => w.floor)));
    only = unmet;
  }
}

export async function computeDueWakes(args: {
  ctx: Context;
  app: AppLike;
  reader: Reader;
  requester: WakeRequester;
  workerIds?: string[] | null;
  first?: number | null;
  after?: string | null;
  now?: Date;
  /** Page size and per-channel ceiling of the message scan (tests lower them). */
  scan?: { pageRows: number; maxRows: number };
  /**
   * Re-decides the caller's right to be handed wakes at all, first in the transaction that issues them (before the
   * budget lock). An App key's scope is checked here, under the App's authority anchor, so a revocation either
   * committed before this read or waits for it (N4, #1749).
   */
  authorize?: (tx: Prisma.TransactionClient, workerIds: string[]) => Promise<void>;
  /** App-key registration prefilter; the deciding authorize checks the whole selected page again. */
  workerWhere?: Prisma.WorkerWhereInput;
  /** #2169: the reason kinds this call can deliver. A STOP notice is offered only to a call that lists STOP. */
  acceptsStop?: boolean;
  onWorkersSelected?: (workerIds: string[]) => void;
  /** #2755: derive the due wakes and return them without reserving, charging the budget or writing anything. */
  preview?: boolean;
}): Promise<DueWakesResult> {
  const { ctx, app, reader, requester } = args;
  const now = args.now ?? new Date();
  const first = Math.min(Math.max(args.first ?? DUE_WAKES_PAGE_DEFAULT, 1), DUE_WAKES_PAGE_MAX);
  const db = ctx.db;

  const settings = await db.app.findUniqueOrThrow({
    where: { id: app.id },
    select: { tickerMinCadenceSeconds: true, tickerSelfSubscribeCadenceSeconds: true, wakeDailyBudget: true, sessionDormancyDays: true },
  });

  const page = await readableWorkers(ctx, app, reader, args.workerIds ?? null, args.after ?? null, first + 1, args.workerWhere);
  args.onWorkersSelected?.(page.map(w => w.id));
  const hasMore = page.length > first;
  const workers = page.slice(0, first);
  const empty: DueWakesResult = { status: 'OK', withheld: 0, wakes: [], dormant: [], nextAfter: null, budgetNotice: null };
  if (workers.length === 0) return empty;
  const nextAfter = hasMore ? workers[workers.length - 1]!.id : null;
  const ids = workers.map((w) => w.id);

  const [wakeSettings, availability, activity, subs, deliveryChannels, deliveryTicks, readStates, deliveryTasks, wakeAcks] = await Promise.all([
    db.workerWakeSettings.findMany({ where: { workerId: { in: ids } } }),
    db.workerAvailability.findMany({ where: { workerId: { in: ids } } }),
    loadWorkersActivity(ctx, ids, now),
    db.tickerSubscription.findMany({
      where: { workerId: { in: ids }, endedAt: null, ticker: { appId: app.id, deletedAt: null, enabled: true } },
      include: { ticker: true },
    }),
    db.workerDeliveryChannel.findMany({ where: { workerId: { in: ids } } }),
    db.workerDeliveryTick.findMany({ where: { workerId: { in: ids } } }),
    db.channelReadState.findMany({ where: { workerId: { in: ids } }, select: { workerId: true, channelId: true, lastSeenSeq: true, lastCheckedAt: true } }),
    // #1708: the latest task-event delivery per worker, for the floor (cor:agt:080:13).
    db.workerDeliveryTaskEvent.groupBy({ by: ['workerId'], where: { workerId: { in: ids }, deliveredAt: { not: null } }, _max: { deliveredAt: true } }),
    // #2072 (R53): the latest acknowledged wake per worker. A textless wake moves no mark, so its receipt is the floor's clock.
    db.workerWakeAck.groupBy({ by: ['workerId'], where: { workerId: { in: ids } }, _max: { ackedAt: true } }),
  ]);
  const taskDeliveredOf = new Map(deliveryTasks.map((d) => [d.workerId, d._max.deliveredAt?.getTime() ?? 0]));
  const wakeAckedOf = new Map(wakeAcks.map((d) => [d.workerId, d._max.ackedAt?.getTime() ?? 0]));
  const settingsOf = new Map(wakeSettings.map((s) => [s.workerId, s]));
  // S7: who is on standby, evaluated in this read (never cached), in one query.
  const standbyRows = await db.$queryRaw<Array<{ id: string; head: string }>>(Prisma.sql`
    SELECT w.id, w.reports_to_worker_id AS head FROM workers w WHERE w.id IN (${Prisma.join(ids)}) AND ${onStandbySql(Prisma.sql`w`)}`);
  const standbyHeadOf = new Map(standbyRows.map((r) => [r.id, r.head]));
  const availabilityOf = new Map(availability.map((a) => [a.workerId, a]));
  const subsOf = new Map<string, typeof subs>();
  for (const s of subs) subsOf.set(s.workerId, [...(subsOf.get(s.workerId) ?? []), s]);
  const deliveredOf = new Map(deliveryChannels.map((d) => [`${d.workerId}:${d.channelId}`, d]));
  const tickAckOf = new Map(deliveryTicks.map((d) => [`${d.workerId}:${d.tickerId}`, d]));
  const seenOf = new Map(readStates.map((r) => [`${r.workerId}:${r.channelId}`, r.lastSeenSeq]));
  // #2138 §3.1/§3.3: when each worker last CHECKED each channel, and which workers are PENDING (not expected to check).
  const checkedOf = new Map(readStates.map((r) => [`${r.workerId}:${r.channelId}`, r.lastCheckedAt?.getTime() ?? null]));
  const pendingOf = await loadPendingReasons(db, app.id, workers.map((w) => w.id), now);
  // #2022 (R68): a worker a `pause` or `halt` covers is due no tick. Live coverage, worked out in this read.
  const tickStopped = timeStoppedWorkers(await coveringSignals(db, app.id, ids, now));
  // #2022 (cor:agt:090:04): the one stop notice each worker is due, offered only to a call that declared it takes them (#2169).
  const stopOf = args.acceptsStop ? await pendingStopNotices(db, app.id, ids) : new Map<string, PendingStopNotice>();

  // Registers: the channels each worker watches (not POST-only).
  const registers = await Promise.all(ids.map(async (id) => [id, await collectRegisterRows(db, { workerId: id })] as const));
  const channelIds = [...new Set(registers.flatMap(([, c]) => (c?.rows ?? []).filter((r) => r.role !== 'POST').map((r) => r.channelId)))];
  const channelRows = channelIds.length === 0 ? [] : await db.channel.findMany({
    where: { id: { in: channelIds }, deletedAt: null },
    select: { id: true, memoryId: true, lastSeq: true, incarnation: true, memory: { select: { isEncrypted: true } } },
  });
  const channelOf = new Map(channelRows.map((c) => [c.id, c]));

  // R1/B3: the caller's reading right, and each distinct holder's.
  // #2755: a PREVIEW is the platform's own read (the dark-worker alarm), which may read every channel and every task; the
  // holder's right, below, still applies.
  const callerIds = args.preview ? null : await getAccessibleMemoryIds(ctx);
  const callerCan = (memoryId: string) => callerIds === null || callerIds.includes(memoryId);
  const holderCache = new Map<string, Set<string> | 'all' | null>();
  const holderOf = new Map<string, Set<string> | 'all' | null>();

  // #1708: task reasons, only for a caller who may read the App's tasks (cor:agt:050:21). App-wide, so one check.
  const taskReader = args.preview ? true : await mayReadAppTasks(ctx, app.id);
  const pendingTasks = taskReader ? await pendingTaskWakes(db, ids, now) : new Map<string, PendingTaskWake[]>();
  /** A held worker's task reasons need its holder to be a participant still (the channels' holder test). */
  const tasksFor = (workerId: string): PendingTaskWake[] => (holderOf.get(workerId) === null ? [] : pendingTasks.get(workerId) ?? []);

  // Per worker: the channels it counts that BOTH readers may read.
  type Counted = { channelId: string; mentionOnly: boolean; seen: number; delivered: number; head: number; checkedAtMs: number | null };
  const countedOf = new Map<string, Counted[]>();
  for (const w of workers) {
    const rows = registers.find(([id]) => id === w.id)?.[1]?.rows ?? [];
    const holder = w.heldByUserId ? await holderAccess(ctx, app, w.heldByUserId, holderCache) : 'all';
    holderOf.set(w.id, holder);
    const list: Counted[] = [];
    for (const r of rows) {
      if (r.role === 'POST') continue;
      const ch = channelOf.get(r.channelId);
      if (!ch) continue;
      if (!callerCan(ch.memoryId) || !mayRead(holder, ch.memoryId)) continue;
      const d = deliveredOf.get(`${w.id}:${ch.id}`);
      // A channel recreated since the delivery was recorded starts over (its seqs restarted).
      const delivered = d && d.channelIncarnation === ch.incarnation ? d.deliveredThroughSeq : 0;
      list.push({ channelId: ch.id, mentionOnly: r.mentionOnly, seen: seenOf.get(`${w.id}:${ch.id}`) ?? 0, delivered, head: ch.lastSeq, checkedAtMs: checkedOf.get(`${w.id}:${ch.id}`) ?? null });
    }
    countedOf.set(w.id, list);
  }

  // One read per channel, from the lowest floor any worker needs.
  const floorOf = new Map<string, number>();
  for (const list of countedOf.values()) {
    for (const c of list) {
      const lo = Math.max(c.seen, c.delivered);
      if (c.head > lo) floorOf.set(c.channelId, Math.min(floorOf.get(c.channelId) ?? Infinity, lo));
    }
  }
  const watchersOf = new Map<string, Watcher[]>();
  for (const w of workers) {
    const own = mentionTokenOf(w.name);
    const subsHere = subsOf.get(w.id) ?? [];
    const mentionsImmediate = (settingsOf.get(w.id)?.mentions ?? 'IMMEDIATE') === 'IMMEDIATE';
    for (const c of countedOf.get(w.id) ?? []) {
      if (c.head <= Math.max(c.seen, c.delivered)) continue;
      const covers = (s: (typeof subsHere)[number]) => s.ticker.channelIds.length === 0 || s.ticker.channelIds.includes(c.channelId);
      const subCovers = subsHere.some(covers);
      const subAll = !c.mentionOnly && subsHere.some((s) => s.ticker.relevance !== 'MENTIONS' && covers(s));
      if (!mentionsImmediate && !subCovers) continue;
      watchersOf.set(c.channelId, [
        ...(watchersOf.get(c.channelId) ?? []),
        { floor: Math.max(c.seen, c.delivered), workerId: w.id, tokens: own ? [own] : [], immediate: mentionsImmediate, subCovers, subAll, standbyHead: standbyHeadOf.get(w.id) ?? null },
      ]);
    }
  }
  const scan = args.scan ?? { pageRows: WAKE_SCAN_ROWS_PER_CHANNEL, maxRows: WAKE_SCAN_MAX_ROWS_PER_CHANNEL };
  const messagesOf = new Map<string, RoutedMessage[]>();
  await Promise.all([...floorOf].map(async ([channelId, lo]) => {
    const ch = channelOf.get(channelId)!;
    messagesOf.set(
      channelId,
      await scanChannel(db, { id: ch.id, memoryId: ch.memoryId, encrypted: ch.memory.isEncrypted }, lo, ch.lastSeq, watchersOf.get(channelId) ?? [], scan),
    );
  }));

  const floorMs = settings.tickerMinCadenceSeconds * 1000;
  const signFor = (workerId: string, wake: WorkerWake): string =>
    signWakeProof({
      v: WAKE_PROOF_VERSION,
      kind: 'wake-proof',
      appId: app.id,
      workerId,
      requester,
      // #2072 (R53): no channel range. The display channels stay on the wake; the proof carries the wake's identity.
      channels: [],
      ticks: wake.reasons.flatMap((r) => (r.kind === 'TICK' ? [{ tickerId: r.tickerId, k: r.k }] : [])),
      tasks: [...tasksOf(wake), ...stopsOf(wake)],
      exempt: wake.exempt,
      issuedAt: now.getTime(),
      wakeKey: wakeIdentity(identityOf(wake)),
    });
  const issued: Array<Omit<DueWakeOut, 'timing'> & { exempt: boolean }> = [];
  const dormant: Array<{ workerId: string; mentions: number }> = [];

  for (const w of workers) {
    const ws = settingsOf.get(w.id);
    const own = mentionTokenOf(w.name);
    const workerTokens = own ? [own] : [];
    const standbyHead = standbyHeadOf.get(w.id) ?? null;
    const inputs: ChannelInput[] = (countedOf.get(w.id) ?? []).map((c) => {
      const lo = Math.max(c.seen, c.delivered);
      return {
        channelId: c.channelId,
        incarnation: channelOf.get(c.channelId)!.incarnation,
        mentionOnly: c.mentionOnly,
        lastCheckedAtMs: c.checkedAtMs,
        messages: (messagesOf.get(c.channelId) ?? []).filter((m) => m.seq > lo && m.seq <= c.head
          && (!standbyHead || (m.mentions.some((t) => workerTokens.includes(t)) && (m.humanAuthored === true || m.authorWorkerId === standbyHead)))),
      };
    });

    const isDormant = isWorkerDormant(activity.get(w.id)?.lastActiveAt, settings.sessionDormancyDays, now);
    if (isDormant) {
      const n = relevantMentionCount(inputs, w.id, workerTokens);
      if (n > 0) dormant.push({ workerId: w.id, mentions: n });
      continue; // never due
    }
    // A worker's own pause holds a stop notice too (cor:agt:080:11, Decided; Vera's receipt §4): it waits.
    if (ws?.pausedUntil && ws.pausedUntil.getTime() > now.getTime()) continue; // a pause silences ticks AND mentions (Q2)
    const stop = stopOf.get(w.id);
    // #2138 §3.6: a TEAM pause silences EVERY reason (ticks of every kind, mentions, task events), exactly as a worker's own pause does.
    // #2022: except one stop-signal notice (Holger R105), which then travels alone.
    const teamPaused = pendingOf.get(w.id) === 'TEAM_PAUSED';
    // S7 R85: a live isolation, its own state. #2022: a stop notice reaches an isolated worker (R86), alone.
    const isolated = s7Available() && !!ws?.isolatedUntil && ws.isolatedUntil.getTime() > now.getTime();
    if ((teamPaused || isolated) && !stop) continue;
    const stopReason = (n: PendingStopNotice) => ({ kind: 'STOP' as const, eventId: n.eventId, signalId: n.signalId, level: n.level, notice: n.notice, interrupt: n.interrupt });
    if (teamPaused || isolated) {
      const only: WorkerWake = { reasons: [stopReason(stop!)], channels: [], unread: 0, unreadMentions: 0, exempt: false, anchorAtMs: stop!.at.getTime() };
      issued.push({ workerId: w.id, wake: only, availability: null, proof: signFor(w.id, only), exempt: false });
      continue;
    }

    // S7: a TICK is not one of the four kinds a standby worker is sent.
    const subscriptions: SubscriptionInput[] = (standbyHead || tickStopped.has(w.id) ? [] : subsOf.get(w.id) ?? []).map((s) => ({
      ticker: {
        id: s.ticker.id,
        anchorAt: s.ticker.anchorAt,
        cadenceSeconds: s.ticker.cadenceSeconds,
        quietHours: s.ticker.quietHours,
        enabled: s.ticker.enabled,
        deletedAt: s.ticker.deletedAt,
        relevance: s.ticker.relevance === 'MENTIONS' ? 'MENTIONS' : 'ALL',
        channelIds: s.ticker.channelIds,
        reasons: s.ticker.reasons,
      },
      lastAckedTick: tickAckOf.get(`${w.id}:${s.ticker.id}`)?.lastAckedTick ?? 0,
    }));
    let wake = workerWake({
      workerId: w.id,
      workerTokens,
      mentionsImmediate: (ws?.mentions ?? 'IMMEDIATE') === 'IMMEDIATE',
      channels: inputs,
      subscriptions,
      checkPending: (pendingOf.get(w.id) ?? null) !== null,
      tasks: tasksFor(w.id)
        .slice(0, WAKE_TASK_REASONS_MAX)
        .map(({ taskId, eventId, chainIndex, event, title, handle, at, standbyHeld }) => ({ taskId, eventId, chainIndex, event, title, handle, atMs: at.getTime(), ...(standbyHeld ? { standbyHeld } : {}) })),
      now,
    });
    // #2022: the stop notice rides ahead of everything else in the wake (cor:agt:090:04), or is the wake.
    if (stop) {
      if (wake) wake.reasons.unshift(stopReason(stop));
      else wake = { reasons: [stopReason(stop)], channels: [], unread: 0, unreadMentions: 0, exempt: false, anchorAtMs: stop.at.getTime() };
    }
    if (!wake) continue;

    // cor:agt:080:13 — at most one wake per worker per floor, for every caller; a wake inside the window waits.
    // #2022: a stop notice skips the floor (cor:agt:090:04, D-2026-10-16-002).
    const last = Math.max(
      0,
      ...deliveryChannels.filter((d) => d.workerId === w.id).map((d) => d.deliveredAt.getTime()),
      ...deliveryTicks.filter((d) => d.workerId === w.id).map((d) => d.ackedAt.getTime()),
      taskDeliveredOf.get(w.id) ?? 0,
      wakeAckedOf.get(w.id) ?? 0,
    );
    if (last > 0 && now.getTime() - last < floorMs && !hasStop(wake)) continue;

    const a = availabilityOf.get(w.id);
    let proof = signFor(w.id, wake);
    // The proof must verify (MAX_PROOF_CHARS) or the wake could never be acknowledged and would wedge the worker:
    // shed the NEWEST task reasons until it fits. They stay pending for the next wake.
    while (proof.length > MAX_PROOF_CHARS && tasksOf(wake).length > 0) {
      const lastTask = wake.reasons.map((r) => r.kind).lastIndexOf('TASK');
      wake.reasons.splice(lastTask, 1);
      proof = signFor(w.id, wake);
    }
    if (wake.reasons.length === 0) continue;
    issued.push({
      workerId: w.id,
      wake,
      availability: a && recordInEffect(a, now, activity.get(w.id)?.lastActiveAt ?? null) ? { state: a.state, reason: a.reason, until: a.until, setAt: a.setAt } : null,
      proof,
      exempt: wake.exempt,
    });
  }

  // cor:agt:080:15 — the daily budget. Exempt wakes always pass; a withheld wake stays due. A wake that passes
  // RESERVES its slot until it is acknowledged or its proof expires, under one lock per App, so readers running
  // at the same time cannot hand out more than the budget (Diego P2-4).
  const day = utcDay(now);
  const budget = settings.wakeDailyBudget ?? defaultWakeBudget(
    await db.worker.count({ where: { appId: app.id, retiredAt: null } }),
    settings.tickerSelfSubscribeCadenceSeconds,
  );
  let withheld = 0;
  const wakes: DueWakeOut[] = [];
  const deliverySettings = await loadDeliverySettings(db, app.id);
  const passes = (i: (typeof issued)[number]) => {
    const { exempt: _e, ...out } = i;
    const anchorMs = i.wake.anchorAtMs ?? now.getTime();
    // #2022: a stop notice waits for no batching window and no busy delay (cor:agt:090:04; cor:agt:080:27, Proposed).
    const timing = hasStop(i.wake)
      ? { anchorAt: new Date(anchorMs), deliverAfter: now, busyDeadline: now }
      : { anchorAt: new Date(anchorMs), ...batchTiming(deliverySettings, { oldestPostedAt: new Date(anchorMs) }) };
    wakes.push({ ...out, timing });
  };
  // #2755: a PREVIEW is the pure derivation above and nothing else: no reservation, no budget slot, no proof
  // acknowledgement state touched. The dark-worker alarm reads it as the platform, so it must not spend the budget.
  if (args.preview) {
    for (const i of issued) passes(i);
    return { status: 'OK', withheld: 0, wakes, dormant: [], nextAfter, budgetNotice: null };
  }
  if (issued.length > 0) {
    await db.$transaction(async (tx) => {
      // #1708 (Riana P2-1 on #1859): task reasons are decided again HERE, under the authority anchors a revoker takes
      // exclusively (removeAppMember: the App, its org and owner, the removed user), so a revocation either committed
      // before these locks and is seen, or waits for this issue. One sorted call, before any other lock (the key's
      // `authorize` re-takes the App's anchors, which this transaction already holds). The reader decided before the
      // transaction is only a pre-filter; the answer rests on `taskOk`.
      const holderIdOf = new Map(workers.map((w) => [w.id, w.heldByUserId]));
      let taskReaderNow = false;
      const holderNow = new Map<string, boolean>();
      if (taskReader) {
        const holders = [...new Set(workers.map((w) => w.heldByUserId).filter((h): h is string => !!h))];
        const anchors: AuthorityAnchor[] = [
          { kind: 'app', id: app.id },
          ...(app.organizationId ? [{ kind: 'org' as const, id: app.organizationId }] : []),
          ...(app.ownerUserId ? [{ kind: 'user' as const, id: app.ownerUserId }] : []),
          ...(ctx.userId ? [{ kind: 'user' as const, id: ctx.userId }] : []),
          ...holders.map((id) => ({ kind: 'user' as const, id })),
        ];
        await lockAuthorityAnchors(tx, anchors, 'shared');
        // The caller's platform roles are re-read under its user anchor (updateUserRoles takes it exclusively), so a
        // demotion that committed first is seen (Riana, #1859 delta); a deleted caller or revoked key reads no task.
        const txCtx = withoutRequestCaches(ctx, tx);
        const liveCtx = await liveTxContext(ctx, tx).catch((e: unknown) => {
          if (e instanceof Error && e.message === 'Forbidden') return null; // the shared gates' denial; anything else is loud
          throw e;
        });
        taskReaderNow = liveCtx !== null && (await mayReadAppTasks(liveCtx, app.id));
        for (const h of holders) holderNow.set(h, (await holderParticipates(txCtx, app, h)) !== null);
      }
      const taskOk = (workerId: string): boolean => {
        if (!taskReaderNow) return false;
        const h = holderIdOf.get(workerId);
        return !h || holderNow.get(h) === true;
      };
      // A fresh wake whose task reasons are no longer the caller's to see keeps only its other reasons, re-signed.
      for (let n = issued.length - 1; n >= 0; n--) {
        const i = issued[n]!;
        if (tasksOf(i.wake).length === 0 || taskOk(i.workerId)) continue;
        const rest = withoutTasks(i.wake);
        if (!rest) { issued.splice(n, 1); continue; }
        i.wake = rest;
        i.proof = signFor(i.workerId, rest);
      }
      await args.authorize?.(tx, page.map(w => w.id));
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'wakebudget:' + app.id}, 0))`;
      const used = (await tx.appWakeDay.findUnique({ where: { appId_day: { appId: app.id, day } } }))?.wakes ?? 0;
      const cutoff = toNaiveUtc(new Date(now.getTime() - WAKE_PROOF_MAX_AGE_MS));
      const rows = await tx.$queryRaw<Array<{ worker_id: string; wake_key: string; wake: WorkerWake; absorbed_keys: string[] }>>(Prisma.sql`
        SELECT worker_id, wake_key, wake, absorbed_keys FROM app_wake_reservations WHERE app_id = ${app.id} AND reserved_at > ${cutoff}::timestamp`);
      const live = new Map(rows.map((r) => [r.worker_id, r]));
      let consumed = used + live.size;
      const reserve: Array<{ workerId: string; key: string; wake: WorkerWake; absorbed?: string[] }> = [];
      wakes.length = 0;
      withheld = 0;
      for (const i of issued) {
        // An outstanding wake is only this reader's to see if every channel of it is one they may read (R1/B3). For a
        // reader who cannot, it does not exist: they get their own view of what is due, outside that reservation (it
        // is not refreshed and no slot is charged, so only an exempt wake reaches them; the holder's router still owes the
        // outstanding one).
        let stored = live.get(i.workerId);
        // A channel recreated since the wake was issued restarted its seqs: the stored wake can no longer be
        // acknowledged (WAKE_PROOF_STALE), so it is void, not outstanding. Dropped here, or re-issuing it would wedge
        // the worker for as long as a router polls (Rook, #1751 cycle 3).
        // #1708: so is one carrying a task event that no longer asks anything of the worker (the task ended, the alarm's
        // episode passed, the worker acted): re-handing it would deliver exactly what the pre-delivery re-checks refuse.
        // Judged only by a reader of the App's tasks; for anyone else the stored wake is not theirs to see (below).
        const stillPending = new Set([...tasksFor(i.workerId).map(taskKey), ...(stopOf.has(i.workerId) ? [taskKey({ eventId: stopOf.get(i.workerId)!.eventId, chainIndex: 0 })] : [])]);
        // #2022 (Diego #2166 P2-1): so is one carrying a TICK for a worker a `pause` or `halt` now covers (R68), or a
        // stop notice that is no longer the one due: re-handing it would deliver what the stop forbids.
        const staleTask = !!stored && ((taskOk(i.workerId) && tasksOf(stored.wake).some((t) => !stillPending.has(taskKey(t))))
          || stopsOf(stored.wake).some((t) => !stillPending.has(taskKey(t)))
          || (tickStopped.has(i.workerId) && stored.wake.reasons.some((r) => r.kind === 'TICK')));
        if (stored && (staleTask || !stored.wake.channels.every((c) => channelOf.get(c.channelId)?.incarnation === c.incarnation))) {
          await tx.$executeRaw`DELETE FROM app_wake_reservations WHERE worker_id = ${i.workerId}`;
          live.delete(i.workerId);
          consumed--;
          stored = undefined;
        }
        const readable = new Set((countedOf.get(i.workerId) ?? []).map((c) => c.channelId));
        const have = stored && stored.wake.channels.every((c) => readable.has(c.channelId)) && (taskOk(i.workerId) || tasksOf(stored.wake).length === 0)
          ? stored
          : undefined;
        if (stored && !have) {
          // Another wake for the worker is outstanding, and a reservation holds one wake per worker. A second
          // non-exempt wake here would be a delivery no slot paid for (and, with room, a second inside one floor),
          // so it waits for the first to be acknowledged or to lapse; it is not "withheld" by the budget, so no
          // notice is raised. An exempt wake never takes a slot and still passes (Diego, #1751 cycle 4).
          // #2022: a stop notice is never left behind another wake (cor:agt:090:04).
          if (i.exempt || hasStop(i.wake)) passes(i);
          continue;
        }
        if (have) {
          // A wake for this worker is already outstanding. It is handed out AGAIN, exactly, until it is acknowledged
          // or its proof lapses: a second, different wake would be a second delivery against one allowance (and
          // inside one floor), which no acknowledgement-side refusal can undo once the nudge is sent (Diego cycle 3,
          // P2-1). What arrived since stays due, and is the next wake after this one is consumed.
          // #2069: but a reason that fell due AFTER the outstanding wake was issued (a tick, a task event) is not "what
          // arrived since" to wait on a consumer that may never come: an unacknowledged MENTION wake would otherwise hide
          // every later TICK and TASK for as long as it stays outstanding (a dark team). The reservation is rewritten to
          // the current wake: still ONE reservation and ONE slot for the worker, and the old proof still acknowledges
          // exactly what it names.
          if (absorbsNewReason(have.wake, i.wake)) {
            // The descendant remembers every key it absorbed: that lineage, not "some reservation exists", is what lets an
            // earlier proof of the same wake be acknowledged without a second charge (acknowledge.ts).
            reserve.push({ workerId: i.workerId, key: wakeIdentity(identityOf(i.wake)), wake: i.wake, absorbed: [...new Set([...have.absorbed_keys, have.wake_key])] });
            passes(i);
            continue;
          }
          if (have.wake_key !== wakeIdentity(identityOf(i.wake))) {
            // A reservation made before R63 carries no anchor: it takes the fresh one. One that has it keeps it (never restarted).
            have.wake.anchorAtMs ??= i.wake.anchorAtMs ?? null;
            i.wake = have.wake;
            i.exempt = have.wake.exempt;
            i.proof = signFor(i.workerId, have.wake);
          }
          reserve.push({ workerId: i.workerId, key: have.wake_key, wake: have.wake, absorbed: have.absorbed_keys });
          passes(i);
          continue;
        }
        if (!i.exempt) {
          // #2022 (R89): a stop notice counts against the budget but is never withheld by it.
          if (consumed >= budget && !hasStop(i.wake)) { withheld++; continue; }
          consumed++;
          reserve.push({ workerId: i.workerId, key: wakeIdentity(identityOf(i.wake)), wake: i.wake });
        }
        passes(i);
      }
      const nowNaive = toNaiveUtc(now);
      for (const { workerId, key, wake, absorbed } of reserve) {
        await tx.$executeRaw(Prisma.sql`
          INSERT INTO app_wake_reservations (worker_id, app_id, reserved_at, wake_key, wake, absorbed_keys)
          VALUES (${workerId}, ${app.id}, ${nowNaive}::timestamp, ${key}, ${JSON.stringify(wake)}::jsonb,
                  ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(absorbed ?? [])}::jsonb)))
          ON CONFLICT (worker_id) DO UPDATE SET reserved_at = EXCLUDED.reserved_at, app_id = EXCLUDED.app_id,
            wake_key = EXCLUDED.wake_key, wake = EXCLUDED.wake, absorbed_keys = EXCLUDED.absorbed_keys`);
      }
    });
  }
  return {
    status: withheld > 0 ? 'WAKE_BUDGET_EXHAUSTED' : 'OK',
    withheld,
    wakes,
    dormant,
    nextAfter,
    budgetNotice: withheld > 0 ? { appId: app.id, day, withheld } : null,
  };
}
