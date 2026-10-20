/**
 * #2018 S2 — one mark (D-2026-10-16-001, Holger ruling A; Xavier CHECKED 6258919583).
 * A text-batch ack raises delivered-through and, on a mention-only attendance only, the read position. A worker's own
 * mentions read raises delivered-through over the contiguous prefix it actually returned (and, mention-only, the read
 * position). Windows, gaps, other workers' filters and ALL-ticker coverage move nothing. Textless wake acks move no mark
 * (R53, pinned in legacyAckNoMarks2072.test.ts).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GraphQLError } from 'graphql';
import { randomBytes } from 'node:crypto';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
import { idleWindowMsFor } from '../../../lib/sessionActivity.js';
import { runAsActor } from '../../../lib/requestActor.js';
import { APP_KEY_PREFIX, hashAppKey } from '../../../middleware/auth.js';
import { ensureChannelWithRoot } from '../../../lib/channels.js';
import { appendChatMessage } from '../../../lib/chatRoot.js';
import { getMemoryEncryptionInfo } from '../../../lib/nodeCrypto.js';
import { resolvers, type Context } from './resolvers.js';
import { maybeAdvanceOwnChannelRead } from '../../../lib/teamAttention.js';
import { recordMentionsWorker } from '../../../lib/mentionsReadResolution.js';
import { waitForLockWaiters } from '../../../test/lockWait.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../lib/bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));
// Rollback pin: a read-position write that fails after delivered was raised must leave both marks where they were.
const failRead = vi.hoisted(() => ({ on: false }));
vi.mock('../../../lib/channelReadState.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../lib/channelReadState.js')>();
  return { ...real, advanceReadState: vi.fn(async (...a: Parameters<typeof real.advanceReadState>) => {
    if (failRead.on) throw new Error('read write failed');
    return real.advanceReadState(...a);
  }) };
});

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
  kit = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: app.id, agentId, name: 'Kit', slug: 'kit' }, select: { id: true, name: true } });
  rook = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: app.id, agentId, name: 'Rook', slug: 'rook' }, select: { id: true, name: true } });
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

describe('#2018 S2: authority, exclusions, atomicity', () => {
  afterEach(() => { failRead.on = false; });

  it('the App convenience read (teamChatMessages) moves the marks the same way', async () => {
    const s = await ownSession();
    await mentionOnly();
    await say('@kit a', { mentions: ['kit'] });
    const page = await Q.teamChatMessages({}, { appRef: app.id, mentionsRef: kit.id, sinceSeq: 0, limit: 20 }, selfCtx(s));
    expect(page.items.map((m: any) => m.seq)).toEqual([1]);
    expect(await marks()).toEqual({ delivered: 1, read: 1 });
  });

  it('an ended session, or none, moves nothing; the page is still returned', async () => {
    const s = await ownSession({ endedAt: new Date() });
    await say('@kit a', { mentions: ['kit'] });
    const page = await mentionsRead(s, { sinceSeq: 0, limit: 20 }).catch(() => ({ items: [] }));
    expect(await marks()).toEqual({ delivered: 0, read: 0 });
    await Q.channelMessages({}, { channelRef: channel.id, mentionsRef: kit.id, sinceSeq: 0, limit: 20 }, ctx(manager.id));
    expect(await marks()).toEqual({ delivered: 0, read: 0 });
    expect(page).toBeDefined();
  });

  it('a session of a worker the channel does not register moves nothing for anyone', async () => {
    await db.registerEntry.deleteMany({ where: { attendeeWorkerId: kit.id } });
    const s = await ownSession();
    await say('@kit a', { mentions: ['kit'] });
    await mentionsRead(s, { sinceSeq: 0, limit: 20 });
    expect(await db.workerDeliveryChannel.count()).toBe(0);
    // #2138: the read is still a check (lastCheckedAt), but no read position moves for anyone.
    expect(await db.channelReadState.count({ where: { lastSeenSeq: { gt: 0 } } })).toBe(0);
  });

  it('an encrypted channel is excluded: the advance moves no mark even for a page filtered by the worker', async () => {
    // Called directly: without a session key the read itself refuses first, which would make this pin vacuous.
    const s = await ownSession();
    await mentionOnly();
    await say('@kit a', { mentions: ['kit'] });
    const page = { items: [{ seq: 1 }], total: 1 };
    recordMentionsWorker(page, kit.id);
    const args = { channelId: channel.id, capturedHead: 1, mentionsRef: kit.id, sinceSeq: 0, limit: 20, page };
    await db.memory.update({ where: { id: channel.memoryId }, data: { isEncrypted: true } });
    await maybeAdvanceOwnChannelRead(selfCtx(s), args);
    expect(await marks()).toEqual({ delivered: 0, read: 0 });
    // Control: the same call on the plaintext channel moves both.
    await db.memory.update({ where: { id: channel.memoryId }, data: { isEncrypted: false } });
    await maybeAdvanceOwnChannelRead(selfCtx(s), args);
    expect(await marks()).toEqual({ delivered: 1, read: 1 });
  });

  it('a failing read-position write rolls back the delivered raise (own read), and the page is still returned', async () => {
    const s = await ownSession();
    await mentionOnly();
    await say('@kit a', { mentions: ['kit'] });
    failRead.on = true;
    const page = await mentionsRead(s, { sinceSeq: 0, limit: 20 });
    expect(page.items).toHaveLength(1);
    expect(await marks()).toEqual({ delivered: 0, read: 0 });
  });

  it('a failing read-position write rolls back the whole batch ack', async () => {
    await mentionOnly();
    await say('@kit a', { mentions: ['kit'] });
    await aged();
    const b = (await read(hostKey)).batches[0];
    failRead.on = true;
    await expect(M.acknowledgeDeliveryBatches({}, { batchIds: [b.id] }, keyCtx(hostKey))).rejects.toThrow();
    expect(await marks()).toEqual({ delivered: 0, read: 0 });
  });

  // George P3 on 8f146ccb: Promise.all order does not decide which takes the wake lock first. The first is parked
  // holding the lock, the second is observed blocked on it, then the first is released.
  it.each(['read first', 'ack first'] as const)('an own read and a batch ack racing (%s holds the wake lock) end at the max of both', async (order) => {
    const s = await ownSession();
    await mentionOnly();
    for (const t of ['a', 'b', 'c']) await say(`@kit ${t}`, { mentions: ['kit'] });
    await aged();
    const b = (await read(hostKey)).batches[0];
    const park = parkAfterWakeLock();
    const ack = (d = db) => M.acknowledgeDeliveryBatches({}, { batchIds: [b.id], through: [{ channelId: channel.id, seq: 2 }] }, keyCtx(hostKey, app.id, { db: d as never }));
    const own = (d = db) => Q.channelMessages({}, { channelRef: channel.id, mentionsRef: kit.id, sinceSeq: 0, limit: 20 }, selfCtx(s, { db: d as never }));
    const first = order === 'read first' ? own(park.db) : ack(park.db);
    await park.reached;
    const second = order === 'read first' ? ack() : own();
    await waitForLockWaiters(db, 1);
    park.release();
    await Promise.all([first, second]);
    expect(await marks()).toEqual({ delivered: 3, read: 3 });
  });
});

/**
 * Wrap `db` so the first transaction statement matching `match` runs `before` first (awaited), or parks right
 * before or after it until released.
 */
