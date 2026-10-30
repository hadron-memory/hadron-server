/**
 * #2014 — a worker's team-chat posts are rate limited (10 per minute, 60 per hour, across every Channel), and the first
 * refusal in an hour raises one `alarm.post-limit` through the task-less alarm seam #2755 built.
 *
 * The refusal is TEAM_CHAT_POST_RATE_LIMITED, naming the limit and when it resets, and writes no message. The alarm (its
 * event, its one-open-episode row and its wake schedule) COMMITS even though the post is refused. A human post is not
 * limited and raises nothing.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { ensureChannelWithRoot } from '../../../lib/channels.js';
import { runAsActor } from '../../../lib/requestActor.js';
import { raisePostLimitAlarm } from '../../../lib/agentTasks/postLimit.js';
import { pendingTaskWakes } from '../../../lib/agentTasks/taskWakes.js';
import { type Context } from './resolvers.js';
import { teamChatMutations } from './resolvers.teamChat.js';
import { resolvers } from './resolvers.js';

vi.mock('../../../lib/bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));
vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({ syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }) }));

const M = resolvers.Mutation as any;
const ctx = (userId?: string): Context => ({ db, userId, roles: ['READER'] }) as Context;
const MIN = 60_000;

type W = { id: string; name: string; holder: string; session: string };

let org: { id: string; urn: string };
let manager: { id: string };
let holderA: { id: string };
let holderB: { id: string };
let app: { id: string };
let agent: { id: string };
let memory: { id: string };
let channel: { id: string; memoryId: string };
let other: { id: string; memoryId: string };
let liam: W;
let rook: W;
let boss: W;

async function mkUser(n: number) {
  return db.user.create({ data: { id: generateId(), githubId: 98_800 + n, githubUsername: `pl-${n}-${Date.now()}-${Math.floor(Math.random() * 1e5)}`, roles: ['READER'] }, select: { id: true } });
}
async function mkWorker(name: string, holder: string, reportsTo?: string): Promise<W> {
  const w = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId: app.id, agentId: agent.id, name, slug: name.toLowerCase(), heldByUserId: holder, heldAt: new Date(), reportsToWorkerId: reportsTo ?? null }, select: { id: true, name: true } });
  await db.registerEntry.create({ data: { id: generateId(), appId: app.id, channelId: channel.id, attendeeWorkerId: w.id, role: 'BOTH' } });
  const session = (await db.session.create({ data: { id: generateId(), appId: app.id, userId: holder, workerId: w.id, agentId: agent.id, type: 'DEVELOPER', startedAt: new Date() } })).id;
  return { ...w, holder, session };
}

const humanSays = (userId: string, body: string) => teamChatMutations.createTeamChatMessage({}, { appRef: app.id, body, replyToSeq: null, sessionRef: null }, ctx(userId));
const workerSays = (w: W, body: string) =>
  runAsActor({ workerId: w.id, agentId: agent.id }, () => teamChatMutations.createTeamChatMessage({}, { appRef: app.id, body, replyToSeq: null, sessionRef: w.session }, ctx(w.holder)));
const workerSaysIn = (w: W, ch: { id: string }, body: string) =>
  runAsActor({ workerId: w.id, agentId: agent.id }, () => M.createChannelMessage({}, { channelRef: ch.id, body, replyToSeq: null, sessionRef: w.session }, ctx(w.holder)));

/** Move every message of the worker back in time by `ms` (they were posted just now). */
const age = (w: W, ms: number) =>
  db.node.updateMany({ where: { nodeType: 'chat-message', createdByWorkerId: w.id }, data: { createdAt: new Date(Date.now() - ms) } });
const post = async (w: W, n: number, tag: string) => { for (let i = 0; i < n; i++) await workerSays(w, `${tag} ${i}`); };
const messageCount = () => db.node.count({ where: { nodeType: 'chat-message' } });
const alarms = () => db.agentTeamEvent.findMany({ where: { type: 'alarm.post-limit' } });

