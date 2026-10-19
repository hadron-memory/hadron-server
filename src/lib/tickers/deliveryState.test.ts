import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../../generated/prisma/index.js';
import { generateId } from '../id.js';
import { deliveryStateTransaction, beginDeliveryTracking, recordDeliveryException, observeDeliveryPolicyThrough, loadDeliveryWait, reconcileDeliveryAlarm, advanceDeliveryEscalation } from './deliveryState.js';

const db = new PrismaClient();
const stamp = (minutes: number) => new Date(Date.UTC(2026, 9, 18, 10, minutes));
let appId: string, workerId: string, agentId: string, orgId: string;
const managers = [generateId(), generateId(), generateId()];
beforeAll(async () => {
  orgId = generateId(); appId = generateId(); agentId = generateId(); workerId = generateId();
  await db.organization.create({ data: { id: orgId, name: 'S5 isolated fixture', urn: `s5-${orgId}.example` } });
  await db.agent.create({ data: { id: agentId, organizationId: orgId, name: 'S5', urn: `s5-${orgId}.example:agent` } });
  await db.app.create({ data: { id: appId, organizationId: orgId, name: 'S5', urn: `s5-${orgId}.example:app` } });
  await db.worker.create({ data: { id: workerId, appId, agentId, name: 'S5 worker', slug: 's5-worker' } });

  const memoryId = generateId(), rootId = generateId();
  await db.memory.create({ data: { id: memoryId, organizationId: orgId, name: 'S5 channel host', urn: `s5-${orgId}.example:channels`, class: 'knowledge' } });
  await db.node.create({ data: { id: rootId, memoryId, loc: 'chats:scenario', name: 'Scenario root', nodeType: 'chat' } });
  await db.channel.create({ data: { id: 'channel-s5', memoryId, loc: 'chats:scenario', name: 'Scenario channel', chatRootNodeId: rootId } });
  for (const id of managers) {
    await db.user.create({ data: { id, roles: ['READER'] } });
    await db.orgMember.create({ data: { organizationId: orgId, userId: id, role: 'ADMIN' } });
  }
});
afterAll(async () => {
  await db.worker.deleteMany({ where: { id: workerId } });
  await db.app.deleteMany({ where: { id: appId } });
  await db.agent.deleteMany({ where: { id: agentId } });
  await db.organization.deleteMany({ where: { id: orgId } });
  await db.user.deleteMany({ where: { id: { in: managers } } });
  await db.$disconnect();
});

const message = (seq = 1) => ({ workerId, channelId: 'channel-s5', channelIncarnation: 1, seq, dueSince: stamp(0) });
const run = <T>(fn: Parameters<typeof deliveryStateTransaction<T>>[3]) => deliveryStateTransaction(db, appId, workerId, fn);

describe('S5 persisted transitions and races', () => {
  it('initializes rollout once, rejects another App and refuses unobserved time', async () => {
    await run(async tx => { await beginDeliveryTracking(tx, workerId, stamp(0)); });
    await expect(deliveryStateTransaction(db, 'foreign-app', workerId, async () => undefined)).rejects.toThrow('DELIVERY_WORKER_NOT_FOUND');
    await expect(run(tx => loadDeliveryWait(tx, message(), stamp(1)))).rejects.toThrow('DELIVERY_WAIT_INCOMPLETE');
  });
  it('duplicate concurrent effective transitions persist one interval and union on reload', async () => {
    const transition = { workerId, cause: 'wake-paused' as const, coverage: { kind: 'worker' as const }, startedAt: stamp(5), endedAt: stamp(60) };
    await Promise.all([run(tx => recordDeliveryException(tx, transition)), run(tx => recordDeliveryException(tx, transition))]);
    await run(tx => observeDeliveryPolicyThrough(tx, workerId, stamp(80)));
    const rows = await db.workerDeliveryWaitException.findMany({ where: { workerId } });
    expect(rows).toHaveLength(1);
    expect((await run(tx => loadDeliveryWait(tx, message(), stamp(65)))).waitedMs).toBe(10 * 60_000);
  });
  it('concurrent evaluation selects one worker alarm across channels; duplicate raises do nothing', async () => {
    const input = { workerId, candidates: [message(), { ...message(2), channelId: 'other' }], now: stamp(70), hold: null };
    const results = await Promise.all([run(tx => reconcileDeliveryAlarm(tx, input)), run(tx => reconcileDeliveryAlarm(tx, input))]);
    expect(results.filter(r => r.raised)).toHaveLength(1);
    expect(await db.workerDeliveryAlarmEpisode.count({ where: { workerId } })).toBe(1);
    expect(await db.agentTeamEvent.count({ where: { appId, type: 'delivery.stuck' } })).toBe(1);
    await run(tx => recordDeliveryException(tx, { workerId, cause: 'isolated', coverage: { kind: 'worker' }, startedAt: stamp(80), endedAt: stamp(100) }));
    await run(tx => observeDeliveryPolicyThrough(tx, workerId, stamp(130)));
    expect(await run(tx => advanceDeliveryEscalation(tx, workerId, stamp(104)))).toBe(false);
    const advances = await Promise.all([run(tx => advanceDeliveryEscalation(tx, workerId, stamp(105))), run(tx => advanceDeliveryEscalation(tx, workerId, stamp(105)))]);
    expect(advances.filter(Boolean)).toHaveLength(1);
    const active = await db.workerDeliveryAlarmEpisode.findUniqueOrThrow({ where: { workerId } });
    await db.agentTeamEvent.update({ where: { id: active.alarmEventId }, data: { acknowledgedAt: stamp(106), acknowledgedByWorkerId: workerId } });
    expect(await run(tx => advanceDeliveryEscalation(tx, workerId, stamp(130)))).toBe(false);
  });
  it('does not infer resolution from missing candidates or a different incarnation', async () => {
    const before = await db.workerDeliveryAlarmEpisode.findUniqueOrThrow({ where: { workerId } });
    await run(tx => reconcileDeliveryAlarm(tx, { workerId, candidates: [], now: stamp(71), hold: null }));
    expect((await db.workerDeliveryAlarmEpisode.findUniqueOrThrow({ where: { workerId } })).episodeId).toBe(before.episodeId);
    expect(await db.agentTeamEvent.count({ where: { appId, type: 'delivery.resumed' } })).toBe(0);
  });
  it('only covering marks close once, preserve history and allow an already-aged successor', async () => {
    const before = await db.agentTeamEvent.findFirstOrThrow({ where: { appId, type: 'delivery.stuck' } });
    const input = { workerId, candidates: [message(2)], now: stamp(72), hold: null,
      mark: { channelId: 'channel-s5', channelIncarnation: 1, throughSeq: 1, principal: { kind: 'worker' as const, workerId } } };
    await db.workerDeliveryChannel.create({ data: { workerId, channelId: 'channel-s5', channelIncarnation: 1, deliveredThroughSeq: 1, deliveredAt: stamp(72) } });
    await run(tx => reconcileDeliveryAlarm(tx, input));
    await run(tx => reconcileDeliveryAlarm(tx, input));
    expect(await db.agentTeamEvent.count({ where: { appId, type: 'delivery.resumed' } })).toBe(1);
    expect(await db.agentTeamEvent.findUnique({ where: { id: before.id } })).toEqual(before);
    expect((await db.workerDeliveryAlarmEpisode.findUniqueOrThrow({ where: { workerId } })).anchorSeq).toBe(2);
  });
});
