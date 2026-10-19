/** S13 projection pins over the exact S5 0639532a checkpoint.
 * No hold-table or complete enumeration DTO is invented here. Public read implementation is intentionally absent.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import {
  beginDeliveryTracking, deliveryAlarmSnapshot, deliveryStateTransaction, loadDeliveryWait,
  observeDeliveryPolicyThrough, reconcileDeliveryAlarm, recordDeliveryException,
} from '../../../lib/tickers/deliveryState.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({ syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }) }));
const Q = resolvers.Query as any;
const minute = 60_000;
const start = new Date('2026-10-19T00:00:00Z');
const stamp = (n: number) => new Date(start.getTime() + n * minute);
const asOf = stamp(40);
let appId: string, workerId: string, channelId: string, ctx: Context;
const message = () => ({ workerId, channelId, channelIncarnation: 1, seq: 1, dueSince: start });
const run = <T>(fn: Parameters<typeof deliveryStateTransaction<T>>[3]) => deliveryStateTransaction(db, appId, workerId, fn);
const read = (extra: Record<string, unknown> = {}) => Q.workerDeliveryHealth({}, { appRef: appId, workerRef: workerId, ...extra }, ctx);

beforeEach(async () => {
  await cleanDb(db);
  const suffix = generateId();
  const org = await db.organization.create({ data: { name: 'S13 projection', urn: `s13-${suffix}.example` } });
  const user = await db.user.create({ data: { githubId: 9932029, githubUsername: `s13-${suffix}`, roles: ['READER'] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: user.id, role: 'ADMIN' } });
  ctx = { db, userId: user.id, roles: ['READER'] };
  const agent = await db.agent.create({ data: { name: 'S13 role', urn: `${org.urn}:role`, organizationId: org.id } });
  const app = await db.app.create({ data: { name: 'S13 app', urn: `${org.urn}:app`, organizationId: org.id } });
  appId = app.id;
  const worker = await db.worker.create({ data: { appId, agentId: agent.id, name: 'Target', slug: 'target' } });
  workerId = worker.id;
  const memory = await db.memory.create({ data: { name: 'S13 host', urn: `${org.urn}:host`, class: 'knowledge', organizationId: org.id } });
  const root = await db.node.create({ data: { memoryId: memory.id, loc: 'chat:projection', name: 'Projection', nodeType: 'chat' } });
  channelId = (await db.channel.create({ data: { memoryId: memory.id, loc: root.loc, name: 'Projection', chatRootNodeId: root.id, incarnation: 1 } })).id;
  await run(async tx => {
    await beginDeliveryTracking(tx, workerId, start);
  });
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(asOf);
});
afterEach(() => vi.useRealTimers());

const certify = () => run(tx => observeDeliveryPolicyThrough(tx, workerId, asOf));
const raise = async () => {
  await run(tx => observeDeliveryPolicyThrough(tx, workerId, stamp(30)));
  await run(tx => reconcileDeliveryAlarm(tx, { workerId, candidates: [message()], now: stamp(30), hold: null }));
  return db.workerDeliveryAlarmEpisode.findUniqueOrThrow({ where: { workerId } });
};

describe('S5 checkpoint controls for S13 fixtures', () => {
  it('loads a persisted canonical alarm without a projection or a history replay', async () => {
    const alarm = await raise(); await certify();
    const snapshot = await db.$transaction(tx => deliveryAlarmSnapshot(tx, workerId, asOf));
    expect(snapshot).toMatchObject({ episodeId: alarm.episodeId, eventId: alarm.alarmEventId, state: 'ACTIVE', waitedMs: 40 * minute, waitAsOf: asOf });
  });
});

describe('S13 canonical current-alarm projection', () => {
  it('returns the canonical alarm independently of the channel detail limit and recent history', async () => {
    const alarm = await raise(); await certify();
    // The alarm is old relative to unrelated recent events; a bounded event page cannot derive its currentness.
    for (let i = 0; i < 3; i++) await db.agentTeamEvent.create({ data: { appId, subjectWorkerId: workerId, type: 'task.created', createdAt: stamp(39) } });
    const health = await read({ limit: 1 });
    expect(health.asOf).toEqual(asOf);
    expect(health.activeAlarmCount).toBe(1);
    expect(health.suppressedAlarmCount).toBe(0);
    expect(health.alarm).toMatchObject({ episodeId: alarm.episodeId, eventId: alarm.alarmEventId, state: 'ACTIVE', waitedMs: 40 * minute, waitAsOf: asOf });
  });
  it('uses per-message exception union rather than elapsed wall-clock age', async () => {
    await run(async tx => {
      for (const [lo, hi] of [[5, 15], [10, 20]]) await recordDeliveryException(tx, { workerId, cause: 'wake-paused', coverage: { kind: 'worker' }, startedAt: stamp(lo!), endedAt: stamp(hi!) });
    });
    const alarm = await raise(); await certify();
    const canonical = await db.$transaction(tx => loadDeliveryWait(tx, message(), asOf));
    expect(canonical.waitedMs).toBe(25 * minute);
    const health = await read();
    expect(health.alarm).toMatchObject({ episodeId: alarm.episodeId, waitedMs: canonical.waitedMs, waitAsOf: asOf });
  });
  it('projects suppression without resolving the episode or conflating it with acknowledgement', async () => {
    const alarm = await raise();
    await run(tx => recordDeliveryException(tx, { workerId, cause: 'isolated', coverage: { kind: 'worker' }, startedAt: stamp(35), endedAt: null }));
    await db.agentTeamEvent.update({ where: { id: alarm.alarmEventId }, data: { acknowledgedAt: stamp(36), acknowledgedByUserId: ctx.userId } });
    await certify();
    expect(await db.$transaction(tx => deliveryAlarmSnapshot(tx, workerId, asOf))).toMatchObject({ state: 'SUPPRESSED', waitedMs: 35 * minute });
    const health = await read();
    expect([health.activeAlarmCount, health.suppressedAlarmCount]).toEqual([0, 1]);
    expect(health.alarm).toMatchObject({ episodeId: alarm.episodeId, state: 'SUPPRESSED', waitedMs: 35 * minute });
    expect(await db.agentTeamEvent.count({ where: { appId, type: 'delivery.resumed' } })).toBe(0);
  });
  it('refuses incomplete coverage instead of fabricating zero or CLEAR', async () => {
    await raise();
    await db.workerDeliveryWaitState.update({ where: { workerId }, data: { observedThrough: stamp(39) } });
    await expect(db.$transaction(tx => deliveryAlarmSnapshot(tx, workerId, asOf))).rejects.toThrow('DELIVERY_WAIT_INCOMPLETE');
    const code = await read().then(() => 'UNEXPECTED_SUCCESS', (e: any) => e.extensions?.code ?? e.message);
    expect(code).toBe('DELIVERY_WAIT_INCOMPLETE');
  });
  it.each(['deleted', 'replaced', 'removed'])('uses R62 canonical currentness for a %s channel without writing resumed history', async kind => {
    const alarm = await raise(); await certify();
    if (kind === 'deleted') await db.channel.update({ where: { id: channelId }, data: { deletedAt: stamp(35) } });
    else if (kind === 'replaced') await db.channel.update({ where: { id: channelId }, data: { incarnation: 2 } });
    else await db.channel.delete({ where: { id: channelId } });
    expect(await db.$transaction(tx => deliveryAlarmSnapshot(tx, workerId, asOf))).toBeNull();
    const health = await read();
    expect([health.activeAlarmCount, health.suppressedAlarmCount, health.alarm]).toEqual([0, 0, null]);
    expect((await db.workerDeliveryAlarmEpisode.findUniqueOrThrow({ where: { workerId } })).episodeId).toBe(alarm.episodeId);
    expect(await db.agentTeamEvent.count({ where: { appId, type: 'delivery.resumed' } })).toBe(0);
  });
  it('leaves historical events, acknowledgement, ledger and current projection unchanged on read', async () => {
    await raise(); await certify();
    const before = await Promise.all([
      db.agentTeamEvent.findMany({ where: { appId }, orderBy: { id: 'asc' } }),
      db.workerDeliveryAlarmEpisode.findMany({ where: { workerId } }),
      db.workerDeliveryWaitException.findMany({ where: { workerId } }),
      db.workerDeliveryWaitState.findMany({ where: { workerId } }),
    ]);
    await read();
    const after = await Promise.all([
      db.agentTeamEvent.findMany({ where: { appId }, orderBy: { id: 'asc' } }),
      db.workerDeliveryAlarmEpisode.findMany({ where: { workerId } }),
      db.workerDeliveryWaitException.findMany({ where: { workerId } }),
      db.workerDeliveryWaitState.findMany({ where: { workerId } }),
    ]);
    expect(after).toEqual(before);
  });
});
