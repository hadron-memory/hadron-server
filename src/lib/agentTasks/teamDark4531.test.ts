/**
 * #4531 (hrn:node:hadronmemory.com:specs:cor:agt:050:34, Proposed) — a team that goes dark raises one alarm per
 * episode. Build-now parts only: the evaluator, `team.dark` / `team.recovered`, `Query.teamHealth`, the 30-minute
 * default window with no setter. The open questions (window setting, who sets it) are not built.
 *
 * A message is posted at the real clock and the evaluator runs at a later `now`, so a wake's age is exact.
 * Scenario names (S1..S7) are the Rule's.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../id.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../workerSignature.js';
import { ensureChannelWithRoot } from '../channels.js';
import { appendChatMessage } from '../chatRoot.js';
import { getMemoryEncryptionInfo } from '../nodeCrypto.js';
import { resolvers, type Context } from '../../api/graphql/schema/resolvers.js';
import { taskStallTick } from '../../jobs/taskStallEvaluator.js';

vi.mock('../../lib/bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));

const MIN = 60_000;
const T0 = new Date();
const after = (minutes: number) => new Date(T0.getTime() + minutes * MIN);
const Q = resolvers.Query as any;
const M = resolvers.Mutation as any;
const SECRET_BODY = 'the launch codes are in the blue folder';

let org: { id: string; urn: string };
let app: { id: string };
let user: { id: string };
let outsider: { id: string };
let agent: { id: string };
let channel: { id: string; memoryId: string; loc: string; chatRootNodeId: string };
const w: Record<string, { id: string }> = {};
const ctx = (userId = user.id): Context => ({ db, userId, roles: ['READER'] });

/** Dynamic, so each pin fails on its own assertion on main (the module does not exist there). */
const teamDark = () => import('./teamDark.js');
const evaluate = async (now: Date) => (await teamDark()).evaluateTeamDark(db, now);
const darkEvents = () => db.agentTeamEvent.findMany({ where: { appId: app.id, type: 'team.dark' }, orderBy: { createdAt: 'asc' } });
const recoveredEvents = () => db.agentTeamEvent.findMany({ where: { appId: app.id, type: 'team.recovered' }, orderBy: { createdAt: 'asc' } });
type Episode = { id: string; eventId: string; recoveredEventId: string | null; openedAt: Date; endedAt: Date | null };
const episodes = () => db.$queryRaw<Episode[]>`
  SELECT id, event_id AS "eventId", recovered_event_id AS "recoveredEventId", opened_at AS "openedAt", ended_at AS "endedAt"
  FROM team_dark_episodes WHERE app_id = ${app.id} ORDER BY opened_at, id`;
const health = (c = ctx()) => Q.teamHealth({}, { appRef: app.id }, c);

