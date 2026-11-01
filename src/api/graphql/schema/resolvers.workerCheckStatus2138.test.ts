import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
/**
 * #2138 §3.4 — the worker check status on the surfaces that read it: the team
 * roster and the single-worker read on GraphQL, and hadron_team_roster,
 * hadron_list_workers and hadron_get_worker on MCP. The rules themselves are
 * pinned in src/lib/workerCheckStatus.test.ts; this file pins the INPUTS each
 * surface feeds them: the live session, open tasks, `usesTasks`, the worker's
 * own pause, the team pause, and `lastCheckedAt` on the App's TEAM channel only.
 *
 * Every timestamp is relative to the real now, since the surfaces read the clock.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { ensureChannelWithRoot } from '../../../lib/channels.js';
import { loadPendingReasons } from '../../../lib/tickers/checkPending.js';
import { resolvers, type Context } from './resolvers.js';
import type { AuthContext } from '../../../middleware/auth.js';
import { createTestableMcpServer } from '../../../mcp/server.js';

vi.mock('../../../lib/bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));
vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({ syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }) }));

const Q = resolvers.Query as any;
const F = resolvers as any;
const MIN = 60_000;
const ago = (minutes: number) => new Date(Date.now() - minutes * MIN);
const ctx = (userId?: string): Context => ({ db, userId, roles: ['READER'] }) as Context;

let org: { id: string; urn: string };
let member: { id: string };
let outsider: { id: string };
let app: { id: string; urn: string };
let agent: { id: string };
let coordAgent: { id: string };
let teamChannel: { id: string };
let otherChannel: { id: string };
const w: Record<string, { id: string }> = {};

async function mkUser(n: number) {
  return db.user.create({
    data: { id: generateId(), githubId: 99_300 + n, githubUsername: `cs-${n}-${Date.now()}-${Math.floor(Math.random() * 1e5)}`, roles: ['READER'] },
    select: { id: true },
  });
}

beforeEach(async () => {
  await cleanDb(db);
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
  org = await db.organization.create({ data: { id: generateId(), name: 'cs-org', urn: `cs-${suffix}.com` } });
  member = await mkUser(1);
  outsider = await mkUser(2);
  agent = await db.agent.create({ data: { id: generateId(), organizationId: org.id, name: 'Engineer', urn: `${org.urn}:engineer`, visibility: 'ORGANIZATION' } });
  coordAgent = await db.agent.create({
    data: { id: generateId(), organizationId: org.id, name: 'Coordinator', urn: `${org.urn}:coordinator`, visibility: 'ORGANIZATION', usesTasks: false },
  });
  app = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Team', urn: `${org.urn}:team` } });
  await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
  await db.appMember.create({ data: { appId: app.id, userId: member.id, role: 'member' } });
  const memory = await db.memory.create({
    data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:team-shared`, name: 'shared', class: 'app', appId: app.id, sharedMemoryOfAgentId: agent.id },
  });
  teamChannel = (await ensureChannelWithRoot(db, { memoryId: memory.id, loc: 'chats:team', name: 'team', createdBy: member.id, asDefaultOfAppId: app.id })).channel;
  otherChannel = (await ensureChannelWithRoot(db, { memoryId: memory.id, loc: 'chats:other', name: 'other', createdBy: member.id })).channel;
  for (const [name, agentId] of [['Anne', agent.id], ['Kit', agent.id], ['Rook', agent.id], ['Ada', coordAgent.id]] as const) {
    w[name] = await db.worker.create({
      data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId: app.id, agentId, name, slug: name.toLowerCase(), role: 'engineer', heldByUserId: member.id },
      select: { id: true },
    });
  }
});

/** A live session for `name`, started `minutesAgo` minutes ago and driven just now. */
const bind = (name: string, minutesAgo = 60) =>
  db.session.create({
    data: { id: generateId(), appId: app.id, userId: member.id, workerId: w[name].id, agentId: agent.id, type: 'DEVELOPER', startedAt: ago(minutesAgo), updatedAt: new Date() },
  });
const assign = (name: string, minutesAgo: number) =>
  db.agentTask.create({ data: { appId: app.id, title: 'T', ownerUserId: member.id, assigneeWorkerId: w[name].id, assignedAt: ago(minutesAgo) } });
const checked = (name: string, channelId: string, minutesAgo: number) =>
  db.channelReadState.create({ data: { workerId: w[name].id, appId: app.id, channelId, lastSeenSeq: 0, lastCheckedAt: ago(minutesAgo) } });

