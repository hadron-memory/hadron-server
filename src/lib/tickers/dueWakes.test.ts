import { WORKER_SIGNATURE_DEFAULTS } from '../workerSignature.js';
/**
 * #1748 — Tickers S2 (epic #1659): `dueWakes`, the broadcast stamp, wake proofs
 * and `acknowledgeWakes`. Acceptance list of the issue, one block per heading.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { GraphQLError } from 'graphql';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../id.js';
import { ensureChannelWithRoot } from '../channels.js';
import { appendChatMessage } from '../chatRoot.js';
import { getMemoryEncryptionInfo } from '../nodeCrypto.js';
import { runAsActor } from '../requestActor.js';
import { resolvers, type Context } from '../../api/graphql/schema/resolvers.js';
import { teamChatMutations } from '../../api/graphql/schema/resolvers.teamChat.js';
import { loadWorkersActivity } from '../../api/graphql/schema/resolvers.worker.js';
import { computeDueWakes } from './dueWakes.js';
import { isSessionDormant, isWorkerDormant } from '../sessionActivity.js';
import { wakeStampsFor } from './postStamp.js';
import { signWakeProof, verifyWakeProof } from './wakeProof.js';
import { teamAttentionPage } from '../teamAttention.js';

vi.mock('../bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));
vi.mock('../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../integrations/github/syncGraphFromGithub.js', () => ({ syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }) }));

const Q = resolvers.Query as any;
const M = resolvers.Mutation as any;

const ctx = (userId?: string, extra: Partial<Context> = {}): Context => ({ db, userId, roles: ['READER'], ...extra }) as Context;
async function code(p: Promise<unknown>): Promise<string | undefined> {
  try { await p; } catch (e) { expect(e).toBeInstanceOf(GraphQLError); return (e as GraphQLError).extensions?.code as string; }
  return undefined;
}
const DAY = 86_400_000;
const stampsOf = (c: Context, ...rest: [any, string | null, string[]]) => db.$transaction((tx) => wakeStampsFor(c, tx, ...rest));

let org: { id: string; urn: string };
let manager: { id: string };
let holderA: { id: string };
let holderB: { id: string };
let outsider: { id: string };
let app: { id: string; urn: string };
let agent: { id: string };
let memory: { id: string };
let channel: { id: string; memoryId: string; loc: string; chatRootNodeId: string };
let liam: { id: string; name: string };
let rook: { id: string; name: string };
let post: ReturnType<typeof vi.spyOn>;

async function mkUser(n: number) {
  return db.user.create({ data: { id: generateId(), githubId: 97_000 + n, githubUsername: `dw-${n}-${Date.now()}-${Math.floor(Math.random() * 1e5)}`, roles: ['READER'] }, select: { id: true } });
}
async function mkWorker(name: string, extra: Record<string, unknown> = {}, watch = true) {
  const w = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId: app.id, agentId: agent.id, name, slug: name.toLowerCase(), ...extra }, select: { id: true, name: true } });
  if (watch) await db.registerEntry.create({ data: { id: generateId(), appId: app.id, channelId: channel.id, attendeeWorkerId: w.id, role: 'BOTH' } });
  return w;
}
async function mkChannel(memoryId: string, loc: string, createdBy: string) {
  const made = await ensureChannelWithRoot(db, { memoryId, loc, name: loc, createdBy });
  return { id: made.channel.id, memoryId, loc, chatRootNodeId: made.rootId };
}
async function say(ch: typeof channel, body: string, data: Record<string, unknown> = {}) {
  const enc = await getMemoryEncryptionInfo(db, ch.memoryId);
  return appendChatMessage(db, { id: ch.chatRootNodeId, memoryId: ch.memoryId, loc: ch.loc }, enc, async ({ tx, seq, msgNum }) =>
    tx.node.create({ data: { id: generateId(), memoryId: ch.memoryId, loc: `${ch.loc}:messages:${msgNum}`, name: msgNum, nodeType: 'chat-message', seq, messageChannelId: ch.id, content: body, data: { mentions: [], ...data } } }),
    { asChannel: true });
}
const mention = (...mentions: string[]) => ({ mentions });
const mkTicker = (over: Record<string, unknown> = {}) =>
  db.ticker.create({ data: { id: generateId(), appId: app.id, ownerUserId: manager.id, name: 'Eng', slug: `eng-${generateId().slice(-5)}`, cadenceSeconds: 600, anchorAt: new Date(Date.now() - 3600_000), ...over } });
const subscribe = (tickerId: string, workerId: string) =>
  db.tickerSubscription.create({ data: { id: generateId(), tickerId, workerId, createdBy: manager.id } });
const due = (c: Context, extra: Record<string, unknown> = {}) => Q.dueWakes({}, { appRef: app.id, ...extra }, c);
const ids = (page: any) => page.wakes.map((w: any) => w.worker.id).sort();
/** Moves every floor clock an hour back: channel deliveries and, since #2072 (R53), the textless wakes' receipts. */
const pastFloor = async (ageMs = 3600_000) => {
  const ago = new Date(Date.now() - ageMs);
  await db.workerDeliveryChannel.updateMany({ data: { deliveredAt: ago } });
  await db.workerWakeAck.updateMany({ data: { ackedAt: ago } });
};
/** A proof as it was issued `ms` earlier: what replaying it looks like after `pastFloor(ms)` moved the clocks back. */
const issuedEarlier = (proof: string, ms: number) => { const p = verifyWakeProof(proof); return signWakeProof({ ...p, issuedAt: p.issuedAt - ms }); };

