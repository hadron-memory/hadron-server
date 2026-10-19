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
  const w = await db.worker.create({ data: { id: generateId(), appId: app.id, agentId: agent.id, name, slug: name.toLowerCase(), ...extra }, select: { id: true, name: true } });
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
    expect(page.wakes[0].reasons).toEqual([{ kind: 'TICK', ticker: expect.objectContaining({ id: t.id }), task: null }]);
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

describe('#2068 — a ticker that wakes without chat, through the whole loader', () => {
  it('ticks with no unread at all, acknowledges, and is not due again until the next tick; without the option it stays silent', async () => {
    const quiet = await mkTicker();
    await subscribe(quiet.id, liam.id);
    expect(ids(await due(ctx(manager.id)))).toEqual([]);
    await db.ticker.update({ where: { id: quiet.id }, data: { wakeWithoutChat: true } });
    const page = await due(ctx(manager.id));
    expect(ids(page)).toEqual([liam.id]);
    expect(page.wakes[0].reasons).toEqual([{ kind: 'TICK', ticker: expect.objectContaining({ id: quiet.id }), task: null }]);
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

  it('never bypasses a pause or the per-worker floor', async () => {
    const t = await mkTicker({ wakeWithoutChat: true });
    await subscribe(t.id, liam.id);
    await db.workerWakeSettings.create({ data: { workerId: liam.id, pausedUntil: new Date(Date.now() + 3600_000) } });
    expect(ids(await due(ctx(manager.id)))).toEqual([]);
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
    await db.workerDeliveryChannel.updateMany({ data: { deliveredAt: new Date(Date.now() - 3600_000) } });
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
    const row = await db.workerDeliveryChannel.findFirstOrThrow({ where: { workerId: liam.id } });
    expect(row).toMatchObject({ deliveredThroughSeq: 1, ackedByUserId: holderA.id });
    // Nothing newer: not due again (outside or inside the ceiling).
    expect(ids(await due(ctx(holderA.id)))).toEqual([]);

    // A repeat acknowledgement moves nothing and is not another wake against the budget.
    expect(await M.acknowledgeWakes({}, { proofs: [first.wakes[0].proof] }, ctx(holderA.id))).toEqual({ acknowledged: 0, unchanged: 1 });
    expect((await db.appWakeDay.findFirstOrThrow({ where: { appId: app.id } })).wakes).toBe(1);

    // An older proof can never lower delivered-through.
    await say(channel, 'two', mention('liam'));
    await db.workerDeliveryChannel.update({ where: { workerId_channelId: { workerId: liam.id, channelId: channel.id } }, data: { deliveredAt: new Date(Date.now() - 3600_000) } });
    const second = await due(ctx(holderA.id));
    await M.acknowledgeWakes({}, { proofs: [second.wakes[0].proof] }, ctx(holderA.id));
    await M.acknowledgeWakes({}, { proofs: [first.wakes[0].proof] }, ctx(holderA.id));
    expect((await db.workerDeliveryChannel.findFirstOrThrow({ where: { workerId: liam.id } })).deliveredThroughSeq).toBe(2);
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
    await db.workerDeliveryChannel.updateMany({ data: { deliveredAt: new Date(Date.now() - 3600_000) } });
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
    expect(await code(M.acknowledgeWakes({}, { proofs: [signWakeProof({ ...p, v: 3 } as never)] }, ctx(holderA.id)))).toBe('WAKE_PROOF_INVALID');
    const old = signWakeProof({ ...p, issuedAt: Date.now() - 16 * 60_000 });
    expect(await code(M.acknowledgeWakes({}, { proofs: [old] }, ctx(holderA.id)))).toBe('WAKE_PROOF_STALE');
    // A channel recreated since issue.
    await db.channel.update({ where: { id: channel.id }, data: { incarnation: { increment: 1 } } });
    expect(await code(M.acknowledgeWakes({}, { proofs: [w.proof] }, ctx(holderA.id)))).toBe('WAKE_PROOF_STALE');
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
    expect(later.wakes[0].wake.unreadMentions).toBe(2); // the burst is ONE wake
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
    await db.workerDeliveryChannel.updateMany({ data: { deliveredAt: new Date(Date.now() - 3600_000) } });
    await say(channel, 'again', mention('liam'));
    const after = await due(ctx(manager.id));
    expect(after.wakes).toEqual([]);
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
    const old = new Date(Date.now() - 3600_000);
    await db.workerDeliveryChannel.updateMany({ where: { workerId: liam.id }, data: { deliveredAt: old, ackedByUserId: manager.id } });
    await db.workerDeliveryTick.updateMany({ where: { workerId: liam.id }, data: { ackedAt: old, ackedByUserId: manager.id } });
    expect(await M.acknowledgeWakes({}, { proofs: [first.proof] }, ctx(holderA.id))).toEqual({ acknowledged: 0, unchanged: 1 });
    const ch = await db.workerDeliveryChannel.findFirstOrThrow({ where: { workerId: liam.id } });
    const tk = await db.workerDeliveryTick.findFirstOrThrow({ where: { workerId: liam.id } });
    expect([ch.deliveredAt.getTime(), ch.ackedByUserId]).toEqual([old.getTime(), manager.id]);
    expect([tk.ackedAt.getTime(), tk.ackedByUserId]).toEqual([old.getTime(), manager.id]);
    // A newer mention is therefore not held back by the replay: the window ended an hour ago.
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
    await db.workerDeliveryChannel.updateMany({ data: { deliveredAt: new Date(Date.now() - 3600_000) } });
    await say(channel, 'two', mention('liam'));
    const p2 = (await due(ctx(holderA.id))).wakes[0];
    expect(p2.proof).not.toBe(p1.proof);
    const before = await db.appWakeReservation.findMany();
    expect(before).toHaveLength(1);
    // Rook wants the last slot (used 1 + Liam's reservation = 2): withheld.
    await say(channel, 'for rook', mention('rook'));
    expect((await due(ctx(holderB.id))).wakes).toHaveLength(0);
    // The old proof, replayed, is unchanged and must not free Liam's second reservation.
    expect(await M.acknowledgeWakes({}, { proofs: [p1.proof] }, ctx(holderA.id))).toEqual({ acknowledged: 0, unchanged: 1 });
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
    await db.workerDeliveryChannel.updateMany({ data: { deliveredAt: new Date(Date.now() - 3600_000) } });
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
    await db.workerDeliveryChannel.updateMany({ data: { deliveredAt: new Date(Date.now() - 3600_000) } });
    expect((await due(ctx(holderA.id))).wakes[0].channels[0]).toMatchObject({ fromSeq: 2, throughSeq: 2 });
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
    expect(await code(M.acknowledgeWakes({}, { proofs: [p1.proof] }, ctx(holderA.id)))).toBe('WAKE_PROOF_STALE');
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
