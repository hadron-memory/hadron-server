/**
 * #4234 (S11 of the Team on Orca epic, #4229) — wakes and deliveries for a short-lived worker that is not running.
 *
 * A worker of a SHORT_LIVED Agent runs only while it holds a task (#4224); between tasks its session is ended and it has
 * no terminal. Typing a wake into a terminal that is not there fails, so such a worker is handed no wake at all: its
 * mentions wait in the channel and its first run reads them (S7); its assignment is the first prompt of that run.
 *
 * - A stopped short-lived worker (no open session) is never due: not for a mention, not for a task event.
 * - Once it runs again (an open session), what waited is due as usual.
 * - A LONG_LIVED worker without a session is unchanged (it is still due).
 * - No dark-worker alarm between tasks (the NO_SESSION exemption, cor:agt:050:26, pinned here).
 * - G8: a mention alone never makes a short-lived worker desired-RUNNING; only a task does.
 * - Subscribing a short-lived Agent's worker to a ticker is refused with TICKER_ON_SHORT_LIVED: its ticks could never
 *   be delivered.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GraphQLError } from 'graphql';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../id.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../workerSignature.js';
import { ensureChannelWithRoot } from '../channels.js';
import { appendChatMessage } from '../chatRoot.js';
import { getMemoryEncryptionInfo } from '../nodeCrypto.js';
import { evaluateDarkWorkers } from '../agentTasks/darkWorker.js';
import { computeDueWakes } from './dueWakes.js';
import { decideDesiredState } from '../desiredState/desiredState.js';
import { resolvers, type Context } from '../../api/graphql/schema/resolvers.js';

vi.mock('../../lib/bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));
vi.mock('../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));

const M = resolvers.Mutation as any;
const MIN = 60_000;
const T0 = new Date();
const after = (minutes: number) => new Date(T0.getTime() + minutes * MIN);

let org: { id: string; urn: string };
let app: { id: string; organizationId: string | null; ownerUserId: string | null };
let user: { id: string };
let shortAgent: { id: string };
let longAgent: { id: string };
let channel: { id: string; memoryId: string; loc: string; chatRootNodeId: string };
const w: Record<string, { id: string }> = {};

const ctx = (): Context => ({ db, userId: user.id, roles: ['READER'] }) as Context;

beforeEach(async () => {
  await cleanDb(db);
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
  org = await db.organization.create({ data: { id: generateId(), name: 'sl-org', urn: `sl-${suffix}.com` } });
  user = await db.user.create({ data: { id: generateId(), githubId: 42_340_000 + Math.floor(Math.random() * 100_000), githubUsername: `sl-${suffix}`, roles: ['READER'] } });
  shortAgent = await db.agent.create({ data: { id: generateId(), organizationId: org.id, name: 'Engineer', urn: `${org.urn}:engineer`, visibility: 'ORGANIZATION', lifecycle: 'SHORT_LIVED' } });
  longAgent = await db.agent.create({ data: { id: generateId(), organizationId: org.id, name: 'Coordinator', urn: `${org.urn}:coordinator`, visibility: 'ORGANIZATION' } });
  app = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Team', urn: `${org.urn}:team` }, select: { id: true, organizationId: true, ownerUserId: true } });
  await db.appAgent.create({ data: { appId: app.id, agentId: shortAgent.id } });
  await db.appAgent.create({ data: { appId: app.id, agentId: longAgent.id } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: user.id, role: 'ADMIN' } });
  await db.appMember.create({ data: { appId: app.id, userId: user.id, role: 'member' } });
  const memory = await db.memory.create({
    data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:team-shared`, name: 'shared', class: 'app', appId: app.id, sharedMemoryOfAgentId: shortAgent.id },
  });
  const made = await ensureChannelWithRoot(db, { memoryId: memory.id, loc: 'chats:team', name: 'team', createdBy: user.id, asDefaultOfAppId: app.id });
  channel = { id: made.channel.id, memoryId: memory.id, loc: 'chats:team', chatRootNodeId: made.rootId };
  for (const [name, agentId] of [['Byron', shortAgent.id], ['Peter', longAgent.id]] as const) {
    w[name] = await db.worker.create({
      data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId: app.id, agentId, name, slug: name.toLowerCase(), role: 'engineer', heldByUserId: user.id, heldAt: new Date() },
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
/** A session for the worker: open (`ended` false) or ended a minute after it started (a finished stint). */
const session = (name: string, ended = false) => {
  const startedAt = new Date(T0.getTime() - 120 * MIN);
  return db.session.create({
    data: {
      id: generateId(), appId: app.id, userId: user.id, workerId: w[name].id, agentId: name === 'Byron' ? shortAgent.id : longAgent.id,
      type: 'DEVELOPER', startedAt, updatedAt: startedAt, ...(ended ? { endedAt: new Date(startedAt.getTime() + MIN) } : {}),
    },
  });
};
const assign = async (name: string) => {
  const t = await db.agentTask.create({ data: { appId: app.id, title: 'Build #4234', ownerUserId: user.id, assigneeWorkerId: w[name].id, assignedAt: new Date(T0.getTime() - 5 * MIN) } });
  await db.agentTeamEvent.create({ data: { appId: app.id, taskId: t.id, type: 'task.assigned', subjectWorkerId: w[name].id, actorUserId: user.id, createdAt: new Date(T0.getTime() - 5 * MIN) } });
  return t;
};
const due = (now = new Date()) =>
  computeDueWakes({ ctx: ctx(), app, reader: { manager: true, userId: user.id }, requester: { userId: user.id }, now });