beforeEach(async () => {
  await cleanDb(db);
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
  org = await db.organization.create({ data: { id: generateId(), name: 'dw-org', urn: `dw-org-${suffix}.com` } });
  [manager, holderA, holderB, outsider] = [await mkUser(1), await mkUser(2), await mkUser(3), await mkUser(4)];
  await db.orgMember.create({ data: { id: generateId(), organizationId: org.id, userId: manager.id, role: 'ADMIN' } });
  agent = await db.agent.create({ data: { id: generateId(), organizationId: org.id, name: 'Team', urn: `${org.urn}:team`, visibility: 'ORGANIZATION' } });
  app = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Team', urn: `${org.urn}:team` } });
  await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
  for (const u of [holderA, holderB]) await db.appMember.create({ data: { appId: app.id, userId: u.id, role: 'member' } });
  memory = await db.memory.create({ data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:team-shared`, name: 'shared', class: 'app', appId: app.id, sharedMemoryOfAgentId: agent.id } });
  channel = await mkChannel(memory.id, 'chats:team', manager.id);
  await db.channel.update({ where: { id: channel.id }, data: {} });
  liam = await mkWorker('Liam', { heldByUserId: holderA.id, heldAt: new Date() });
  rook = await mkWorker('Rook', { heldByUserId: holderB.id, heldAt: new Date() });
  post = vi.spyOn(teamChatMutations, 'createTeamChatMessage').mockResolvedValue({} as never);
});
afterEach(() => post.mockRestore());

describe('who is due — the headline (red against the session-based model)', () => {
  it('a worker with a lapsed session and one with no session at all are both due', async () => {
    await db.session.create({ data: { id: generateId(), appId: app.id, userId: holderA.id, workerId: liam.id, agentId: agent.id, type: 'DEVELOPER', startedAt: new Date(Date.now() - 3 * DAY), updatedAt: new Date(Date.now() - 3 * DAY) } });
    await say(channel, 'hi', mention('liam', 'rook'));
    const page = await due(ctx(manager.id));
    expect(ids(page)).toEqual([liam.id, rook.id].sort());
    expect(page.status).toBe('OK');
    expect(page.wakes[0].reasons[0].kind).toBe('MENTION');
    expect(page.wakes[0].proof).toMatch(/\./);
  });

  it('unavailable and unheld workers are still due, and the wake carries the availability mark', async () => {
    const orphan = await mkWorker('Orphan');
    await db.workerAvailability.create({ data: { workerId: liam.id, state: 'unavailable', reason: 'out-of-tokens', setAt: new Date(), setBy: 'worker' } });
    await say(channel, 'hi', mention('liam', 'orphan'));
    const page = await due(ctx(manager.id));
    expect(ids(page)).toEqual([liam.id, orphan.id].sort());
    expect(page.wakes.find((w: any) => w.worker.id === liam.id).availability).toMatchObject({ state: 'unavailable', reason: 'out-of-tokens' });
  });
});

describe('never due: retired, paused, dormant', () => {
  it('a retired worker, a paused worker; a pause silences ticks and mentions; mentions OFF silences only mentions', async () => {
    await db.worker.update({ where: { id: rook.id }, data: { retiredAt: new Date() } });
    await db.workerWakeSettings.create({ data: { workerId: liam.id, pausedUntil: new Date(Date.now() + 3600_000) } });
    await say(channel, 'hi', mention('liam', 'rook'));
    expect(ids(await due(ctx(manager.id)))).toEqual([]);

    await db.workerWakeSettings.update({ where: { workerId: liam.id }, data: { pausedUntil: new Date(Date.now() - 1000) } });
    expect(ids(await due(ctx(manager.id)))).toEqual([liam.id]);

    await db.workerWakeSettings.update({ where: { workerId: liam.id }, data: { mentions: 'OFF' } });
    await db.appWakeReservation.deleteMany(); // the mention wake issued above was delivered or lapsed
    expect(ids(await due(ctx(manager.id)))).toEqual([]);
    const t = await mkTicker();
    await subscribe(t.id, liam.id);
    const page = await due(ctx(manager.id));
    expect(ids(page)).toEqual([liam.id]);
    expect(page.wakes[0].reasons.map((r: any) => r.kind)).toEqual(['TICK']);
  });

  it('a dormant worker is never due; its mentions are counted where a router sees them', async () => {
    await db.session.create({ data: { id: generateId(), appId: app.id, userId: holderA.id, workerId: liam.id, agentId: agent.id, type: 'DEVELOPER', startedAt: new Date(Date.now() - 100 * DAY), updatedAt: new Date(Date.now() - 100 * DAY), endedAt: new Date(Date.now() - 100 * DAY) } });
    await say(channel, 'hi', mention('liam'));
    await say(channel, 'again', mention('liam', 'all'));
    const page = await due(ctx(manager.id));
    expect(ids(page)).toEqual([]);
    expect(page.dormant).toEqual([expect.objectContaining({ mentions: 2, worker: expect.objectContaining({ id: liam.id }) })]);
  });

  it('dormancy: one dormant and one recent session is not dormant; all dormant is; never-bound is not', async () => {
    const old = new Date(Date.now() - 120 * DAY);
    const mkSession = (workerId: string, at: Date, ended = true) =>
      db.session.create({ data: { id: generateId(), appId: app.id, userId: holderA.id, workerId, agentId: agent.id, type: 'DEVELOPER', startedAt: at, updatedAt: at, endedAt: ended ? at : null } });
    await mkSession(liam.id, old);
    await mkSession(liam.id, new Date(Date.now() - 1 * DAY));
    await mkSession(rook.id, old);
    await mkSession(rook.id, new Date(Date.now() - 95 * DAY));
    const never = await mkWorker('Nova');
    const act = await loadWorkersActivity(ctx(manager.id), [liam.id, rook.id, never.id], new Date());
    expect(isWorkerDormant(act.get(liam.id)?.lastActiveAt, 90, new Date())).toBe(false);
    expect(isWorkerDormant(act.get(rook.id)?.lastActiveAt, 90, new Date())).toBe(true);
    expect(isWorkerDormant(act.get(never.id)?.lastActiveAt, 90, new Date())).toBe(false);
  });

  it('differential: the SQL fold agrees with isSessionDormant session by session', async () => {
    const now = new Date();
    const ages = [1, 20, 89, 91, 150, 400];
    const rows: Array<{ workerId: string; sessions: Array<{ startedAt: Date; updatedAt: Date; endedAt: Date | null; autoExpiredAt: Date | null }> }> = [];
    for (const [i, a] of ages.entries()) {
      const w = await mkWorker(`Diff${i}`, {}, false);
      const sessions = [] as typeof rows[number]['sessions'];
      for (const k of [a, a + 30]) {
        const at = new Date(now.getTime() - k * DAY);
        const ended = (i + k) % 2 === 0 ? new Date(at.getTime() + 3600_000) : null;
        const auto = k % 3 === 0 ? new Date(at.getTime() + 1000) : null;
        await db.session.create({ data: { id: generateId(), appId: app.id, userId: holderA.id, workerId: w.id, agentId: agent.id, type: 'DEVELOPER', startedAt: at, updatedAt: new Date(at.getTime() + 1800_000), endedAt: ended, autoExpiredAt: auto } });
        sessions.push({ startedAt: at, updatedAt: new Date(at.getTime() + 1800_000), endedAt: ended, autoExpiredAt: auto });
      }
      rows.push({ workerId: w.id, sessions });
    }
    const act = await loadWorkersActivity(ctx(manager.id), rows.map((r) => r.workerId), now);
    for (const r of rows) {
      const expected = r.sessions.every((s) => isSessionDormant(s, null, 90, now));
      expect(isWorkerDormant(act.get(r.workerId)?.lastActiveAt, 90, now), `worker ${r.workerId}`).toBe(expected);
    }
  });
});

describe('ticks and relevance through the whole loader', () => {
  it('a tick wakes a subscriber with relevant unread, once, with the ticker as the reason', async () => {
    const t = await mkTicker();
    await subscribe(t.id, liam.id);
    await say(channel, 'plain news');
    const page = await due(ctx(manager.id));
    expect(page.wakes).toHaveLength(1);
    expect(page.wakes[0].reasons).toEqual([{ kind: 'TICK', ticker: expect.objectContaining({ id: t.id }), task: null, tickDueAt: expect.any(Date) }]);
    expect(page.wakes[0].channels[0]).toMatchObject({ fromSeq: 1, throughSeq: 1 });
    expect(page.wakes[0]).toMatchObject({ unread: 1, unreadMentions: 0 });
  });

  it('no relevant unread, no wake; a disabled or deleted ticker does not tick', async () => {
    const t = await mkTicker();
    await subscribe(t.id, liam.id);
    expect(ids(await due(ctx(manager.id)))).toEqual([]);
    await say(channel, 'news');
    await db.ticker.update({ where: { id: t.id }, data: { enabled: false } });
    expect(ids(await due(ctx(manager.id)))).toEqual([]);
    await db.ticker.update({ where: { id: t.id }, data: { enabled: true, deletedAt: new Date() } });
    expect(ids(await due(ctx(manager.id)))).toEqual([]);
  });

  it('the worker\'s own posts never count, nor messages at or below its read position', async () => {
    const t = await mkTicker();
    await subscribe(t.id, liam.id);
    await say(channel, 'mine', { authorWorkerId: liam.id });
    await say(channel, 'read already');
    await db.channelReadState.create({ data: { id: generateId(), workerId: liam.id, appId: app.id, channelId: channel.id, lastSeenSeq: 2 } });
    expect(ids(await due(ctx(manager.id)))).toEqual([]);
    await say(channel, 'new');
    expect((await due(ctx(manager.id))).wakes[0].channels[0]).toMatchObject({ fromSeq: 3, throughSeq: 3 });
  });

  it('a mention-only register entry limits what even an ALL ticker counts', async () => {
    await db.registerEntry.updateMany({ where: { attendeeWorkerId: liam.id }, data: { mentionOnly: true } });
    const t = await mkTicker();
    await subscribe(t.id, liam.id);
    await say(channel, 'plain');
    expect(ids(await due(ctx(manager.id)))).toEqual([]);
    await say(channel, 'for you', mention('liam'));
    const w = (await due(ctx(manager.id))).wakes[0];
    expect(w.channels[0]).toMatchObject({ fromSeq: 2, throughSeq: 2, latestMentionSeq: 2 });
  });
});

describe('#2017 R63 — when a wake may be typed: anchorAt, deliverAfter, busyDeadline', () => {
  const T0 = new Date('2026-10-19T02:00:00Z');
  const timing = (w: any) => ({ anchorAt: w.anchorAt.toISOString(), deliverAfter: w.deliverAfter.toISOString(), busyDeadline: w.busyDeadline.toISOString() });
  const at = (iso: string) => new Date(iso);
  let window: number; let busy: number;
  beforeEach(async () => {
    const s = await db.app.findUniqueOrThrow({ where: { id: app.id }, select: { tickerMinCadenceSeconds: true, deliveryBusyDelaySeconds: true } });
    window = s.tickerMinCadenceSeconds; busy = s.deliveryBusyDelaySeconds;
  });
  const plus = (d: Date, sec: number) => new Date(d.getTime() + sec * 1000).toISOString();

  it('a mention anchors on the FIRST still-due post; later arrivals never slide it', async () => {
    await say(channel, 'first', mention('liam'));
    await say(channel, 'second', mention('liam'));
    await db.node.updateMany({ where: { messageChannelId: channel.id, seq: 1 } as never, data: { createdAt: T0 } });
    await db.node.updateMany({ where: { messageChannelId: channel.id, seq: 2 } as never, data: { createdAt: new Date(T0.getTime() + 600_000) } });
    const w = (await due(ctx(manager.id))).wakes[0];
    expect(timing(w)).toEqual({ anchorAt: T0.toISOString(), deliverAfter: plus(T0, window), busyDeadline: plus(T0, busy) });
  });

  it('a channel-empty tick anchors on the OLDEST unacknowledged tick, not the newest', async () => {
    const t = await mkTicker({ cadenceSeconds: 600, anchorAt: at('2026-10-19T00:00:00Z') });
    await subscribe(t.id, liam.id);
    await say(channel, 'plain news'); // an ALL ticker needs relevant unread; the anchor is still the tick, not the post
    await db.workerDeliveryTick.create({ data: { workerId: liam.id, tickerId: t.id, lastAckedTick: 2, ackedAt: new Date(Date.now() - 86_400_000) } });
    const w = (await due(ctx(manager.id))).wakes[0];
    // The first tick after the acknowledged tick 2 is tick 3: anchor + 3 x 600 s.
    expect(w.reasons.map((r: any) => r.kind)).toEqual(['TICK']);
    expect(w.anchorAt.toISOString()).toBe('2026-10-19T00:30:00.000Z');
    expect(w.busyDeadline.toISOString()).toBe(plus(w.anchorAt, busy));
  });

  it('a mixed wake anchors on its EARLIEST reason; a re-offer never restarts it', async () => {
    const tickAnchor = new Date(Date.now() - 3_600_000);
    const t = await mkTicker({ cadenceSeconds: 600, anchorAt: tickAnchor });
    await subscribe(t.id, liam.id);
    await say(channel, 'for you', mention('liam'));
    const posted = new Date(Date.now() - 600_000);
    await db.node.updateMany({ where: { messageChannelId: channel.id }, data: { createdAt: posted } });
    const first = (await due(ctx(manager.id))).wakes[0];
    expect(first.reasons.map((r: any) => r.kind).sort()).toEqual(['MENTION', 'TICK']);
    // The oldest unacknowledged tick (tick 1, 10 minutes after the ticker's anchor) is older than the post.
    expect(first.anchorAt.toISOString()).toBe(new Date(tickAnchor.getTime() + 600_000).toISOString());
    await say(channel, 'and again', mention('liam')); // arrives later: the outstanding wake is re-offered
    const again = (await due(ctx(manager.id))).wakes[0];
    expect(timing(again)).toEqual(timing(first));
  });
});

describe('#2069 — an outstanding wake absorbs reasons that fall due later', () => {
  const kinds = (w: any) => w.reasons.map((r: any) => r.kind).sort();

  it('an unacknowledged MENTION wake does not hide a tick that falls due after it: one wake, both reasons, one slot', async () => {
    await say(channel, 'for you', mention('liam'));
    const first = (await due(ctx(manager.id))).wakes[0];
    expect(kinds(first)).toEqual(['MENTION']);
    const t = await mkTicker();
    await subscribe(t.id, liam.id);
    const again = (await due(ctx(manager.id))).wakes;
    expect(again).toHaveLength(1);
    expect(kinds(again[0])).toEqual(['MENTION', 'TICK']);
    const slots = await db.$queryRaw<Array<{ n: bigint }>>`SELECT count(*)::bigint n FROM app_wake_reservations WHERE worker_id = ${liam.id}`;
    expect(Number(slots[0]!.n)).toBe(1);
    const ack = await M.acknowledgeWakes({}, { proofs: [again[0].proof] }, ctx(manager.id));
    expect(ack.acknowledged).toBe(1);
    const row = await db.workerDeliveryTick.findFirstOrThrow({ where: { workerId: liam.id, tickerId: t.id } });
    expect(row.lastAckedTick).toBeGreaterThanOrEqual(1);
    await db.workerDeliveryChannel.updateMany({ data: { deliveredAt: new Date(Date.now() - 3600_000) } });
    await db.workerDeliveryTick.updateMany({ data: { ackedAt: new Date(Date.now() - 3600_000) } });
    expect(ids(await due(ctx(manager.id)))).toEqual([]);
  });

  it('control: a mention that only GROWS the outstanding wake does not rewrite it (the new one waits, as before)', async () => {
    await say(channel, 'first', mention('liam'));
    const first = (await due(ctx(manager.id))).wakes[0];
    await say(channel, 'second', mention('liam'));
    const again = (await due(ctx(manager.id))).wakes[0];
    const body = (proof: string) => JSON.parse(Buffer.from(proof.split('.')[0]!, 'base64url').toString());
    expect(body(again.proof).channels).toEqual(body(first.proof).channels);
    expect(again.channels[0]).toMatchObject({ fromSeq: 1, throughSeq: 1 });
  });

  it('control: an UNRELATED newer reservation does not share the old proof\'s allowance (old behavior kept)', async () => {
    await say(channel, 'first', mention('liam'));
    const first = (await due(ctx(manager.id))).wakes[0];
    await db.$executeRaw`DELETE FROM app_wake_reservations WHERE worker_id = ${liam.id}`; // as the stale-task path does
    await say(channel, 'second', mention('liam'));
    const second = (await due(ctx(manager.id))).wakes[0];
    expect(second.proof).not.toBe(first.proof);
    await M.acknowledgeWakes({}, { proofs: [first.proof] }, ctx(manager.id));
    const days = await db.$queryRaw<Array<{ wakes: number }>>`SELECT sum(wakes)::int AS wakes FROM app_wake_days`;
    expect(days[0]!.wakes).toBe(1); // the old proof still pays for what it moved
    const left = await db.$queryRaw<Array<{ n: bigint }>>`SELECT count(*)::bigint n FROM app_wake_reservations WHERE worker_id = ${liam.id}`;
    expect(Number(left[0]!.n)).toBe(1); // the newer reservation is untouched
  });

  it('one allowance: the old proof then the new one charge the day once, in either order', async () => {
    for (const oldFirst of [true, false]) {
      await db.$executeRaw`DELETE FROM app_wake_days`;
      await db.$executeRaw`DELETE FROM app_wake_reservations`;
      await db.workerDeliveryChannel.deleteMany({});
      await db.workerDeliveryTick.deleteMany({});
      await db.workerWakeAck.deleteMany({});
      await db.tickerSubscription.deleteMany({});
      await db.ticker.deleteMany({});
      await say(channel, `for you ${oldFirst}`, mention('liam'));
      const first = (await due(ctx(manager.id))).wakes[0];
      const t = await mkTicker();
      await subscribe(t.id, liam.id);
      const union = (await due(ctx(manager.id))).wakes[0];
      expect(kinds(union)).toEqual(['MENTION', 'TICK']);
      const order = oldFirst ? [first, union] : [union, first];
      for (const w of order) await M.acknowledgeWakes({}, { proofs: [w.proof] }, ctx(manager.id));
      const days = await db.$queryRaw<Array<{ wakes: number }>>`SELECT sum(wakes)::int AS wakes FROM app_wake_days`;
      expect(days[0]!.wakes).toBe(1);
      const left = await db.$queryRaw<Array<{ n: bigint }>>`SELECT count(*)::bigint n FROM app_wake_reservations WHERE worker_id = ${liam.id}`;
      expect(Number(left[0]!.n)).toBe(0);
    }
  });

  it('the OLD proof, acknowledged first, delivers only what it names: the tick stays due, and the textless mention is re-offered (R53)', async () => {
    await say(channel, 'for you', mention('liam'));
    const first = (await due(ctx(manager.id))).wakes[0];
    const t = await mkTicker();
    await subscribe(t.id, liam.id);
    await M.acknowledgeWakes({}, { proofs: [first.proof] }, ctx(manager.id));
    await say(channel, 'plain news');
    await db.workerDeliveryChannel.updateMany({ data: { deliveredAt: new Date(Date.now() - 3600_000) } });
    await db.workerDeliveryTick.updateMany({ data: { ackedAt: new Date(Date.now() - 3600_000) } });
    await db.workerWakeAck.updateMany({ data: { ackedAt: new Date(Date.now() - 3600_000) } }); // R53: the receipt's clock is the floor
    const rest = (await due(ctx(manager.id))).wakes;
    // R53: a mention-only acknowledgement moves no message mark, so the mention is offered again with the tick.
    expect(rest.map(kinds)).toEqual([['MENTION', 'TICK']]);
  });
});

describe('#2068 (R49/R54) — a ticker with reason every-tick, through the whole loader', () => {
  it('ticks with no unread at all, acknowledges, and is not due again until the next tick; read-team-channel alone stays silent', async () => {
    const quiet = await mkTicker();
    await subscribe(quiet.id, liam.id);
    expect(ids(await due(ctx(manager.id)))).toEqual([]);
    await db.ticker.update({ where: { id: quiet.id }, data: { reasons: ['every-tick'] } });
    const page = await due(ctx(manager.id));
    expect(ids(page)).toEqual([liam.id]);
    expect(page.wakes[0].reasons).toEqual([{ kind: 'TICK', ticker: expect.objectContaining({ id: quiet.id }), task: null, tickDueAt: expect.any(Date) }]);
    expect(page.wakes[0].channels).toEqual([]);
    expect(page.wakes[0]).toMatchObject({ unread: 0, unreadMentions: 0 });
    const ack = await M.acknowledgeWakes({}, { proofs: [page.wakes[0].proof] }, ctx(manager.id));
    expect(ack.acknowledged).toBe(1);
    const row = await db.workerDeliveryTick.findFirstOrThrow({ where: { workerId: liam.id, tickerId: quiet.id } });
    expect(row.lastAckedTick).toBeGreaterThanOrEqual(1);
    await db.workerDeliveryTick.updateMany({ data: { ackedAt: new Date(Date.now() - 3600_000) } });
    expect(ids(await due(ctx(manager.id)))).toEqual([]); // same tick, already acknowledged
    const later = await computeDueWakes({ ctx: ctx(manager.id), app: { id: app.id, organizationId: org.id, ownerUserId: null }, reader: { manager: true, userId: manager.id }, requester: { userId: manager.id }, now: new Date(Date.now() + 600_000) });
    expect(later.wakes).toHaveLength(1);
  });

  const everyTick = (over: Record<string, unknown> = {}) => mkTicker({ reasons: ['every-tick'], ...over });
  const appLike2 = () => ({ id: app.id, organizationId: org.id, ownerUserId: null });
  const readAt = (ms: number) => computeDueWakes({ ctx: ctx(manager.id), app: appLike2(), reader: { manager: true, userId: manager.id }, requester: { userId: manager.id }, now: new Date(Date.now() + ms) });

  it('every-tick ignores relevance: a MENTIONS ticker and an ALL ticker both tick with nothing unread; read-team-channel on a MENTIONS ticker needs a mention', async () => {
    const mine = await mkTicker({ relevance: 'MENTIONS', reasons: ['read-team-channel'], name: 'M' });
    await subscribe(mine.id, liam.id);
    await say(channel, 'plain news');
    expect(ids(await due(ctx(manager.id)))).toEqual([]); // MENTIONS + read-team-channel: plain chat does not count
    await db.ticker.update({ where: { id: mine.id }, data: { reasons: ['every-tick'] } });
    expect(ids(await due(ctx(manager.id)))).toEqual([liam.id]);
    // Legacy control: a normal ALL read-team-channel ticker with relevant unread still ticks.
    await db.appWakeReservation.deleteMany();
    await db.ticker.update({ where: { id: mine.id }, data: { relevance: 'ALL', reasons: ['read-team-channel'] } });
    expect(ids(await due(ctx(manager.id)))).toEqual([liam.id]);
  });

  it('a channel-empty TICK proof acknowledges exactly its tick: no chat mark, no read position, no other ticker', async () => {
    const mine = await everyTick({ name: 'Mine' });
    const other = await mkTicker({ name: 'Other' });
    await subscribe(mine.id, liam.id);
    await subscribe(other.id, liam.id);
    const w = (await due(ctx(manager.id))).wakes[0];
    expect(w.reasons.map((r: any) => r.ticker.id)).toEqual([mine.id]); // the read-team-channel ticker has nothing to say
    expect(w.channels).toEqual([]);
    expect(await M.acknowledgeWakes({}, { proofs: [w.proof] }, ctx(manager.id))).toEqual({ acknowledged: 1, unchanged: 0 });
    expect(await db.workerDeliveryChannel.count()).toBe(0);
    expect(await db.channelReadState.count()).toBe(0);
    expect(await db.workerDeliveryTick.findMany({ select: { tickerId: true } })).toEqual([{ tickerId: mine.id }]);
    await db.workerDeliveryTick.updateMany({ data: { ackedAt: new Date(Date.now() - 3600_000) } });
    expect(ids(await due(ctx(manager.id)))).toEqual([]); // the acknowledged tick is not due
    expect((await readAt(600_001)).wakes).toHaveLength(1); // the next one is
  });

  it('a channel-empty proof is refused when forged, foreign, stale or for another worker; nothing is written', async () => {
    const t = await everyTick();
    await subscribe(t.id, liam.id);
    const w = (await due(ctx(holderA.id))).wakes[0];
    expect(await code(M.acknowledgeWakes({}, { proofs: [`${w.proof}x`] }, ctx(holderA.id)))).toBe('WAKE_PROOF_INVALID');
    expect(await code(M.acknowledgeWakes({}, { proofs: [w.proof] }, ctx(holderB.id)))).toBe('WAKE_PROOF_REQUESTER_MISMATCH');
    const p = verifyWakeProof(w.proof);
    expect(await code(M.acknowledgeWakes({}, { proofs: [signWakeProof({ ...p, issuedAt: Date.now() - 16 * 60_000 })] }, ctx(holderA.id)))).toBe('WAKE_PROOF_STALE');
    expect(await db.workerDeliveryTick.count()).toBe(0);
  });

  it('#2102 Dara P2-4: a prior-cycle ancestor receipt does not let a late ancestor proof charge again', async () => {
    await say(channel, 'one', mention('liam'));
    const a = (await due(ctx(manager.id))).wakes[0];
    const aKey = verifyWakeProof(a.proof).wakeKey!;
    // A receipt of the same still-due textless mention from a PRIOR cycle (R53: offered again after the floor).
    await db.workerWakeAck.create({ data: { workerId: liam.id, wakeKey: aKey, ackedAt: new Date(Date.now() - 3600_000) } });
    const t = await everyTick();
    await subscribe(t.id, liam.id);
    const b = (await due(ctx(manager.id))).wakes[0];
    const r = await db.appWakeReservation.findUniqueOrThrow({ where: { workerId: liam.id } });
    expect(r.absorbedKeys).toContain(aKey);
    expect(await M.acknowledgeWakes({}, { proofs: [b.proof] }, ctx(manager.id))).toEqual({ acknowledged: 1, unchanged: 0 });
    expect(await M.acknowledgeWakes({}, { proofs: [a.proof] }, ctx(manager.id))).toEqual({ acknowledged: 0, unchanged: 1 });
    expect((await db.appWakeDay.findFirstOrThrow({ where: { appId: app.id } })).wakes).toBe(1);
  });

  it('every-tick bypasses none of: pause, dormancy, the daily budget', async () => {
    const t = await everyTick();
    await subscribe(t.id, liam.id);
    // pause
    await db.workerWakeSettings.create({ data: { workerId: liam.id, pausedUntil: new Date(Date.now() + 3600_000) } });
    expect(ids(await due(ctx(manager.id)))).toEqual([]);
    await db.workerWakeSettings.update({ where: { workerId: liam.id }, data: { pausedUntil: null } });
    // dormancy
    const old = new Date(Date.now() - 100 * DAY);
    await db.session.create({ data: { id: generateId(), appId: app.id, userId: holderA.id, workerId: liam.id, agentId: agent.id, type: 'DEVELOPER', startedAt: old, updatedAt: old, endedAt: old } });
    expect(ids(await due(ctx(manager.id)))).toEqual([]);
    await db.session.deleteMany({ where: { workerId: liam.id } });
    // the budget
    await db.app.update({ where: { id: app.id }, data: { wakeDailyBudget: 0 } });
    const spent = await due(ctx(manager.id));
    expect(spent.status).toBe('WAKE_BUDGET_EXHAUSTED');
    expect(spent.wakes).toEqual([]);
  });

  it('every-tick respects the per-worker floor across a NEW tick: withheld inside it, offered after it (with a positive control)', async () => {
    const floorSeconds = (await db.app.findUniqueOrThrow({ where: { id: app.id }, select: { tickerMinCadenceSeconds: true } })).tickerMinCadenceSeconds;
    expect(floorSeconds).toBe(120);
    const now = Date.now();
    // Ticks fall at anchor + j x 120 s; tick 4 is current now and tick 5 falls 20 s from now.
    const t = await everyTick({ cadenceSeconds: 120, anchorAt: new Date(now - 5 * 120_000 + 20_000) });
    await subscribe(t.id, liam.id);
    const first = (await due(ctx(manager.id))).wakes[0];
    expect(first.reasons).toHaveLength(1);
    await M.acknowledgeWakes({}, { proofs: [first.proof] }, ctx(manager.id));
    await db.workerDeliveryTick.updateMany({ data: { ackedAt: new Date(now) } });
    const row = await db.workerDeliveryTick.findFirstOrThrow({ where: { tickerId: t.id } });
    expect(row.lastAckedTick).toBe(4);
    // Tick 5 is a NEW, otherwise-due tick, 25 s after the acknowledgement: inside the 120 s floor, so it waits.
    expect((await readAt(25_000)).wakes).toEqual([]);
    // Positive control: the same tick is offered once the floor has passed, so nothing else was suppressing it.
    const after = await readAt(125_000);
    expect(after.wakes).toHaveLength(1);
    expect(after.wakes[0].wake.reasons).toEqual([expect.objectContaining({ kind: 'TICK', k: 5 })]);
  });

  it('a ticker row created before the column existed reads as [read-team-channel] (the migration default), naming no ticker', async () => {
    const id = generateId();
    await db.$executeRaw`INSERT INTO tickers (id, app_id, name, slug, cadence_seconds, anchor_at, channel_ids, relevance, enabled, owner_user_id, created_at)
      VALUES (${id}, ${app.id}, 'Old', 'old', 600, now(), '{}', 'ALL', true, ${manager.id}, now())`;
    expect((await db.ticker.findUniqueOrThrow({ where: { id } })).reasons).toEqual(['read-team-channel']);
  });
});

describe('read fields', () => {
  it('Ticker.nextTickAt / lastTickAt and WorkerWakeSettings.dormant', async () => {
    const F = resolvers as any;
    const t = await mkTicker({ anchorAt: new Date(Date.now() - 3600_000 - 5_000) }); // 6 ticks in, 5 s past the last
    const last = await F.Ticker.lastTickAt(t, {}, ctx(manager.id));
    const next = await F.Ticker.nextTickAt(t, {}, ctx(manager.id));
    expect(next.getTime() - last.getTime()).toBe(600_000);
    expect(Date.now() - last.getTime()).toBeLessThan(600_000);
    expect(await F.Ticker.nextTickAt({ ...t, enabled: false }, {}, ctx(manager.id))).toBeNull();
    expect(await F.WorkerWakeSettings.dormant({ workerId: liam.id }, {}, ctx(manager.id))).toBe(false);
    await db.session.create({ data: { id: generateId(), appId: app.id, userId: holderA.id, workerId: liam.id, agentId: agent.id, type: 'DEVELOPER', startedAt: new Date(Date.now() - 200 * DAY), endedAt: new Date(Date.now() - 200 * DAY) } });
    expect(await F.WorkerWakeSettings.dormant({ workerId: liam.id }, {}, ctx(manager.id))).toBe(true);
  });
});

describe('who may read due wakes, and R1/B3', () => {
  it('a holder reads the workers they hold, a manager all of them; a plain member reads none; outsiders and keys are concealed', async () => {
    await say(channel, 'hi', mention('liam', 'rook'));
    expect(ids(await due(ctx(holderA.id)))).toEqual([liam.id]);
    expect(ids(await due(ctx(holderB.id)))).toEqual([rook.id]);
    expect(ids(await due(ctx(manager.id)))).toEqual([liam.id, rook.id].sort());
    expect(await code(due(ctx(outsider.id)))).toBe('APP_NOT_FOUND');
    expect(await code(due(ctx(undefined, { appId: app.id } as Partial<Context>)))).toBe('APP_NOT_FOUND');
    expect(await code(due(ctx(manager.id, { impersonation: { adminUserId: 'x' } } as any)))).toBe('APP_NOT_FOUND');
    // Asking for a worker one may not read is just an absent worker.
    expect(ids(await due(ctx(holderA.id), { workerRefs: [rook.id] }))).toEqual([]);
  });

  it('a worker whose only unread is in its holder\'s personal memory: a wake for the holder, nothing — and no trace — for a manager', async () => {
    const personal = await db.memory.create({ data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:liam-personal`, name: 'p', class: 'personal', userId: holderA.id } });
    const secret = await mkChannel(personal.id, 'chats:private', holderA.id);
    await db.registerEntry.create({ data: { id: generateId(), appId: app.id, channelId: secret.id, attendeeWorkerId: liam.id, role: 'BOTH' } });
    await say(secret, 'private news', mention('liam'));
    const mine = await due(ctx(holderA.id));
    expect(mine.wakes).toHaveLength(1);
    expect(mine.wakes[0].channels.map((c: any) => c.channel.id)).toEqual([secret.id]);
    const theirs = await due(ctx(manager.id));
    expect(theirs.wakes).toEqual([]);
    expect(theirs.dormant).toEqual([]);
    expect(JSON.stringify(theirs)).not.toContain(secret.id);
    // ...and with a readable channel too, the manager sees only that one.
    await say(channel, 'team news', mention('liam'));
    // While the holder's private wake is outstanding the manager is handed no second one (cycle 4); once it is
    // acknowledged and the floor has passed, the manager sees only the readable channel.
    expect((await due(ctx(manager.id))).wakes).toEqual([]);
    await M.acknowledgeWakes({}, { proofs: mine.wakes.map((w: any) => w.proof) }, ctx(holderA.id));
    await pastFloor();
    const both = await due(ctx(manager.id));
    expect(both.wakes[0].channels.map((c: any) => c.channel.id)).toEqual([channel.id]);
    expect(both.wakes[0].unread).toBe(1);
  });
});

