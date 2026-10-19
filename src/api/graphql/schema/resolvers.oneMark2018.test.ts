/**
 * #2018 S2 — one mark (D-2026-10-16-001, Holger ruling A; Xavier CHECKED 6258919583).
 * A text-batch ack raises delivered-through and, on a mention-only attendance only, the read position. A worker's own
 * mentions read raises delivered-through over the contiguous prefix it actually returned (and, mention-only, the read
 * position). Windows, gaps, other workers' filters and ALL-ticker coverage move nothing. Textless wake acks move no mark
 * (R53, pinned in legacyAckNoMarks2072.test.ts).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GraphQLError } from 'graphql';
import { randomBytes } from 'node:crypto';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { idleWindowMsFor } from '../../../lib/sessionActivity.js';
import { runAsActor } from '../../../lib/requestActor.js';
import { APP_KEY_PREFIX, hashAppKey } from '../../../middleware/auth.js';
import { ensureChannelWithRoot } from '../../../lib/channels.js';
import { appendChatMessage } from '../../../lib/chatRoot.js';
import { getMemoryEncryptionInfo } from '../../../lib/nodeCrypto.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../lib/bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));

const M = resolvers.Mutation as any;
const Q = resolvers.Query as any;

const ctx = (userId?: string): Context => ({ db, userId, roles: ['READER'] }) as Context;
async function code(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(GraphQLError);
    return (e as GraphQLError).extensions?.code as string;
  }
  return undefined;
}

let org: { id: string; urn: string };
let app: { id: string; urn: string };
let otherApp: { id: string };
let agentId: string;
let manager: { id: string };
let kit: { id: string; name: string };
let rook: { id: string; name: string };
let channel: { id: string; memoryId: string; loc: string; chatRootNodeId: string };
let hostKey: { id: string };   // attention:deliver + host:operate(orca1)
let otherHostKey: { id: string }; // attention:deliver + host:operate(orca2)
let bareKey: { id: string };   // attention:deliver only
let opOnlyKey: { id: string }; // host:operate only
let foreignKey: { id: string };

async function mkKey(appId: string, label: string) {
  const raw = `${APP_KEY_PREFIX}${randomBytes(32).toString('hex')}`;
  return db.appKey.create({ data: { id: generateId(), appId, keyHash: hashAppKey(raw), keyPreview: raw.slice(-4), label }, select: { id: true } });
}
const keyCtx = (k: { id: string }, appId = app.id, extra: Partial<Context> = {}): Context =>
  ({ db, appId, appKeyId: k.id, organizationId: org.id, roles: [], ...extra }) as Context;
const read = (k: { id: string }, extra: Record<string, unknown> = {}, appId = app.id) =>
  Q.deliveryBatches({}, { appRef: appId, ...extra }, keyCtx(k, appId));

async function say(body: string, data: Record<string, unknown> = {}) {
  const enc = await getMemoryEncryptionInfo(db, channel.memoryId);
  return appendChatMessage(db, { id: channel.chatRootNodeId, memoryId: channel.memoryId, loc: channel.loc }, enc, async ({ tx, seq, msgNum }) =>
    tx.node.create({ data: { id: generateId(), memoryId: channel.memoryId, loc: `${channel.loc}:messages:${msgNum}`, name: msgNum, nodeType: 'chat-message', seq, messageChannelId: channel.id, content: body, data: { authorName: 'Ada', mentions: [], ...data } } }),
    { asChannel: true });
}

beforeEach(async () => {
  await cleanDb(db);
  const n = Math.floor(Math.random() * 1_000_000);
  org = await db.organization.create({ data: { name: 'Batches', urn: `batches-${n}.example` }, select: { id: true, urn: true } });
  manager = await db.user.create({ data: { githubId: 81_000_000 + n, githubUsername: `bt-m-${n}`, roles: ['READER'] }, select: { id: true } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: manager.id, role: 'ADMIN' } });
  agentId = (await M.createAgent({}, { orgId: org.id, name: 'Team Agent' }, ctx(manager.id))).id;
  app = await db.app.create({ data: { organizationId: org.id, name: 'Team', urn: `${org.urn}:team` }, select: { id: true, urn: true } });
  otherApp = await db.app.create({ data: { organizationId: org.id, name: 'Other', urn: `${org.urn}:other` }, select: { id: true } });
  kit = await db.worker.create({ data: { appId: app.id, agentId, name: 'Kit', slug: 'kit' }, select: { id: true, name: true } });
  rook = await db.worker.create({ data: { appId: app.id, agentId, name: 'Rook', slug: 'rook' }, select: { id: true, name: true } });
  const memory = await db.memory.create({ data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:team-shared`, name: 'shared', class: 'app', appId: app.id, sharedMemoryOfAgentId: agentId } });
  const made = await ensureChannelWithRoot(db, { memoryId: memory.id, loc: 'chats:team', name: 'team', createdBy: manager.id });
  channel = { id: made.channel.id, memoryId: memory.id, loc: 'chats:team', chatRootNodeId: made.rootId };
  for (const w of [kit, rook]) await db.registerEntry.create({ data: { id: generateId(), appId: app.id, channelId: channel.id, attendeeWorkerId: w.id, role: 'BOTH' } });
  hostKey = await mkKey(app.id, 'orca1');
  otherHostKey = await mkKey(app.id, 'orca2');
  bareKey = await mkKey(app.id, 'bare');
  opOnlyKey = await mkKey(app.id, 'op-only');
  foreignKey = await mkKey(otherApp.id, 'foreign');
  const grant = (k: { id: string }, scope: string, hostId?: string) => M.grantAppKeyScope({}, { id: k.id, scope, ...(hostId ? { hostId } : {}) }, ctx(manager.id));
  await grant(hostKey, 'attention:deliver'); await grant(hostKey, 'host:operate', 'orca1');
  await grant(otherHostKey, 'attention:deliver'); await grant(otherHostKey, 'host:operate', 'orca2');
  await grant(bareKey, 'attention:deliver');
  await grant(opOnlyKey, 'host:operate', 'orca1');
  // orca1 launches Kit only; orca2 launches Rook only.
  await M.registerHost({}, { input: { appRef: app.id, label: 'Orca 1', pollIntervalSeconds: 60, workers: [{ worker: kit.id, family: 'claude', worktrees: [] }] } }, keyCtx(hostKey));
  await M.registerHost({}, { input: { appRef: app.id, label: 'Orca 2', pollIntervalSeconds: 60, workers: [{ worker: rook.id, family: 'claude', worktrees: [] }] } }, keyCtx(otherHostKey));
});

// Both workers are mentioned, and the window (the app floor) has long passed.
async function postForBoth() {
  await say('hello @kit and @rook', { mentions: ['kit', 'rook'] });
  await db.node.updateMany({ where: { messageChannelId: channel.id }, data: { createdAt: new Date(Date.now() - 3600_000) } });
}


async function ownSession(data: Record<string, unknown> = {}) {
  return db.session.create({ data: { id: generateId(), appId: app.id, userId: manager.id, workerId: kit.id, agentId, ...data } as any });
}
const selfCtx = (s: { id: string }, extra: Partial<Context> = {}): Context => ({ ...ctx(manager.id), appId: app.id, sessionId: s.id, ...extra });
const selfRead = (s: { id: string }, args: Record<string, unknown> = {}, extra: Partial<Context> = {}) =>
  Q.deliveryBatches({}, { appRef: app.id, ...args }, selfCtx(s, extra));
const selfAck = (s: { id: string }, batchIds: string[], extra: Partial<Context> = {}) =>
  M.acknowledgeDeliveryBatches({}, { batchIds }, selfCtx(s, extra));


const marks = async (w: { id: string } = kit) => ({
  delivered: (await db.workerDeliveryChannel.findUnique({ where: { workerId_channelId: { workerId: w.id, channelId: channel.id } } }))?.deliveredThroughSeq ?? 0,
  read: (await db.channelReadState.findFirst({ where: { workerId: w.id, channelId: channel.id } }))?.lastSeenSeq ?? 0,
});
const mentionOnly = (w: { id: string } = kit) => db.registerEntry.updateMany({ where: { attendeeWorkerId: w.id, channelId: channel.id }, data: { mentionOnly: true } });
const mentionsRead = (s: { id: string }, args: Record<string, unknown>) =>
  Q.channelMessages({}, { channelRef: channel.id, mentionsRef: kit.id, ...args }, selfCtx(s));
async function aged() { await db.node.updateMany({ where: { messageChannelId: channel.id }, data: { createdAt: new Date(Date.now() - 3600_000) } }); }

describe('#2018 S2: a text-batch ack', () => {
  it('on a mention-only attendance raises delivered and the read position to the batch end', async () => {
    await mentionOnly();
    await say('chatter');
    await say('for kit', { mentions: ['kit'] });
    await aged();
    const b = (await read(hostKey)).batches[0];
    await M.acknowledgeDeliveryBatches({}, { batchIds: [b.id] }, keyCtx(hostKey));
    expect(await marks()).toEqual({ delivered: 2, read: 2 });
  });

  it('on a full attendance raises delivered only (ruling A)', async () => {
    await say('chatter');
    await say('for kit', { mentions: ['kit'] });
    await aged();
    const b = (await read(hostKey)).batches[0];
    await M.acknowledgeDeliveryBatches({}, { batchIds: [b.id] }, keyCtx(hostKey));
    expect(await marks()).toEqual({ delivered: 2, read: 0 });
  });

  it('a partial through moves both marks exactly to it on a mention-only attendance, and never lowers them', async () => {
    await mentionOnly();
    for (const t of ['a', 'b', 'c']) await say(`@kit ${t}`, { mentions: ['kit'] });
    await aged();
    const b = (await read(hostKey)).batches[0];
    await M.acknowledgeDeliveryBatches({}, { batchIds: [b.id], through: [{ channelId: channel.id, seq: 2 }] }, keyCtx(hostKey));
    expect(await marks()).toEqual({ delivered: 2, read: 2 });
    // The full ack afterwards raises both to 3; an older partial replayed never lowers them.
    await M.acknowledgeDeliveryBatches({}, { batchIds: [b.id] }, keyCtx(hostKey));
    expect(await marks()).toEqual({ delivered: 3, read: 3 });
    await M.acknowledgeDeliveryBatches({}, { batchIds: [b.id], through: [{ channelId: channel.id, seq: 2 }] }, keyCtx(hostKey));
    expect(await marks()).toEqual({ delivered: 3, read: 3 });
  });
});

describe('#2018 S2: an own mentions read', () => {
  it('raises delivered over what it returned; mention-only also raises the read position; then nothing is due', async () => {
    const s = await ownSession();
    await mentionOnly();
    await say('chatter');
    await say('for kit', { mentions: ['kit'] });
    await aged();
    const page = await mentionsRead(s, { sinceSeq: 0, limit: 20 });
    expect(page.items.map((m: any) => m.seq)).toEqual([2]);
    expect(await marks()).toEqual({ delivered: 2, read: 2 });
    expect((await read(hostKey)).batches).toEqual([]);
  });

  it('on a full attendance raises delivered only, and the chatter stays unread', async () => {
    const s = await ownSession();
    await say('chatter');
    await say('for kit', { mentions: ['kit'] });
    await aged();
    await mentionsRead(s, { sinceSeq: 0, limit: 20 });
    expect(await marks()).toEqual({ delivered: 2, read: 0 });
    expect((await read(hostKey)).batches).toEqual([]);
  });

  it('a multi-page read raises only through the last returned seq; the rest stays due', async () => {
    const s = await ownSession();
    for (const t of ['a', 'b', 'c']) await say(`@kit ${t}`, { mentions: ['kit'] });
    await aged();
    await mentionsRead(s, { sinceSeq: 0, limit: 2 });
    expect((await marks()).delivered).toBe(2);
    const b = (await read(hostKey)).batches[0];
    expect(b.ranges.map((r: any) => [r.fromSeq, r.throughSeq])).toEqual([[3, 3]]);
    await mentionsRead(s, { sinceSeq: 2, limit: 2 });
    expect((await marks()).delivered).toBe(3);
  });

  it.each([
    ['a window (beforeSeq)', { sinceSeq: 0, beforeSeq: 3, limit: 20 }],
    ['the newest page (no sinceSeq)', { limit: 20 }],
    ['an offset', { sinceSeq: 0, offset: 1, limit: 20 }],
    ['a count probe', { sinceSeq: 0, limit: 0 }],
    ['a deferred read', { sinceSeq: 0, limit: 20, advanceReadState: false }],
    ['a gap above the mark', { sinceSeq: 1, limit: 20 }],
  ])('%s moves no mark', async (_label, args) => {
    const s = await ownSession();
    await say('@kit a', { mentions: ['kit'] });
    await say('@kit b', { mentions: ['kit'] });
    await aged();
    const q = (args as any).advanceReadState === false
      ? Q.channelMessages({}, { channelRef: channel.id, mentionsRef: kit.id, ...args }, selfCtx(s))
      : mentionsRead(s, args as Record<string, unknown>);
    await q;
    expect(await marks()).toEqual({ delivered: 0, read: 0 });
  });

  it('another worker\'s mentions filter moves nothing for either worker', async () => {
    const s = await ownSession();
    await say('@rook a', { mentions: ['rook'] });
    await aged();
    await Q.channelMessages({}, { channelRef: channel.id, mentionsRef: rook.id, sinceSeq: 0, limit: 20 }, selfCtx(s));
    expect(await marks()).toEqual({ delivered: 0, read: 0 });
    expect(await marks(rook)).toEqual({ delivered: 0, read: 0 });
  });

  it('an ALL-relevance ticker covering a full attendance makes a mentions read move nothing', async () => {
    const s = await ownSession();
    const t = await db.ticker.create({ data: { id: generateId(), appId: app.id, ownerUserId: manager.id, name: 'Eng', slug: 'eng', cadenceSeconds: 600, anchorAt: new Date(Date.now() - 3600_000) } });
    await db.tickerSubscription.create({ data: { id: generateId(), tickerId: t.id, workerId: kit.id, createdBy: manager.id } });
    await say('chatter');
    await say('@kit a', { mentions: ['kit'] });
    await aged();
    await mentionsRead(s, { sinceSeq: 0, limit: 20 });
    expect(await marks()).toEqual({ delivered: 0, read: 0 });
  });

  it('an unfiltered read is unchanged: it raises the read position and not delivered', async () => {
    const s = await ownSession();
    await say('@kit a', { mentions: ['kit'] });
    await Q.channelMessages({}, { channelRef: channel.id, sinceSeq: 0, limit: 20 }, selfCtx(s));
    expect(await marks()).toEqual({ delivered: 0, read: 1 });
  });
});
