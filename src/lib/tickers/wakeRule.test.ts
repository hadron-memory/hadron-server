import { describe, it, expect } from 'vitest';
import { workerWake, relevantMentionCount, type ChannelInput, type RoutedMessage, type SubscriptionInput } from './wakeRule.js';

const W = 'w-liam';
const tokens = ['liam'];
const NOW = new Date('2026-10-05T09:10:00Z'); // tick 1 of the default ticker below

const msg = (seq: number, over: Partial<RoutedMessage> = {}): RoutedMessage => ({
  seq, authorWorkerId: null, mentions: [], broadcastWakes: false, managerPost: false, ...over,
});
const channel = (id: string, messages: RoutedMessage[], mentionOnly = false): ChannelInput => ({ channelId: id, incarnation: 1, mentionOnly, messages });
const ticker = (over: Record<string, unknown> = {}): SubscriptionInput => ({
  ticker: {
    id: 't1', anchorAt: new Date('2026-10-05T09:00:00Z'), cadenceSeconds: 600, quietHours: null, enabled: true,
    relevance: 'ALL', channelIds: [], ...over,
  } as SubscriptionInput['ticker'],
  lastAckedTick: 0,
});
const run = (channels: ChannelInput[], subs: SubscriptionInput[] = [], extra: { mentionsImmediate?: boolean; now?: Date; checkPending?: boolean } = {}) =>
  workerWake({ workerId: W, workerTokens: tokens, mentionsImmediate: extra.mentionsImmediate ?? true, channels, subscriptions: subs, checkPending: extra.checkPending, now: extra.now ?? NOW });

