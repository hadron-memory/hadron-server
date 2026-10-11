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
    expect(page.wakes[0].reasons).toEqual([{ kind: 'TICK', ticker: expect.objectContaining({ id: t.id }) }]);
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
    expect(await code(M.acknowledgeWakes({}, { proofs: [signWakeProof({ ...p, v: 2 } as never)] }, ctx(holderA.id)))).toBe('WAKE_PROOF_INVALID');
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
    expect(post).toHaveBeenCalledTimes(1);
    expect((post.mock.calls[0]![1] as any).body).toMatch(/daily wake budget is spent/);
    await due(ctx(manager.id));
    expect(post).toHaveBeenCalledTimes(1); // once a day
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
    expect(await wakeStampsFor(ctx(manager.id), appLike(), null, ['all'])).toEqual({ managerPost: true, broadcastWakes: true });
    expect(await wakeStampsFor(ctx(manager.id), appLike(), null, ['liam'])).toEqual({ managerPost: true });
    expect(await wakeStampsFor(ctx(holderA.id), appLike(), null, ['all'])).toEqual({});
    expect(await wakeStampsFor(ctx(manager.id), appLike(), null, [])).toEqual({});
  });

  it('a manager posting THROUGH a worker session is the worker\'s post: no manager stamp', async () => {
    expect(await wakeStampsFor(ctx(manager.id), appLike(), liam.id, ['all'])).toEqual({});
  });

  it('the grant worker with a person behind the session broadcasts; revoked, an App key, or impersonated does not', async () => {
    await grant(liam.id);
    expect(await wakeStampsFor(ctx(holderA.id), appLike(), liam.id, ['all'])).toEqual({ broadcastWakes: true });
    expect(await wakeStampsFor(ctx(holderA.id), appLike(), liam.id, ['rook'])).toEqual({}); // not a broadcast, grant is no exemption
    expect(await wakeStampsFor(ctx(undefined, { appId: app.id } as Partial<Context>), appLike(), liam.id, ['all'])).toEqual({});
    expect(await wakeStampsFor(ctx(holderA.id, { impersonation: { adminUserId: 'x' } } as any), appLike(), liam.id, ['all'])).toEqual({});
    expect(await wakeStampsFor(ctx(holderB.id), appLike(), rook.id, ['all'])).toEqual({}); // no grant
    await db.appGrant.updateMany({ data: { revokedAt: new Date() } });
    expect(await wakeStampsFor(ctx(holderA.id), appLike(), liam.id, ['all'])).toEqual({});
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