describe('delivery record: acknowledging, never reading', () => {
  it('unacknowledged stays due; acknowledgement is monotonic, records who, and never moves the read position', async () => {
    await say(channel, 'one', mention('liam'));
    const first = await due(ctx(holderA.id));
    expect(await due(ctx(holderA.id))).toMatchObject({ wakes: [expect.objectContaining({ proof: expect.any(String) })] });

    const r = await M.acknowledgeWakes({}, { proofs: [first.wakes[0].proof] }, ctx(holderA.id));
    expect(r).toEqual({ acknowledged: 1, unchanged: 0 });
    expect(await db.channelReadState.count({ where: { workerId: liam.id } })).toBe(0);
    // #2072 (R53): the acknowledgement records the wake's receipt, with who, and moves no message mark.
    expect(await db.workerDeliveryChannel.count({ where: { workerId: liam.id } })).toBe(0);
    expect(await db.workerWakeAck.findFirstOrThrow({ where: { workerId: liam.id } })).toMatchObject({ ackedByUserId: holderA.id });
    // Inside the ceiling it is not due again, though its text stays undelivered.
    expect(ids(await due(ctx(holderA.id)))).toEqual([]);

    // A repeat acknowledgement moves nothing and is not another wake against the budget.
    expect(await M.acknowledgeWakes({}, { proofs: [first.wakes[0].proof] }, ctx(holderA.id))).toEqual({ acknowledged: 0, unchanged: 1 });
    expect((await db.appWakeDay.findFirstOrThrow({ where: { appId: app.id } })).wakes).toBe(1);

    // An older proof replayed after a newer wake was acknowledged changes nothing.
    await say(channel, 'two', mention('liam'));
    const ageMs = 5 * 60_000;
    await pastFloor(ageMs);
    const second = await due(ctx(holderA.id));
    expect(await M.acknowledgeWakes({}, { proofs: [second.wakes[0].proof] }, ctx(holderA.id))).toEqual({ acknowledged: 1, unchanged: 0 });
    expect(await M.acknowledgeWakes({}, { proofs: [issuedEarlier(first.wakes[0].proof, ageMs)] }, ctx(holderA.id))).toEqual({ acknowledged: 0, unchanged: 1 });
    expect((await db.appWakeDay.findFirstOrThrow({ where: { appId: app.id } })).wakes).toBe(2);
    expect(await db.workerDeliveryChannel.count({ where: { workerId: liam.id } })).toBe(0);
  });

  it('records the tick; the same tick is not due again until the next one', async () => {
    const t = await mkTicker();
    await subscribe(t.id, liam.id);
    await say(channel, 'news');
    const w = (await due(ctx(manager.id))).wakes[0];
    await M.acknowledgeWakes({}, { proofs: [w.proof] }, ctx(manager.id));
    const tick = await db.workerDeliveryTick.findFirstOrThrow({ where: { workerId: liam.id, tickerId: t.id } });
    expect(tick.lastAckedTick).toBeGreaterThanOrEqual(1);
    await say(channel, 'more news');
    await pastFloor();
    await db.workerDeliveryTick.updateMany({ data: { ackedAt: new Date(Date.now() - 3600_000) } });
    expect(ids(await due(ctx(manager.id)))).toEqual([]); // same tick, already acknowledged
    const later = await computeDueWakes({ ctx: ctx(manager.id), app: { id: app.id, organizationId: org.id, ownerUserId: null }, reader: { manager: true, userId: manager.id }, requester: { userId: manager.id }, now: new Date(Date.now() + 600_000) });
    expect(later.wakes).toHaveLength(1);
  });

  it('refuses a foreign requester, a stale proof, an unknown version, an attention token, a recreated channel — writing nothing', async () => {
    await say(channel, 'one', mention('liam'));
    const w = (await due(ctx(holderA.id))).wakes[0];
    expect(await code(M.acknowledgeWakes({}, { proofs: [w.proof] }, ctx(manager.id)))).toBe('WAKE_PROOF_REQUESTER_MISMATCH');
    expect(await code(M.acknowledgeWakes({}, { proofs: [w.proof] }, ctx(holderB.id)))).toBe('WAKE_PROOF_REQUESTER_MISMATCH');
    expect(await code(M.acknowledgeWakes({}, { proofs: ['garbage'] }, ctx(holderA.id)))).toBe('WAKE_PROOF_INVALID');
    const p = verifyWakeProof(w.proof);
    expect(await code(M.acknowledgeWakes({}, { proofs: [signWakeProof({ ...p, v: 4 } as never)] }, ctx(holderA.id)))).toBe('WAKE_PROOF_INVALID');
    // #2072: a v3 proof names no channel; one that does was not issued here.
    expect(await code(M.acknowledgeWakes({}, { proofs: [signWakeProof({ ...p, channels: [{ channelId: channel.id, incarnation: 1, through: 1 }] })] }, ctx(holderA.id)))).toBe('WAKE_PROOF_INVALID');
    const old = signWakeProof({ ...p, issuedAt: Date.now() - 16 * 60_000 });
    expect(await code(M.acknowledgeWakes({}, { proofs: [old] }, ctx(holderA.id)))).toBe('WAKE_PROOF_STALE');
    // A channel recreated since issue: still refused for an old-format (v2) proof that names it (#2072 keeps that
    // validation; a v3 proof names no channel and writes no mark).
    const ch = await db.channel.findUniqueOrThrow({ where: { id: channel.id } });
    const v2 = signWakeProof({ ...p, v: 2, wakeKey: undefined, channels: [{ channelId: channel.id, incarnation: ch.incarnation, through: 1 }] });
    await db.channel.update({ where: { id: channel.id }, data: { incarnation: { increment: 1 } } });
    expect(await code(M.acknowledgeWakes({}, { proofs: [v2] }, ctx(holderA.id)))).toBe('WAKE_PROOF_STALE');
    expect(await db.workerDeliveryChannel.count()).toBe(0);
  });

  it('a holder who lost the worker can no longer acknowledge its proof', async () => {
    await say(channel, 'one', mention('liam'));
    const w = (await due(ctx(holderA.id))).wakes[0];
    await db.worker.update({ where: { id: liam.id }, data: { heldByUserId: holderB.id } });
    expect(await code(M.acknowledgeWakes({}, { proofs: [w.proof] }, ctx(holderA.id)))).toBe('WAKE_PROOF_REQUESTER_MISMATCH');
  });
});

