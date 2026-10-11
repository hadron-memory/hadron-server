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

import { Prisma } from '../../generated/prisma/index.js';
import type { Context } from '../../api/graphql/schema/resolvers.helpers.js';
import { getAccessibleMemoryIds, isAppParticipant } from '../../api/graphql/schema/resolvers.helpers.js';
import { loadWorkersActivity } from '../../api/graphql/schema/resolvers.worker.js';
import { recordInEffect } from '../agentTasks/availability.js';
import { collectRegisterRows } from '../resolveRegister.js';
import { decryptNodeFields } from '../nodeCrypto.js';
import { BROADCAST_MENTION_TOKENS, mentionTokenOf } from '../mentionToken.js';
import { isWorkerDormant, toNaiveUtc } from '../sessionActivity.js';
import {
  relevantMentionCount,
  workerWake,
  type ChannelInput,
  type RoutedMessage,
  type SubscriptionInput,
  type WorkerWake,
} from './wakeRule.js';
import { signWakeProof, wakeIdentity, WAKE_PROOF_MAX_AGE_MS, type WakeRequester } from './wakeProof.js';

/**
 * Messages read per channel per page, and the most one request reads from one channel. Scanning goes on past a
 * full page for as long as some worker still has nothing relevant in what was read (cor:agt:080:08), so a backlog
 * of messages that are not for a worker (its own posts, chatter in a mention-only channel) cannot hide the
 * message that is — see `scanChannel`. The ceiling bounds the work, not the correctness of the common case.
 */
export const WAKE_SCAN_ROWS_PER_CHANNEL = 5_000;
export const WAKE_SCAN_MAX_ROWS_PER_CHANNEL = 50_000;
export const DUE_WAKES_PAGE_DEFAULT = 100;
export const DUE_WAKES_PAGE_MAX = 200;