function hookedDb(match: (sql: string, values: unknown[]) => boolean, hook: { before?: () => Promise<void>; park?: 'before' | 'after' }) {
  let fired = false;
  let reached!: () => void; const reachedP = new Promise<void>((r) => { reached = r; });
  let release!: () => void; const released = new Promise<void>((r) => { release = r; });
  const original = db.$transaction.bind(db) as any;
  const wrapped = new Proxy(db, { get(target, prop) {
    if (prop !== '$transaction') return Reflect.get(target, prop);
    return (work: any, opts: any) => original(async (tx: any) => work(new Proxy(tx, { get(t, key) {
      if (key !== '$executeRaw') return Reflect.get(t, key);
      return async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const hit = !fired && match(strings.join('?'), values);
        if (hit) { fired = true; await hook.before?.(); }
        if (hit && hook.park === 'before') { reached(); await released; }
        const result = await t.$executeRaw(strings, ...values);
        if (hit && hook.park === 'after') { reached(); await released; }
        return result;
      };
    } })), opts);
  } });
  return { db: wrapped, reached: reachedP, release, fired: () => fired };
}
const parkAfterWakeLock = () => hookedDb((sql, v) => sql.includes('pg_advisory_xact_lock(') && v.includes('wake:' + kit.id), { park: 'after' });
/** Park the mark transaction at its delivered write: every lock is held and every condition has been read. */
const parkAtMarkWrite = () => hookedDb((sql) => sql.includes('INSERT INTO worker_delivery_channels'), { park: 'before' });

