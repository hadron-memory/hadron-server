/** Persisted 050:26 S7/S8: each pass reloads the ledger in a new transaction. */
import { afterEach, beforeEach, expect, it } from 'vitest';
import { PrismaClient } from '../../generated/prisma/index.js';
import { generateId } from '../id.js';
import { beginDeliveryTracking, deliveryStateTransaction, observeDeliveryPolicyThrough, recordDeliveryException, reconcileDeliveryAlarm, deliveryAlarmSnapshot } from './deliveryState.js';

const db = new PrismaClient();
const at = (minute: number) => new Date(Date.UTC(2026, 9, 19, 10, minute));
let orgId: string, appId: string, agentId: string, workerId: string;
const run = <T>(fn: Parameters<typeof deliveryStateTransaction<T>>[3]) => deliveryStateTransaction(db, appId, workerId, fn);
beforeEach(async () => {
  orgId = generateId(); appId = generateId(); agentId = generateId(); workerId = generateId();
  await db.organization.create({ data: { id: orgId, name: 'S5 scenario', urn: `s5-${orgId}.example` } });
  await db.agent.create({ data: { id: agentId, organizationId: orgId, name: 'Scenario', urn: `s5-${orgId}.example:agent` } });
  await db.app.create({ data: { id: appId, organizationId: orgId, name: 'Scenario', urn: `s5-${orgId}.example:app` } });
  await db.worker.create({ data: { id: workerId, appId, agentId, name: 'Scenario worker', slug: 'scenario-worker' } });
  await run(tx => beginDeliveryTracking(tx, workerId, at(0)));
});
afterEach(async () => {
  await db.worker.deleteMany({ where: { id: workerId } });
  await db.app.deleteMany({ where: { id: appId } });
  await db.agent.deleteMany({ where: { id: agentId } });
  await db.organization.deleteMany({ where: { id: orgId } });
  await db.$disconnect();
});
const message = (seq: number, minute = 0) => ({ workerId, channelId: 'scenario-channel', channelIncarnation: 1, seq, dueSince: at(minute) });
const evaluate = (minute: number, candidates = [message(1)]) => run(tx => reconcileDeliveryAlarm(tx, {
  workerId, candidates, now: at(minute), hold: null,
}));

it('S7: a 10:05–11:00 pause preserves prior five minutes across reload; alarm begins exactly at 11:10', async () => {
  await run(tx => recordDeliveryException(tx, { workerId, cause: 'wake-paused', coverage: { kind: 'worker' }, startedAt: at(5), endedAt: at(60) }));
  await run(tx => observeDeliveryPolicyThrough(tx, workerId, at(80)));
  expect(await evaluate(65)).toEqual({ raised: null, resumed: null });
  expect((await evaluate(70)).raised).toBeTruthy();
  const original = await run(tx => deliveryAlarmSnapshot(tx, workerId, at(70)));
  expect(original).toMatchObject({ waitedMs: 900_000, waitAsOf: at(70), state: 'ACTIVE' });
  // A later worker-wide exception suppresses the existing episode; it does
  // not end it or emit a resumed event, even after its threshold was reached.
  await run(tx => recordDeliveryException(tx, { workerId, cause: 'team-paused', coverage: { kind: 'worker' }, startedAt: at(80), endedAt: null }));
  await run(tx => observeDeliveryPolicyThrough(tx, workerId, at(90)));
  expect(await evaluate(90)).toEqual({ raised: null, resumed: null });
  expect(await run(tx => deliveryAlarmSnapshot(tx, workerId, at(90)))).toMatchObject({ episodeId: original!.episodeId, waitedMs: 1_500_000, state: 'SUPPRESSED' });
  expect(await db.agentTeamEvent.count({ where: { appId, type: 'delivery.resumed' } })).toBe(0);
});

it('S8: an older budget/standby-covered message cannot hide a later uncovered mention; hold remains an obstruction', async () => {
  await run(tx => recordDeliveryException(tx, { workerId, cause: 'standby', coverage: { kind: 'range', channelId: 'scenario-channel', channelIncarnation: 1, fromSeq: 1, throughSeq: 1 }, startedAt: at(0), endedAt: null }));
  await run(tx => observeDeliveryPolicyThrough(tx, workerId, at(20)));
  const result = await run(tx => reconcileDeliveryAlarm(tx, {
    workerId, candidates: [message(1), message(2, 2)], now: at(20),
    hold: { reason: 'draft', terminalId: 'term_s5-test' },
  }));
  expect(result.raised).toBeTruthy();
  expect(await db.workerDeliveryAlarmEpisode.findUniqueOrThrow({ where: { workerId } })).toMatchObject({ anchorSeq: 2 });
  const event = await db.agentTeamEvent.findUniqueOrThrow({ where: { id: result.raised! } });
  expect(event.payload).toMatchObject({ firstPendingSeq: 2, reason: 'draft', terminalId: 'term_s5-test' });
});

it('loads a nondefault persisted S9 window for the deciding App', async () => {
  await db.app.update({ where: { id: appId }, data: { deliveryStuckWindowSeconds: 1_800 } });
  await run(tx => observeDeliveryPolicyThrough(tx, workerId, at(30)));
  expect(await evaluate(15)).toEqual({ raised: null, resumed: null });
  expect((await evaluate(30)).raised).toBeTruthy();
  const event = await db.agentTeamEvent.findFirstOrThrow({ where: { appId, type: 'delivery.stuck' } });
  expect(event.payload).toMatchObject({ windowSeconds: 1_800 });
});
