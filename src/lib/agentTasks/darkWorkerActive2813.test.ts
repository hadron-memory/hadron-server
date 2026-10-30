/**
 * #2813 — the `wake-unacked` trigger of the dark-worker alarm is exempt for a worker whose live session shows activity
 * inside the App's window (`sessionActivityAt`: startedAt, the heartbeat `updatedAt`, the latest counted UsageEvent). A
 * worker in one long turn is not dark just because its deliverer could not type the wake. `overdue` is unchanged.
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
import { resolvers, type Context } from '../../api/graphql/schema/resolvers.js';
import { runAsActor } from '../requestActor.js';
import { setS7AvailableForTest } from '../tickers/s7Availability.js';

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
/** A live session, started two hours before T0 and last driven (heartbeat) at `touched`. */
const bind = (name: string, touched: Date) =>
  db.session.create({ data: { id: generateId(), appId: app.id, userId: user.id, workerId: w[name].id, agentId: agent.id, type: 'DEVELOPER', startedAt: new Date(T0.getTime() - 120 * MIN), updatedAt: touched } });
const QUIET = new Date(T0.getTime() - 120 * MIN);
const assign = (name: string) =>
  db.agentTask.create({ data: { appId: app.id, title: 'T', ownerUserId: user.id, assigneeWorkerId: w[name].id, assignedAt: new Date(T0.getTime() - 5 * MIN) } });
const alarms = (name: string) => db.agentTeamEvent.findMany({ where: { subjectWorkerId: w[name].id, type: 'alarm.dark-worker' }, orderBy: { createdAt: 'asc' } });


const M = resolvers.Mutation as any;
const Q = resolvers.Query as any;

describe('#2813 session activity inside the window exempts wake-unacked', () => {
  it('no episode opens for a worker driven inside the window, whatever the wake\'s age', async () => {
    await bind('Tove', after(38)); // heartbeat 2 min before the pass
    await say('hello @tove', ['tove']);
    expect(await evaluateDarkWorkers(db, after(40))).toEqual([]);
    expect(await alarms('Tove')).toHaveLength(0);
    expect(await db.darkWorkerEpisode.count()).toBe(0);
  });

  it('the same worker with no activity inside the window is alarmed (today\'s behaviour)', async () => {
    await bind('Tove', QUIET);
    await say('hello @tove', ['tove']);
    expect(await evaluateDarkWorkers(db, after(40))).toHaveLength(1);
    expect((await alarms('Tove'))[0].payload).toMatchObject({ reason: 'wake-unacked' });
  });

  it('an open wake-unacked episode ends on the first pass that sees activity inside the window, and raises nothing', async () => {
    await bind('Tove', QUIET);
    await say('hello @tove', ['tove']);
    expect(await evaluateDarkWorkers(db, after(40))).toHaveLength(1);
    await db.session.updateMany({ where: { workerId: w.Tove.id }, data: { updatedAt: after(44) } });
    expect(await evaluateDarkWorkers(db, after(45))).toEqual([]);
    expect(await db.darkWorkerEpisode.count({ where: { workerId: w.Tove.id, endedAt: null } })).toBe(0);
    expect(await db.darkWorkerEpisode.count({ where: { workerId: w.Tove.id, endedAt: { not: null } } })).toBe(1);
    expect(await alarms('Tove')).toHaveLength(1);
  });

  it('a counted UsageEvent is activity on its own, with no heartbeat touch (a session driven through node reads)', async () => {
    const s = await bind('Tove', QUIET);
    await db.usageEvent.create({ data: { id: generateId(), type: 'node_read', sessionId: s.id, appId: app.id, userId: user.id, countsAsActivity: true, createdAt: after(39) } as any });
    await say('hello @tove', ['tove']);
    expect(await evaluateDarkWorkers(db, after(40))).toEqual([]);
  });

  it('a UsageEvent that does not count as activity exempts nothing', async () => {
    const s = await bind('Tove', QUIET);
    await db.usageEvent.create({ data: { id: generateId(), type: 'node_read', sessionId: s.id, appId: app.id, userId: user.id, countsAsActivity: false, createdAt: after(39) } as any });
    await say('hello @tove', ['tove']);
    expect(await evaluateDarkWorkers(db, after(40))).toHaveLength(1);
  });

  it('the delay is bounded: last activity at T, wake due before T, the alarm fires on the first pass after T + window', async () => {
    await bind('Tove', after(20));
    await say('hello @tove', ['tove']); // due at ~T0, long before the activity
    expect(await evaluateDarkWorkers(db, after(49))).toEqual([]); // 29 min since the activity
    expect(await evaluateDarkWorkers(db, after(50))).toHaveLength(1); // exactly the window: no longer "later than now - window"
    expect((await alarms('Tove'))[0].payload).toMatchObject({ reason: 'wake-unacked' });
  });

  it('honours the App\'s own window', async () => {
    await db.app.update({ where: { id: app.id }, data: { deliveryDarkAlarmWindowSeconds: 600 } });
    await bind('Tove', after(20));
    await say('hello @tove', ['tove']);
    expect(await evaluateDarkWorkers(db, after(29))).toEqual([]);
    expect(await evaluateDarkWorkers(db, after(31))).toHaveLength(1);
  });

  it('overdue is unaffected: an active worker with a task that never checked is still alarmed, reason overdue', async () => {
    await bind('Liam', after(59));
    await assign('Liam');
    expect(await evaluateDarkWorkers(db, after(60))).toHaveLength(1);
    expect((await alarms('Liam'))[0].payload).toMatchObject({ reason: 'overdue' });
  });

  it('one worker\'s activity does not exempt another\'s wake', async () => {
    await bind('Tove', after(39));
    await bind('Liam', QUIET);
    await say('hello @tove @liam', ['tove', 'liam']);
    expect(await evaluateDarkWorkers(db, after(40))).toHaveLength(1);
    expect(await alarms('Liam')).toHaveLength(1);
    expect(await alarms('Tove')).toHaveLength(0);
  });
});

describe('#2813 only the worker\'s own driving is activity (cor:agt:020:03, cor:agt:070:04)', () => {
  const holderCtx = (): Context => ({ db, userId: user.id, roles: ['READER'] });

  it('the deliverer\'s dueWakes read and acknowledgeWakes leave the session\'s activity unchanged', async () => {
    const s = await bind('Tove', QUIET);
    await say('hello @tove', ['tove']);
    const before = await db.session.findUniqueOrThrow({ where: { id: s.id } });
    const page = await Q.dueWakes({}, { appRef: app.id }, holderCtx());
    expect(page.wakes.length).toBeGreaterThan(0);
    await M.acknowledgeWakes({}, { proofs: [page.wakes[0].proof] }, holderCtx());
    const after_ = await db.session.findUniqueOrThrow({ where: { id: s.id } });
    expect(after_.updatedAt?.getTime()).toBe(before.updatedAt?.getTime());
    expect(await db.usageEvent.count({ where: { sessionId: s.id } })).toBe(0);
  });

  it('an exempt worker becomes dark once its OWN activity ages past the window', async () => {
    await bind('Tove', after(38));
    await say('hello @tove', ['tove']);
    expect(await evaluateDarkWorkers(db, after(40))).toEqual([]);
    expect(await evaluateDarkWorkers(db, after(70))).toHaveLength(1);
  });
});
