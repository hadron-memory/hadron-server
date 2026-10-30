import { WORKER_SIGNATURE_DEFAULTS } from '../workerSignature.js';
/**
 * #2790 — `WakeReason.tickDueAt`: a TICK reason's own oldest unacknowledged tick time (cor:agt:080:23), per reason,
 * computed at read time, null for every other kind; `anchorAt` stays the minimum over all reasons (cor:agt:080:27).
 * The same value is shown by the MCP `hadron_due_wakes`.
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
import { createTestableMcpServer } from '../../mcp/server.js';
import type { AuthContext } from '../../middleware/auth.js';

vi.mock('../bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));
vi.mock('../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../integrations/github/syncGraphFromGithub.js', () => ({ syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }) }));

const Q = resolvers.Query as any;
const M = resolvers.Mutation as any;

const ctx = (userId?: string, extra: Partial<Context> = {}): Context => ({ db, userId, roles: ['READER'], ...extra }) as Context;
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


const iso = (d: Date | null | undefined) => d?.toISOString() ?? null;
const tickOf = (w: any, tickerId: string) => w.reasons.find((r: any) => r.kind === 'TICK' && r.ticker.id === tickerId);
const at = (ms: number) => new Date(ms);
const SEC = 1000;
const auth = (userId: string) => ({ userId, roles: ['READER'], clientId: `user:${userId}` }) as AuthContext;
const mcpText = async (userId: string) => {
  const sh = createTestableMcpServer(auth(userId), { sessionId: `td-${generateId()}`, cachedAppResolution: { kind: 'multi-app' } });
  const r: any = await sh.callTool('hadron_due_wakes', { appRef: app.id });
  return r.content[0].text as string;
};
/** Moves the one posted message `agoSec` seconds into the past (the mention's post time is the wake's anchor). */
const backdate = (agoSec: number) => db.node.updateMany({ where: { messageChannelId: channel.id }, data: { createdAt: at(Date.now() - agoSec * SEC) } });