describe('R2 — amplification limits', () => {
  const appLike = () => ({ id: app.id, organizationId: org.id, ownerUserId: null });
  const at = (offsetMs: number) => new Date(Date.now() + offsetMs);

  it('the ceiling: a mention 30 seconds after a wake waits for the window, then wakes — for a manager\'s too', async () => {
    await say(channel, 'one', mention('liam'));
    const w = (await due(ctx(holderA.id))).wakes[0];
    await M.acknowledgeWakes({}, { proofs: [w.proof] }, ctx(holderA.id));
    await say(channel, 'burst', { ...mention('liam'), managerPost: true });
    await say(channel, 'burst 2', mention('liam'));
    const args = { ctx: ctx(manager.id), app: appLike(), reader: { manager: true, userId: manager.id }, requester: { userId: manager.id } };
    expect((await computeDueWakes({ ...args, now: at(30_000) })).wakes).toEqual([]);
    const later = await computeDueWakes({ ...args, now: at(121_000) });
    expect(later.wakes).toHaveLength(1);
    // The burst is ONE wake. #2072 (R53): the first mention's text was never delivered, so it is still unread with them.
    expect(later.wakes[0].wake.unreadMentions).toBe(3);
  });

  it('broadcast: an unstamped @all waits for the tick; a stamped one wakes at once', async () => {
    const m = await say(channel, 'everyone', mention('all'));
    expect(ids(await due(ctx(manager.id)))).toEqual([]);
    await db.node.updateMany({ where: { id: m.inserted.id }, data: { data: { mentions: ['all'], broadcastWakes: true } } });
    expect(ids(await due(ctx(manager.id)))).toEqual([liam.id, rook.id].sort());
  });

  it('the daily budget: withheld wakes are counted and stay due, the rest is returned; a manager\'s mention passes; one notice a day', async () => {
    await db.app.update({ where: { id: app.id }, data: { wakeDailyBudget: 1 } });
    const third = await mkWorker('Nova', { heldByUserId: holderA.id, heldAt: new Date() });
    await say(channel, 'for liam', mention('liam'));
    await say(channel, 'for rook', mention('rook'));
    await say(channel, 'for nova by a manager', { ...mention('nova'), managerPost: true });
    const page = await due(ctx(manager.id));
    expect(page.status).toBe('WAKE_BUDGET_EXHAUSTED');
    expect(page.wakes).toHaveLength(2); // the exempt one + one against the budget
    expect(page.wakes.map((w: any) => w.worker.id)).toContain(third.id);
    expect(page.withheld).toBe(1);
    // #1791: the platform posts it, as a system author (not through the reader's own chat post).
    const sysNotices = async () => (await db.node.findMany({ where: { messageChannelId: channel.id, nodeType: 'chat-message' } }))
      .filter((n) => (n.data as any)?.authorSystem === true);
    expect(post).not.toHaveBeenCalled();
    expect((await sysNotices()).map((n) => n.content)).toEqual([expect.stringMatching(/daily wake budget is spent/)]);
    await due(ctx(manager.id));
    expect(await sysNotices()).toHaveLength(1); // once a day
    // Acknowledging counts against the day; exempt wakes do not count.
    await M.acknowledgeWakes({}, { proofs: page.wakes.map((w: any) => w.proof) }, ctx(manager.id));
    expect((await db.appWakeDay.findFirstOrThrow({ where: { appId: app.id } })).wakes).toBe(1);
    // Spent: the next non-exempt wake is withheld (and stays due), the stamp-exempt one passes.
    await pastFloor();
    await say(channel, 'again', mention('liam'));
    const after = await due(ctx(manager.id));
    // #2072 (R53): the manager's mention to Nova moved no mark, so it is still due and, exempt, passes again.
    expect(after.wakes.map((w: any) => w.worker.id)).toEqual([third.id]);
    expect(after.withheld).toBe(2); // Rook's unacknowledged mention is still due, and so is Liam's new one
  });

  it('the default budget is roster × (86,400 ÷ self-subscribe cadence) × 2', async () => {
    const { defaultWakeBudget } = await import('./dueWakes.js');
    expect(defaultWakeBudget(33, 600)).toBe(33 * 144 * 2);
  });
});