/** An enabled ALL-relevance ticker covering every channel, with Kit subscribed (Dara's probe fixture). */
async function allTicker(opts: { enabled?: boolean; subscribe?: boolean } = {}) {
  const t = await db.ticker.create({ data: { id: generateId(), appId: app.id, ownerUserId: manager.id, name: 'All', slug: 'all', cadenceSeconds: 600, anchorAt: new Date(Date.now() - 3600_000), enabled: opts.enabled ?? true } });
  if (opts.subscribe ?? true) await db.tickerSubscription.create({ data: { id: generateId(), tickerId: t.id, workerId: kit.id, createdBy: manager.id } });
  return t;
}

// Dara P2-1 on 8f146ccb: the own-mentions marks are decided under the mark's own locks, not on the policy the
// preflight read. Unshown chatter at seq 1, the mention at seq 2; the mentions page returns [2].
describe('#2018 S2: the own-mentions mark decision is re-derived and fenced (Dara P2-1)', () => {
  type Kind = 'register' | 'session' | 'all-ticker' | 'control';
  // A second org admin edits the register: the session driver's own user anchor must not be what orders the write.
  async function admin2() {
    const u = await db.user.create({ data: { githubId: 82_000_000 + Math.floor(Math.random() * 1_000_000), githubUsername: `bt-a2-${generateId()}`, roles: ['READER'] }, select: { id: true } });
    await db.orgMember.create({ data: { organizationId: org.id, userId: u.id, role: 'ADMIN' } });
    return u;
  }
  async function setup(kind: Kind) {
    const s = await ownSession();
    if (kind !== 'all-ticker') await mentionOnly();
    await say('unshown chatter');
    await say('@kit visible', { mentions: ['kit'] });
    await aged();
    return s;
  }

  // The change commits AFTER the preflight and BEFORE the mark transaction's first lock: the decision must see it.
  it.each(['register', 'session', 'all-ticker', 'control'] as const)('a %s change committed after the preflight moves no mark', async (kind: Kind) => {
    const s = await setup(kind);
    const other = await admin2();
    const change = async () => {
      if (kind === 'register') {
        const e = await db.registerEntry.findFirstOrThrow({ where: { attendeeWorkerId: kit.id, channelId: channel.id } });
        await M.updateRegisterEntry({}, { ref: e.id, input: { role: 'POST' } }, ctx(other.id));
      } else if (kind === 'session') {
        await db.session.update({ where: { id: s.id }, data: { endedAt: new Date() } });
      } else if (kind === 'all-ticker') {
        await allTicker();
      }
    };
    // The mark transaction's first lock: the authority anchors (fixed head) or the wake lock (8f146ccb).
    const hook = hookedDb((sql, v) => sql.includes('pg_advisory_xact_lock') && (v.includes('authorization:app') || v.includes('wake:' + kit.id)), { before: change });
    const page = await Q.channelMessages({}, { channelRef: channel.id, mentionsRef: kit.id, sinceSeq: 0, limit: 20 }, selfCtx(s, { db: hook.db as never }));
    expect(hook.fired()).toBe(true);
    expect(page.items.map((m: any) => m.seq)).toEqual([2]);
    expect(await marks()).toEqual(kind === 'control' ? { delivered: 2, read: 2 } : { delivered: 0, read: 0 });
    // Nothing was marked delivered: a fresh host batch still starts at the unshown chatter (8f146ccb offered none).
    if (kind === 'all-ticker') expect((await read(hostKey)).batches[0]?.ranges[0]?.fromSeq).toBe(1);
  });

  // George P2 on 8ed33339: two own reads through the SAME session both hold its row FOR SHARE. The liveness re-check
  // under the wake lock must not write that row (the heartbeat already ran outside), or the wake holder's UPDATE waits
  // on the other reader's share lock while that reader waits on the wake lock: a deadlock.
  it('two own reads through the same session, both holding its row, one holding the wake lock, both complete', async () => {
    const s = await setup('control');
    const call = (d: unknown) => {
      const page = { items: [{ seq: 2 }], total: 1 };
      recordMentionsWorker(page, kit.id);
      return maybeAdvanceOwnChannelRead(selfCtx(s, { db: d as never }), { channelId: channel.id, capturedHead: 2, mentionsRef: kit.id, sinceSeq: 0, limit: 20, page });
    };
    // B: past its outside heartbeat, parked before its transaction's first lock. A: through to the wake lock, parked.
    // B then takes the session row FOR SHARE and waits on the wake lock; A is released.
    const parkB = hookedDb((sql, v) => sql.includes('pg_advisory_xact_lock') && v.includes('authorization:app'), { park: 'before' });
    const second = call(parkB.db);
    await parkB.reached;
    const parkA = parkAfterWakeLock();
    const first = call(parkA.db);
    await parkA.reached;
    parkB.release();
    await waitForLockWaiters(db, 1);
    parkA.release();
    const settled = await Promise.allSettled([first, second]);
    expect(settled.map((r) => r.status === 'rejected' ? String(r.reason) : r.status)).toEqual(['fulfilled', 'fulfilled']);
    expect(await marks()).toEqual({ delivered: 2, read: 2 });
  });

  // The writer arrives after the mark's locks: parked right after the wake lock (before any condition is read), or at
  // the delivered write (every condition read). It is observed blocked, the marks commit on the policy they were
  // decided on, and only then does it land.
  const kinds = ['register', 'session', 'ticker-enable', 'ticker-subscribe', 'ticker-create'] as const;
  const points = ['after the wake lock', 'at the mark write'] as const;
  it.each(kinds.flatMap((k) => points.map((p) => [k, p] as const)))('a %s writer arriving %s waits for the marks to commit', async (kind, point) => {
    const s = await setup(kind === 'register' || kind === 'session' ? 'control' : 'all-ticker');
    const other = await admin2();
    const ticker = kind === 'ticker-enable' ? await allTicker({ enabled: false })
      : kind === 'ticker-subscribe' ? await allTicker({ subscribe: false }) : null;
    const park = point === 'at the mark write' ? parkAtMarkWrite() : parkAfterWakeLock();
    const reading = Q.channelMessages({}, { channelRef: channel.id, mentionsRef: kit.id, sinceSeq: 0, limit: 20 }, selfCtx(s, { db: park.db as never }));
    await park.reached;
    let committed = false;
    const write = (async () => {
      if (kind === 'register') {
        const e = await db.registerEntry.findFirstOrThrow({ where: { attendeeWorkerId: kit.id, channelId: channel.id } });
        await M.updateRegisterEntry({}, { ref: e.id, input: { role: 'POST' } }, ctx(other.id));
      } else if (kind === 'session') {
        await db.session.update({ where: { id: s.id }, data: { endedAt: new Date() } });
      } else if (kind === 'ticker-enable') {
        await M.updateTicker({}, { ref: ticker!.id, input: { enabled: true } }, ctx(manager.id));
      } else if (kind === 'ticker-subscribe') {
        await M.subscribeWorker({}, { tickerRef: ticker!.id, workerRef: kit.id }, ctx(manager.id));
      } else {
        // A ticker created after the row scan has no row to hold: the App's tickers lock orders the create.
        const t = await M.createTicker({}, { appRef: app.id, input: { name: 'All', cadenceSeconds: 600 } }, ctx(manager.id));
        await M.subscribeWorker({}, { tickerRef: t.id, workerRef: kit.id }, ctx(manager.id));
      }
    })().then(() => { committed = true; });
    // Unfenced, the writer commits at once and nothing ever waits: fail fast instead of hanging the parked read.
    await waitForLockWaiters(db, 1, 2_000).catch((e) => { park.release(); throw e; });
    expect(committed).toBe(false);
    park.release();
    expect((await reading).items.map((m: any) => m.seq)).toEqual([2]);
    await write;
    expect(await marks()).toEqual(kind === 'register' || kind === 'session' ? { delivered: 2, read: 2 } : { delivered: 2, read: 0 });
  });
});