describe('#2790 tickDueAt: a TICK reason carries its own oldest unacknowledged tick', () => {
  it('an old mention and a fresh tick: the tick reason shows the TICK\'s time, anchorAt stays the mention\'s', async () => {
    const anchor = Date.now() - 1000 * SEC; // tick 1 fell 400 s ago; it is the only tick so far
    const t = await mkTicker({ cadenceSeconds: 600, anchorAt: at(anchor) });
    await subscribe(t.id, liam.id);
    await say(channel, 'old news for you', mention('liam'));
    await backdate(3000);
    const posted = Date.now() - 3000 * SEC;
    const w = (await due(ctx(manager.id))).wakes[0];
    expect(w.reasons.map((r: any) => r.kind).sort()).toEqual(['MENTION', 'TICK']);
    expect(iso(tickOf(w, t.id).tickDueAt)).toBe(at(anchor + 600 * SEC).toISOString());
    expect(Math.abs(w.anchorAt.getTime() - posted)).toBeLessThan(2 * SEC);
    expect(w.reasons.find((r: any) => r.kind === 'MENTION').tickDueAt).toBeNull();
  });

  it('a re-handed TICK reason keeps its tickDueAt after the subscription ends, or the ticker is disabled (Diego P2-1)', async () => {
    const anchor = Date.now() - 1000 * SEC;
    const t = await mkTicker({ cadenceSeconds: 600, anchorAt: at(anchor) });
    await subscribe(t.id, liam.id);
    await say(channel, 'old news for you', mention('liam'));
    const first = (await due(ctx(manager.id))).wakes[0];
    const want = at(anchor + 600 * SEC).toISOString();
    expect(iso(tickOf(first, t.id).tickDueAt)).toBe(want);
    await M.unsubscribeWorker({}, { tickerRef: t.id, workerRef: liam.id }, ctx(manager.id));
    const ended = (await due(ctx(manager.id))).wakes[0];
    expect(ended.reasons.map((r: any) => r.kind).sort()).toEqual(['MENTION', 'TICK']);
    expect(iso(tickOf(ended, t.id).tickDueAt)).toBe(want);
    await db.ticker.update({ where: { id: t.id }, data: { enabled: false } });
    const disabled = (await due(ctx(manager.id))).wakes[0];
    expect(iso(tickOf(disabled, t.id).tickDueAt)).toBe(want);
  });

  it('two tickers, A with an old unacknowledged tick and B with a fresh one: each shows its own; a TICK-only wake anchors on the smallest', async () => {
    const now = Date.now();
    const a = await mkTicker({ name: 'A', slug: `a-${generateId().slice(-5)}`, cadenceSeconds: 600, anchorAt: at(now - 3000 * SEC) });
    const b = await mkTicker({ name: 'B', slug: `b-${generateId().slice(-5)}`, cadenceSeconds: 600, anchorAt: at(now - 1000 * SEC) });
    await subscribe(a.id, liam.id);
    await subscribe(b.id, liam.id);
    await say(channel, 'plain news'); // an ALL ticker fires on relevant unread
    const w = (await due(ctx(manager.id))).wakes[0];
    expect(w.reasons.map((r: any) => r.kind)).toEqual(['TICK', 'TICK']);
    const aAt = iso(tickOf(w, a.id).tickDueAt);
    const bAt = iso(tickOf(w, b.id).tickDueAt);
    expect(aAt).toBe(at(now - 3000 * SEC + 600 * SEC).toISOString());
    expect(bAt).toBe(at(now - 1000 * SEC + 600 * SEC).toISOString());
    // cor:agt:080:27: the wake's anchor is at or before every TICK reason's time, and equals the smallest of them here.
    expect(w.anchorAt.getTime()).toBeLessThanOrEqual(Date.parse(bAt!));
    expect(w.anchorAt.toISOString()).toBe(aAt);
  });

  it('several unacknowledged ticks on one ticker: the OLDEST one, and the one after the acknowledged tick', async () => {
    const now = Date.now();
    const t = await mkTicker({ cadenceSeconds: 600, anchorAt: at(now - 3700 * SEC) }); // ticks 1..6 have fallen
    await subscribe(t.id, liam.id);
    await say(channel, 'plain news');
    const first = (await due(ctx(manager.id))).wakes[0];
    expect(iso(tickOf(first, t.id).tickDueAt)).toBe(at(now - 3700 * SEC + 600 * SEC).toISOString());
    await db.appWakeReservation.deleteMany();
    await db.workerDeliveryTick.create({ data: { workerId: liam.id, tickerId: t.id, lastAckedTick: 2, ackedAt: at(now - DAY) } });
    const later = (await due(ctx(manager.id))).wakes[0];
    expect(iso(tickOf(later, t.id).tickDueAt)).toBe(at(now - 3700 * SEC + 3 * 600 * SEC).toISOString());
  });

  it('a tick that joins an outstanding wake leaves that ticker\'s tickDueAt at its OLDEST unacknowledged tick, read now', async () => {
    const T0 = Date.now();
    const anchor = T0 - 1000 * SEC; // tick 1 at T0 - 400 s
    const t = await mkTicker({ cadenceSeconds: 600, anchorAt: at(anchor) });
    await subscribe(t.id, liam.id);
    await say(channel, 'plain news');
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(at(T0));
      const first = (await due(ctx(manager.id))).wakes[0];
      expect(iso(tickOf(first, t.id).tickDueAt)).toBe(at(anchor + 600 * SEC).toISOString());
      vi.setSystemTime(at(T0 + 1300 * SEC)); // ticks 2 and 3 have fallen: tick 3 joins the outstanding wake
      const joined = (await due(ctx(manager.id))).wakes[0];
      expect(iso(tickOf(joined, t.id).tickDueAt)).toBe(at(anchor + 600 * SEC).toISOString());
      expect(joined.anchorAt.toISOString()).toBe(at(anchor + 600 * SEC).toISOString());
    } finally {
      vi.useRealTimers();
    }
  });

  it('a MENTION-only wake has no tickDueAt on any reason', async () => {
    await say(channel, 'for you', mention('liam'));
    const w = (await due(ctx(manager.id))).wakes[0];
    expect(w.reasons.map((r: any) => [r.kind, r.tickDueAt ?? null])).toEqual([['MENTION', null]]);
  });
});

describe('#2790 MCP parity: hadron_due_wakes shows a TICK reason\'s tickDueAt and no other kind\'s', () => {
  it('the tick line carries tickDueAt; a mention-only wake carries none', async () => {
    const anchor = Date.now() - 1000 * SEC;
    const t = await mkTicker({ cadenceSeconds: 600, anchorAt: at(anchor) });
    await subscribe(t.id, liam.id);
    await say(channel, 'plain news');
    const text = await mcpText(manager.id);
    expect(text).toContain(`tick Eng tickDueAt ${at(anchor + 600 * SEC).toISOString()}`);

    await db.appWakeReservation.deleteMany();
    await db.tickerSubscription.deleteMany();
    await say(channel, 'for you', mention('liam'));
    const mentionOnly = await mcpText(manager.id);
    expect(mentionOnly).toContain('mention');
    expect(mentionOnly).not.toContain('tickDueAt');
  });
});