describe('post-time stamps (N3)', () => {
  const appLike = () => ({ id: app.id, organizationId: org.id, ownerUserId: null });
  const grant = (workerId: string, revokedAt: Date | null = null) =>
    db.appGrant.create({ data: { id: generateId(), appId: app.id, granteeWorkerId: workerId, name: 'ticker.subscribe-workers', grantedBy: manager.id, revokedAt } });

  it('a manager posting as themselves stamps both; a plain member stamps nothing', async () => {
    expect(await stampsOf(ctx(manager.id), appLike(), null, ['all'])).toEqual({ managerPost: true, broadcastWakes: true });
    expect(await stampsOf(ctx(manager.id), appLike(), null, ['liam'])).toEqual({ managerPost: true });
    expect(await stampsOf(ctx(holderA.id), appLike(), null, ['all'])).toEqual({});
    expect(await stampsOf(ctx(manager.id), appLike(), null, [])).toEqual({});
  });

  it('a manager posting THROUGH a worker session is the worker\'s post: no manager stamp', async () => {
    expect(await stampsOf(ctx(manager.id), appLike(), liam.id, ['all'])).toEqual({});
  });

  it('the grant worker with a person behind the session broadcasts; revoked, an App key, or impersonated does not', async () => {
    await grant(liam.id);
    expect(await stampsOf(ctx(holderA.id), appLike(), liam.id, ['all'])).toEqual({ broadcastWakes: true });
    expect(await stampsOf(ctx(holderA.id), appLike(), liam.id, ['rook'])).toEqual({}); // not a broadcast, grant is no exemption
    expect(await stampsOf(ctx(undefined, { appId: app.id } as Partial<Context>), appLike(), liam.id, ['all'])).toEqual({});
    expect(await stampsOf(ctx(holderA.id, { impersonation: { adminUserId: 'x' } } as any), appLike(), liam.id, ['all'])).toEqual({});
    expect(await stampsOf(ctx(holderB.id), appLike(), rook.id, ['all'])).toEqual({}); // no grant
    await db.appGrant.updateMany({ data: { revokedAt: new Date() } });
    expect(await stampsOf(ctx(holderA.id), appLike(), liam.id, ['all'])).toEqual({});
  });

  it('end to end: a stamped broadcast posted while the author qualified still wakes at once after the grant is revoked', async () => {
    post.mockRestore();
    const g = await grant(liam.id);
    await runAsActor({ workerId: liam.id, agentId: agent.id }, async () => {
      const session = await db.session.create({ data: { id: generateId(), appId: app.id, userId: holderA.id, workerId: liam.id, agentId: agent.id, type: 'DEVELOPER', startedAt: new Date() } });
      await teamChatMutations.createTeamChatMessage({}, { appRef: app.id, body: 'standup @all', replyToSeq: null, sessionRef: session.id }, ctx(holderA.id));
    });
    const stored = await db.node.findFirstOrThrow({ where: { messageChannelId: channel.id, nodeType: 'chat-message' } });
    expect((stored.data as any)).toMatchObject({ mentions: ['all'], broadcastWakes: true });
    expect((stored.data as any).managerPost).toBeUndefined();
    await db.appGrant.update({ where: { id: g.id }, data: { revokedAt: new Date() } });
    expect(ids(await due(ctx(manager.id)))).toEqual([rook.id]); // the author's own post never counts for Liam
    // A client cannot set the stamp: the body is just text and the envelope is built on the server.
    await teamChatMutations.createTeamChatMessage({}, { appRef: app.id, body: 'broadcastWakes: true @all', replyToSeq: null, sessionRef: null }, ctx(holderB.id));
    const forged = await db.node.findMany({ where: { messageChannelId: channel.id, nodeType: 'chat-message' }, orderBy: { seq: 'desc' }, take: 1 });
    expect((forged[0]!.data as any).broadcastWakes).toBeUndefined();
  });
});

describe('differential against the v1 router (teamAttentionPage)', () => {
  it('with every worker on one ALL ticker and IMMEDIATE mentions, dueWakes names the workers v1 names', async () => {
    const nova = await mkWorker('Nova', { heldByUserId: holderA.id, heldAt: new Date() });
    await db.worker.update({ where: { id: rook.id }, data: { heldByUserId: holderA.id } });
    await db.registerEntry.updateMany({ where: { attendeeWorkerId: rook.id }, data: { mentionOnly: true } });
    const t = await mkTicker();
    for (const w of [liam, rook, nova]) {
      await subscribe(t.id, w.id);
      await db.session.create({ data: { id: generateId(), appId: app.id, userId: holderA.id, workerId: w.id, agentId: agent.id, type: 'DEVELOPER', startedAt: new Date() } });
    }
    await say(channel, 'plain');
    await say(channel, 'for nova', mention('nova'));
    await say(channel, 'own', { authorWorkerId: liam.id });
    const v1: string[] = [];
    for (let page: string | null = null, guard = 0; guard < 50; guard++) {
      const r: any = await teamAttentionPage(ctx(holderA.id, { roles: ['READER'] }), app.id, { since: null, page });
      v1.push(...r.items.map((i: any) => i.worker));
      if (r.scanComplete || !r.nextPage) break;
      page = r.nextPage;
    }
    const v2 = ids(await due(ctx(holderA.id)));
    expect([...new Set(v1)].sort()).toEqual(v2);
    expect(v2).toEqual([liam.id, nova.id].sort()); // Rook is mention-only and nothing mentioned it
  });
});

describe('load', () => {
  it('200 workers × 3 channels in under a second', async () => {
    const channels = [channel, await mkChannel(memory.id, 'chats:two', manager.id), await mkChannel(memory.id, 'chats:three', manager.id)];
    const workers = await Promise.all(Array.from({ length: 200 }, (_, i) => mkWorker(`Load${i}`, { heldByUserId: holderA.id, heldAt: new Date() }, false)));
    await db.registerEntry.createMany({
      data: workers.flatMap((w) => channels.map((c) => ({ id: generateId(), appId: app.id, channelId: c.id, attendeeWorkerId: w.id, role: 'BOTH' as const }))),
    });
    for (const c of channels) for (let i = 0; i < 20; i++) await say(c, `m${i}`, i % 5 === 0 ? mention('load7', 'load150') : {});
    const t = await mkTicker();
    await db.tickerSubscription.createMany({ data: workers.map((w) => ({ id: generateId(), tickerId: t.id, workerId: w.id, createdBy: manager.id })) });
    const started = performance.now();
    const page = await due(ctx(manager.id), { first: 200 });
    const elapsed = performance.now() - started;
    // The page is 200 of 202 workers; Liam and Rook have no subscription and nothing to be told.
    expect(page.wakes.length).toBeGreaterThan(190);
    console.info(`dueWakes 200 workers x 3 channels: ${Math.round(elapsed)} ms`);
    expect(elapsed).toBeLessThan(1000);
  }, 60_000);
});

// ── Cycle 1: the reviews of 4c232239 / 19ac4719 (Diego, Rook §10) ──────────────

describe('cycle 1 — whose authority reads and acknowledges wakes', () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const asWorker = <T>(w: { id: string }, fn: () => Promise<T>) => runAsActor({ workerId: w.id, agentId: agent.id }, fn);

  it('a stale platform-ADMIN claim on an old credential is not a manager (Diego P2-1)', async () => {
    await say(channel, 'hi', mention('liam', 'rook'));
    // holderA's user row has no ADMIN role; the credential still says so.
    const stale = ctx(holderA.id, { roles: ['ADMIN'] });
    expect(ids(await due(stale))).toEqual([liam.id]); // only what they hold
    expect(ids(await due(ctx(manager.id)))).toEqual([liam.id, rook.id].sort());
  });

  it('a worker session cannot read its holder\'s other workers\' wakes, nor acknowledge them (Rook P2)', async () => {
    const sibling = await mkWorker('Nova', { heldByUserId: holderA.id, heldAt: new Date() });
    await say(channel, 'hi', mention('liam', 'nova'));
    const proofs = (await due(ctx(holderA.id))).wakes.map((w: any) => w.proof);
    expect(proofs).toHaveLength(2);
    expect(await code(asWorker(liam, () => due(ctx(holderA.id))))).toBe('APP_NOT_FOUND');
    expect(await code(asWorker(liam, () => M.acknowledgeWakes({}, { proofs }, ctx(holderA.id))))).toBe('WAKE_ACK_FORBIDDEN');
    expect(await db.workerDeliveryChannel.count({ where: { workerId: { in: [liam.id, sibling.id] } } })).toBe(0);
    // The person, as themselves, still can.
    expect(await M.acknowledgeWakes({}, { proofs }, ctx(holderA.id))).toEqual({ acknowledged: 2, unchanged: 0 });
  });

  it('acknowledgement authority is held through the write: a release in flight is waited for, then refused (Diego P2-2)', async () => {
    await say(channel, 'one', mention('liam'));
    const w = (await due(ctx(holderA.id))).wakes[0];
    let open!: () => void;
    const gate = new Promise<void>((r) => { open = r; });
    let ready!: () => void;
    const locked = new Promise<void>((r) => { ready = r; });
    const releasing = db.$transaction(async (tx) => {
      await tx.worker.update({ where: { id: liam.id }, data: { heldByUserId: null, heldAt: null } });
      ready();
      await gate;
    });
    await locked;
    let settled = false;
    const ack = M.acknowledgeWakes({}, { proofs: [w.proof] }, ctx(holderA.id)).then(
      (v: unknown) => { settled = true; return { ok: v }; },
      (e: unknown) => { settled = true; return { err: e }; },
    );
    let waited: boolean;
    try {
      await sleep(500);
      waited = !settled;
    } finally {
      open();
    }
    await releasing;
    expect(waited).toBe(true);
    const out: any = await ack;
    expect(out.err?.extensions?.code).toBe('WAKE_PROOF_REQUESTER_MISMATCH');
    expect(await db.workerDeliveryChannel.count({ where: { workerId: liam.id } })).toBe(0);
  });

  it('a demoted manager\'s proof is refused at acknowledgement (live roles)', async () => {
    await say(channel, 'one', mention('liam'));
    const page = await due(ctx(manager.id));
    // The credential claims ADMIN only through the org membership; remove it before the ack.
    await db.orgMember.deleteMany({ where: { userId: manager.id } });
    expect(await code(M.acknowledgeWakes({}, { proofs: [page.wakes[0].proof] }, ctx(manager.id)))).toBe('WAKE_PROOF_REQUESTER_MISMATCH');
  });
});

describe('cycle 1 — a repeat acknowledgement changes nothing (Diego P2-3)', () => {
  it('keeps the delivery time and who delivered, so the ceiling does not move', async () => {
    const t = await mkTicker();
    await subscribe(t.id, liam.id);
    await say(channel, 'one', mention('liam'));
    const first = (await due(ctx(holderA.id))).wakes[0];
    await M.acknowledgeWakes({}, { proofs: [first.proof] }, ctx(holderA.id));
    // #2072 (R53): the wake's receipt is its delivery record now; no message mark is written.
    const ageMs = 5 * 60_000;
    const old = new Date(Date.now() - ageMs);
    await db.workerWakeAck.updateMany({ where: { workerId: liam.id }, data: { ackedAt: old, ackedByUserId: manager.id } });
    await db.workerDeliveryTick.updateMany({ where: { workerId: liam.id }, data: { ackedAt: old, ackedByUserId: manager.id } });
    expect(await M.acknowledgeWakes({}, { proofs: [issuedEarlier(first.proof, ageMs)] }, ctx(holderA.id))).toEqual({ acknowledged: 0, unchanged: 1 });
    const ch = await db.workerWakeAck.findFirstOrThrow({ where: { workerId: liam.id } });
    const tk = await db.workerDeliveryTick.findFirstOrThrow({ where: { workerId: liam.id } });
    expect([ch.ackedAt.getTime(), ch.ackedByUserId]).toEqual([old.getTime(), manager.id]);
    expect([tk.ackedAt.getTime(), tk.ackedByUserId]).toEqual([old.getTime(), manager.id]);
    // A newer mention is therefore not held back by the replay: the window ended five minutes ago.
    await say(channel, 'two', mention('liam'));
    expect(ids(await due(ctx(holderA.id)))).toEqual([liam.id]);
  });
});

