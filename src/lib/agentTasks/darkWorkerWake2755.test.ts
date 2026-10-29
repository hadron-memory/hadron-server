/**
 * #2755 — the dark-worker alarm, UNACKNOWLEDGED-WAKE trigger: a wake due to a worker (cor:agt:080:08) that has gone
 * unacknowledged for longer than the App's `darkAlarmWindowSeconds` raises the alarm whatever the check status says.
 * The OVERDUE trigger and the shared episode/chain mechanics are pinned in darkWorker2755.test.ts.
 *
 * A message is posted at the real clock and the evaluator runs at a later `now`, so the wake's age is exact.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../id.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../workerSignature.js';
import { ensureChannelWithRoot } from '../channels.js';
import { appendChatMessage } from '../chatRoot.js';
import { getMemoryEncryptionInfo } from '../nodeCrypto.js';
import { evaluateDarkWorkers } from './darkWorker.js';

vi.mock('../../lib/bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));

const MIN = 60_000;
const T0 = new Date();
const after = (minutes: number) => new Date(T0.getTime() + minutes * MIN);

let org: { id: string; urn: string };
let app: { id: string };
let user: { id: string };
let agent: { id: string };
let channel: { id: string; memoryId: string; loc: string; chatRootNodeId: string };
const w: Record<string, { id: string }> = {};

beforeEach(async () => {
  await cleanDb(db);
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
  org = await db.organization.create({ data: { id: generateId(), name: 'dw-org', urn: `dw-${suffix}.com` } });
  user = await db.user.create({ data: { id: generateId(), githubId: 98_700 + Math.floor(Math.random() * 1000), githubUsername: `dw-${suffix}`, roles: ['READER'] } });
  agent = await db.agent.create({ data: { id: generateId(), organizationId: org.id, name: 'Engineer', urn: `${org.urn}:engineer`, visibility: 'ORGANIZATION' } });
  app = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Team', urn: `${org.urn}:team` } });
  await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: user.id, role: 'ADMIN' } });
  await db.appMember.create({ data: { appId: app.id, userId: user.id, role: 'member' } }); // the holder still participates
  const memory = await db.memory.create({
    data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:team-shared`, name: 'shared', class: 'app', appId: app.id, sharedMemoryOfAgentId: agent.id },
  });
  const made = await ensureChannelWithRoot(db, { memoryId: memory.id, loc: 'chats:team', name: 'team', createdBy: user.id, asDefaultOfAppId: app.id });
  channel = { id: made.channel.id, memoryId: memory.id, loc: 'chats:team', chatRootNodeId: made.rootId };
  for (const name of ['Liam', 'Tove']) {
    w[name] = await db.worker.create({
      data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId: app.id, agentId: agent.id, name, slug: name.toLowerCase(), role: 'engineer', heldByUserId: user.id, heldAt: new Date() },
      select: { id: true },
    });
    await db.registerEntry.create({ data: { id: generateId(), appId: app.id, channelId: channel.id, attendeeWorkerId: w[name].id, role: 'BOTH' } });
  }
});

async function say(body: string, mentions: string[]) {
  const enc = await getMemoryEncryptionInfo(db, channel.memoryId);
  return appendChatMessage(db, { id: channel.chatRootNodeId, memoryId: channel.memoryId, loc: channel.loc }, enc, async ({ tx, seq, msgNum }) =>
    tx.node.create({ data: { id: generateId(), memoryId: channel.memoryId, loc: `${channel.loc}:messages:${msgNum}`, name: msgNum, nodeType: 'chat-message', seq, messageChannelId: channel.id, content: body, data: { mentions } } }),
    { asChannel: true });
}
/** A live session, started two hours before T0 and still driven at `touched`. */
const bind = (name: string, touched: Date) =>
  db.session.create({ data: { id: generateId(), appId: app.id, userId: user.id, workerId: w[name].id, agentId: agent.id, type: 'DEVELOPER', startedAt: new Date(T0.getTime() - 120 * MIN), updatedAt: touched } });
