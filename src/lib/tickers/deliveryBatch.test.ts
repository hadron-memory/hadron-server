import { WORKER_SIGNATURE_DEFAULTS } from '../workerSignature.js';
/** S1 slice (c), #2017: whole-loader DB fixtures. Authority entry gates are Liam's resolver tests. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../id.js';
import { ensureChannelWithRoot } from '../channels.js';
import { appendChatMessage } from '../chatRoot.js';
import { getMemoryEncryptionInfo } from '../nodeCrypto.js';
import type { Context } from '../../api/graphql/schema/resolvers.js';
import { loadDeliveryBatches } from './deliveryBatch.js';

vi.mock('../bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));
vi.mock('../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../integrations/github/syncGraphFromGithub.js', () => ({ syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }) }));
const posted = new Date('2026-10-19T10:00:00Z');
const ready = new Date('2026-10-19T11:00:00Z');
type Ch = { id: string; memoryId: string; loc: string; chatRootNodeId: string };
let org: { id: string; urn: string }, manager: { id: string }, holder: { id: string };
let app: { id: string; urn: string; organizationId: string | null; ownerUserId: string | null };
let agent: { id: string }, worker: { id: string; name: string }, registration: { id: string };
let channel: Ch, caller: Context;
const person = async (n: number) => db.user.create({ data: { id: generateId(), githubId: 99600 + n, githubUsername: `loader-${n}-${generateId()}`, roles: ['READER'] }, select: { id: true } });
const userCtx = (id: string): Context => ({ db, userId: id, roles: ['READER'] });
const register = (hostId: string) => db.hostRegistration.create({ data: { id: generateId(), appId: app.id, hostId, label: hostId, pollIntervalSeconds: 60, refreshedAt: ready } });
const watch = (w: string, ch: Ch, role: 'BOTH' | 'POST' = 'BOTH') => db.registerEntry.create({ data: { id: generateId(), appId: app.id, channelId: ch.id, attendeeWorkerId: w, role } });
const newChannel = async (memoryId: string, loc: string): Promise<Ch> => {
  const made = await ensureChannelWithRoot(db, { memoryId, loc, name: loc, createdBy: manager.id });
  return { id: made.channel.id, memoryId, loc, chatRootNodeId: made.rootId };
};
const newWorker = async (name: string, host = registration.id) => {
  const w = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId: app.id, agentId: agent.id, name, slug: name.toLowerCase(), heldByUserId: holder.id, heldAt: posted }, select: { id: true, name: true } });
  await db.hostRegistrationWorker.create({ data: { registrationId: host, workerId: w.id, family: 'codex' } });
  await watch(w.id, channel); return w;
};
const say = async (body: string, extra: Record<string, unknown> = {}, ch = channel, at = posted) => {
  const encryption = await getMemoryEncryptionInfo(db, ch.memoryId);
  return appendChatMessage(db, { id: ch.chatRootNodeId, memoryId: ch.memoryId, loc: ch.loc }, encryption,
    async ({ tx, seq, msgNum }) => tx.node.create({ data: { id: generateId(), memoryId: ch.memoryId, loc: `${ch.loc}:messages:${msgNum}`, name: msgNum, nodeType: 'chat-message', seq, messageChannelId: ch.id, content: body, createdAt: at, data: { authorName: 'Ada', mentions: ['target'], ...extra } } }), { asChannel: true });
};
const load = (extra: Partial<Parameters<typeof loadDeliveryBatches>[0]> = {}) => loadDeliveryBatches({ ctx: caller, app, hostId: 'host-a', now: ready, ...extra });
const batch = async () => { const page = await load(); expect(page.batches).toHaveLength(1); return page.batches[0]!; };
const mark = (through: number, incarnation = 1) => db.workerDeliveryChannel.create({ data: { workerId: worker.id, channelId: channel.id, channelIncarnation: incarnation, deliveredThroughSeq: through, deliveredAt: posted } });
const rawMessages = async (count: number, mentions: string[] = ['target']) => {
  await db.node.createMany({ data: Array.from({ length: count }, (_, i) => ({ id: generateId(), memoryId: channel.memoryId, loc: `${channel.loc}:messages:bulk-${i+1}`, name: `bulk-${i+1}`, nodeType: 'chat-message', seq: i+1, messageChannelId: channel.id, content: `message-${i+1}`, createdAt: new Date(posted.getTime() + i), data: { authorName: 'Ada', mentions } })) });
  await db.channel.update({ where: { id: channel.id }, data: { lastSeq: count, lastMessageAt: posted } });
};

beforeEach(async () => {
  await cleanDb(db);
  org = await db.organization.create({ data: { id: generateId(), name: 'Loader', urn: `loader-${generateId()}.com` } });
  manager = await person(1); holder = await person(2);
  await db.orgMember.create({ data: { organizationId: org.id, userId: manager.id, role: 'ADMIN' } });
  agent = await db.agent.create({ data: { id: generateId(), organizationId: org.id, name: 'Loader', urn: `${org.urn}:agent`, visibility: 'ORGANIZATION' }, select: { id: true } });
  app = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Loader', urn: `${org.urn}:app` } });
  await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
  await db.appMember.create({ data: { appId: app.id, userId: holder.id, role: 'member' } });
  const key = await db.appKey.create({ data: { id: generateId(), appId: app.id, keyHash: `loader-${generateId()}`, keyPreview: 'test' } });
  caller = { db, appId: app.id, appKeyId: key.id, roles: [] };
  const memory = await db.memory.create({ data: { id: generateId(), organizationId: org.id, name: 'Shared', urn: `${org.urn}:shared`, class: 'app', appId: app.id, sharedMemoryOfAgentId: agent.id } });
  channel = await newChannel(memory.id, 'chats:team');
  registration = await register('host-a');
  worker = await newWorker('Target');
});

describe('whole delivery batch loader: host roster and S4 reach', () => {
  it('returns only this host live registration and active workers, with no trace of others', async () => {
    const other = await register('host-b');
    const foreign = await newWorker('Foreign', other.id);
    const retired = await newWorker('Retired');
    await db.worker.update({ where: { id: retired.id }, data: { retiredAt: ready } });
    await say('reaches all', { mentions: ['all'], broadcastWakes: true });
    const page = await load();
    expect(page.batches.map(b => b.workerId)).toEqual([worker.id]);
    expect(JSON.stringify(page)).not.toContain(foreign.id); expect(JSON.stringify(page)).not.toContain(retired.id);
    await db.hostRegistration.update({ where: { id: registration.id }, data: { lostAt: ready } });
    expect(await load()).toEqual({ batches: [], nextAfter: null });
    expect(await load({ hostId: 'unknown-host' })).toEqual({ batches: [], nextAfter: null });
  });
  it('uses direct/reply-folded tokens and stamped broadcasts, never body parsing, unstamped broadcasts or own posts', async () => {
    await say('direct');
    await say('stamped', { mentions: ['all'], broadcastWakes: true });
    await say('unstamped', { mentions: ['all'] });
    await say('mine', { authorWorkerId: worker.id });
    await say('body says @target but envelope does not', { mentions: [] });
    await say('reply-folded', { mentions: ['target'], replyToSeq: 1 });
    await say('string stamp is not authority', { mentions: ['all'], broadcastWakes: 'true' });
    expect((await batch()).ranges[0]!.seqs).toEqual([1,2,6]);
  });
  it('applies the maximum of read and current-incarnation delivered marks', async () => {
    for (let i = 0; i < 5; i++) await say(`msg-${i+1}`);
    await db.channelReadState.create({ data: { id: generateId(), workerId: worker.id, appId: app.id, channelId: channel.id, lastSeenSeq: 2 } });
    await mark(3);
    expect((await batch()).ranges[0]!.seqs).toEqual([4,5]);
    await db.channelReadState.updateMany({ where: { workerId: worker.id }, data: { lastSeenSeq: 4 } });
    expect((await batch()).ranges[0]!.seqs).toEqual([5]);
  });
  it('restarts delivered mark for a new channel incarnation', async () => {
    await say('new incarnation'); await mark(99, 1);
    await db.channel.update({ where: { id: channel.id }, data: { incarnation: 2 } });
    expect((await batch()).ranges[0]).toMatchObject({ incarnation: 2, fromSeq: 1, throughSeq: 1, seqs: [1] });
  });
});

describe('two-reader gate and defensive encrypted exclusion', () => {
  it('omits a channel the caller cannot read, but its holder can read it', async () => {
    const secret = await db.memory.create({ data: { id: generateId(), organizationId: org.id, name: 'Holder-only', urn: `${org.urn}:holder-secret`, class: 'personal', userId: holder.id } });
    const ch = await newChannel(secret.id, 'chats:private'); await watch(worker.id, ch);
    await say('private payload', {}, ch);
    const hidden = await load(); expect(hidden.batches).toEqual([]); expect(JSON.stringify(hidden)).not.toContain(ch.id);
    expect((await load({ ctx: userCtx(holder.id) })).batches).toHaveLength(1);
  });
  it('omits a channel the caller can read but the holder cannot', async () => {
    const secret = await db.memory.create({ data: { id: generateId(), organizationId: org.id, name: 'Caller-only', urn: `${org.urn}:caller-secret`, class: 'personal', userId: manager.id } });
    const ch = await newChannel(secret.id, 'chats:private'); await watch(worker.id, ch);
    await say('caller payload', {}, ch);
    expect((await load({ ctx: userCtx(manager.id) })).batches).toEqual([]);
    await db.worker.update({ where: { id: worker.id }, data: { heldByUserId: null, heldAt: null } });
    expect((await load({ ctx: userCtx(manager.id) })).batches).toHaveLength(1);
  });
  it('omits legacy encrypted channels entirely without attempting to decrypt their messages', async () => {
    await say('must not leak');
    await db.memory.update({ where: { id: channel.memoryId }, data: { isEncrypted: true } });
    const result = await load(); expect(result.batches).toEqual([]); expect(JSON.stringify(result)).not.toContain(channel.id);
  });
  it('does not load POST-only or deleted channel registrations', async () => {
    await say('not watched');
    await db.registerEntry.updateMany({ where: { attendeeWorkerId: worker.id }, data: { role: 'POST' } });
    expect((await load()).batches).toEqual([]);
    await db.registerEntry.updateMany({ where: { attendeeWorkerId: worker.id }, data: { role: 'BOTH' } });
    await db.channel.update({ where: { id: channel.id }, data: { deletedAt: ready } });
    expect((await load()).batches).toEqual([]);
  });
});

describe('timing, parent context, identity, paging and overflow', () => {
  it('uses persisted window/busy settings and oldest eligible post; no delivery before the boundary', async () => {
    await db.app.update({ where: { id: app.id }, data: { tickerMinCadenceSeconds: 180, deliveryBusyDelaySeconds: 300, deliveryStuckWindowSeconds: 700 } });
    await say('oldest'); await say('later', {}, channel, new Date(posted.getTime() + 60_000));
    expect((await load({ now: new Date(posted.getTime() + 179_999) })).batches).toEqual([]);
    const out = (await load({ now: new Date(posted.getTime() + 180_000) })).batches[0]!;
    expect(out.deliverAfter).toEqual(new Date(posted.getTime() + 180_000));
    expect(out.busyDeadline).toEqual(new Date(posted.getTime() + 300_000));
    expect(out.ranges[0]!.seqs).toEqual([1,2]);
  });
  it('supplies only same-channel parents and leaves unknown parents as seq-only stubs', async () => {
    await say('parent-context', { mentions: [], authorName: 'Gil' });
    await say('reply', { replyToSeq: 1 });
    await say('unknown parent', { replyToSeq: 99 });
    const out = await batch();
    expect(out.text).toContain('(re #1 Gil: "parent-context")'); expect(out.text).toContain('(re #99)');
    expect(out.ranges[0]!.seqs).toEqual([2,3]);
  });
  it('same state returns identical text/hash/batchKey without writes; eligible changes change all three', async () => {
    await say('one'); const beforeMarks = await db.workerDeliveryChannel.count();
    const a = await batch(), b = await batch();
    expect(b).toEqual(a); expect(await db.workerDeliveryChannel.count()).toBe(beforeMarks);
    await say('two'); const c = await batch();
    expect(c.text).not.toBe(a.text); expect(c.renderHash).not.toBe(a.renderHash); expect(c.batchKey).not.toBe(a.batchKey);
  });
  it('pages the host roster without repeating workers and honors workerIds before taking the page', async () => {
    const b = await newWorker('Second'); const c = await newWorker('Third');
    await say('broadcast', { mentions: ['all'], broadcastWakes: true });
    const expected = [worker.id,b.id,c.id].sort(); const observed: string[] = [];
    let after: string | null = null;
    do { const p = await load({ first: 1, after }); observed.push(...p.batches.map(x => x.workerId)); after = p.nextAfter; } while (after);
    expect(observed).toEqual(expected);
    expect((await load({ first: 1, workerIds: [c.id] })).batches.map(x => x.workerId)).toEqual([c.id]);
    expect((await load({ workerIds: [] })).batches).toEqual([]);
  });
  it('overflow leaves exactly the unrendered eligible suffix due', async () => {
    await rawMessages(13);
    const out = await batch(); expect(out.overflow).toBe(3);
    expect(out.ranges[0]!.seqs).toEqual([1,2,3,4,5,6,7,8,9,10]);
    await mark(10);
    const next = await batch(); expect(next.overflow).toBe(0); expect(next.ranges[0]!.seqs).toEqual([11,12,13]);
  });
  it('keeps exact ranges across channels and changes batchKey on incarnation without changing text', async () => {
    const second = await newChannel(channel.memoryId, 'chats:second'); await watch(worker.id, second);
    await say('first-a'); await say('first-b', {}, second, new Date(posted.getTime() + 1000));
    await say('second-a', {}, channel, new Date(posted.getTime() + 2000));
    await say('second-b', {}, second, new Date(posted.getTime() + 3000));
    const a = await batch();
    expect(a.ranges.map(r => ({ channelId: r.channelId, seqs: r.seqs })).sort((x,y) => x.channelId.localeCompare(y.channelId))).toEqual([
      { channelId: channel.id, seqs: [1,2] }, { channelId: second.id, seqs: [1,2] },
    ].sort((x,y) => x.channelId.localeCompare(y.channelId)));
    await db.channel.update({ where: { id: second.id }, data: { incarnation: 2 } });
    const b = await batch(); expect(b.text).toBe(a.text); expect(b.renderHash).toBe(a.renderHash); expect(b.batchKey).not.toBe(a.batchKey);
  });
  it('returns at most ten eligible bodies per channel while retaining the full eligible total', async () => {
    await rawMessages(205);
    const fetched: number[] = [];
    const raw = db.$queryRaw.bind(db) as (...args: unknown[]) => Promise<unknown>;
    const observedDb = new Proxy(db, { get(target, property) {
      if (property === '$queryRaw') return async (...args: unknown[]) => {
        const result = await raw(...args);
        if (Array.isArray(result) && result.length && result[0] && typeof result[0] === 'object' && 'created_at' in result[0]) fetched.push(result.length);
        return result;
      };
      return Reflect.get(target, property, target);
    } });
    const page = await load({ ctx: { ...caller, db: observedDb } });
    expect(page.batches[0]!.overflow).toBe(195); expect(fetched).toEqual([10]);
  });
  it('starts timing at the first eligible post rather than older ordinary unread', async () => {
    await say('old ordinary', { mentions: [] }, channel, new Date(posted.getTime() - 3600_000));
    await say('eligible');
    expect((await load({ now: new Date(posted.getTime() + 119_999) })).batches).toEqual([]);
    const out = (await load({ now: new Date(posted.getTime() + 120_000) })).batches[0]!;
    expect(out.deliverAfter).toEqual(new Date(posted.getTime() + 120_000));
    expect(out.ranges[0]).toMatchObject({ fromSeq: 1, throughSeq: 2, seqs: [2] });
  });
  it('counts all eligible overflow beyond the internal per-channel sample', async () => {
    await rawMessages(205);
    const out = await batch(); expect(out.overflow).toBe(195);
    expect(out.ranges[0]!.seqs).toEqual([1,2,3,4,5,6,7,8,9,10]);
  });
  it('finds a reached message beyond a long prefix of ordinary unread messages', async () => {
    await rawMessages(1001, []);
    await say('finally reaches target');
    expect((await batch()).ranges[0]!.seqs).toEqual([1002]);
  });
});

it('samples a channel by seq before the cap even if timestamps disagree', async () => {
  for (let i = 1; i <= 11; i++) await say(`backward-${i}`, {}, channel, new Date(posted.getTime() - i * 1000));
  expect((await batch()).ranges[0].seqs).toEqual([1,2,3,4,5,6,7,8,9,10]);
});

it('keeps timing from the oldest eligible post even when seq sampling leaves it beyond the cap', async () => {
  for (let i = 1; i <= 10; i++) await say(`recent-${i}`, {}, channel, ready);
  await say('older-beyond-prefix', {}, channel, posted);
  const b = await batch();
  expect(b.ranges[0].seqs).toEqual([1,2,3,4,5,6,7,8,9,10]);
  expect(b.deliverAfter.getTime()).toBeLessThanOrEqual(ready.getTime());
});