describe('cycle 1 — the daily budget bounds what is handed out (Diego P2-4)', () => {
  beforeEach(() => db.app.update({ where: { id: app.id }, data: { wakeDailyBudget: 1 } }));

  it('reads that run before any acknowledgement cannot hand out more than the budget', async () => {
    await say(channel, 'for liam', mention('liam'));
    await say(channel, 'for rook', mention('rook'));
    const [a, b] = await Promise.all([due(ctx(holderA.id)), due(ctx(holderB.id))]);
    expect(a.wakes.length + b.wakes.length).toBe(1);
    expect(a.withheld + b.withheld).toBe(1);
    // The winner re-reading keeps its one slot (a re-read is not another wake); the loser is still withheld.
    const winner = a.wakes.length ? ctx(holderA.id) : ctx(holderB.id);
    const loser = a.wakes.length ? ctx(holderB.id) : ctx(holderA.id);
    expect((await due(winner)).wakes).toHaveLength(1);
    expect((await due(loser)).wakes).toHaveLength(0);
    // Acknowledging spends the slot for good.
    await M.acknowledgeWakes({}, { proofs: (await due(winner)).wakes.map((w: any) => w.proof) }, winner);
    expect((await db.appWakeDay.findFirstOrThrow({ where: { appId: app.id } })).wakes).toBe(1);
    expect(await db.appWakeReservation.count()).toBe(0);
    expect((await due(loser)).wakes).toHaveLength(0);
  });

  it('an unacknowledged reservation frees its slot when its proof can no longer be acknowledged', async () => {
    await say(channel, 'for liam', mention('liam'));
    await say(channel, 'for rook', mention('rook'));
    const args = (userId: string) => ({ ctx: ctx(userId), app: { id: app.id, organizationId: org.id, ownerUserId: null }, reader: { manager: true, userId }, requester: { userId } });
    const first = await computeDueWakes({ ...args(manager.id), workerIds: [liam.id] });
    expect(first.wakes).toHaveLength(1);
    expect((await computeDueWakes({ ...args(manager.id), workerIds: [rook.id] })).wakes).toHaveLength(0);
    const later = await computeDueWakes({ ...args(manager.id), workerIds: [rook.id], now: new Date(Date.now() + 16 * 60_000) });
    expect(later.wakes).toHaveLength(1);
  });

  it('a manager\'s mention is exempt: it neither takes a slot nor waits for one', async () => {
    await say(channel, 'for liam', mention('liam'));
    await say(channel, 'for rook, by a manager', { ...mention('rook'), managerPost: true });
    const page = await due(ctx(manager.id));
    expect(page.wakes).toHaveLength(2);
    expect(page.withheld).toBe(0);
    expect(await db.appWakeReservation.count()).toBe(1); // only Liam's
  });
});

describe('cycle 1 — a backlog of irrelevant messages cannot hide the relevant one (Diego P2-5)', () => {
  const scan = { pageRows: 5, maxRows: 200 };
  const run = (userId: string, extra: Record<string, unknown> = {}) =>
    computeDueWakes({ ctx: ctx(userId), app: { id: app.id, organizationId: org.id, ownerUserId: null }, reader: { manager: true, userId }, requester: { userId }, scan, ...extra });

  it('a mention-only worker with 12 chatter messages ahead of its mention is woken', async () => {
    const mo = await mkWorker('Mo', { heldByUserId: holderA.id, heldAt: new Date() });
    await db.registerEntry.updateMany({ where: { attendeeWorkerId: mo.id }, data: { mentionOnly: true } });
    for (let i = 0; i < 12; i++) await say(channel, `chatter ${i}`);
    await say(channel, 'for mo', mention('mo'));
    const page = await run(manager.id, { workerIds: [mo.id] });
    expect(page.wakes.map((w) => w.workerId)).toEqual([mo.id]);
    expect(page.wakes[0]!.wake.channels[0]).toMatchObject({ throughSeq: 13, latestMentionSeq: 13 });
  });

  it('a worker\'s own 12 posts ahead of one from someone else do not hide it', async () => {
    for (let i = 0; i < 12; i++) await say(channel, `mine ${i}`, { authorWorkerId: liam.id });
    await say(channel, 'from rook', { authorWorkerId: rook.id, mentions: ['liam'] });
    const page = await run(manager.id, { workerIds: [liam.id] });
    expect(page.wakes.map((w) => w.workerId)).toEqual([liam.id]);
  });

  it('mixed baselines: a stuck worker at the start does not starve one whose own floor is far on', async () => {
    const mo = await mkWorker('Mo', { heldByUserId: holderA.id, heldAt: new Date() });
    await db.registerEntry.updateMany({ where: { attendeeWorkerId: mo.id }, data: { mentionOnly: true } });
    for (let i = 0; i < 14; i++) await say(channel, `chatter ${i}`);
    await say(channel, 'for both', mention('mo', 'liam'));
    await db.channelReadState.create({ data: { id: generateId(), workerId: liam.id, appId: app.id, channelId: channel.id, lastSeenSeq: 14 } });
    const page = await run(manager.id, { workerIds: [mo.id, liam.id] });
    expect(page.wakes.map((w) => w.workerId).sort()).toEqual([mo.id, liam.id].sort());
  });
});

describe('cycle 1 — post-time stamps are decided on live authority, in the append (Diego P2-6; Rook P3-1, P3-2)', () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const appLike = () => ({ id: app.id, organizationId: org.id, ownerUserId: null });
  const grant = (workerId: string) =>
    db.appGrant.create({ data: { id: generateId(), appId: app.id, granteeWorkerId: workerId, name: 'ticker.subscribe-workers', grantedBy: manager.id } });

  it('a stale ADMIN claim stamps nothing', async () => {
    expect(await stampsOf(ctx(holderA.id, { roles: ['ADMIN'] }), appLike(), null, ['all'])).toEqual({});
    expect(await stampsOf(ctx(manager.id), appLike(), null, ['all'])).toEqual({ managerPost: true, broadcastWakes: true });
  });

  it('a grant revoked while the post waits is not honoured; the barrier is the revoking transaction', async () => {
    const g = await grant(liam.id);
    let open!: () => void;
    const gate = new Promise<void>((r) => { open = r; });
    let ready!: () => void;
    const locked = new Promise<void>((r) => { ready = r; });
    const revoking = db.$transaction(async (tx) => {
      await tx.appGrant.update({ where: { id: g.id }, data: { revokedAt: new Date() } });
      ready();
      await gate;
    });
    await locked;
    let settled = false;
    const stamped = stampsOf(ctx(holderA.id), appLike(), liam.id, ['all']).then((v) => { settled = true; return v; });
    let waited: boolean;
    try {
      await sleep(500);
      waited = !settled;
    } finally {
      open();
    }
    await revoking;
    expect(waited).toBe(true);
    expect(await stamped).toEqual({});
  });

  it('the grant is spent on a holder\'s behalf: an unheld grantee, or another person\'s worker, does not broadcast', async () => {
    await grant(liam.id);
    expect(await stampsOf(ctx(holderA.id), appLike(), liam.id, ['all'])).toEqual({ broadcastWakes: true });
    expect(await stampsOf(ctx(holderB.id), appLike(), liam.id, ['all'])).toEqual({}); // not the holder of Liam
    await db.worker.update({ where: { id: liam.id }, data: { heldByUserId: null, heldAt: null } });
    expect(await stampsOf(ctx(holderA.id), appLike(), liam.id, ['all'])).toEqual({});
  });

  it('a stamp on a row that pre-dates its Channel is cleared at adoption', async () => {
    const early = 'chats:early';
    for (const [n, data] of [[1, { mentions: ['all'], broadcastWakes: true, managerPost: true }], [2, { mentions: ['liam'] }]] as const) {
      await db.node.create({ data: { id: generateId(), memoryId: memory.id, loc: `${early}:messages:${n}`, name: String(n), nodeType: 'chat-message', seq: n, content: 'x', data } });
    }
    await mkChannel(memory.id, early, manager.id);
    const rows = await db.node.findMany({ where: { memoryId: memory.id, loc: { startsWith: `${early}:messages:` } }, orderBy: { seq: 'asc' } });
    expect(rows.map((r) => r.data)).toEqual([{ mentions: ['all'] }, { mentions: ['liam'] }]);
    expect(rows.every((r) => r.messageChannelId !== null)).toBe(true);
  });
});

describe('cycle 1 — smaller dispositions (Diego, Rook)', () => {
  it('a budget notice whose post failed is tried again, not lost for the day', async () => {
    await db.app.update({ where: { id: app.id }, data: { wakeDailyBudget: 0 } });
    await say(channel, 'for liam', mention('liam'));
    const teamChat = await import('../../api/graphql/schema/resolvers.teamChat.js');
    const spy = vi.spyOn(teamChat, 'postSystemNotice').mockRejectedValueOnce(new Error('chat down'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await due(ctx(manager.id));
    warn.mockRestore();
    await due(ctx(manager.id));
    expect(spy).toHaveBeenCalledTimes(2);
    await due(ctx(manager.id));
    expect(spy).toHaveBeenCalledTimes(2); // posted this time: once a day again
    spy.mockRestore();
  });

  it('an availability mark that has lapsed is not reported as in effect', async () => {
    await db.workerAvailability.create({ data: { workerId: liam.id, state: 'unavailable', reason: 'out-of-tokens', until: new Date(Date.now() - 1000), setAt: new Date(Date.now() - 3600_000), setBy: 'worker' } });
    await db.workerAvailability.create({ data: { workerId: rook.id, state: 'unavailable', reason: 'other', until: new Date(Date.now() + 3600_000), setAt: new Date(), setBy: 'worker' } });
    await say(channel, 'hi', mention('liam', 'rook'));
    const page = await due(ctx(manager.id));
    expect(page.wakes.find((w: any) => w.worker.id === liam.id).availability).toBeNull();
    expect(page.wakes.find((w: any) => w.worker.id === rook.id).availability).toMatchObject({ state: 'unavailable' });
  });
});

// ── Cycle 2: Diego's delta on fe5f5c97 ─────────────────────────────────────────

/** A transaction that does `work`, then stays open until released: the "revoker in flight" of a barrier test. */
function holdOpen(work: (tx: Parameters<Parameters<typeof db.$transaction>[0]>[0]) => Promise<void>) {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  let ready!: () => void;
  const locked = new Promise<void>((r) => { ready = r; });
  const done = db.$transaction(async (tx) => { await work(tx); ready(); await gate; });
  return { locked, release, done };
}
/** Whether `p` is still pending after `ms`, always releasing the barrier. */
async function stillWaiting(p: Promise<unknown>, h: { release: () => void }, ms = 500): Promise<boolean> {
  let settled = false;
  p.then(() => { settled = true; }, () => { settled = true; });
  try {
    await new Promise((r) => setTimeout(r, ms));
    return !settled;
  } finally {
    h.release();
  }
}

describe('cycle 2 — the authority anchors (Diego P2-1)', () => {
  const appLike = () => ({ id: app.id, organizationId: org.id, ownerUserId: null });

  it('a demotion that is in flight when an acknowledgement starts is waited for, then the proof is refused', async () => {
    await say(channel, 'one', mention('liam'));
    const w = (await due(ctx(manager.id))).wakes[0];
    const h = holdOpen(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('authorization:org'), hashtext(${org.id}))`;
      await tx.orgMember.deleteMany({ where: { userId: manager.id } });
    });
    await h.locked;
    const ack = M.acknowledgeWakes({}, { proofs: [w.proof] }, ctx(manager.id));
    const settledEarly = ack.then(() => 'ok', (e: any) => e.extensions?.code);
    expect(await stillWaiting(settledEarly, h)).toBe(true);
    await h.done;
    expect(await settledEarly).toBe('WAKE_PROOF_REQUESTER_MISMATCH');
    expect(await db.workerDeliveryChannel.count({ where: { workerId: liam.id } })).toBe(0);
  });

  it('an App uninstalled while an acknowledgement starts is waited for, then refused', async () => {
    await say(channel, 'one', mention('liam'));
    const w = (await due(ctx(holderA.id))).wakes[0];
    const h = holdOpen(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('authorization:app'), hashtext(${app.id}))`;
      await tx.app.update({ where: { id: app.id }, data: { uninstalledAt: new Date() } });
    });
    await h.locked;
    const settled = M.acknowledgeWakes({}, { proofs: [w.proof] }, ctx(holderA.id)).then(() => 'ok', (e: any) => e.extensions?.code);
    expect(await stillWaiting(settled, h)).toBe(true);
    await h.done;
    expect(await settled).toBe('WAKE_PROOF_REQUESTER_MISMATCH');
  });

  it('a post made while the App is being uninstalled waits, then stamps nothing', async () => {
    const h = holdOpen(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('authorization:app'), hashtext(${app.id}))`;
      await tx.app.update({ where: { id: app.id }, data: { uninstalledAt: new Date() } });
    });
    await h.locked;
    const stamped = stampsOf(ctx(manager.id), appLike(), null, ['all']);
    expect(await stillWaiting(stamped, h)).toBe(true);
    await h.done;
    expect(await stamped).toEqual({});
  });
});

describe('cycle 2 — issue and acknowledge share the budget lock (Diego P2-2)', () => {
  it('an acknowledgement waits for an issuer holding the App\'s budget lock, and the last slot is not handed out twice', async () => {
    await db.app.update({ where: { id: app.id }, data: { wakeDailyBudget: 1 } });
    await say(channel, 'for liam', mention('liam'));
    await say(channel, 'for rook', mention('rook'));
    const a = (await due(ctx(holderA.id))).wakes[0];
    const h = holdOpen(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'wakebudget:' + app.id}, 0))`;
    });
    await h.locked;
    const ack = M.acknowledgeWakes({}, { proofs: [a.proof] }, ctx(holderA.id));
    expect(await stillWaiting(ack, h)).toBe(true);
    await ack;
    // A is spent: the single slot is gone and B stays withheld, whichever order the reads came in.
    expect((await due(ctx(holderB.id))).wakes).toHaveLength(0);
    expect((await db.appWakeDay.findFirstOrThrow({ where: { appId: app.id } })).wakes).toBe(1);
  });
});