describe('the due rule — cor:agt:080:08–:12', () => {
  it('nothing unread: nothing due, even on a current tick (S2 of :10)', () => {
    expect(run([channel('c1', [])], [ticker()])).toBeNull();
  });

  it('a mention wakes at once with no subscription, and carries one range per channel', () => {
    const w = run([channel('c1', [msg(5), msg(6, { mentions: ['liam'] }), msg(7)])]);
    expect(w?.reasons).toEqual([{ kind: 'MENTION' }]);
    expect(w?.channels).toEqual([expect.objectContaining({ channelId: 'c1', fromSeq: 5, throughSeq: 7, latestMentionSeq: 6, unread: 3, unreadMentions: 1 })]);
  });

  it('mentions OFF never wake; a tick still can', () => {
    const chans = [channel('c1', [msg(6, { mentions: ['liam'] })])];
    expect(run(chans, [], { mentionsImmediate: false })).toBeNull();
    expect(run(chans, [ticker()], { mentionsImmediate: false })?.reasons).toEqual([{ kind: 'TICK', tickerId: 't1', k: 1 }]);
  });

  it('a tick wakes only with relevant unread, and only when its tick is newer than the acknowledged one', () => {
    const chans = [channel('c1', [msg(3)])];
    expect(run(chans, [ticker()])?.reasons).toEqual([{ kind: 'TICK', tickerId: 't1', k: 1 }]);
    expect(run(chans, [{ ...ticker(), lastAckedTick: 1 }])).toBeNull();
    expect(run(chans, [ticker()], { now: new Date('2026-10-05T09:09:59Z') })).toBeNull(); // the anchor/tick 0 is no tick
  });

  it('one wake lists every reason: a mention and two tickers', () => {
    const chans = [channel('c1', [msg(3, { mentions: ['liam'] })])];
    const w = run(chans, [ticker(), ticker({ id: 't2' })]);
    expect(w?.reasons).toHaveLength(3);
    expect(w?.channels).toHaveLength(1);
  });

  it('a late poll yields one wake for the current tick, not one per missed tick', () => {
    const w = run([channel('c1', [msg(3)])], [ticker()], { now: new Date('2026-10-05T10:05:00Z') });
    expect(w?.reasons).toEqual([{ kind: 'TICK', tickerId: 't1', k: 6 }]);
  });

  it('R63: anchorAtMs is the EARLIEST waiting reason: a mention post, the oldest unacknowledged tick, a task event', () => {
    const post = (seq: number, ms: number) => msg(seq, { mentions: ['liam'], postedAtMs: ms });
    const t0 = Date.parse('2026-10-05T09:00:00Z');
    // Mention only.
    expect(run([channel('c1', [post(5, t0 + 7000)])])?.anchorAtMs).toBe(t0 + 7000);
    // The FIRST still-due mention, not the newest.
    expect(run([channel('c1', [post(5, t0 + 7000), post(6, t0 + 9000)])])?.anchorAtMs).toBe(t0 + 7000);
    // A tick: the oldest unacknowledged tick (tick 1 at anchor + 600 s), whichever tick is current.
    const late = { now: new Date('2026-10-05T10:05:00Z') }; // tick 6
    expect(run([channel('c1', [msg(3)])], [ticker()], late)?.anchorAtMs).toBe(t0 + 600_000);
    expect(run([channel('c1', [msg(3)])], [{ ...ticker(), lastAckedTick: 4 }], late)?.anchorAtMs).toBe(t0 + 5 * 600_000);
    // Mixed: the earlier of a task event and a mention.
    const w = workerWake({ workerId: W, workerTokens: tokens, mentionsImmediate: true, channels: [channel('c1', [post(5, t0 + 9000)])], subscriptions: [], now: NOW,
      tasks: [{ taskId: 't', eventId: 'e', chainIndex: 0, event: 'ASSIGNED', title: 'x', atMs: t0 + 2000 }] });
    expect(w?.anchorAtMs).toBe(t0 + 2000);
    // Nothing carries a time (pure fixtures): null, never invented.
    expect(run([channel('c1', [msg(6, { mentions: ['liam'] })])])?.anchorAtMs).toBeNull();
  });

  it('#2068: an every-tick ticker ticks with nothing unread; one without it stays silent', () => {
    expect(run([channel('c1', [])], [ticker({ reasons: ['every-tick'] })])?.reasons).toEqual([{ kind: 'TICK', tickerId: 't1', k: 1 }]);
    expect(run([], [ticker({ reasons: ['every-tick'] })])?.reasons).toEqual([{ kind: 'TICK', tickerId: 't1', k: 1 }]);
    expect(run([channel('c1', [])], [ticker({ reasons: ['read-team-channel'] })])).toBeNull();
  });

  it('#2068 (R49/R54): no reasons never fires; any one reason that holds fires; read-team-channel needs unread', () => {
    expect(run([channel('c1', [msg(3)])], [ticker({ reasons: [] })])).toBeNull();
    expect(run([channel('c1', [])], [ticker({ reasons: ['read-team-channel'] })])).toBeNull();
    expect(run([channel('c1', [msg(3)])], [ticker({ reasons: ['read-team-channel'] })])?.reasons).toEqual([{ kind: 'TICK', tickerId: 't1', k: 1 }]);
    expect(run([channel('c1', [])], [ticker({ reasons: ['read-team-channel', 'every-tick'] })])?.reasons).toEqual([{ kind: 'TICK', tickerId: 't1', k: 1 }]);
    // An unset reasons (a ticker built before the column) is today's behavior.
    expect(run([channel('c1', [])], [ticker()])).toBeNull();
  });

  it('#2068: relevance narrows read-team-channel only; every-tick ignores it (ALL and MENTIONS)', () => {
    const plain = [channel('c1', [msg(3)])];
    expect(run(plain, [ticker({ relevance: 'MENTIONS', reasons: ['read-team-channel'] })])).toBeNull();
    expect(run(plain, [ticker({ relevance: 'MENTIONS', reasons: ['every-tick'] })])?.reasons).toEqual([{ kind: 'TICK', tickerId: 't1', k: 1 }]);
    expect(run([channel('c1', [])], [ticker({ relevance: 'MENTIONS', reasons: ['every-tick'] })])?.reasons).toEqual([{ kind: 'TICK', tickerId: 't1', k: 1 }]);
    expect(run([channel('c1', [])], [ticker({ relevance: 'ALL', reasons: ['every-tick'] })])?.reasons).toEqual([{ kind: 'TICK', tickerId: 't1', k: 1 }]);
  });

  it('#2068: every-tick never bypasses the tick rules (acked, disabled, not yet a tick)', () => {
    expect(run([channel('c1', [])], [{ ...ticker({ reasons: ['every-tick'] }), lastAckedTick: 1 }])).toBeNull();
    expect(run([channel('c1', [])], [ticker({ reasons: ['every-tick'], enabled: false })])).toBeNull();
    expect(run([channel('c1', [])], [ticker({ reasons: ['every-tick'] })], { now: new Date('2026-10-05T09:09:59Z') })).toBeNull();
  });

  it('#2068: a chat-less tick lists no channel, and a tick with chat still lists its range', () => {
    const quiet = run([channel('c1', [])], [ticker({ reasons: ['every-tick'] })]);
    expect(quiet?.channels).toEqual([]);
    expect(quiet?.unread).toBe(0);
    const busy = run([channel('c1', [msg(3)])], [ticker({ reasons: ['every-tick'] })]);
    expect(busy?.channels).toEqual([expect.objectContaining({ channelId: 'c1', fromSeq: 3, throughSeq: 3 })]);
  });

  it('a disabled ticker does not tick', () => {
    expect(run([channel('c1', [msg(3)])], [ticker({ enabled: false })])).toBeNull();
  });

  it('the worker\'s own posts never count', () => {
    expect(run([channel('c1', [msg(3, { authorWorkerId: W }), msg(4, { authorWorkerId: W, mentions: ['liam'] })])], [ticker()])).toBeNull();
  });

  it('in a mention-only channel a non-mention never wakes, even on an ALL ticker', () => {
    const quiet = [channel('c1', [msg(3), msg(4)], true)];
    expect(run(quiet, [ticker()])).toBeNull();
    const withMention = [channel('c1', [msg(3), msg(4, { mentions: ['liam'] })], true)];
    const w = run(withMention, [ticker()]);
    expect(w?.channels[0]).toMatchObject({ fromSeq: 4, throughSeq: 4, unread: 1 });
  });

  it('a MENTIONS ticker needs a relevant mention; ALL needs any relevant unread', () => {
    const plain = [channel('c1', [msg(3)])];
    expect(run(plain, [ticker({ relevance: 'MENTIONS' })])).toBeNull();
    const ment = [channel('c1', [msg(3, { mentions: ['liam'] })])];
    expect(run(ment, [ticker({ relevance: 'MENTIONS' })], { mentionsImmediate: false })?.reasons).toHaveLength(1);
  });

  it('a ticker with channelIds counts only those channels', () => {
    const chans = [channel('c1', [msg(3)]), channel('c2', [msg(9)])];
    const w = run(chans, [ticker({ channelIds: ['c2'] })]);
    expect(w?.channels.map((c) => c.channelId)).toEqual(['c2']);
  });

  it('broadcasts: an unstamped @all is ordinary unread (waits for the tick); a stamped one wakes at once', () => {
    const unstamped = [channel('c1', [msg(3, { mentions: ['all'] })])];
    expect(run(unstamped)).toBeNull();
    expect(run(unstamped, [ticker()])?.reasons).toEqual([{ kind: 'TICK', tickerId: 't1', k: 1 }]);
    const stamped = [channel('c1', [msg(3, { mentions: ['all'], broadcastWakes: true })])];
    expect(run(stamped)?.reasons).toEqual([{ kind: 'MENTION' }]);
  });

  it('a manager-authored mention is exempt from the budget; a worker\'s is not', () => {
    expect(run([channel('c1', [msg(3, { mentions: ['liam'], managerPost: true })])])?.exempt).toBe(true);
    expect(run([channel('c1', [msg(3, { mentions: ['liam'] })])])?.exempt).toBe(false);
    // A manager-authored message that is only a tick reason does not exempt.
    expect(run([channel('c1', [msg(3, { managerPost: true })])], [ticker()])?.exempt).toBe(false);
  });

  it('counts mentions of a worker that may not be woken (dormant workers are counted, B2)', () => {
    expect(relevantMentionCount([channel('c1', [msg(3, { mentions: ['liam'] }), msg(4, { mentions: ['all'] }), msg(5)])], W, tokens)).toBe(2);
    expect(relevantMentionCount([channel('c1', [msg(3, { mentions: ['liam'] })], true)], W, ['nobody'])).toBe(0);
  });
});

