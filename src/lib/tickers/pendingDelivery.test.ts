import { WORKER_SIGNATURE_DEFAULTS } from '../workerSignature.js';
/** #2017 shared metadata source for S5/S13. Red first; no body/renderer cap may truncate pending metadata. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../id.js';
import type { Context } from '../../api/graphql/schema/resolvers.js';
import { loadDeliveryBatches } from './deliveryBatch.js';

vi.mock('../bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));
vi.mock('../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
const id = (n: number) => n.toString(16).padStart(32, '0');
const posted = new Date('2026-10-19T10:00:00Z'), now = new Date('2026-10-19T11:00:00Z');
const workerId = id(9), channelId = id(8), registrationId = id(10);
let ctx: Context;
let app: { id: string; urn: string; organizationId: string | null; ownerUserId: string | null };
const enumerate = async (extra: Record<string, unknown> = {}) => {
  const { enumeratePendingDelivery } = await import('./pendingDelivery.js');
  return enumeratePendingDelivery({ ctx, app, hostId: 'host-a', now, first: 1000, ...extra } as any);
};
async function messages(count: number, extra: Record<string, unknown> = {}, ch = channelId, memoryId = id(6), offset = 0) {
  await db.node.createMany({ data: Array.from({ length: count }, (_, i) => ({ id: generateId(), memoryId, loc: `chat:messages:${ch}:${offset+i+1}`, name: `${offset+i+1}`, nodeType: 'chat-message', messageChannelId: ch, seq: offset+i+1, createdAt: new Date(posted.getTime()+offset+i), content: `BODY_SECRET_${offset+i+1}`, data: { authorName: 'AUTHOR_SECRET', mentions: ['target'], ...extra } })) });
  await db.channel.update({ where: { id: ch }, data: { lastSeq: count+offset, lastMessageAt: posted } });
}
async function addWorker(n: number, name: string, reg = registrationId) {
  const w = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, id: id(n), appId: app.id, agentId: id(4), name, slug: name.toLowerCase(), heldByUserId: id(3), heldAt: posted } });
  await db.hostRegistrationWorker.create({ data: { registrationId: reg, workerId: w.id, family: 'codex' } });
  await db.registerEntry.create({ data: { appId: app.id, channelId, attendeeWorkerId: w.id, role: 'BOTH' } });
  return w;
}
beforeEach(async () => {
  await cleanDb(db);
  await db.organization.create({ data: { id: id(1), name: 'Pending', urn: 'pending.example' } });
  for (const n of [2,3]) await db.user.create({ data: { id: id(n), githubId: 99700+n, githubUsername: `pending-${n}`, roles: ['READER'] } });
  await db.orgMember.create({ data: { organizationId: id(1), userId: id(2), role: 'ADMIN' } });
  await db.agent.create({ data: { id: id(4), organizationId: id(1), name: 'Pending role', urn: 'pending.example:role', visibility: 'ORGANIZATION' } });
  app = await db.app.create({ data: { id: id(5), organizationId: id(1), name: 'Pending App', urn: 'pending.example:app' } });
  await db.appAgent.create({ data: { appId: app.id, agentId: id(4) } });
  await db.appMember.create({ data: { appId: app.id, userId: id(3), role: 'member' } });
  await db.appKey.create({ data: { id: id(11), appId: app.id, keyHash: 'pending-fixture', keyPreview: 'test' } });
  ctx = { db, appId: app.id, appKeyId: id(11), roles: [] };
  await db.memory.create({ data: { id: id(6), organizationId: id(1), name: 'Pending host', urn: 'pending.example:shared', class: 'app', appId: app.id, sharedMemoryOfAgentId: id(4) } });
  await db.node.create({ data: { id: id(7), memoryId: id(6), loc: 'chat:team', name: 'Team', nodeType: 'chat' } });
  await db.channel.create({ data: { id: channelId, memoryId: id(6), loc: 'chat:team', name: 'Team', chatRootNodeId: id(7), incarnation: 1 } });
  await db.hostRegistration.create({ data: { id: registrationId, appId: app.id, hostId: 'host-a', label: 'host-a', pollIntervalSeconds: 60, refreshedAt: now } });
  await addWorker(9, 'Target');
});

describe('loader byte parity control', () => {
  it('preserves the baseline serialized text, hash, key, ranges, timing, overflow and paging', async () => {
    await messages(13);
    const page = await loadDeliveryBatches({ ctx, app, hostId: 'host-a', now });
    expect(JSON.stringify(page)).toBe("{\"batches\":[{\"workerId\":\"00000000000000000000000000000009\",\"workerName\":\"Target\",\"text\":\"[hadron chat] 10 for Target \u00b7 #1 AUTHOR_SECRET: BODY_SECRET_1 \u00b7 #2 AUTHOR_SECRET: BODY_SECRET_2 \u00b7 #3 AUTHOR_SECRET: BODY_SECRET_3 \u00b7 #4 AUTHOR_SECRET: BODY_SECRET_4 \u00b7 #5 AUTHOR_SECRET: BODY_SECRET_5 \u00b7 #6 AUTHOR_SECRET: BODY_SECRET_6 \u00b7 #7 AUTHOR_SECRET: BODY_SECRET_7 \u00b7 #8 AUTHOR_SECRET: BODY_SECRET_8 \u00b7 #9 AUTHOR_SECRET: BODY_SECRET_9 \u00b7 #10 AUTHOR_SECRET: BODY_SECRET_10 \u00b7 +3 more waiting \u00b7 read: hadron team chat inbox \u00b7 reply: hadron team chat post --reply-to <seq> \\\"@name \u2026\\\"\",\"renderHash\":\"e56b869e1743451bc3c4f750b77bc78126e6095f6968241ba89e97a24b3191a1\",\"batchKey\":\"8167c385bf233bb9023e0cf6aab4087f\",\"deliverAfter\":\"2026-10-19T10:02:00.000Z\",\"busyDeadline\":\"2026-10-19T10:10:00.000Z\",\"interrupt\":false,\"ranges\":[{\"channelId\":\"00000000000000000000000000000008\",\"fromSeq\":1,\"throughSeq\":10,\"seqs\":[1,2,3,4,5,6,7,8,9,10],\"incarnation\":1}],\"overflow\":3}],\"nextAfter\":null}");
  });
});

describe('complete metadata-only pending enumeration', () => {
  it('returns every eligible row past the renderer cap, with no text, author or mention envelope', async () => {
    await messages(205);
    const page = await enumerate();
    expect(page.items).toHaveLength(205); expect(page.complete).toBe(true); expect(page.nextAfter).toBeNull();
    expect(page.items.map((m: any) => m.seq)).toEqual(Array.from({ length: 205 }, (_, i) => i+1));
    for (const m of page.items) expect(Object.keys(m).sort()).toEqual(['channelId','dueSince','incarnation','seq','state','withheldReason','workerId'].sort());
    expect(page.items.every((m: any) => m.state === 'due' && m.withheldReason === null)).toBe(true);
    const text = JSON.stringify(page); expect(text).not.toContain('BODY_SECRET'); expect(text).not.toContain('AUTHOR_SECRET'); expect(text).not.toContain('target');
  });
  it('pages all metadata with explicit incompleteness and no duplicates or silently lost suffix', async () => {
    await messages(205);
    const seqs: number[] = []; let after: string | null = null; let pages = 0;
    do {
      const page = await enumerate({ first: 17, after }); pages++;
      expect(page.items.length).toBeLessThanOrEqual(17);
      seqs.push(...page.items.map((m: any) => m.seq));
      expect(page.complete).toBe(page.nextAfter === null);
      after = page.nextAfter;
      if (after) expect(page.complete).toBe(false);
      expect(pages).toBeLessThan(20);
    } while (after);
    expect(seqs).toEqual(Array.from({ length: 205 }, (_, i) => i+1));
  });
  it('retains timing-withheld rows and post times, then makes overflow due at the inclusive deadline', async () => {
    await messages(13);
    const before = await enumerate({ now: new Date(posted.getTime()+119999) });
    expect(before.items).toHaveLength(13); expect(before.items.every((m: any) => m.state === 'withheld' && m.withheldReason === 'timing')).toBe(true);
    expect(before.items[12].dueSince).toEqual(new Date(posted.getTime()+12));
    const at = await enumerate({ now: new Date(posted.getTime()+120000) });
    expect(at.items).toHaveLength(13); expect(at.items.every((m: any) => m.state === 'due' && m.withheldReason === null)).toBe(true);
    expect((await loadDeliveryBatches({ ctx, app, hostId: 'host-a', now: new Date(posted.getTime()+120000) })).batches[0]!.overflow).toBe(3);
  });
  it('uses the same S4 reach, own-post and read/delivery floors as the batch loader', async () => {
    await messages(1); await messages(1, { mentions: ['all'], broadcastWakes: true }, channelId, id(6), 1);
    await messages(1, { mentions: ['all'] }, channelId, id(6), 2);
    await messages(1, { authorWorkerId: workerId }, channelId, id(6), 3);
    await messages(1, { mentions: [] }, channelId, id(6), 4);
    await messages(1, {}, channelId, id(6), 5);
    expect((await enumerate()).items.map((m: any) => m.seq)).toEqual([1,2,6]);
    await db.channelReadState.create({ data: { workerId, channelId, lastSeenSeq: 1 } });
    await db.workerDeliveryChannel.create({ data: { workerId, channelId, channelIncarnation: 1, deliveredThroughSeq: 2, deliveredAt: posted } });
    expect((await enumerate()).items.map((m: any) => m.seq)).toEqual([6]);
    await db.channelReadState.updateMany({ where: { workerId, channelId }, data: { lastSeenSeq: 6 } });
    expect((await enumerate()).items).toEqual([]);
  });
  it('a stale delivery incarnation does not hide the current occupancy', async () => {
    await messages(3);
    await db.workerDeliveryChannel.create({ data: { workerId, channelId, channelIncarnation: 1, deliveredThroughSeq: 3, deliveredAt: posted } });
    expect((await enumerate()).items).toEqual([]);
    await db.channel.update({ where: { id: channelId }, data: { incarnation: 2 } });
    expect((await enumerate()).items.map((m: any) => [m.incarnation,m.seq])).toEqual([[2,1],[2,2],[2,3]]);
  });
  it('omits encrypted channels without a trace', async () => {
    await messages(1); await db.memory.update({ where: { id: id(6) }, data: { isEncrypted: true } });
    expect(await enumerate()).toEqual({ items: [], complete: true, nextAfter: null });
  });
  it.each(['caller', 'holder'])('omits channels denied to the %s without exposing counts', async reason => {
    await messages(1);
    await db.memory.update({ where: { id: id(6) }, data: { class: 'private', userId: reason === 'caller' ? id(3) : id(2), userMemoryOfAgentId: id(4), sharedMemoryOfAgentId: null } });
    const person: Context = { db, userId: id(2), roles: ['READER'] };
    expect(await enumerate({ ctx: reason === 'caller' ? ctx : person })).toEqual({ items: [], complete: true, nextAfter: null });
  });
  it('selects the live host registration and active workers only', async () => {
    await db.hostRegistration.create({ data: { id: id(20), appId: app.id, hostId: 'host-b', label: 'host-b', pollIntervalSeconds: 60, refreshedAt: now } });
    const other = await addWorker(21, 'Other', id(20)); const retired = await addWorker(22, 'Retired');
    await db.worker.update({ where: { id: retired.id }, data: { retiredAt: now } });
    await messages(1, { mentions: ['all'], broadcastWakes: true });
    expect((await enumerate()).items.map((m: any) => m.workerId)).toEqual([workerId]);
    expect(JSON.stringify(await enumerate())).not.toContain(other.id);
    await db.hostRegistration.update({ where: { id: registrationId }, data: { lostAt: now } });
    expect(await enumerate()).toEqual({ items: [], complete: true, nextAfter: null });
  });
  it('self mode supports one unhosted worker and refuses ambiguous selection', async () => {
    await messages(1); await db.hostRegistrationWorker.deleteMany({ where: { workerId } });
    expect((await enumerate({ hostId: null, workerIds: [workerId] })).items).toHaveLength(1);
    await expect(enumerate({ hostId: null, workerIds: [] })).rejects.toThrow(/exactly one worker/);
  });
  it('honors selected workers across metadata pages without replacing the filter with the cursor', async () => {
    const other = await addWorker(23, 'Other'); await messages(3, { mentions: ['all'], broadcastWakes: true });
    const first = await enumerate({ workerIds: [other.id], first: 2 });
    const second = await enumerate({ workerIds: [other.id], first: 2, after: first.nextAfter });
    expect([...first.items,...second.items].map((m: any) => [m.workerId,m.seq])).toEqual([[other.id,1],[other.id,2],[other.id,3]]);
    expect(second.complete).toBe(true);
  });
  it('never selects bodies or author envelopes in its raw metadata queries', async () => {
    await messages(13);
    const raw = db.$queryRaw.bind(db) as (...args: unknown[]) => Promise<any>;
    const observed = new Proxy(db, { get(target, property) {
      if (property === '$queryRaw') return async (...args: any[]) => {
        const q = args[0]; const sql = (Array.isArray(q) ? q : q.strings ?? []).join(' ');
        const select = sql.split(/\bFROM\b/i)[0]; expect(select).not.toMatch(/\b(?:content|data|authorName|authorWorkerId)\b/i);
        const rows = await raw(...args);
        for (const r of Array.isArray(rows) ? rows : []) expect(Object.keys(r)).not.toEqual(expect.arrayContaining(['content']));
        return rows;
      };
      return Reflect.get(target, property, target);
    } });
    expect((await enumerate({ ctx: { ...ctx, db: observed } })).items).toHaveLength(13);
  });
  it('rejects an invalid cursor or reusing one with a changed asOf or worker selection', async () => {
    await messages(3);
    await expect(enumerate({ after: 'not-a-cursor' })).rejects.toThrow(/cursor|after/i);
    const first = await enumerate({ first: 1 }); expect(first.complete).toBe(false);
    await expect(enumerate({ first: 1, after: first.nextAfter, now: new Date(now.getTime()+1) })).rejects.toThrow(/cursor|after/i);
    await expect(enumerate({ first: 1, after: first.nextAfter, workerIds: [workerId] })).rejects.toThrow(/cursor|after/i);
  });
  it('keeps rows beyond the body-character cap due without reading their sizes', async () => {
    await messages(2);
    await db.node.updateMany({ where: { messageChannelId: channelId, seq: 1 }, data: { content: '😀'.repeat(7000) } });
    expect((await loadDeliveryBatches({ ctx, app, hostId: 'host-a', now })).batches[0]!.overflow).toBe(1);
    const page = await enumerate();
    expect(page.items.map((m: any) => [m.seq,m.state,m.withheldReason])).toEqual([[1,'due',null],[2,'due',null]]);
  });
  it('continues beyond the internal worker page even when its first 200 workers have no watched channels', async () => {
    const workers = [workerId];
    for (let i=0;i<204;i++) workers.push((await addWorker(1000+i, `Worker${i}`)).id);
    await messages(1, { mentions: ['all'], broadcastWakes: true });
    expect((await enumerate()).items).toHaveLength(205);
    await db.registerEntry.updateMany({ where: { attendeeWorkerId: { in: workers.slice(0,200) } }, data: { role: 'POST' } });
    const page = await enumerate();
    expect(page.items.map((m: any) => m.workerId)).toEqual(workers.slice(200));
    expect(page.complete).toBe(true);
  });
  it('a cursor position cannot substitute another worker into a forced self selection', async () => {
    const other = await addWorker(23, 'Other'); await messages(3, { mentions: ['all'], broadcastWakes: true });
    const page = await enumerate({ hostId: null, workerIds: [workerId], first: 1 });
    await expect(enumerate({ hostId: null, workerIds: [workerId,workerId], first: 1, after: page.nextAfter })).rejects.toThrow(/exactly one worker/);
    const cursor = JSON.parse(Buffer.from(page.nextAfter!, 'base64url').toString('utf8'));
    cursor.workerId = other.id;
    const forged = Buffer.from(JSON.stringify(cursor)).toString('base64url');
    await expect(enumerate({ hostId: null, workerIds: [workerId], first: 1, after: forged })).rejects.toThrow(/cursor|after/i);
  });

});