describe('cycle 2 — an old, unchanged proof cannot cancel a newer reservation (Diego P2-3)', () => {
  it('replaying the first proof after a second wake was issued leaves the second\'s allowance', async () => {
    await db.app.update({ where: { id: app.id }, data: { wakeDailyBudget: 2 } });
    await say(channel, 'one', mention('liam'));
    const p1 = (await due(ctx(holderA.id))).wakes[0];
    await M.acknowledgeWakes({}, { proofs: [p1.proof] }, ctx(holderA.id));
    const ageMs = 5 * 60_000;
    await pastFloor(ageMs);
    const replay = issuedEarlier(p1.proof, ageMs); // p1 as issued before its own (now five-minute-old) receipt
    await say(channel, 'two', mention('liam'));
    const p2 = (await due(ctx(holderA.id))).wakes[0];
    expect(p2.proof).not.toBe(p1.proof);
    const before = await db.appWakeReservation.findMany();
    expect(before).toHaveLength(1);
    // Rook wants the last slot (used 1 + Liam's reservation = 2): withheld.
    await say(channel, 'for rook', mention('rook'));
    expect((await due(ctx(holderB.id))).wakes).toHaveLength(0);
    // The old proof, replayed, is unchanged and must not free Liam's second reservation.
    expect(await M.acknowledgeWakes({}, { proofs: [replay] }, ctx(holderA.id))).toEqual({ acknowledged: 0, unchanged: 1 });
    expect(await db.appWakeReservation.findMany()).toEqual(before);
    expect((await due(ctx(holderB.id))).wakes).toHaveLength(0);
    // Acknowledging the second spends it for good.
    expect(await M.acknowledgeWakes({}, { proofs: [p2.proof] }, ctx(holderA.id))).toEqual({ acknowledged: 1, unchanged: 0 });
    expect(await db.appWakeReservation.count()).toBe(0);
  });
});

describe('cycle 2 — the scan cannot strand a MENTIONS ticker, nor stop at a row ceiling (Diego P2-4)', () => {
  const run = (userId: string, scan: { pageRows: number; maxRows: number }, extra: Record<string, unknown> = {}) =>
    computeDueWakes({ ctx: ctx(userId), app: { id: app.id, organizationId: org.id, ownerUserId: null }, reader: { manager: true, userId }, requester: { userId }, scan, ...extra });

  it('mentions OFF, a MENTIONS ticker, an ordinary register entry: chatter ahead of the mention does not hide it', async () => {
    const mo = await mkWorker('Mo', { heldByUserId: holderA.id, heldAt: new Date() });
    await db.workerWakeSettings.create({ data: { workerId: mo.id, mentions: 'OFF' } });
    const t = await mkTicker({ relevance: 'MENTIONS' });
    await subscribe(t.id, mo.id);
    for (let i = 0; i < 12; i++) await say(channel, `chatter ${i}`);
    await say(channel, 'for mo', mention('mo'));
    const page = await run(manager.id, { pageRows: 5, maxRows: 200 }, { workerIds: [mo.id] });
    expect(page.wakes.map((w) => w.workerId)).toEqual([mo.id]);
    expect(page.wakes[0]!.wake.reasons.map((r) => r.kind)).toEqual(['TICK']);
  });

  it('past the row ceiling with nothing relevant in the prefix, the mention is still found', async () => {
    const mo = await mkWorker('Mo', { heldByUserId: holderA.id, heldAt: new Date() });
    await db.registerEntry.updateMany({ where: { attendeeWorkerId: mo.id }, data: { mentionOnly: true } });
    for (let i = 0; i < 30; i++) await say(channel, `chatter ${i}`);
    await say(channel, 'for mo', mention('mo'));
    const page = await run(manager.id, { pageRows: 5, maxRows: 8 }, { workerIds: [mo.id] });
    expect(page.wakes.map((w) => w.workerId)).toEqual([mo.id]);
  });

  it('past the row ceiling, a worker\'s own posts ahead of one from someone else do not hide it either', async () => {
    const t = await mkTicker();
    await subscribe(t.id, liam.id);
    for (let i = 0; i < 30; i++) await say(channel, `mine ${i}`, { authorWorkerId: liam.id });
    await say(channel, 'from rook', { authorWorkerId: rook.id });
    const page = await run(manager.id, { pageRows: 5, maxRows: 8 }, { workerIds: [liam.id] });
    expect(page.wakes.map((w) => w.workerId)).toEqual([liam.id]);
  });
});

// ── Cycle 3: Diego's delta on 18eef56a ─────────────────────────────────────────

describe('cycle 3 — one outstanding wake per worker (Diego P2-1)', () => {
  it('a second issue before the first is acknowledged hands out the SAME wake, so one allowance buys one delivery', async () => {
    await db.app.update({ where: { id: app.id }, data: { wakeDailyBudget: 1 } });
    await say(channel, 'one', mention('liam'));
    const p1 = (await due(ctx(holderA.id))).wakes[0];
    expect(p1.channels[0]).toMatchObject({ fromSeq: 1, throughSeq: 1 });
    await say(channel, 'two', mention('liam'));
    const p2 = (await due(ctx(holderA.id))).wakes[0];
    // Not a wake through 2: the outstanding one, again.
    expect(p2.channels[0]).toMatchObject({ fromSeq: 1, throughSeq: 1 });
    expect(await db.appWakeReservation.count()).toBe(1);
    // Delivering and acknowledging both proofs spends the one slot once.
    expect(await M.acknowledgeWakes({}, { proofs: [p1.proof] }, ctx(holderA.id))).toEqual({ acknowledged: 1, unchanged: 0 });
    expect(await M.acknowledgeWakes({}, { proofs: [p2.proof] }, ctx(holderA.id))).toEqual({ acknowledged: 0, unchanged: 1 });
    expect((await db.appWakeDay.findFirstOrThrow({ where: { appId: app.id } })).wakes).toBe(1);
    // What arrived since is still owed, but the budget is spent and the floor holds: it waits, withheld.
    await pastFloor();
    const next = await due(ctx(holderA.id));
    expect(next.wakes).toEqual([]);
    expect(next.withheld).toBe(1);
  });

  it('with room in the budget the next wake follows the first, never alongside it', async () => {
    await say(channel, 'one', mention('liam'));
    const p1 = (await due(ctx(holderA.id))).wakes[0];
    await say(channel, 'two', mention('liam'));
    expect((await due(ctx(holderA.id))).wakes[0].channels[0].throughSeq).toBe(1);
    await M.acknowledgeWakes({}, { proofs: [p1.proof] }, ctx(holderA.id));
    await pastFloor();
    // #2072 (R53): the acknowledgement delivered no text, so the next wake still starts at the first mention.
    expect((await due(ctx(holderA.id))).wakes[0].channels[0]).toMatchObject({ fromSeq: 1, throughSeq: 2 });
  });
});

