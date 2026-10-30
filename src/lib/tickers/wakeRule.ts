// The due-wake rule for ONE worker — #1748, cor:agt:080:08–:12 (plan §4.2).
//
// Pure: everything the database knows is handed in, so the rule is testable
// without one and `dueWakes` is only the loading around it. A worker's wake
// merges every reason into ONE wake with one seq range per channel; it never
// moves the read position (cor:agt:080:16), and counts only what is above BOTH
// the read position and the delivered-through seq.

import { mentionReach } from '../mentionReach.js';
import { BROADCAST_MENTION_TOKENS } from '../mentionToken.js';
import { currentTick, oldestUnackedTickAt, type TickerSchedule } from './ticks.js';

/** One chat message, reduced to what routing needs. Never a body, author name or mention text outside this module. */
export type RoutedMessage = {
  seq: number;
  authorWorkerId: string | null;
  mentions: readonly string[];
  /** Server-written at post time (cor:agt:080:14, N3): the author could wake everyone. */
  broadcastWakes: boolean;
  teamTagsVersion?: number;
  teamBroadcastWorkerIds?: readonly string[];
  /** Server-written at post time: the author manages the App (cor:agt:080:15 budget exemption). */
  managerPost: boolean;
  /** S7 (#2023): a person, not a worker or the system, wrote it. Read only for a worker on standby (standby.ts). */
  humanAuthored?: boolean;
  /** R63: when the message was posted (ms since epoch); the anchor of a mention. Optional so pure-rule fixtures need not carry it. */
  postedAtMs?: number;
};

export type ChannelInput = {
  channelId: string;
  incarnation: number;
  /** The register marks this channel mention-only for the worker. */
  mentionOnly: boolean;
  /** #2138 §3.1: when the worker last CHECKED this channel (ms), or null/absent when it never has. */
  lastCheckedAtMs?: number | null;
  /** Messages above both the read position and the delivered-through seq, up to the head. */
  messages: RoutedMessage[];
};

export type SubscriptionInput = {
  ticker: TickerSchedule & { id: string; relevance: 'ALL' | 'MENTIONS'; channelIds: string[]; /** #2068: why it fires (cor:agt:080:10). Default read-team-channel. */ reasons?: readonly string[] };
  lastAckedTick: number;
};

export type WakeChannel = { channelId: string; incarnation: number; fromSeq: number; throughSeq: number; latestMentionSeq: number | null; unread: number; unreadMentions: number };

/**
 * #1708 — a task event the worker must act on (src/lib/agentTasks/taskWakes.ts). `title` is the team's own
 * words for the task, carried so the nudge can name it; it reaches only a requester who may read the task
 * (cor:agt:050:21). `chainIndex` is 0 except for an alarm's woken position.
 */
export type TaskWakeReason = {
  kind: 'TASK';
  taskId: string;
  eventId: string;
  chainIndex: number;
  event: 'ASSIGNED' | 'REASSIGNED' | 'MATCHED' | 'CHILD_FINISHED' | 'ALARM' | 'END_SESSION';
  title: string;
  /** #2553: the task's handle, printed first in the nudge. */
  handle: string;
  /** S7 (R90): messages held from a standby worker and passed at this assignment; rides the event, so returned once. */
  standbyHeld?: number;
};

/**
 * #2022 (S6, cor:agt:090:04) — a stop-signal notice: the newest one the worker hasn't been delivered. Only a `halt`'s
 * stop notice interrupts. Acknowledged like a task event (its event id at chain position 0), so never a chat mark.
 */
export type StopWakeReason = {
  kind: 'STOP';
  eventId: string;
  signalId: string;
  level: 'pause-dispatch' | 'pause' | 'halt';
  notice: 'stop' | 'resume';
  interrupt: boolean;
};

export type WakeReason = { kind: 'MENTION' } | { kind: 'TICK'; tickerId: string; k: number; action?: import('./tickActions.js').StoredTickAction | import('./tickActions.js').PublicTickAction } | TaskWakeReason | StopWakeReason;

/** A task wake handed to the rule: already gated for the requester, oldest first. */
export type TaskWakeInput = Omit<TaskWakeReason, 'kind'> & { /** R63: the task event's time (ms), the anchor of a task reason. */ atMs?: number };

export type WorkerWake = {
  reasons: WakeReason[];
  channels: WakeChannel[];
  unread: number;
  unreadMentions: number;
  /** A manager-authored mention is among the reasons: exempt from the daily budget. */
  exempt: boolean;
  /**
   * R63 (#2017): when the earliest waiting reason became due (ms): a mention's first still-due post, a tick's OLDEST
   * unacknowledged tick time, a task event's time. Null when no reason carries a time. Never restarted by a re-offer or a join.
   */
  anchorAtMs?: number | null;
};

type Stats = {
  relevant: RoutedMessage[];
  mentions: RoutedMessage[];
  /** Mentions that wake at once: direct, or a broadcast whose author could (the stamp). */
  immediate: RoutedMessage[];
};

function statsOf(ch: ChannelInput, workerId: string, workerTokens: readonly string[]): Stats {
  const relevant: RoutedMessage[] = [];
  const mentions: RoutedMessage[] = [];
  const immediate: RoutedMessage[] = [];
  for (const m of ch.messages) {
    if (m.authorWorkerId === workerId) continue;
    const direct = m.mentions.some(t => workerTokens.includes(t));
    const legacyBroadcast = m.teamTagsVersion !== 1 && m.mentions.some(t => (BROADCAST_MENTION_TOKENS as readonly string[]).includes(t));
    const mentioned = m.teamTagsVersion === 1 ? mentionReach(m, workerTokens, [workerId]) !== null : direct || legacyBroadcast;
    // In a mention-only channel only mentions count (#8088).
    if (ch.mentionOnly && !mentioned) continue;
    relevant.push(m);
    if (mentioned) {
      mentions.push(m);
      if (m.teamTagsVersion === 1 || direct || m.broadcastWakes) immediate.push(m);
    }
  }
  return { relevant, mentions, immediate };
}

