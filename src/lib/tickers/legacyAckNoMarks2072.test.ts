/**
 * #2072 — Holger R53 (A′, cor:agt:080:04/:16): a legacy wake acknowledgement never moves a message mark.
 * Wake proofs carry no channel ranges; acknowledging any legacy proof (old v1/v2 ones naming channels included)
 * records ticks, task receipts and budget, and leaves delivered-through and the read position where they were.
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

/** The signed payload of a wake proof, as an acknowledger reads it. */
const payloadOf = (proof: string) => verifyWakeProof(proof);
const marks = () => db.workerDeliveryChannel.findMany({ where: { workerId: liam.id } });
const ack = (proofs: string[], c: Context) => M.acknowledgeWakes({}, { proofs }, c);

describe('#2072 / R53: issued wake proofs carry no channel ranges', () => {
  it('a MENTION wake keeps its display channels on the wake object, and its proof names no channel', async () => {
    await say(channel, 'one', mention('liam'));
    const w = (await due(ctx(holderA.id))).wakes[0];
    expect(w.channels.map((c: any) => c.channel.id)).toEqual([channel.id]); // display/counts unchanged
    expect(payloadOf(w.proof).channels).toEqual([]);
  });

  it('a TICK wake on an ALL ticker with unread chat names no channel in its proof', async () => {
    const t = await mkTicker();
    await subscribe(t.id, liam.id);
    await say(channel, 'news');
    const w = (await due(ctx(manager.id))).wakes[0];
    expect(w.reasons.map((r: any) => r.kind)).toEqual(['TICK']);
    expect(payloadOf(w.proof).channels).toEqual([]);
  });
});

describe('#2072 / R53: acknowledging a legacy wake moves no message mark', () => {
  it('a MENTION wake ack moves neither delivered-through nor the read position; the mention text stays undelivered', async () => {
    await say(channel, 'one', mention('liam'));
    const w = (await due(ctx(holderA.id))).wakes[0];
    await ack([w.proof], ctx(holderA.id));
    expect(await marks()).toEqual([]);
    expect(await db.channelReadState.count({ where: { workerId: liam.id } })).toBe(0);
    // The reservation of the acknowledged wake is spent either way: the worker is not wedged behind it.
    expect(await db.appWakeReservation.count({ where: { workerId: liam.id } })).toBe(0);
  });

  it('a TICK wake with unread chat records the tick and moves no channel mark', async () => {
    const t = await mkTicker();
    await subscribe(t.id, liam.id);
    await say(channel, 'news');
    const w = (await due(ctx(manager.id))).wakes[0];
    expect(await ack([w.proof], ctx(manager.id))).toEqual({ acknowledged: 1, unchanged: 0 });
    expect((await db.workerDeliveryTick.findFirstOrThrow({ where: { workerId: liam.id, tickerId: t.id } })).lastAckedTick).toBeGreaterThanOrEqual(1);
    expect(await marks()).toEqual([]);
  });

  it('a mixed MENTION + TICK wake records the tick only', async () => {
    const t = await mkTicker();
    await subscribe(t.id, liam.id);
    await say(channel, 'one', mention('liam'));
    const w = (await due(ctx(manager.id))).wakes[0];
    expect(w.reasons.map((r: any) => r.kind).sort()).toEqual(['MENTION', 'TICK']);
    await ack([w.proof], ctx(manager.id));
    expect(await db.workerDeliveryTick.count({ where: { workerId: liam.id } })).toBe(1);
    expect(await marks()).toEqual([]);
  });

  it('an old-format (v2) proof that still names a channel range writes no channel mark, and still records its tick', async () => {
    const t = await mkTicker();
    await subscribe(t.id, liam.id);
    await say(channel, 'one', mention('liam'));
    const w = (await due(ctx(manager.id))).wakes[0];
    const issued = payloadOf(w.proof);
    const ch = await db.channel.findUniqueOrThrow({ where: { id: channel.id } });
    // As a proof issued before the deploy: v2, naming the channel's range.
    const old = signWakeProof({
      v: 2, kind: 'wake-proof', appId: app.id, workerId: liam.id, requester: { userId: manager.id },
      channels: [{ channelId: channel.id, incarnation: ch.incarnation, through: 1 }],
      ticks: issued.ticks, tasks: [], exempt: false, issuedAt: Date.now(),
    });
    await ack([old], ctx(manager.id));
    expect(await marks()).toEqual([]);
    expect(await db.workerDeliveryTick.count({ where: { workerId: liam.id } })).toBe(1);
    expect(await db.channelReadState.count({ where: { workerId: liam.id } })).toBe(0);
  });

  it('an old v1 proof naming a channel range writes no channel mark', async () => {
    await say(channel, 'one', mention('liam'));
    const ch = await db.channel.findUniqueOrThrow({ where: { id: channel.id } });
    const old = signWakeProof({
      v: 1, kind: 'wake-proof', appId: app.id, workerId: liam.id, requester: { userId: holderA.id },
      channels: [{ channelId: channel.id, incarnation: ch.incarnation, through: 1 }],
      ticks: [], exempt: false, issuedAt: Date.now(),
    } as never);
    await ack([old], ctx(holderA.id));
    expect(await marks()).toEqual([]);
  });

  it('old-format validation stays: a v2 proof naming a recreated channel is stale, and a failed call writes nothing', async () => {
    const t = await mkTicker();
    await subscribe(t.id, liam.id);
    await say(channel, 'one', mention('liam'));
    const w = (await due(ctx(manager.id))).wakes[0];
    const issued = payloadOf(w.proof);
    const old = signWakeProof({
      v: 2, kind: 'wake-proof', appId: app.id, workerId: liam.id, requester: { userId: manager.id },
      channels: [{ channelId: channel.id, incarnation: 99, through: 1 }],
      ticks: [], tasks: [], exempt: false, issuedAt: Date.now(),
    });
    expect(await code(ack([w.proof, old], ctx(manager.id)))).toBe('WAKE_PROOF_STALE');
    expect(await db.workerDeliveryTick.count({ where: { workerId: liam.id } })).toBe(0);
    expect(issued.ticks.length).toBe(1);
  });
});