describe('cycle 4 — a reader who cannot see the outstanding wake is not handed a second one (Diego #8597)', () => {
  async function holderPrivateWake() {
    const personal = await db.memory.create({ data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:liam-personal4`, name: 'p', class: 'personal', userId: holderA.id } });
    const secret = await mkChannel(personal.id, 'chats:private', holderA.id);
    await db.registerEntry.create({ data: { id: generateId(), appId: app.id, channelId: secret.id, attendeeWorkerId: liam.id, role: 'BOTH' } });
    await say(secret, 'private news', mention('liam'));
    expect((await due(ctx(holderA.id))).wakes).toHaveLength(1);
    expect(await db.appWakeReservation.count()).toBe(1);
  }

  it('budget 1: the manager gets no second, uncharged wake for a worker whose private wake is outstanding', async () => {
    await db.app.update({ where: { id: app.id }, data: { wakeDailyBudget: 1 } });
    await holderPrivateWake();
    await say(channel, 'team news', mention('liam'));
    const theirs = await due(ctx(manager.id));
    expect(theirs.wakes).toEqual([]);
    expect(JSON.stringify(theirs)).not.toContain('private news');
    // The holder's one outstanding wake is still the only delivery against the allowance.
    expect(await db.appWakeReservation.count()).toBe(1);
  });

  it('a manager\'s own (exempt) mention still reaches them', async () => {
    await holderPrivateWake();
    await say(channel, 'from a manager', { ...mention('liam'), managerPost: true });
    const theirs = await due(ctx(manager.id));
    expect(theirs.wakes).toHaveLength(1);
    expect(theirs.wakes[0].channels.map((c: any) => c.channel.id)).toEqual([channel.id]);
  });
});

describe('cycle 3 — a recreated channel does not wedge an outstanding wake (Rook)', () => {
  it('the stored wake of a channel whose incarnation moved is dropped, and a fresh one can be acknowledged', async () => {
    await say(channel, 'one', mention('liam'));
    const p1 = (await due(ctx(holderA.id))).wakes[0];
    expect(await db.appWakeReservation.count()).toBe(1);
    // The channel is recreated: its seqs restart and its incarnation moves.
    await db.channel.update({ where: { id: channel.id }, data: { incarnation: { increment: 1 }, lastSeq: 0 } });
    await db.node.deleteMany({ where: { messageChannelId: channel.id } });
    await say(channel, 'fresh start', mention('liam'));
    // #2072 (R53) retired the STALE refusal of p1 here: a v3 proof names no channel, so a recreated one cannot void
    // it (the old-format v2 refusal is pinned under 'refuses a foreign requester…'). The stored wake is still dropped.
    const p2 = (await due(ctx(holderA.id))).wakes[0];
    expect(p2.channels[0].channel.id).toBe(channel.id);
    expect(await M.acknowledgeWakes({}, { proofs: [p2.proof] }, ctx(holderA.id))).toEqual({ acknowledged: 1, unchanged: 0 });
    expect(await db.appWakeReservation.count()).toBe(0);
  });
});

describe('cycle 3 — a candidate must be able to wake, not merely mention (Diego P2-2)', () => {
  const scan = { pageRows: 5, maxRows: 200 };
  const run = (userId: string, extra: Record<string, unknown> = {}, sc = scan) =>
    computeDueWakes({ ctx: ctx(userId), app: { id: app.id, organizationId: org.id, ownerUserId: null }, reader: { manager: true, userId }, requester: { userId }, scan: sc, ...extra });

  it('unstamped broadcasts ahead of a direct mention do not hide it (no subscription, immediate mentions)', async () => {
    for (let i = 0; i < 12; i++) await say(channel, `everyone ${i}`, mention('all'));
    await say(channel, 'for liam', mention('liam'));
    const page = await run(manager.id, { workerIds: [liam.id] });
    expect(page.wakes.map((w) => w.workerId)).toEqual([liam.id]);
    expect(page.wakes[0]!.wake.channels[0]).toMatchObject({ latestMentionSeq: 13 });
  });

  it('a worker\'s own mentions ahead of a real one do not fill the ceiling', async () => {
    for (let i = 0; i < 30; i++) await say(channel, `me ${i}`, { authorWorkerId: liam.id, mentions: ['liam'] });
    await say(channel, 'for liam', { authorWorkerId: rook.id, mentions: ['liam'] });
    const page = await run(manager.id, { workerIds: [liam.id] }, { pageRows: 5, maxRows: 8 });
    expect(page.wakes.map((w) => w.workerId)).toEqual([liam.id]);
  });

  it('a stamped broadcast is a candidate for an immediate worker; an unstamped one only for a ticker subscriber', async () => {
    for (let i = 0; i < 12; i++) await say(channel, `chatter ${i}`);
    await say(channel, 'everyone', { ...mention('all'), broadcastWakes: true });
    const page = await run(manager.id, { workerIds: [liam.id] });
    expect(page.wakes.map((w) => w.workerId)).toEqual([liam.id]);
  });
});

describe('cycle 3 — the stamp holds the Worker row in one mode (Diego P2-3)', () => {
  it('two broadcast posts from one lapsed granted-worker session into two channels both land', async () => {
    post.mockRestore();
    await db.appGrant.create({ data: { id: generateId(), appId: app.id, granteeWorkerId: liam.id, name: 'ticker.subscribe-workers', grantedBy: manager.id } });
    // A second memory: posts into one memory serialize on its path lock, so only different memories can interleave.
    const agent2 = await db.agent.create({ data: { id: generateId(), organizationId: org.id, name: 'Team2', urn: `${org.urn}:team2`, visibility: 'ORGANIZATION' } });
    await db.appAgent.create({ data: { appId: app.id, agentId: agent2.id } });
    const memory2 = await db.memory.create({ data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:team-shared-2`, name: 'shared2', class: 'app', appId: app.id, sharedMemoryOfAgentId: agent2.id } });
    const other = await mkChannel(memory2.id, 'chats:other', manager.id);
    const session = await db.session.create({ data: { id: generateId(), appId: app.id, userId: holderA.id, workerId: liam.id, agentId: agent.id, type: 'DEVELOPER', startedAt: new Date(Date.now() - 3 * DAY), updatedAt: new Date(Date.now() - 3 * DAY) } });
    // The schedule that deadlocks a SHARE-then-UPDATE order: while a third party holds the Worker row SHARED, both posts
    // get as far as they can; when it lets go, a post that already holds SHARE and wants UPDATE waits on the other's SHARE.
    const h = holdOpen(async (tx) => { await tx.$queryRaw`SELECT 1 FROM workers WHERE id = ${liam.id} FOR SHARE`; });
    await h.locked;
    const posts = runAsActor({ workerId: liam.id, agentId: agent.id }, () => Promise.allSettled([channel, other].map((c) =>
      teamChatMutations.createChannelMessage({}, { channelRef: c.id, body: 'standup @all', replyToSeq: null, sessionRef: session.id }, ctx(holderA.id)))));
    await stillWaiting(posts, h);
    const results = await posts;
    expect(results.map((r) => (r.status === 'rejected' ? String((r as PromiseRejectedResult).reason) : 'ok'))).toEqual(['ok', 'ok']);
    await h.done;
    // The session really was lapsed and resumed by the posts (otherwise this would not reach the Worker UPDATE).
    expect((await db.session.findUniqueOrThrow({ where: { id: session!.id } })).updatedAt?.getTime() ?? 0).toBeGreaterThan(Date.now() - 60_000);
    expect(await db.node.count({ where: { messageChannelId: { in: [channel.id, other.id] }, nodeType: 'chat-message' } })).toBe(2);
  });
});

describe('#2138 §3.3 — the live-check reason through the whole loader', () => {
  const liveTicker = () => mkTicker({ reasons: ['live-check'] });
  const task = (workerId: string, status = 'started') =>
    db.agentTask.create({ data: { id: generateId(), appId: app.id, title: 't', ownerUserId: manager.id, assigneeWorkerId: workerId, assignedAt: new Date(), status,
      ...(status === 'started' ? { startedAt: new Date() } : {}), ...(status === 'finished' ? { startedAt: new Date(), finishedAt: new Date(), resultOutcome: 'done' } : {}),
      ...(status === 'cancelled' ? { cancelledAt: new Date() } : {}) } });
  const stampCheck = (workerId: string, agoSec: number) =>
    db.channelReadState.upsert({
      where: { id: `chk-${workerId}` },
      create: { id: `chk-${workerId}`, workerId, channelId: channel.id, lastSeenSeq: 0, lastCheckedAt: new Date(Date.now() - agoSec * 1000) },
      update: { lastCheckedAt: new Date(Date.now() - agoSec * 1000) },
    });

  it('a worker with a task and a stale (or missing) check is due, with nothing unread', async () => {
    const t = await liveTicker();
    await subscribe(t.id, liam.id);
    await task(liam.id);
    expect(ids(await due(ctx(manager.id)))).toEqual([liam.id]);
    await stampCheck(liam.id, 700);
    expect(ids(await due(ctx(manager.id)))).toEqual([liam.id]);
  });

  it('a fresh check (younger than the cadence) is not due', async () => {
    const t = await liveTicker();
    await subscribe(t.id, liam.id);
    await task(liam.id);
    await stampCheck(liam.id, 30);
    expect(ids(await due(ctx(manager.id)))).toEqual([]);
  });

  it('a worker with NO task is PENDING: never due for a live-check; a finished or cancelled task does not count', async () => {
    const t = await liveTicker();
    await subscribe(t.id, liam.id);
    expect(ids(await due(ctx(manager.id)))).toEqual([]);
    await task(liam.id, 'finished');
    await task(liam.id, 'cancelled');
    expect(ids(await due(ctx(manager.id)))).toEqual([]);
  });

  it('an ASSIGNED-but-not-started (pending) task counts as having a task', async () => {
    const t = await liveTicker();
    await subscribe(t.id, liam.id);
    await task(liam.id, 'pending');
    expect(ids(await due(ctx(manager.id)))).toEqual([liam.id]);
  });

  it('an Agent with usesTasks:false counts as having a task', async () => {
    const t = await liveTicker();
    await subscribe(t.id, liam.id);
    await db.agent.update({ where: { id: agent.id }, data: { usesTasks: false } });
    expect(ids(await due(ctx(manager.id)))).toContain(liam.id);
  });

  it('paused, isolated-by-pause and a TEAM pause are never due', async () => {
    const t = await liveTicker();
    await subscribe(t.id, liam.id);
    await task(liam.id);
    await db.workerWakeSettings.create({ data: { workerId: liam.id, pausedUntil: new Date(Date.now() + 3600_000) } });
    expect(ids(await due(ctx(manager.id)))).toEqual([]);
    await db.workerWakeSettings.update({ where: { workerId: liam.id }, data: { pausedUntil: null } });
    expect(ids(await due(ctx(manager.id)))).toEqual([liam.id]);
    await db.app.update({ where: { id: app.id }, data: { teamPausedAt: new Date() } });
    expect(ids(await due(ctx(manager.id)))).toEqual([]);
  });

  it('#2013: a stamped @all post makes read-team-channel (relevance mentions) due, and a fresh check silences it', async () => {
    const t = await mkTicker({ relevance: 'MENTIONS', reasons: ['read-team-channel'] });
    await subscribe(t.id, liam.id);
    await db.workerWakeSettings.create({ data: { workerId: liam.id, mentions: 'OFF' } });
    await say(channel, '@all standup moved', { mentions: ['all'], broadcastWakes: true });
    expect(ids(await due(ctx(manager.id)))).toContain(liam.id);
    await stampCheck(liam.id, 30);
    expect(ids(await due(ctx(manager.id)))).not.toContain(liam.id);
  });

  it('#2138 §3.6: a TEAM pause silences EVERY reason, not only live-check: read-team-channel, every-tick and an immediate mention', async () => {
    const rtc = await mkTicker({ relevance: 'MENTIONS', reasons: ['read-team-channel'], name: 'R' });
    const every = await mkTicker({ reasons: ['every-tick'], name: 'E' });
    await subscribe(rtc.id, liam.id);
    await subscribe(every.id, liam.id);
    await say(channel, 'hey @liam', { mentions: ['liam'] }); // immediate mention (mentions IMMEDIATE by default)
    const reasons = async () => (await due(ctx(manager.id))).wakes.flatMap((w: any) => w.reasons.map((r: any) => r.kind)).sort();
    expect(await reasons()).toEqual(['MENTION', 'TICK', 'TICK']);
    await db.app.update({ where: { id: app.id }, data: { teamPausedAt: new Date() } });
    expect(await reasons()).toEqual([]);
    await db.app.update({ where: { id: app.id }, data: { teamPausedAt: null } });
    expect(await reasons()).toEqual(['MENTION', 'TICK', 'TICK']);
  });

  it('read-team-channel with an unread mention: due with a stale check, not with a fresh one', async () => {
    const t = await mkTicker({ relevance: 'MENTIONS', reasons: ['read-team-channel'] });
    await subscribe(t.id, liam.id);
    await db.workerWakeSettings.create({ data: { workerId: liam.id, mentions: 'OFF' } });
    await say(channel, 'hey @liam', { mentions: ['liam'] });
    expect(ids(await due(ctx(manager.id)))).toEqual([liam.id]);
    await stampCheck(liam.id, 30);
    expect(ids(await due(ctx(manager.id)))).toEqual([]);
  });
});

describe('S3 immutable team reach before wake sampling', () => {
  afterEach(() => vi.unstubAllEnvs());
  it('finds a real ordinary-author team post beyond irrelevant rows, without extending global @all', async () => {
    vi.stubEnv('TEAM_TAGS_ENABLED','true');
    post.mockRestore();
    const { writeReportsTo } = await import('../workerReportsTo.js');
    await db.$transaction(tx=>writeReportsTo(tx,{appId:app.id,workerId:liam.id,to:rook.id,actor:{userId:manager.id,workerId:null,agentId:null},setBy:'app-manager'}));
    const solo = await mkWorker('Solo',{heldByUserId:holderB.id,heldAt:new Date()});
    await db.registerEntry.updateMany({where:{attendeeWorkerId:{in:[liam.id,rook.id,solo.id]}},data:{mentionOnly:true}});
    for (let i=0;i<10;i++) await say(channel,`irrelevant ${i}`,{teamTagsVersion:1,teamBroadcastWorkerIds:[solo.id]});
    const posted = await teamChatMutations.createTeamChatMessage({}, {appRef:app.id,body:'@team.rook.all @all',sessionRef:null,replyToSeq:null},ctx(holderA.id));
    expect(posted.broadcastWakes).toBe(false);
    await db.$transaction(tx=>writeReportsTo(tx,{appId:app.id,workerId:liam.id,to:null,actor:{userId:manager.id,workerId:null,agentId:null},setBy:'app-manager'}));
    vi.stubEnv('TEAM_TAGS_ENABLED','false');
    const page = await computeDueWakes({ctx:ctx(manager.id),app:{id:app.id,organizationId:org.id,ownerUserId:null},reader:{manager:true,userId:manager.id},requester:{userId:manager.id},workerIds:[liam.id,rook.id],scan:{pageRows:1,maxRows:2}});
    expect(page.wakes.map(w=>w.workerId).sort()).toEqual([liam.id,rook.id].sort());
    expect(page.wakes.every(w=>w.wake.channels[0]?.latestMentionSeq===posted.seq)).toBe(true);
  });
});