const assign = (name: string) =>
  db.agentTask.create({ data: { appId: app.id, title: 'T', ownerUserId: user.id, assigneeWorkerId: w[name].id, assignedAt: new Date(T0.getTime() - 5 * MIN) } });
const alarms = (name: string) => db.agentTeamEvent.findMany({ where: { subjectWorkerId: w[name].id, type: 'alarm.dark-worker' }, orderBy: { createdAt: 'asc' } });

describe('#2755 a due wake left unacknowledged past the window', () => {
  it('raises reason wake-unacked for a worker with NO task (NO_TASK does not exempt it), with the wake\'s age as evidence', async () => {
    await bind('Tove', after(31));
    await say('hello @tove', ['tove']);
    expect(await evaluateDarkWorkers(db, after(29))).toEqual([]); // 1800 s window not yet passed
    expect(await evaluateDarkWorkers(db, after(31))).toHaveLength(1);
    const [alarm] = await alarms('Tove');
    expect(alarm).toMatchObject({ taskId: null, severity: 'alarm' });
    expect(alarm.payload).toMatchObject({ reason: 'wake-unacked' });
    const age = (alarm.payload as any).oldestWakeAgeSeconds as number;
    expect(age).toBeGreaterThanOrEqual(30 * 60);
    expect(age).toBeLessThan(32 * 60);
  });

  it('raises while the check status is still OK (a task, checked just now)', async () => {
    await bind('Liam', after(31));
    await assign('Liam');
    await db.channelReadState.create({ data: { workerId: w.Liam.id, appId: app.id, channelId: channel.id, lastSeenSeq: 0, lastCheckedAt: after(30) } });
    await say('ping @liam', ['liam']);
    expect(await evaluateDarkWorkers(db, after(31))).toHaveLength(1);
    expect((await alarms('Liam'))[0].payload).toMatchObject({ reason: 'wake-unacked' });
  });

  it('honours the App\'s own window', async () => {
    await db.app.update({ where: { id: app.id }, data: { deliveryDarkAlarmWindowSeconds: 600 } });
    await bind('Tove', after(11));
    await say('hello @tove', ['tove']);
    expect(await evaluateDarkWorkers(db, after(9))).toEqual([]);
    expect(await evaluateDarkWorkers(db, after(11))).toHaveLength(1);
  });

  it('raises none for NO_SESSION, a paused or isolated worker, or a paused team', async () => {
    await say('hello @tove @liam', ['tove', 'liam']);
    expect(await evaluateDarkWorkers(db, after(40))).toEqual([]); // no live session
    await bind('Tove', after(40));
    await bind('Liam', after(40));
    await db.workerWakeSettings.create({ data: { workerId: w.Tove.id, pausedUntil: after(120) } });
    await db.workerWakeSettings.create({ data: { workerId: w.Liam.id, isolatedUntil: after(120) } });
    expect(await evaluateDarkWorkers(db, after(40))).toEqual([]);
    await db.workerWakeSettings.deleteMany({});
    await db.app.update({ where: { id: app.id }, data: { teamPausedAt: after(1) } });
    expect(await evaluateDarkWorkers(db, after(40))).toEqual([]);
  });

  it('one open episode across both reasons: OVERDUE then an unacked wake is the same episode, ended only when both clear', async () => {
    await bind('Liam', after(60));
    await assign('Liam');
    // 60 minutes on, a worker with a task that never checked is OVERDUE
    expect(await evaluateDarkWorkers(db, after(60))).toHaveLength(1);
    expect((await alarms('Liam'))[0].payload).toMatchObject({ reason: 'overdue' });
    await say('ping @liam', ['liam']);
    // checks the channel (no longer OVERDUE) while the wake stays unacknowledged past the window: same episode
    await db.channelReadState.create({ data: { workerId: w.Liam.id, appId: app.id, channelId: channel.id, lastSeenSeq: 0, lastCheckedAt: after(90) } });
    await db.session.updateMany({ where: { workerId: w.Liam.id }, data: { updatedAt: after(95) } });
    expect(await evaluateDarkWorkers(db, after(95))).toEqual([]);
    expect(await db.darkWorkerEpisode.count({ where: { workerId: w.Liam.id, endedAt: null } })).toBe(1);
    expect(await alarms('Liam')).toHaveLength(1);
  });

  it('the episode ends when the wake is acknowledged and the worker is no longer OVERDUE', async () => {
    await bind('Tove', after(40));
    await say('hello @tove', ['tove']);
    expect(await evaluateDarkWorkers(db, after(40))).toHaveLength(1);
    await db.channelReadState.create({ data: { workerId: w.Tove.id, appId: app.id, channelId: channel.id, lastSeenSeq: 1_000_000, lastCheckedAt: after(41) } });
    await db.session.updateMany({ where: { workerId: w.Tove.id }, data: { updatedAt: after(42) } });
    expect(await evaluateDarkWorkers(db, after(42))).toEqual([]);
    expect(await db.darkWorkerEpisode.count({ where: { workerId: w.Tove.id, endedAt: { not: null } } })).toBe(1);
  });
});