/**
 * Relevant mentions the worker has, whether or not it may be woken for them
 * (dormant workers are counted, never silently dropped: cor:agt:080:11, B2).
 */
export function relevantMentionCount(channels: ChannelInput[], workerId: string, workerTokens: readonly string[]): number {
  return channels.reduce((n, ch) => n + statsOf(ch, workerId, workerTokens).mentions.length, 0);
}

export function workerWake(args: {
  workerId: string;
  workerTokens: readonly string[];
  mentionsImmediate: boolean;
  channels: ChannelInput[];
  subscriptions: SubscriptionInput[];
  /** #1708 — task events the worker is due for. They wake at once, like a mention, whatever the mentions setting. */
  tasks?: TaskWakeInput[];
  /** #2138 §3.3: the worker is PENDING (not expected to check: no task, standby, isolated, paused): `live-check` is never due. */
  checkPending?: boolean;
  now: Date;
}): WorkerWake | null {
  const { workerId, workerTokens, channels, subscriptions, now } = args;
  const perChannel = new Map(channels.map((ch) => [ch.channelId, { ch, s: statsOf(ch, workerId, workerTokens) }]));
  const reasons: WakeReason[] = [];
  /** channelId → the contributing flag; a channel is listed only when some reason points at it. */
  const included = new Set<string>();
  let exempt = false;
  const anchors: number[] = [];

  // cor:agt:080:09 — a relevant mention wakes at once, regardless of quiet hours and subscriptions.
  if (args.mentionsImmediate) {
    let any = false;
    for (const { ch, s } of perChannel.values()) {
      if (s.immediate.length === 0) continue;
      any = true;
      included.add(ch.channelId);
      if (s.immediate.some((m) => m.managerPost)) exempt = true;
      for (const m of s.immediate) if (m.postedAtMs !== undefined) anchors.push(m.postedAtMs);
    }
    if (any) reasons.push({ kind: 'MENTION' });
  }

  // cor:agt:080:10 — each live subscription whose current tick is newer than the last acknowledged.
  for (const sub of subscriptions) {
    const k = currentTick(sub.ticker, now);
    if (k === null || k <= sub.lastAckedTick) continue;
    const scope = sub.ticker.channelIds.length > 0 ? new Set(sub.ticker.channelIds) : null;
    let any = false;
    for (const { ch, s } of perChannel.values()) {
      if (scope && !scope.has(ch.channelId)) continue;
      const hits = sub.ticker.relevance === 'MENTIONS' ? s.mentions : s.relevant;
      if (hits.length === 0) continue;
      any = true;
      included.add(ch.channelId);
    }
    // #2068 (Holger R49): the ticker's reasons decide whether it fires; any one that holds fires it. Every other tick rule
    // above (schedule, acknowledged tick) still holds. No reasons = never.
    const why = sub.ticker.reasons ?? ['read-team-channel'];
    // #2138 §3.3: a worker that CHECKED within the ticker's cadence is not nudged again for it. `read-team-channel` waits for
    // the next tick (a worst case near twice the period is accepted); `live-check` is the stale-check nudge, whatever is unread,
    // and never for a PENDING worker. The check is judged on the channels this ticker covers (all the worker's when it names none).
    const cadenceMs = sub.ticker.cadenceSeconds * 1000;
    const covered = [...perChannel.values()].filter(({ ch }) => !scope || scope.has(ch.channelId));
    const fresh = covered.some(({ ch }) => ch.lastCheckedAtMs != null && now.getTime() - ch.lastCheckedAtMs < cadenceMs);
    if (
      why.includes('every-tick') ||
      (why.includes('read-team-channel') && any && !fresh) ||
      (why.includes('live-check') && !args.checkPending && !fresh)
    ) {
      reasons.push({ kind: 'TICK', tickerId: sub.ticker.id, k });
      anchors.push(oldestUnackedTickAt(sub.ticker, sub.lastAckedTick, k).getTime());
    }
  }

  for (const t of args.tasks ?? []) {
    reasons.push({ kind: 'TASK', taskId: t.taskId, eventId: t.eventId, chainIndex: t.chainIndex, event: t.event, title: t.title, handle: t.handle, ...(t.standbyHeld ? { standbyHeld: t.standbyHeld } : {}) });
    if (t.atMs !== undefined) anchors.push(t.atMs);
  }

  if (reasons.length === 0) return null;

  const out: WakeChannel[] = [];
  for (const id of included) {
    const { ch, s } = perChannel.get(id)!;
    out.push({
      channelId: ch.channelId,
      incarnation: ch.incarnation,
      fromSeq: Math.min(...s.relevant.map((m) => m.seq)),
      throughSeq: Math.max(...s.relevant.map((m) => m.seq)),
      latestMentionSeq: s.mentions.length > 0 ? Math.max(...s.mentions.map((m) => m.seq)) : null,
      unread: s.relevant.length,
      unreadMentions: s.mentions.length,
    });
  }
  out.sort((a, b) => a.channelId.localeCompare(b.channelId));
  return {
    reasons,
    channels: out,
    unread: out.reduce((n, c) => n + c.unread, 0),
    unreadMentions: out.reduce((n, c) => n + c.unreadMentions, 0),
    exempt,
    anchorAtMs: anchors.length > 0 ? Math.min(...anchors) : null,
  };
}