async function rosterStatus(name: string, userId = member.id) {
  const r = await Q.teamRoster({}, { appRef: app.id }, ctx(userId));
  const e = r.workers.find((x: { name: string }) => x.name === name);
  return F.TeamRosterEntry.checkStatus(e, {}, ctx(userId));
}
async function workerStatus(name: string, userId = member.id) {
  const worker = await Q.worker({}, { ref: w[name].id }, ctx(userId));
  return F.Worker.checkStatus(worker, {}, ctx(userId));
}

describe('the status on the roster and on worker get (they agree)', () => {
  it('NO_SESSION: never bound', async () => {
    expect(await rosterStatus('Anne')).toMatchObject({ status: 'NO_SESSION', pendingReason: null, lastCheckedAt: null });
    expect(await workerStatus('Anne')).toMatchObject({ status: 'NO_SESSION', pendingReason: null, lastCheckedAt: null });
  });

  it('PENDING NO_TASK: bound, no open task', async () => {
    await bind('Rook');
    expect(await rosterStatus('Rook')).toMatchObject({ status: 'PENDING', pendingReason: 'NO_TASK' });
    expect(await workerStatus('Rook')).toMatchObject({ status: 'PENDING', pendingReason: 'NO_TASK' });
  });

  it('a finished or cancelled task is not a task', async () => {
    await bind('Rook');
    await db.agentTask.create({ data: { appId: app.id, title: 'done', ownerUserId: member.id, assigneeWorkerId: w.Rook.id, assignedAt: ago(5), status: 'finished', startedAt: ago(4), finishedAt: ago(1), resultOutcome: 'done' } });
    await db.agentTask.create({ data: { appId: app.id, title: 'gone', ownerUserId: member.id, assigneeWorkerId: w.Rook.id, assignedAt: ago(5), status: 'cancelled', cancelledAt: ago(1) } });
    expect(await rosterStatus('Rook')).toMatchObject({ status: 'PENDING', pendingReason: 'NO_TASK' });
  });

  it('OK: a fresh assignment to a worker that never checked', async () => {
    await bind('Kit', 120);
    await assign('Kit', 2);
    expect(await rosterStatus('Kit')).toMatchObject({ status: 'OK', pendingReason: null, lastCheckedAt: null });
    expect(await workerStatus('Kit')).toMatchObject({ status: 'OK', pendingReason: null, lastCheckedAt: null });
  });

  it('OVERDUE: assigned and checked long ago, and lastCheckedAt is reported', async () => {
    await bind('Kit', 300);
    await assign('Kit', 200);
    await checked('Kit', teamChannel.id, 40);
    const s = await rosterStatus('Kit');
    expect(s.status).toBe('OVERDUE');
    expect(Math.abs(new Date(s.lastCheckedAt).getTime() - ago(40).getTime())).toBeLessThan(5_000);
    expect((await workerStatus('Kit')).status).toBe('OVERDUE');
  });

  it('only the TEAM channel counts: a fresh check on another channel leaves the worker OVERDUE', async () => {
    await bind('Kit', 300);
    await assign('Kit', 200);
    await checked('Kit', teamChannel.id, 40);
    await checked('Kit', otherChannel.id, 1);
    expect((await rosterStatus('Kit')).status).toBe('OVERDUE');
    expect((await workerStatus('Kit')).status).toBe('OVERDUE');
  });

  it('a fresh check on the team channel makes it OK', async () => {
    await bind('Kit', 300);
    await assign('Kit', 200);
    await checked('Kit', teamChannel.id, 3);
    expect((await rosterStatus('Kit')).status).toBe('OK');
  });

  it('usesTasks: false counts as having a task, with none assigned', async () => {
    await bind('Ada', 300);
    expect((await rosterStatus('Ada')).status).toBe('OVERDUE');
    await checked('Ada', teamChannel.id, 2);
    expect((await rosterStatus('Ada')).status).toBe('OK');
  });

  it('the App\'s own settings decide the limit', async () => {
    await bind('Kit', 300);
    await assign('Kit', 200);
    await checked('Kit', teamChannel.id, 15);
    expect((await rosterStatus('Kit')).status).toBe('OK'); // 15 min < 25 min at the defaults
    await db.app.update({ where: { id: app.id }, data: { deliveryCheckPeriodSeconds: 120, deliveryFailedChecksToOverdue: 3 } });
    expect((await rosterStatus('Kit')).status).toBe('OVERDUE'); // 15 min > 11 min
  });

  it('PENDING PAUSED by the worker\'s own pause, TEAM_PAUSED by a team pause', async () => {
    await bind('Kit', 300);
    await assign('Kit', 200);
    await checked('Kit', teamChannel.id, 90);
    await db.workerWakeSettings.create({ data: { workerId: w.Kit.id, pausedUntil: new Date(Date.now() + 30 * MIN) } });
    expect(await rosterStatus('Kit')).toMatchObject({ status: 'PENDING', pendingReason: 'PAUSED' });
    await db.workerWakeSettings.update({ where: { workerId: w.Kit.id }, data: { pausedUntil: null } });
    expect((await rosterStatus('Kit')).status).toBe('OVERDUE');
    await db.app.update({ where: { id: app.id }, data: { teamPausedAt: ago(10) } });
    expect(await rosterStatus('Kit')).toMatchObject({ status: 'PENDING', pendingReason: 'TEAM_PAUSED' });
    expect(await workerStatus('Kit')).toMatchObject({ status: 'PENDING', pendingReason: 'TEAM_PAUSED' });
  });

  it('lifting a team pause (setTeamPause false) restarts the clock: a stale worker is OK the moment it lifts, then OVERDUE again once the clock runs out', async () => {
    await bind('Kit', 300);
    await assign('Kit', 200);
    await checked('Kit', teamChannel.id, 90);
    expect((await rosterStatus('Kit')).status).toBe('OVERDUE');
    await db.app.update({ where: { id: app.id }, data: { teamPausedAt: ago(60 * MIN) } });
    expect(await rosterStatus('Kit')).toMatchObject({ status: 'PENDING', pendingReason: 'TEAM_PAUSED' });
    await db.app.update({ where: { id: app.id }, data: { teamPausedAt: null, teamResumedAt: new Date() } }); // what setTeamPause(false) writes
    expect((await rosterStatus('Kit')).status).toBe('OK');
    await db.app.update({ where: { id: app.id }, data: { teamResumedAt: ago(30 * MIN) } });
    expect((await rosterStatus('Kit')).status).toBe('OVERDUE');
  });

  it('the reason is the ticker\'s own (loadPendingReasons): isolation, and team pause over own pause over isolation', async () => {
    await bind('Kit', 300);
    await assign('Kit', 200);
    const soon = new Date(Date.now() + 30 * MIN);
    const tickerSays = async () => (await loadPendingReasons(db, app.id, [w.Kit.id], new Date())).get(w.Kit.id);
    await db.workerWakeSettings.create({ data: { workerId: w.Kit.id, isolatedUntil: soon } });
    expect(await rosterStatus('Kit')).toMatchObject({ status: 'PENDING', pendingReason: 'ISOLATED' });
    expect(await tickerSays()).toBe('ISOLATED');
    await db.workerWakeSettings.update({ where: { workerId: w.Kit.id }, data: { pausedUntil: soon } });
    expect((await rosterStatus('Kit')).pendingReason).toBe('PAUSED');
    expect(await tickerSays()).toBe('PAUSED');
    await db.app.update({ where: { id: app.id }, data: { teamPausedAt: ago(10) } });
    expect((await rosterStatus('Kit')).pendingReason).toBe('TEAM_PAUSED');
    expect(await tickerSays()).toBe('TEAM_PAUSED');
  });
});

describe('end to end with §3.1 stamping', () => {
  it('a read of the team channel through the worker\'s own session turns OVERDUE into OK; another reader\'s read does not', async () => {
    const session = await bind('Kit', 300);
    await assign('Kit', 200);
    await checked('Kit', teamChannel.id, 40);
    expect((await rosterStatus('Kit')).status).toBe('OVERDUE');
    // A person reading the channel (no worker session) is not the worker checking.
    await Q.teamChatMessages({}, { appRef: app.id }, ctx(member.id));
    expect((await rosterStatus('Kit')).status).toBe('OVERDUE');
    // The worker's own read: the request carries its session (as the CLI and MCP send it).
    await Q.teamChatMessages({}, { appRef: app.id }, { ...ctx(member.id), sessionId: session.id });
    expect(await rosterStatus('Kit')).toMatchObject({ status: 'OK', pendingReason: null });
  });
});

describe('who may read it', () => {
  it('worker get masks it to null for someone outside the App', async () => {
    await bind('Kit');
    const worker = await db.worker.findUniqueOrThrow({ where: { id: w.Kit.id } });
    expect(await F.Worker.checkStatus(worker, {}, ctx(outsider.id))).toBeNull();
  });
});