export type DueWakeOut = {
  workerId: string;
  wake: WorkerWake;
  availability: { state: string; reason: string | null; until: Date | null; setAt: Date } | null;
  proof: string;
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

const identityOf = (wake: WorkerWake) => ({
  channels: wake.channels.map((c) => ({ channelId: c.channelId, incarnation: c.incarnation, through: c.throughSeq })),
  ticks: wake.reasons.flatMap((r) => (r.kind === 'TICK' ? [{ tickerId: r.tickerId, k: r.k }] : [])),
});

const utcDay = (d: Date): Date => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

/** The default daily wake budget: roster × (86,400 ÷ default self-subscribe cadence) × 2 (Q11). */
export function defaultWakeBudget(roster: number, selfSubscribeCadenceSeconds: number): number {
  return Math.floor(roster * (86_400 / selfSubscribeCadenceSeconds) * 2);
}

type Reader = { manager: boolean; userId: string | null };

type AppLike = { id: string; organizationId: string | null; ownerUserId: string | null };

/** Workers of the App the caller may read wakes for: all of them for a manager, else the ones the caller holds. */
async function readableWorkers(
  ctx: Context,
  app: AppLike,
  reader: Reader,
  only: string[] | null,
  after: string | null,
  take: number,
) {
  const where: Prisma.WorkerWhereInput = {
    appId: app.id,
    retiredAt: null,
    ...(reader.manager ? {} : { heldByUserId: reader.userId ?? '__none__' }),
    ...(only ? { id: { in: only } } : {}),
    ...(after ? { AND: [{ id: { gt: after } }] } : {}),
  };
  return ctx.db.worker.findMany({
    where,
    orderBy: { id: 'asc' },
    take,
    select: { id: true, name: true, heldByUserId: true },
  });
}

async function holderAccess(
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

const mayRead = (set: Set<string> | 'all' | null, memoryId: string): boolean => set === 'all' || (set !== null && set.has(memoryId));

function envelopeOf(data: unknown): RoutedMessage | null {
  if (!data || typeof data !== 'object') return null;
  const e = data as Record<string, unknown>;
  return {
    seq: 0,
    authorWorkerId: typeof e.authorWorkerId === 'string' ? e.authorWorkerId : null,
    mentions: Array.isArray(e.mentions) ? e.mentions.filter((v): v is string => typeof v === 'string') : [],
    broadcastWakes: e.broadcastWakes === true,
    managerPost: e.managerPost === true,
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
    const rows = await db.$queryRaw<Array<{ seq: number; author: string | null; mentions: unknown; bw: boolean | null; mp: boolean | null }>>(Prisma.sql`
      SELECT n.seq::int AS seq,
             n.data->>'authorWorkerId' AS author,
             n.data->'mentions' AS mentions,
             (n.data->>'broadcastWakes') = 'true' AS bw,
             (n.data->>'managerPost') = 'true' AS mp
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
    return rows.map((r) => ({
      seq: r.seq,
      authorWorkerId: r.author,
      mentions: Array.isArray(r.mentions) ? (r.mentions as unknown[]).filter((v): v is string => typeof v === 'string') : [],
      broadcastWakes: r.bw === true,
      managerPost: r.mp === true,
    }));
  }
  const rows = await db.$queryRaw<Array<{ seq: number; data: unknown }>>(Prisma.sql`
    SELECT n.seq::int AS seq, n.data
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
    out.push({ ...m, seq: r.seq });
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
type Watcher = { floor: number; workerId: string; tokens: string[]; immediate: boolean; subCovers: boolean; subAll: boolean };

const BROADCAST = BROADCAST_MENTION_TOKENS as readonly string[];

/** Could `m` become (part of) a wake for this watcher? The scan's stopping rule: it must be a real path to one, not a superset. */
function mattersTo(m: RoutedMessage, w: Watcher): boolean {
  if (m.authorWorkerId === w.workerId) return false;
  const direct = m.mentions.some((t) => w.tokens.includes(t));
  const broadcast = !direct && m.mentions.some((t) => BROADCAST.includes(t));
  if (w.immediate && (direct || (broadcast && m.broadcastWakes))) return true;
  if (w.subCovers && (direct || broadcast)) return true;
  return w.subAll;
}

/** The SQL twin of {@link mattersTo}, for the rows still worth fetching: one OR-ed term per unmet watcher. */
function candidatesFor(unmet: Watcher[]): Prisma.Sql {
  const terms = unmet.map((w) => {
    const notOwn = Prisma.sql`(n.data->>'authorWorkerId') IS DISTINCT FROM ${w.workerId}`;
    const parts: Prisma.Sql[] = [];
    if (w.immediate || w.subCovers) parts.push(Prisma.sql`jsonb_exists_any(n.data->'mentions', ${w.tokens}::text[])`);
    if (w.subCovers) parts.push(Prisma.sql`jsonb_exists_any(n.data->'mentions', ${[...BROADCAST]}::text[])`);
    if (w.immediate) parts.push(Prisma.sql`(jsonb_exists_any(n.data->'mentions', ${[...BROADCAST]}::text[]) AND (n.data->>'broadcastWakes') = 'true')`);
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
}): Promise<DueWakesResult> {
  const { ctx, app, reader, requester } = args;
  const now = args.now ?? new Date();
  const first = Math.min(Math.max(args.first ?? DUE_WAKES_PAGE_DEFAULT, 1), DUE_WAKES_PAGE_MAX);
  const db = ctx.db;

  const settings = await db.app.findUniqueOrThrow({
    where: { id: app.id },
    select: { tickerMinCadenceSeconds: true, tickerSelfSubscribeCadenceSeconds: true, wakeDailyBudget: true, sessionDormancyDays: true },
  });

  const page = await readableWorkers(ctx, app, reader, args.workerIds ?? null, args.after ?? null, first + 1);
  const hasMore = page.length > first;
  const workers = page.slice(0, first);
  const empty: DueWakesResult = { status: 'OK', withheld: 0, wakes: [], dormant: [], nextAfter: null, budgetNotice: null };
  if (workers.length === 0) return empty;
  const nextAfter = hasMore ? workers[workers.length - 1]!.id : null;
  const ids = workers.map((w) => w.id);

  const [wakeSettings, availability, activity, subs, deliveryChannels, deliveryTicks, readStates] = await Promise.all([
    db.workerWakeSettings.findMany({ where: { workerId: { in: ids } } }),
    db.workerAvailability.findMany({ where: { workerId: { in: ids } } }),
    loadWorkersActivity(ctx, ids, now),
    db.tickerSubscription.findMany({
      where: { workerId: { in: ids }, endedAt: null, ticker: { appId: app.id, deletedAt: null, enabled: true } },
      include: { ticker: true },
    }),
    db.workerDeliveryChannel.findMany({ where: { workerId: { in: ids } } }),
    db.workerDeliveryTick.findMany({ where: { workerId: { in: ids } } }),
    db.channelReadState.findMany({ where: { workerId: { in: ids } }, select: { workerId: true, channelId: true, lastSeenSeq: true } }),
  ]);
  const settingsOf = new Map(wakeSettings.map((s) => [s.workerId, s]));
  const availabilityOf = new Map(availability.map((a) => [a.workerId, a]));
  const subsOf = new Map<string, typeof subs>();
  for (const s of subs) subsOf.set(s.workerId, [...(subsOf.get(s.workerId) ?? []), s]);
  const deliveredOf = new Map(deliveryChannels.map((d) => [`${d.workerId}:${d.channelId}`, d]));
  const tickAckOf = new Map(deliveryTicks.map((d) => [`${d.workerId}:${d.tickerId}`, d]));
  const seenOf = new Map(readStates.map((r) => [`${r.workerId}:${r.channelId}`, r.lastSeenSeq]));

  // Registers: the channels each worker watches (not POST-only).
  const registers = await Promise.all(ids.map(async (id) => [id, await collectRegisterRows(db, { workerId: id })] as const));
  const channelIds = [...new Set(registers.flatMap(([, c]) => (c?.rows ?? []).filter((r) => r.role !== 'POST').map((r) => r.channelId)))];
  const channelRows = channelIds.length === 0 ? [] : await db.channel.findMany({
    where: { id: { in: channelIds }, deletedAt: null },
    select: { id: true, memoryId: true, lastSeq: true, incarnation: true, memory: { select: { isEncrypted: true } } },
  });
  const channelOf = new Map(channelRows.map((c) => [c.id, c]));

  // R1/B3: the caller's reading right, and each distinct holder's.
  const callerIds = await getAccessibleMemoryIds(ctx);
  const callerCan = (memoryId: string) => callerIds === null || callerIds.includes(memoryId);
  const holderCache = new Map<string, Set<string> | 'all' | null>();

  // Per worker: the channels it counts that BOTH readers may read.
  type Counted = { channelId: string; mentionOnly: boolean; seen: number; delivered: number; head: number };
  const countedOf = new Map<string, Counted[]>();
  for (const w of workers) {
    const rows = registers.find(([id]) => id === w.id)?.[1]?.rows ?? [];
    const holder = w.heldByUserId ? await holderAccess(ctx, app, w.heldByUserId, holderCache) : 'all';
    const list: Counted[] = [];
    for (const r of rows) {
      if (r.role === 'POST') continue;
      const ch = channelOf.get(r.channelId);
      if (!ch) continue;
      if (!callerCan(ch.memoryId) || !mayRead(holder, ch.memoryId)) continue;
      const d = deliveredOf.get(`${w.id}:${ch.id}`);
      // A channel recreated since the delivery was recorded starts over (its seqs restarted).
      const delivered = d && d.channelIncarnation === ch.incarnation ? d.deliveredThroughSeq : 0;
      list.push({ channelId: ch.id, mentionOnly: r.mentionOnly, seen: seenOf.get(`${w.id}:${ch.id}`) ?? 0, delivered, head: ch.lastSeq });
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
        { floor: Math.max(c.seen, c.delivered), workerId: w.id, tokens: own ? [own] : [], immediate: mentionsImmediate, subCovers, subAll },
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
      v: 1,
      kind: 'wake-proof',
      appId: app.id,
      workerId,
      requester,
      channels: wake.channels.map((c) => ({ channelId: c.channelId, incarnation: c.incarnation, through: c.throughSeq })),
      ticks: wake.reasons.flatMap((r) => (r.kind === 'TICK' ? [{ tickerId: r.tickerId, k: r.k }] : [])),
      exempt: wake.exempt,
      issuedAt: now.getTime(),
    });
  const issued: Array<DueWakeOut & { exempt: boolean }> = [];
  const dormant: Array<{ workerId: string; mentions: number }> = [];

  for (const w of workers) {
    const ws = settingsOf.get(w.id);
    const own = mentionTokenOf(w.name);
    const workerTokens = own ? [own] : [];
    const inputs: ChannelInput[] = (countedOf.get(w.id) ?? []).map((c) => {
      const lo = Math.max(c.seen, c.delivered);
      return {
        channelId: c.channelId,
        incarnation: channelOf.get(c.channelId)!.incarnation,
        mentionOnly: c.mentionOnly,
        messages: (messagesOf.get(c.channelId) ?? []).filter((m) => m.seq > lo && m.seq <= c.head),
      };
    });

    const isDormant = isWorkerDormant(activity.get(w.id)?.lastActiveAt, settings.sessionDormancyDays, now);
    if (isDormant) {
      const n = relevantMentionCount(inputs, w.id, workerTokens);
      if (n > 0) dormant.push({ workerId: w.id, mentions: n });
      continue; // never due
    }
    if (ws?.pausedUntil && ws.pausedUntil.getTime() > now.getTime()) continue; // a pause silences ticks AND mentions (Q2)

    const subscriptions: SubscriptionInput[] = (subsOf.get(w.id) ?? []).map((s) => ({
      ticker: {
        id: s.ticker.id,
        anchorAt: s.ticker.anchorAt,
        cadenceSeconds: s.ticker.cadenceSeconds,
        quietHours: s.ticker.quietHours,
        enabled: s.ticker.enabled,
        deletedAt: s.ticker.deletedAt,
        relevance: s.ticker.relevance === 'MENTIONS' ? 'MENTIONS' : 'ALL',
        channelIds: s.ticker.channelIds,
      },
      lastAckedTick: tickAckOf.get(`${w.id}:${s.ticker.id}`)?.lastAckedTick ?? 0,
    }));
    const wake = workerWake({
      workerId: w.id,
      workerTokens,
      mentionsImmediate: (ws?.mentions ?? 'IMMEDIATE') === 'IMMEDIATE',
      channels: inputs,
      subscriptions,
      now,
    });
    if (!wake) continue;

    // cor:agt:080:13 — at most one wake per worker per floor, for every caller; a wake inside the window waits.
    const last = Math.max(
      0,
      ...deliveryChannels.filter((d) => d.workerId === w.id).map((d) => d.deliveredAt.getTime()),
      ...deliveryTicks.filter((d) => d.workerId === w.id).map((d) => d.ackedAt.getTime()),
    );
    if (last > 0 && now.getTime() - last < floorMs) continue;

    const a = availabilityOf.get(w.id);
    const proof = signFor(w.id, wake);
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
  const passes = (i: (typeof issued)[number]) => { const { exempt: _e, ...out } = i; wakes.push(out); };
  if (issued.length > 0) {
    await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'wakebudget:' + app.id}, 0))`;
      const used = (await tx.appWakeDay.findUnique({ where: { appId_day: { appId: app.id, day } } }))?.wakes ?? 0;
      const cutoff = toNaiveUtc(new Date(now.getTime() - WAKE_PROOF_MAX_AGE_MS));
      const rows = await tx.$queryRaw<Array<{ worker_id: string; wake_key: string; wake: WorkerWake }>>(Prisma.sql`
        SELECT worker_id, wake_key, wake FROM app_wake_reservations WHERE app_id = ${app.id} AND reserved_at > ${cutoff}::timestamp`);
      const live = new Map(rows.map((r) => [r.worker_id, r]));
      let consumed = used + live.size;
      const reserve: Array<{ workerId: string; key: string; wake: WorkerWake }> = [];
      wakes.length = 0;
      withheld = 0;
      for (const i of issued) {
        // An outstanding wake is only this reader's to see if every channel of it is one they may read (R1/B3). For a
        // reader who cannot, it does not exist: they get their own view of what is due, outside that reservation (it
        // is not refreshed and no slot is charged; the holder's router still owes the outstanding one).
        const stored = live.get(i.workerId);
        const readable = new Set((countedOf.get(i.workerId) ?? []).map((c) => c.channelId));
        const have = stored && stored.wake.channels.every((c) => readable.has(c.channelId)) ? stored : undefined;
        if (stored && !have) {
          passes(i);
          continue;
        }
        if (have) {
          // A wake for this worker is already outstanding. It is handed out AGAIN, exactly, until it is acknowledged
          // or its proof lapses: a second, different wake would be a second delivery against one allowance (and
          // inside one floor), which no acknowledgement-side refusal can undo once the nudge is sent (Diego cycle 3,
          // P2-1). What arrived since stays due, and is the next wake after this one is consumed.
          if (have.wake_key !== wakeIdentity(identityOf(i.wake))) {
            i.wake = have.wake;
            i.exempt = have.wake.exempt;
            i.proof = signFor(i.workerId, have.wake);
          }
          reserve.push({ workerId: i.workerId, key: have.wake_key, wake: have.wake });
          passes(i);
          continue;
        }
        if (!i.exempt) {
          if (consumed >= budget) { withheld++; continue; }
          consumed++;
          reserve.push({ workerId: i.workerId, key: wakeIdentity(identityOf(i.wake)), wake: i.wake });
        }
        passes(i);
      }
      const nowNaive = toNaiveUtc(now);
      for (const { workerId, key, wake } of reserve) {
        await tx.$executeRaw(Prisma.sql`
          INSERT INTO app_wake_reservations (worker_id, app_id, reserved_at, wake_key, wake)
          VALUES (${workerId}, ${app.id}, ${nowNaive}::timestamp, ${key}, ${JSON.stringify(wake)}::jsonb)
          ON CONFLICT (worker_id) DO UPDATE SET reserved_at = EXCLUDED.reserved_at, app_id = EXCLUDED.app_id,
            wake_key = EXCLUDED.wake_key, wake = EXCLUDED.wake`);
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