describe('#2755 exempt time does not count toward a wake\'s age', () => {
  it('a worker whose own pause ended is alarmed one window after it resumed, not at once from the old anchor', async () => {
    await bind('Tove', after(100));
    await db.workerWakeSettings.create({ data: { workerId: w.Tove.id, pausedUntil: after(20) } });
    await say('hello @tove', ['tove']);
    expect(await evaluateDarkWorkers(db, after(10))).toEqual([]); // paused: exempt
    expect(await evaluateDarkWorkers(db, after(35))).toEqual([]); // resumed 15 min ago, the wake is 35 min old
    expect(await evaluateDarkWorkers(db, after(49))).toEqual([]); // 29 min since it resumed
    expect(await evaluateDarkWorkers(db, after(51))).toHaveLength(1); // 31 min since it resumed
  });

  it('a team pause that ended restarts the wake clock the same way', async () => {
    await bind('Tove', after(100));
    await db.app.update({ where: { id: app.id }, data: { teamResumedAt: after(25) } });
    await say('hello @tove', ['tove']);
    expect(await evaluateDarkWorkers(db, after(40))).toEqual([]);
    expect(await evaluateDarkWorkers(db, after(56))).toHaveLength(1);
  });
});

describe('#2755 the evaluator\'s read of the due wakes writes nothing', () => {
  it('reserves no wake slot and charges no daily budget, however many passes run', async () => {
    await bind('Tove', after(31));
    await say('hello @tove', ['tove']);
    await evaluateDarkWorkers(db, after(31));
    await evaluateDarkWorkers(db, after(32));
    expect(await db.appWakeReservation.count()).toBe(0);
    expect(await db.appWakeDay.count()).toBe(0);
  });

  it('touches no other delivery, read-state or episode row when no alarm is due (the evaluator itself writes nothing then)', async () => {
    await bind('Tove', after(5));
    await say('hello @tove', ['tove']);
    const snapshot = async () => JSON.stringify([
      await db.channelReadState.findMany({ orderBy: { workerId: 'asc' } }),
      await db.workerDeliveryTick.findMany(),
      await db.workerDeliveryTaskEvent.findMany(),
      await db.appWakeReservation.findMany(),
      await db.appWakeDay.findMany(),
      await db.darkWorkerEpisode.findMany(),
      await db.agentTeamEvent.findMany(),
    ]);
    const before = await snapshot();
    expect(await evaluateDarkWorkers(db, after(10))).toEqual([]);
    expect(await snapshot()).toBe(before);
  });
});