const dueIds = async (now?: Date) => (await due(now)).wakes.map((x) => x.workerId).sort();

describe('#4234 a stopped short-lived worker is handed no wake', () => {
  it('a mention to a short-lived worker with its session ended is not due; the same mention to a long-lived one is', async () => {
    await session('Byron', true);
    await say('@byron @peter please look', ['byron', 'peter']);
    expect(await dueIds()).toEqual([w.Peter.id]);
  });

  it('a short-lived worker that never had a session is not due for a mention', async () => {
    await say('@byron please look', ['byron']);
    expect(await dueIds()).toEqual([]);
  });

  it('a task assigned to a stopped short-lived worker is not a wake (the run it starts takes the task as its first prompt)', async () => {
    await assign('Byron');
    expect(await dueIds()).toEqual([]);
  });

  it('the mention waits: once the worker runs again (an open session), it is due', async () => {
    await session('Byron', true);
    await say('@byron please look', ['byron']);
    expect(await dueIds()).toEqual([]);
    await session('Byron');
    expect(await dueIds()).toEqual([w.Byron.id]);
  });

  it('a running short-lived worker (an open session) is due for a mention and a task as usual', async () => {
    await session('Byron');
    await assign('Byron');
    await say('@byron please look', ['byron']);
    const page = await due();
    expect(page.wakes.map((x) => x.workerId)).toEqual([w.Byron.id]);
    expect(page.wakes[0]!.wake.reasons.map((r) => r.kind).sort()).toEqual(['MENTION', 'TASK']);
  });

  it('the stopped worker is not reported dormant either (dormancy is a different state; nothing is withheld)', async () => {
    await say('@byron please look', ['byron']);
    expect((await due()).dormant).toEqual([]);
  });
});

describe('#4234 no dark-worker alarm between tasks', () => {
  it('a stopped short-lived worker mentioned 40 minutes ago raises no alarm (NO_SESSION, cor:agt:050:26)', async () => {
    await session('Byron', true);
    await say('@byron please look', ['byron']);
    expect(await evaluateDarkWorkers(db, after(40))).toEqual([]);
    expect(await db.agentTeamEvent.count({ where: { subjectWorkerId: w.Byron.id, type: 'alarm.dark-worker' } })).toBe(0);
  });
});

describe('#4234 G8: a mention alone does not start a short-lived worker', () => {
  it('with no open task it is desired STOPPED whatever waits in the chat; a task makes it RUNNING', () => {
    const facts = { sweepMode: 'APPLY' as const, leaveAlone: false, retired: false, stopLevel: null, teamPaused: false, resetting: false, lifecycle: 'SHORT_LIVED' as const };
    expect(decideDesiredState({ ...facts, openTasks: 0 })).toMatchObject({ desired: 'STOPPED', reason: 'NO_OPEN_TASK' });
    expect(decideDesiredState({ ...facts, openTasks: 1 })).toMatchObject({ desired: 'RUNNING', reason: 'HOLDS_TASK' });
  });
});

describe('#4234 a ticker on a short-lived Agent\'s worker is refused', () => {
  const code = async (p: Promise<unknown>) => {
    try {
      await p;
      return null;
    } catch (e) {
      expect(e).toBeInstanceOf(GraphQLError);
      return (e as GraphQLError).extensions?.code ?? null;
    }
  };

  it('subscribing the short-lived worker refuses TICKER_ON_SHORT_LIVED and writes nothing; the long-lived one subscribes', async () => {
    const t = await M.createTicker({}, { appRef: app.id, input: { name: 'Engineering', cadenceSeconds: 600 } }, ctx());
    expect(await code(M.subscribeWorker({}, { tickerRef: t.id, workerRef: w.Byron.id }, ctx()))).toBe('TICKER_ON_SHORT_LIVED');
    expect(await db.tickerSubscription.count({ where: { tickerId: t.id, workerId: w.Byron.id } })).toBe(0);
    expect(await code(M.subscribeWorker({}, { tickerRef: t.id, workerRef: w.Peter.id }, ctx()))).toBeNull();
    expect(await db.tickerSubscription.count({ where: { tickerId: t.id, workerId: w.Peter.id, endedAt: null } })).toBe(1);
  });

  it('unsubscribing a short-lived worker (a subscription made before its Agent became short-lived) is still allowed', async () => {
    const t = await M.createTicker({}, { appRef: app.id, input: { name: 'Engineering', cadenceSeconds: 600 } }, ctx());
    await db.tickerSubscription.create({ data: { tickerId: t.id, workerId: w.Byron.id } });
    expect(await code(M.unsubscribeWorker({}, { tickerRef: t.id, workerRef: w.Byron.id }, ctx()))).toBeNull();
    expect(await db.tickerSubscription.count({ where: { tickerId: t.id, workerId: w.Byron.id, endedAt: null } })).toBe(0);
  });
});