beforeEach(async () => {
  await cleanDb(db);
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
  org = await db.organization.create({ data: { id: generateId(), name: 'td-org', urn: `td-${suffix}.com` } });
  user = await db.user.create({ data: { id: generateId(), githubId: 97_700 + Math.floor(Math.random() * 1000), githubUsername: `td-${suffix}`, roles: ['READER'] } });
  outsider = await db.user.create({ data: { id: generateId(), githubId: 96_700 + Math.floor(Math.random() * 1000), githubUsername: `tdo-${suffix}`, roles: ['READER'] } });
  agent = await db.agent.create({ data: { id: generateId(), organizationId: org.id, name: 'Engineer', urn: `${org.urn}:engineer`, visibility: 'ORGANIZATION' } });
  app = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Team', urn: `${org.urn}:team` } });
  await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: user.id, role: 'ADMIN' } });
  await db.appMember.create({ data: { appId: app.id, userId: user.id, role: 'member' } });
  const memory = await db.memory.create({
    data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:team-shared`, name: 'shared', class: 'app', appId: app.id, sharedMemoryOfAgentId: agent.id },
  });
  const made = await ensureChannelWithRoot(db, { memoryId: memory.id, loc: 'chats:team', name: 'team', createdBy: user.id, asDefaultOfAppId: app.id });
  channel = { id: made.channel.id, memoryId: memory.id, loc: 'chats:team', chatRootNodeId: made.rootId };
  for (const [name, role] of [['Cora', 'coordinator'], ['Liam', 'engineer'], ['Tove', 'engineer']] as const) {
    w[name] = await db.worker.create({
      data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId: app.id, agentId: agent.id, name, slug: name.toLowerCase(), role, heldByUserId: user.id, heldAt: new Date() },
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
/** A live session started `startedMinAgo` minutes before T0 and last driven at `touched` (default: never since the start). */
const bind = (name: string, o: { startedMinAgo?: number; touched?: Date } = {}) => {
  const startedAt = new Date(T0.getTime() - (o.startedMinAgo ?? 120) * MIN);
  return db.session.create({ data: { id: generateId(), appId: app.id, userId: user.id, workerId: w[name].id, agentId: agent.id, type: 'DEVELOPER', startedAt, updatedAt: o.touched ?? startedAt } });
};
/** The worker checks the team channel past every message: the wake is acknowledged (a check moves the marks that make it due). */
const ackWake = async (name: string, at: Date) => {
  const where = { workerId: w[name].id, channelId: channel.id };
  const n = await db.channelReadState.updateMany({ where, data: { lastSeenSeq: 1_000_000, lastCheckedAt: at } });
  if (n.count === 0) await db.channelReadState.create({ data: { ...where, appId: app.id, lastSeenSeq: 1_000_000, lastCheckedAt: at } });
};

describe('#4531 S1 — an unacknowledged wake past the window opens one episode and one team.dark', () => {
  it('records one alarm with counts and ages only, no chain, and teamHealth shows the episode and the worker\'s age', async () => {
    await bind('Cora', { touched: after(-5) });
    await say(SECRET_BODY + ' @cora', ['cora']);
    const ids = await evaluate(after(40));
    expect(ids).toHaveLength(1);
    const [alarm] = await darkEvents();
    expect(alarm).toMatchObject({ severity: 'alarm', taskId: null, subjectWorkerId: null, episodeStart: null });
    expect(alarm.chain).toEqual([]);
    expect(JSON.stringify(alarm.payload)).not.toContain('launch codes');
    expect(await episodes()).toHaveLength(1);
    const h = await health();
    expect(h.dark).toBe(true);
    expect(new Date(h.episodeStart).getTime()).toBe(after(40).getTime());
    expect(h.windowSeconds).toBe(1800);
    const cora = h.workers.find((x: any) => x.workerId === w.Cora.id);
    // teamHealth reads at the real clock, so the wake is seconds old here: present, not null (the window judges the pass).
    expect(cora.oldestWakeAgeSeconds).toBeGreaterThanOrEqual(0);
  });

  it('the boundary is the window: exactly 30 minutes opens nothing, one pass later does', async () => {
    await bind('Cora', { touched: after(-5) });
    await say('hello @cora', ['cora']);
    expect(await evaluate(new Date(Date.now() + 29 * MIN))).toEqual([]);
    expect(await evaluate(new Date(Date.now() + 31 * MIN))).toHaveLength(1);
  });

  it('a second pass records nothing more', async () => {
    await bind('Cora', { touched: after(-5) });
    await say('hello @cora', ['cora']);
    expect(await evaluate(after(40))).toHaveLength(1);
    expect(await evaluate(after(41))).toEqual([]);
    expect(await darkEvents()).toHaveLength(1);
    expect(await episodes()).toHaveLength(1);
  });

  it('the evaluator pass (taskStallTick) runs it', async () => {
    await bind('Cora', { touched: after(-5) });
    await say('hello @cora', ['cora']);
    const r = await taskStallTick(db, after(40));
    expect(r.teamDarkRaised).toBe(1);
    expect(await darkEvents()).toHaveLength(1);
  });
});

describe('#4531 S2 — a coordinator with no turn since its session started is dark on its own account', () => {
  it('opens when the window passes while the rest of the team works', async () => {
    await bind('Cora', { startedMinAgo: 0 }); // started at T0, never driven since
    await bind('Liam', { touched: after(39) });
    expect(await evaluate(after(40))).toHaveLength(1);
    expect((await health()).dark).toBe(true);
  });

  it('a coordinator driven after its start is not dark', async () => {
    await bind('Cora', { startedMinAgo: 0, touched: after(20) });
    expect(await evaluate(after(40))).toEqual([]);
  });

  it('a NON-coordinator with no turn does not open an episode on its own', async () => {
    await bind('Liam', { startedMinAgo: 0 });
    await bind('Cora', { startedMinAgo: 0, touched: after(39) });
    expect(await evaluate(after(40))).toEqual([]);
  });

  it('the window counts from the session start: a coordinator relaunched 10 minutes ago is not yet dark', async () => {
    await bind('Cora', { startedMinAgo: -30 }); // started at T0 + 30
    expect(await evaluate(after(40))).toEqual([]);
  });
});

describe('#4531 S3 — exclusions', () => {
  it('a coordinator with a live resume claim (mid-shed) counts for nothing; an expired claim counts again', async () => {
    const s = await bind('Cora', { startedMinAgo: 0 });
    await db.resumeClaim.create({ data: { id: generateId(), appId: app.id, sessionId: s.id, workerId: w.Cora.id, holderUserId: user.id, issuedAt: after(39.5), expiresAt: after(40.5) } });
    expect(await evaluate(after(40))).toEqual([]);
    expect(await episodes()).toHaveLength(0);
    expect(await evaluate(after(41))).toHaveLength(1);
  });

  it('a consumed or revoked claim is not a shed in progress', async () => {
    const s = await bind('Cora', { startedMinAgo: 0 });
    await db.resumeClaim.create({ data: { id: generateId(), appId: app.id, sessionId: s.id, workerId: w.Cora.id, holderUserId: user.id, issuedAt: after(39.5), expiresAt: after(40.5), consumedAt: after(39.6) } });
    expect(await evaluate(after(40))).toHaveLength(1);
  });

  it('a paused coordinator and a retired coordinator are never counted', async () => {
    await bind('Cora', { startedMinAgo: 0 });
    await say('hello @cora', ['cora']);
    await db.workerWakeSettings.create({ data: { workerId: w.Cora.id, pausedUntil: after(120) } });
    expect(await evaluate(after(40))).toEqual([]);
    await db.workerWakeSettings.deleteMany({});
    await db.worker.update({ where: { id: w.Cora.id }, data: { retiredAt: after(10) } });
    expect(await evaluate(after(41))).toEqual([]);
  });

  it('server downtime is not silence: the window counts from the end of an evaluator gap', async () => {
    await bind('Cora', { touched: after(-5) });
    await say('hello @cora', ['cora']);
    await db.stallEvaluatorState.create({ data: { id: 'platform', lastPassAt: after(35), lastGapEndedAt: after(35) } });
    expect(await evaluate(after(40))).toEqual([]);
    expect(await evaluate(after(66))).toHaveLength(1); // 31 minutes after the gap's end
  });
});

describe('#4531 (b) — work is waiting while no worker has been driven', () => {
  const queued = (createdAt: Date) => db.agentTask.create({ data: { appId: app.id, title: 'Queued', ownerUserId: user.id, createdAt } });

  it('a queued task older than the window and nobody driven inside it opens an episode', async () => {
    await bind('Liam', { touched: after(-60) });
    await bind('Tove', { touched: after(-60) });
    await queued(after(-1));
    expect(await evaluate(after(40))).toHaveLength(1);
  });

  it('the same queued task with one worker driven inside the window does not', async () => {
    await bind('Liam', { touched: after(-60) });
    await bind('Tove', { touched: after(35) });
    await queued(after(-1));
    expect(await evaluate(after(40))).toEqual([]);
  });

  it('an assigned task is not queued work', async () => {
    await bind('Liam', { touched: after(-60) });
    await db.agentTask.create({ data: { appId: app.id, title: 'Held', ownerUserId: user.id, assigneeWorkerId: w.Liam.id, assignedAt: after(-1), createdAt: after(-1) } });
    expect(await evaluate(after(40))).toEqual([]);
  });

  it('a lone silent NON-coordinator with a due wake, while another worker is driven, does not make the team dark (recommended reading of the open question)', async () => {
    await bind('Tove', { touched: after(-60) });
    await bind('Liam', { touched: after(39) });
    await say('hello @tove', ['tove']);
    expect(await evaluate(after(40))).toEqual([]);
  });
});

describe('#4531 S4 — recovery', () => {
  it('records one team.recovered when the condition clears, ends the episode, and teamHealth shows none', async () => {
    await bind('Cora', { touched: after(-5) });
    await say('hello @cora', ['cora']);
    await evaluate(after(40));
    await ackWake('Cora', after(41));
    expect(await evaluate(after(42))).toEqual([]);
    const [rec] = await recoveredEvents();
    expect(rec).toMatchObject({ severity: null, chain: null, taskId: null });
    const [ep] = await episodes();
    expect(ep.endedAt?.getTime()).toBe(after(42).getTime());
    expect(ep.recoveredEventId).toBe(rec.id);
    const h = await health();
    expect(h.dark).toBe(false);
    expect(h.episodeStart).toBeNull();
    expect(await evaluate(after(43))).toEqual([]);
    expect(await recoveredEvents()).toHaveLength(1);
  });

  it('a clear-and-return is a new episode only after a full window again', async () => {
    await bind('Cora', { touched: after(-5) });
    await say('first @cora', ['cora']);
    await evaluate(after(40));
    await ackWake('Cora', after(41));
    await evaluate(after(42));
    expect(await evaluate(after(50))).toEqual([]);
    expect(await episodes()).toHaveLength(1);
  });
});

describe('#4531 S4 — one team.recovered per episode, whatever races', () => {
  it('two passes ending the same episode record exactly one team.recovered (the loser rolls its event back)', async () => {
    await bind('Cora', { touched: after(-5) });
    await say('hello @cora', ['cora']);
    await evaluate(after(40));
    const [ep] = await episodes();
    const mod = await teamDark();
    const results = await Promise.all([
      mod.recoverTeamDark(db, app.id, ep.id, ep.openedAt, { workerCount: 3 }, after(42)),
      mod.recoverTeamDark(db, app.id, ep.id, ep.openedAt, { workerCount: 3 }, after(42)),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await recoveredEvents()).toHaveLength(1);
    expect((await episodes())[0].recoveredEventId).toBe(results.find(Boolean));
  });
});

describe('#4531 S5 — the rule reads the platform\'s state, not the deliverer\'s', () => {
  it('opens even though the delivery record says every wake was delivered', async () => {
    await bind('Cora', { touched: after(-5) });
    const msg = await say('hello @cora', ['cora']);
    await db.workerDeliveryChannel.create({ data: { workerId: w.Cora.id, channelId: channel.id, deliveredThroughSeq: 1_000_000, deliveredAt: after(1) } });
    expect(msg).toBeTruthy();
    expect(await evaluate(after(40))).toHaveLength(1);
  });
});

describe('#4531 S6 — two evaluators, one alarm', () => {
  it('two concurrent passes record exactly one team.dark and one open episode', async () => {
    await bind('Cora', { touched: after(-5) });
    await say('hello @cora', ['cora']);
    const mod = await teamDark();
    const results = await Promise.all([mod.evaluateTeamDark(db, after(40)), mod.evaluateTeamDark(db, after(40))]);
    expect(results.flat()).toHaveLength(1);
    expect(await darkEvents()).toHaveLength(1);
    expect((await episodes()).filter((e) => e.endedAt === null)).toHaveLength(1);
  });

  it('raiseTeamDark itself is guarded by the database (a direct second raise inserts nothing)', async () => {
    await bind('Cora', { touched: after(-5) });
    const mod = await teamDark();
    const a = await mod.raiseTeamDark(db, app.id, { reason: 'wake-unacked', workerCount: 3, darkWorkerCount: 1, oldestWakeAgeSeconds: 2400, waitingSeconds: null }, after(40));
    const b = await mod.raiseTeamDark(db, app.id, { reason: 'wake-unacked', workerCount: 3, darkWorkerCount: 1, oldestWakeAgeSeconds: 2400, waitingSeconds: null }, after(40));
    expect([a, b].filter(Boolean)).toHaveLength(1);
    expect(await darkEvents()).toHaveLength(1);
  });
});

describe('#4531 S7 — an App with no coordinator is a valid team', () => {
  it('no coordinator by role, workers report to no one, all working: nothing is raised', async () => {
    await db.worker.update({ where: { id: w.Cora.id }, data: { role: 'engineer' } });
    await bind('Cora', { touched: after(39) });
    await bind('Liam', { touched: after(39) });
    await bind('Tove', { touched: after(39) });
    expect(await evaluate(after(40))).toEqual([]);
  });

  it('a worker is a coordinator by ROLE, not because it reports to no one: a rootless engineer with no turn raises nothing', async () => {
    await db.worker.update({ where: { id: w.Cora.id }, data: { role: 'engineer' } });
    await bind('Cora', { startedMinAgo: 0 });
    await bind('Liam', { touched: after(39) });
    expect(await evaluate(after(40))).toEqual([]);
  });

  it('a coordinator that reports to someone is still a coordinator', async () => {
    await db.worker.update({ where: { id: w.Cora.id }, data: { reportsToWorkerId: w.Liam.id } });
    await bind('Cora', { startedMinAgo: 0 });
    await bind('Liam', { touched: after(39) });
    expect(await evaluate(after(40))).toHaveLength(1);
  });

  it('the role matches in any case', async () => {
    await db.worker.update({ where: { id: w.Cora.id }, data: { role: 'Coordinator' } });
    await bind('Cora', { startedMinAgo: 0 });
    expect(await evaluate(after(40))).toHaveLength(1);
  });
});

describe('#4531 — the read gate (cor:agt:050:21, :23)', () => {
  it('an App participant reads; a stranger gets the answer for an App that does not exist, byte for byte', async () => {
    expect((await health()).dark).toBe(false);
    const stranger = await Q.teamHealth({}, { appRef: app.id }, ctx(outsider.id)).then(() => null, (e: Error) => e.message);
    const missing = await Q.teamHealth({}, { appRef: generateId() }, ctx(outsider.id)).then(() => null, (e: Error) => e.message);
    expect(stranger).not.toBeNull();
    expect(stranger).toBe(missing);
  });

  it('teamHealth lists every non-retired worker with its age, null when it has no due wake', async () => {
    await bind('Cora', { touched: after(-5) });
    const h = await health();
    expect(h.workers.map((x: any) => x.workerId).sort()).toEqual([w.Cora.id, w.Liam.id, w.Tove.id].sort());
    expect(h.workers.every((x: any) => x.oldestWakeAgeSeconds === null)).toBe(true);
  });
});

describe('#4531 — team.dark is not acknowledgeable', () => {
  it('acknowledgeAlarm refuses it, even for whoever manages the App, and nothing is stamped', async () => {
    await bind('Cora', { touched: after(-5) });
    await say('hello @cora', ['cora']);
    const [id] = await evaluate(after(40));
    await expect(M.acknowledgeAlarm({}, { eventId: id }, ctx())).rejects.toMatchObject({ extensions: { code: 'ALARM_NOT_ACKNOWLEDGEABLE' } });
    expect((await db.agentTeamEvent.findUniqueOrThrow({ where: { id } })).acknowledgedAt).toBeNull();
  });

  it('wakes nobody: the alarm has no schedule row', async () => {
    await bind('Cora', { touched: after(-5) });
    await say('hello @cora', ['cora']);
    const [id] = await evaluate(after(40));
    expect(await db.agentTeamAlarmSchedule.count({ where: { eventId: id } })).toBe(0);
  });
});