describe('#2138 §3.3 — channel checks and the ticker', () => {
  const checkedAgo = (sec: number) => NOW.getTime() - sec * 1000;
  const checked = (sec: number | null, msgs: RoutedMessage[] = []) => ({ ...channel('c1', msgs), lastCheckedAtMs: sec === null ? null : checkedAgo(sec) });

  it('read-team-channel: due with an unread message and a stale or missing check; not due with a fresh check', () => {
    const unread = [msg(3, { mentions: ['liam'] })];
    const rtc = [ticker({ relevance: 'MENTIONS', reasons: ['read-team-channel'] })];
    // mentionsImmediate off so only the ticker can wake it
    const go = (ch: ChannelInput) => run([ch], rtc, { mentionsImmediate: false });
    expect(go(checked(null, unread))?.reasons).toEqual([{ kind: 'TICK', tickerId: 't1', k: 1 }]);
    expect(go(checked(700, unread))?.reasons).toEqual([{ kind: 'TICK', tickerId: 't1', k: 1 }]); // older than the 600 s cadence
    expect(go(checked(599, unread))).toBeNull(); // younger than the cadence: waits for the next tick
    expect(go(checked(10, unread))).toBeNull();
  });

  it('live-check: due for a stale check with NOTHING unread; not for a fresh check, nor a pending worker', () => {
    const lc = [ticker({ reasons: ['live-check'] })];
    expect(run([checked(null)], lc)?.reasons).toEqual([{ kind: 'TICK', tickerId: 't1', k: 1 }]);
    expect(run([checked(700)], lc)?.reasons).toEqual([{ kind: 'TICK', tickerId: 't1', k: 1 }]);
    expect(run([checked(599)], lc)).toBeNull();
    expect(run([checked(null)], lc, { checkPending: true })).toBeNull();
    expect(run([checked(700)], lc, { checkPending: true })).toBeNull();
  });

  it('live-check lists no channel when nothing is unread, and still obeys the tick schedule and the acknowledged tick', () => {
    const lc = [ticker({ reasons: ['live-check'] })];
    expect(run([checked(null)], lc)?.channels).toEqual([]);
    expect(run([checked(null)], [{ ...ticker({ reasons: ['live-check'] }), lastAckedTick: 1 }])).toBeNull();
    expect(run([checked(null)], lc, { now: new Date('2026-10-05T09:09:59Z') })).toBeNull();
  });

  it('a check on a channel the ticker does not cover does not make it fresh', () => {
    const lc = [ticker({ reasons: ['live-check'], channelIds: ['c1'] })];
    const other = { ...channel('c2', []), lastCheckedAtMs: checkedAgo(5) };
    expect(run([checked(null), other], lc)?.reasons).toEqual([{ kind: 'TICK', tickerId: 't1', k: 1 }]);
    expect(run([checked(5), other], lc)).toBeNull();
  });

  it('every-tick ignores freshness (its meaning is unconditional)', () => {
    expect(run([checked(5)], [ticker({ reasons: ['every-tick'] })])?.reasons).toEqual([{ kind: 'TICK', tickerId: 't1', k: 1 }]);
  });
});
