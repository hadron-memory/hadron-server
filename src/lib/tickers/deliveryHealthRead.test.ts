/** S5 internal projection; S1's verified report/pending gates are separate. */
import { afterEach, beforeEach, expect, it } from 'vitest';
import { PrismaClient } from '../../generated/prisma/index.js';
import { generateId } from '../id.js';
import { beginDeliveryTracking, deliveryStateTransaction, observeDeliveryPolicyThrough, recordDeliveryException, reconcileDeliveryAlarm } from './deliveryState.js';
import { recordDeliveryHold } from './deliveryHolds.js';
import { deliveryHealthSnapshot } from './deliveryHealthRead.js';

const db = new PrismaClient();
const at = (minute: number) => new Date(Date.UTC(2026, 9, 19, 10, minute));
let orgId: string, appId: string, agentId: string, workerId: string;
const run = <T>(fn: Parameters<typeof deliveryStateTransaction<T>>[3]) => deliveryStateTransaction(db, appId, workerId, fn);
const principal = { kind: 'host-key' as const, appKeyId: 'verified-key', hostId: 'verified-host' };
const message = (channelId: string, seq: number, minute = 0) => ({ workerId, channelId, channelIncarnation: 1, seq, dueSince: at(minute) });
const pending = (messages = [message('aaa', 1)]) => ({ complete: true as const, asOf: at(20), messages });
const hold = (channelId = 'aaa', reason = 'draft' as 'draft' | 'question') => run(tx => recordDeliveryHold(tx, {
  workerId, channelId, channelIncarnation: 1, firstPendingSeq: 1, reason, terminalId: 'term_test', principal, now: at(5),
}));
beforeEach(async () => {
  orgId = generateId(); appId = generateId(); agentId = generateId(); workerId = generateId();
  await db.organization.create({ data: { id: orgId, name: 'Health', urn: `s5-${orgId}.example` } });
  await db.agent.create({ data: { id: agentId, organizationId: orgId, name: 'Health', urn: `s5-${orgId}.example:agent` } });
  await db.app.create({ data: { id: appId, organizationId: orgId, name: 'Health', urn: `s5-${orgId}.example:app` } });
  await db.worker.create({ data: { id: workerId, appId, agentId, name: 'Health', slug: 'health' } });
  const memoryId = generateId();
  await db.memory.create({ data: { id: memoryId, organizationId: orgId, name: 'Health channels', urn: `s5-${orgId}.example:channels`, class: 'knowledge' } });
  for (const id of ['aaa', 'bbb']) {
    const rootId = generateId();
    await db.node.create({ data: { id: rootId, memoryId, loc: `chats:${id}`, name: id, nodeType: 'chat' } });
    await db.channel.create({ data: { id, memoryId, loc: `chats:${id}`, name: id, chatRootNodeId: rootId, lastSeq: 3 } });
  }
  await run(tx => beginDeliveryTracking(tx, workerId, at(0)));
  await run(tx => observeDeliveryPolicyThrough(tx, workerId, at(20)));
});
afterEach(async () => {
  await db.worker.deleteMany({ where: { id: workerId } });
  await db.app.deleteMany({ where: { id: appId } });
  await db.agent.deleteMany({ where: { id: agentId } });
  await db.organization.deleteMany({ where: { id: orgId } });
  await db.$disconnect();
});

it('keeps hold identity/since across duplicate observations and records only semantic changes', async () => {
  const first = await hold();
  expect((await hold()).holdId).toBe(first.holdId);
  expect(await db.agentTeamEvent.count({ where: { appId, type: 'delivery.held' } })).toBe(1);
  const changed = await run(tx => recordDeliveryHold(tx, { workerId, channelId: 'aaa', channelIncarnation: 1, firstPendingSeq: 1, reason: 'question', terminalId: null, principal, now: at(10) }));
  expect(changed).toMatchObject({ holdId: first.holdId, since: at(5), observedAt: at(10), reason: 'question', terminalId: null });
  expect(await db.agentTeamEvent.count({ where: { appId, type: 'delivery.held' } })).toBe(2);
});

