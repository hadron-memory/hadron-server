/** S5 consumes all S1 metadata pages inside one stable authorized snapshot. */
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../id.js';
import type { Context } from '../../api/graphql/schema/resolvers.helpers.js';
import * as source from './pendingDelivery.js';

vi.mock('../bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));
const id = (n: number) => n.toString(16).padStart(32, '0');
const posted = new Date('2026-10-19T10:00:00Z'), now = new Date('2026-10-19T10:01:00Z');
let ctx: Context;
let app: { id: string; urn: string; organizationId: string | null; ownerUserId: string | null };
const load = async (first = 2) => {
  const { loadPendingDeliverySnapshot } = await import('./deliveryPendingSnapshot.js');
  return db.$transaction(tx => loadPendingDeliverySnapshot(tx, { ctx, app, hostId: 'host-a', workerId: id(9), asOf: now, first }), { isolationLevel: 'RepeatableRead' });
};
beforeEach(async () => {
  await cleanDb(db);
  await db.organization.create({ data: { id: id(1), name: 'Adapter', urn: 'adapter.example' } });
  await db.user.create({ data: { id: id(3), roles: ['READER'] } });
  await db.agent.create({ data: { id: id(4), organizationId: id(1), name: 'Adapter', urn: 'adapter.example:role' } });
  app = await db.app.create({ data: { id: id(5), organizationId: id(1), name: 'Adapter', urn: 'adapter.example:app' } });
  await db.appAgent.create({ data: { appId: app.id, agentId: id(4) } });
  await db.appMember.create({ data: { appId: app.id, userId: id(3), role: 'member' } });
  await db.appKey.create({ data: { id: id(11), appId: app.id, keyHash: 'adapter-fixture', keyPreview: 'test' } });
  ctx = { db, appId: app.id, appKeyId: id(11), roles: [] };
  await db.memory.create({ data: { id: id(6), organizationId: id(1), name: 'Team', urn: 'adapter.example:shared', class: 'app', appId: app.id, sharedMemoryOfAgentId: id(4) } });
  await db.node.create({ data: { id: id(7), memoryId: id(6), loc: 'chat:team', name: 'Team', nodeType: 'chat' } });
  await db.channel.create({ data: { id: id(8), memoryId: id(6), loc: 'chat:team', name: 'Team', chatRootNodeId: id(7), incarnation: 2, lastSeq: 13 } });
  await db.worker.create({ data: { id: id(9), appId: app.id, agentId: id(4), name: 'Target', slug: 'target', heldByUserId: id(3), heldAt: posted } });
  await db.hostRegistration.create({ data: { id: id(10), appId: app.id, hostId: 'host-a', label: 'host-a', pollIntervalSeconds: 60, refreshedAt: now } });
  await db.hostRegistrationWorker.create({ data: { registrationId: id(10), workerId: id(9), family: 'codex' } });
  await db.registerEntry.create({ data: { appId: app.id, channelId: id(8), attendeeWorkerId: id(9), role: 'BOTH' } });
  await db.node.createMany({ data: Array.from({ length: 13 }, (_, i) => ({ id: generateId(), memoryId: id(6), loc: `chat:messages:${i+1}`, name: `${i+1}`, nodeType: 'chat-message', messageChannelId: id(8), seq: i+1, createdAt: new Date(posted.getTime()+i), content: 'SECRET_BODY', data: { authorName: 'SECRET_AUTHOR', mentions: ['target'] } })) });
});
afterEach(() => vi.restoreAllMocks());

it('maps every page, timing-withheld and renderer-overflow row to the exact S5 identity/post-time DTO', async () => {
  const result = await load();
  expect(result).toEqual({ complete: true, asOf: now, messages: Array.from({ length: 13 }, (_, i) => ({ workerId: id(9), channelId: id(8), channelIncarnation: 2, seq: i+1, dueSince: new Date(posted.getTime()+i) })) });
  expect(JSON.stringify(result)).not.toMatch(/SECRET|withheldReason|incarnation"/);
});
it('binds all pages to the transaction, fixed time and exact worker, starting from the beginning', async () => {
  const spy = vi.spyOn(source, 'enumeratePendingDelivery');
  await load();
  expect(spy).toHaveBeenCalledTimes(7);
  expect(spy.mock.calls[0]![0].after).toBeNull();
  const client = spy.mock.calls[0]![0].ctx.db;
  expect(client).not.toBe(db);
  for (const [args] of spy.mock.calls) {
    expect(args.ctx.db).toBe(client); expect(args.now).toEqual(now);
    expect(args.workerIds).toEqual([id(9)]); expect(args.hostId).toBe('host-a');
  }
});
it('keeps one database snapshot if a covering mark commits between pages', async () => {
  const original = source.enumeratePendingDelivery;
  let pages = 0;
  vi.spyOn(source, 'enumeratePendingDelivery').mockImplementation(async args => {
    const page = await original(args);
    if (++pages === 1) await db.channelReadState.create({ data: { workerId: id(9), channelId: id(8), lastSeenSeq: 13 } });
    return page;
  });
  expect((await load()).messages).toHaveLength(13);
  expect((await load()).messages).toEqual([]);
});
it('rejects READ COMMITTED and a pooled client instead of certifying mixed pages', async () => {
  const { loadPendingDeliverySnapshot } = await import('./deliveryPendingSnapshot.js');
  const args = { ctx, app, hostId: 'host-a', workerId: id(9), asOf: now };
  await expect(db.$transaction(tx => loadPendingDeliverySnapshot(tx, args), { isolationLevel: 'ReadCommitted' })).rejects.toThrow('DELIVERY_SNAPSHOT_REQUIRED');
  await expect(loadPendingDeliverySnapshot(db as never, args)).rejects.toThrow('DELIVERY_SNAPSHOT_REQUIRED');
});
it('does not turn a failing later page into a partial complete snapshot', async () => {
  const original = source.enumeratePendingDelivery;
  vi.spyOn(source, 'enumeratePendingDelivery').mockImplementationOnce(original).mockRejectedValue(new Error('page unavailable'));
  await expect(load()).rejects.toThrow('page unavailable');
});
it.each([
  { items: [], complete: false, nextAfter: null },
  { items: [], complete: true, nextAfter: 'unexpected' },
  { items: [], complete: false, nextAfter: 'same' },
])('refuses contradictory or stalled page protocol: %j', async page => {
  vi.spyOn(source, 'enumeratePendingDelivery').mockResolvedValue(page);
  await expect(load()).rejects.toThrow('DELIVERY_PENDING_INCOMPLETE');
});
it('does not accept duplicate identities or foreign-worker metadata as a complete set', async () => {
  const item = { workerId: id(9), channelId: id(8), incarnation: 2, seq: 1, dueSince: posted, state: 'due' as const, withheldReason: null };
  const spy = vi.spyOn(source, 'enumeratePendingDelivery').mockResolvedValue({ items: [item, item], complete: true, nextAfter: null });
  await expect(load()).rejects.toThrow('DELIVERY_PENDING_INCOMPLETE');
  spy.mockResolvedValue({ items: [{ ...item, workerId: id(99) }], complete: true, nextAfter: null });
  await expect(load()).rejects.toThrow('DELIVERY_PENDING_INCOMPLETE');
});
it('uses canonical encrypted omission and self-unhosted eligibility', async () => {
  await db.hostRegistrationWorker.deleteMany({ where: { workerId: id(9) } });
  const { loadPendingDeliverySnapshot } = await import('./deliveryPendingSnapshot.js');
  const self = () => db.$transaction(tx => loadPendingDeliverySnapshot(tx, { ctx, app, hostId: null, workerId: id(9), asOf: now, first: 2 }), { isolationLevel: 'RepeatableRead' });
  expect((await self()).messages).toHaveLength(13);
  await db.memory.update({ where: { id: id(6) }, data: { isEncrypted: true } });
  expect(await self()).toEqual({ complete: true, asOf: now, messages: [] });
});