beforeEach(async () => {
  await cleanDb(db);
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
  org = await db.organization.create({ data: { id: generateId(), name: 'pl-org', urn: `pl-org-${suffix}.com` } });
  [manager, holderA, holderB] = [await mkUser(1), await mkUser(2), await mkUser(3)];
  await db.orgMember.create({ data: { id: generateId(), organizationId: org.id, userId: manager.id, role: 'ADMIN' } });
  agent = await db.agent.create({ data: { id: generateId(), organizationId: org.id, name: 'Team', urn: `${org.urn}:team`, visibility: 'ORGANIZATION' } });
  app = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Team', urn: `${org.urn}:team` } });
  await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
  for (const u of [manager, holderA, holderB]) await db.appMember.create({ data: { appId: app.id, userId: u.id, role: 'member' } });
  memory = await db.memory.create({ data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:team-shared`, name: 'shared', class: 'app', appId: app.id, sharedMemoryOfAgentId: agent.id } });
  const made = await ensureChannelWithRoot(db, { memoryId: memory.id, loc: 'chats:team', name: 'team', createdBy: manager.id, asDefaultOfAppId: app.id });
  channel = { id: made.channel.id, memoryId: memory.id };
  const madeOther = await ensureChannelWithRoot(db, { memoryId: memory.id, loc: 'chats:release', name: 'release', createdBy: manager.id });
  other = { id: madeOther.channel.id, memoryId: memory.id };
  boss = await mkWorker('Boss', holderB.id);
  liam = await mkWorker('Liam', holderA.id, boss.id);
  rook = await mkWorker('Rook', holderB.id);
});

describe('#2014 the limit', () => {
  it('admits ten posts in a minute and refuses the eleventh, naming the limit and the reset, storing nothing', async () => {
    await post(liam, 10, 'a');
    const before = await messageCount();
    const err: any = await workerSays(liam, 'eleventh').catch((e) => e);
    expect(err.extensions).toMatchObject({ code: 'TEAM_CHAT_POST_RATE_LIMITED', limit: '10 per minute' });
    expect(new Date(err.extensions.resetsAt).getTime()).toBeGreaterThan(Date.now());
    expect(err.message).toMatch(/10 per minute/);
    expect(await messageCount()).toBe(before);
  });

  it('counts across Channels', async () => {
    await post(liam, 5, 'a');
    for (let i = 0; i < 5; i++) await workerSaysIn(liam, other, `b ${i}`);
    await expect(workerSays(liam, 'x')).rejects.toMatchObject({ extensions: { code: 'TEAM_CHAT_POST_RATE_LIMITED' } });
  });

  it('a post older than a minute no longer counts toward the minute', async () => {
    await post(liam, 10, 'a');
    await age(liam, 61_000);
    await expect(workerSays(liam, 'fresh')).resolves.toBeTruthy();
  });

  it('refuses the 61st post in an hour with the hourly limit named', async () => {
    for (let round = 0; round < 6; round++) { await post(liam, 10, `r${round}`); await age(liam, 2 * MIN + round); }
    const err: any = await workerSays(liam, 'sixty-first').catch((e) => e);
    expect(err.extensions).toMatchObject({ code: 'TEAM_CHAT_POST_RATE_LIMITED', limit: '60 per hour' });
  });

  it('is per worker: another worker is unaffected', async () => {
    await post(liam, 10, 'a');
    await expect(workerSays(rook, 'hello')).resolves.toBeTruthy();
  });

  it('does not limit a human post, and a human raises no alarm', async () => {
    for (let i = 0; i < 15; i++) await humanSays(manager.id, `h ${i}`);
    expect(await alarms()).toHaveLength(0);
  });
});

describe('#2014 the alarm', () => {
  it('the first refusal commits one alarm to the reporting line, with an episode and a wake for the nearest owner', async () => {
    await post(liam, 10, 'a');
    await expect(workerSays(liam, 'x')).rejects.toMatchObject({ extensions: { code: 'TEAM_CHAT_POST_RATE_LIMITED' } });
    const events = await alarms();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ severity: 'alarm', subjectWorkerId: liam.id, taskId: null, appId: app.id });
    expect((events[0]!.chain as any[])[0]).toEqual({ workerId: boss.id });
    expect(await db.postLimitEpisode.count({ where: { workerId: liam.id, endedAt: null } })).toBe(1);
    const sched = await db.agentTeamAlarmSchedule.findMany({ where: { eventId: events[0]!.id }, orderBy: { chainIndex: 'asc' } });
    expect(sched[0]!.wokenAt).not.toBeNull();
  });

  it('a second refusal in the same hour raises nothing more', async () => {
    await post(liam, 10, 'a');
    for (let i = 0; i < 3; i++) await workerSays(liam, `x${i}`).catch(() => undefined);
    expect(await alarms()).toHaveLength(1);
  });

  it('a refusal after the hour opens a new episode and a new alarm; the old episode is closed an hour after it opened', async () => {
    await post(liam, 10, 'a');
    await workerSays(liam, 'x').catch(() => undefined);
    await db.postLimitEpisode.updateMany({ data: { openedAt: new Date(Date.now() - 61 * MIN) } });
    await workerSays(liam, 'y').catch(() => undefined);
    expect(await alarms()).toHaveLength(2);
    const eps = await db.postLimitEpisode.findMany({ orderBy: { openedAt: 'asc' } });
    expect(eps).toHaveLength(2);
    expect(eps[0]!.endedAt!.getTime() - eps[0]!.openedAt.getTime()).toBe(60 * MIN);
    expect(eps[1]!.endedAt).toBeNull();
  });

  it('two concurrent over-limit posts raise exactly one alarm', async () => {
    await post(liam, 10, 'a');
    const results = await Promise.allSettled([workerSays(liam, 'p'), workerSays(liam, 'q'), workerSays(liam, 'r')]);
    expect(results.every((r) => r.status === 'rejected')).toBe(true);
    expect(await alarms()).toHaveLength(1);
    expect(await db.postLimitEpisode.count()).toBe(1);
  });

  it('the partial unique index allows only one open episode per worker', async () => {
    await post(liam, 10, 'a');
    await workerSays(liam, 'x').catch(() => undefined);
    const ev = await db.agentTeamEvent.create({ data: { id: generateId(), appId: app.id, type: 'alarm.post-limit', subjectWorkerId: liam.id, severity: 'alarm', chain: [], payload: {} } });
    await expect(db.postLimitEpisode.create({ data: { appId: app.id, workerId: liam.id, eventId: ev.id, openedAt: new Date() } })).rejects.toBeTruthy();
  });

  it('with no reporting line and no manager worker the alarm is still recorded and the refusal still returned', async () => {
    await post(rook, 10, 'a');
    await expect(workerSays(rook, 'x')).rejects.toMatchObject({ extensions: { code: 'TEAM_CHAT_POST_RATE_LIMITED' } });
    expect(await alarms()).toHaveLength(1);
  });

  it('is delivered to the nearest owner with handle LIMIT, and stops on acknowledgement', async () => {
    await post(liam, 10, 'a');
    await workerSays(liam, 'x').catch(() => undefined);
    const wakes = (await pendingTaskWakes(db, [boss.id], new Date())).get(boss.id) ?? [];
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toMatchObject({ event: 'ALARM', handle: 'LIMIT' });
    expect(wakes[0]!.title).toMatch(/Liam hit the team-chat post limit/);
    await db.agentTeamEvent.updateMany({ where: { type: 'alarm.post-limit' }, data: { acknowledgedAt: new Date(), acknowledgedByWorkerId: boss.id } });
    expect((await pendingTaskWakes(db, [boss.id], new Date())).get(boss.id) ?? []).toHaveLength(0);
  });

  it('raises nothing for a retired worker, an uninstalled App or a soft-deleted App', async () => {
    await db.worker.update({ where: { id: rook.id }, data: { retiredAt: new Date() } });
    expect(await raisePostLimitAlarm(db, rook.id, '10 per minute')).toBeNull();
    await db.app.update({ where: { id: app.id }, data: { uninstalledAt: new Date() } });
    expect(await raisePostLimitAlarm(db, liam.id, '10 per minute')).toBeNull();
    await db.app.update({ where: { id: app.id }, data: { uninstalledAt: null, deletedAt: new Date() } });
    expect(await raisePostLimitAlarm(db, liam.id, '10 per minute')).toBeNull();
    expect(await alarms()).toHaveLength(0);
  });
});