it('requires complete same-asOf enumeration and certified policy coverage; none is never an invented CLEAR', async () => {
  const read = (p: unknown) => run(tx => deliveryHealthSnapshot(tx, { appId, workerId, asOf: at(20), pending: p as never }));
  await expect(read(undefined)).rejects.toThrow('DELIVERY_PENDING_INCOMPLETE');
  await expect(read({ ...pending(), complete: false })).rejects.toThrow('DELIVERY_PENDING_INCOMPLETE');
  await expect(read({ ...pending(), asOf: at(19) })).rejects.toThrow('DELIVERY_PENDING_INCOMPLETE');
  await db.workerDeliveryWaitState.update({ where: { workerId }, data: { observedThrough: at(10) } });
  await expect(read(pending([]))).rejects.toThrow('DELIVERY_WAIT_INCOMPLETE');
});

it('keeps exact counts and the singular worker alarm independent of the channel detail limit', async () => {
  await hold('aaa'); await hold('bbb');
  // A stored transition may be recorded before time has been certified; initialize
  // this interval before certification to avoid inventing historical coverage.
  await db.workerDeliveryWaitState.update({ where: { workerId }, data: { observedThrough: at(0) } });
  await run(tx => recordDeliveryException(tx, { workerId, cause: 'standby', coverage: { kind: 'range', channelId: 'aaa', channelIncarnation: 1, fromSeq: 1, throughSeq: 1 }, startedAt: at(0), endedAt: null }));
  await run(tx => observeDeliveryPolicyThrough(tx, workerId, at(20)));
  const messages = [message('aaa', 1), message('aaa', 2, 1), message('bbb', 1, 2)];
  await run(tx => reconcileDeliveryAlarm(tx, { workerId, candidates: messages, now: at(20), hold: null }));
  const health = await run(tx => deliveryHealthSnapshot(tx, { appId, workerId, asOf: at(20), pending: pending(messages), limit: 1 }));
  expect(health).toMatchObject({ appId, workerId, asOf: at(20), pendingMessageCount: 3, heldChannelCount: 2, activeAlarmCount: 1, suppressedAlarmCount: 0, totalChannels: 2, hasMore: true });
  expect(health.channels).toHaveLength(1);
  expect(health.channels[0]).toMatchObject({ channelId: 'aaa', candidate: { seq: 2, waitedMs: 19 * 60_000, waitAsOf: at(20), suppressionClassification: 'NONE' } });
  expect(health.alarm).toMatchObject({ anchor: { channelId: 'aaa', seq: 2 }, state: 'ACTIVE' });
});

it('covering marks hide the old hold without deleting history; the next hold gets a distinct identity', async () => {
  const first = await hold();
  await db.workerDeliveryChannel.create({ data: { workerId, channelId: 'aaa', channelIncarnation: 1, deliveredThroughSeq: 1, deliveredAt: at(10) } });
  const health = await run(tx => deliveryHealthSnapshot(tx, { appId, workerId, asOf: at(20), pending: pending([message('aaa', 2, 1)]) }));
  expect(health).toMatchObject({ pendingMessageCount: 1, heldChannelCount: 0, activeAlarmCount: 0 });
  const next = await run(tx => recordDeliveryHold(tx, { workerId, channelId: 'aaa', channelIncarnation: 1, firstPendingSeq: 2, reason: 'draft', terminalId: null, principal, now: at(15) }));
  expect(next.holdId).not.toBe(first.holdId);
  expect(await db.agentTeamEvent.count({ where: { appId, type: 'delivery.held' } })).toBe(2);
});

it('R62 excludes retired occupancy from current holds and pending without rewriting history', async () => {
  await hold();
  await db.channel.update({ where: { id: 'aaa' }, data: { incarnation: 2 } });
  const health = await run(tx => deliveryHealthSnapshot(tx, { appId, workerId, asOf: at(20), pending: pending() }));
  expect(health).toMatchObject({ pendingMessageCount: 0, heldChannelCount: 0, totalChannels: 0, channels: [], alarm: null });
  expect(await db.agentTeamEvent.count({ where: { appId, type: 'delivery.held' } })).toBe(1);
});
