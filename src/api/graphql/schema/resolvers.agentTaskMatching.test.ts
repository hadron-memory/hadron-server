import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
/**
 * #1707 — the team roster (plan design:agent-tasks §7.4), on GraphQL and MCP:
 * each derived state on its own, the order when several hold, the read
 * audience, and that a worker is rendered as a sanitized party.
 *
 * The roster reads the wall clock, so every timestamp here is relative to the
 * real now.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GraphQLError } from 'graphql';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { serveEveryAgent } from '../../../test/servedBootPrompt.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';
import type { AuthContext } from '../../../middleware/auth.js';
import { createTestableMcpServer } from '../../../mcp/server.js';
import { taskStallTick } from '../../../jobs/taskStallEvaluator.js';
import { registerHost } from '../../../lib/agentTasks/hosts.js';
import { rosterState } from '../../../lib/agentTasks/roster.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

const M = resolvers.Mutation as any;
const Q = resolvers.Query as any;
const F = resolvers as any;
const MIN = 60_000;
const ago = (minutes: number) => new Date(Date.now() - minutes * MIN);

const ctx = (userId?: string): Context => ({ db, userId, roles: ['READER'] });

let app: { id: string };
let appUrn: string;
let agentId: string;
let admin: { id: string };
let mia: { id: string };
let outsider: { id: string };
const w: Record<string, { id: string }> = {};

beforeEach(async () => {
  await cleanDb(db);
  const n = Math.floor(Math.random() * 1_000_000);
  const org = await db.organization.create({ data: { name: 'Roster', urn: `roster-${n}.example` } });
  admin = await db.user.create({ data: { githubId: 610_000 + n, githubUsername: `ro-admin-${n}`, roles: ['READER'] } });
  mia = await db.user.create({ data: { githubId: 620_000 + n, githubUsername: `ro-mia-${n}`, roles: ['READER'] } });
  outsider = await db.user.create({ data: { githubId: 630_000 + n, githubUsername: `ro-out-${n}`, roles: ['READER'] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  const agent = await M.createAgent({}, { orgId: org.id, name: 'Team Agent' }, ctx(admin.id));
  agentId = agent.id;
  appUrn = `roster-${n}.example:team`;
  app = await db.app.create({ data: { organizationId: org.id, name: 'Team', urn: appUrn }, select: { id: true } });
  await db.appMember.create({ data: { appId: app.id, userId: mia.id, role: 'member' } });
  for (const name of ['Anne', 'Rook', 'Kit']) {
    w[name] = await db.worker.create({
      data: { ...WORKER_SIGNATURE_DEFAULTS, appId: app.id, agentId, name, slug: name.toLowerCase(), role: 'engineer', heldByUserId: mia.id },
      select: { id: true },
    });
  }
  await serveEveryAgent(db); // #2712: binds are served the Agent's boot prompt
});

/** Bind a worker in a session of `family`, driven `minutesAgo` minutes ago. */
const bind = (name: string, family: string | null, minutesAgo = 0) =>
  db.session.create({
    data: { id: generateId(), appId: app.id, workerId: w[name].id, agentId, family, startedAt: ago(minutesAgo), updatedAt: ago(minutesAgo) },
  });

const task = (data: Record<string, unknown>) =>
  db.agentTask.create({ data: { appId: app.id, title: 'T', ownerUserId: mia.id, ...data }, select: { id: true } });

async function roster(userId = mia.id) {
  return Q.teamRoster({}, { appRef: app.id }, ctx(userId));
}
async function entry(name: string) {
  const r = await roster();
  return r.workers.find((e: { name: string }) => e.name === name);
}

describe('teamRoster — each state on its own (plan §7.4)', () => {
  it('NOT_LAUNCHABLE: unbound, and no live host registers it', async () => {
    expect((await entry('Kit')).state).toBe('NOT_LAUNCHABLE');
  });

  it('AVAILABLE: bound with a family and free for work', async () => {
    await bind('Kit', 'codex');
    expect(await entry('Kit')).toMatchObject({ state: 'AVAILABLE', bound: true, family: 'codex', free: true, freeFamilies: ['codex'] });
  });

  it('AVAILABLE with a QUIET binding: bound, family kept, liveSession false (#1723 review, Diego P2-2)', async () => {
    await bind('Kit', 'codex', 25 * 60);
    expect(await entry('Kit')).toMatchObject({ state: 'AVAILABLE', bound: true, liveSession: false, family: 'codex' });
  });

  it('AVAILABLE: unbound, but a live host can launch it (free for work, cor:agt:060:04 / :05)', async () => {
    await registerHost(db, { appId: app.id, hostId: 'orca1', label: 'orca1', pollIntervalSeconds: 60, workers: [{ workerId: w.Kit.id, family: 'glm', worktrees: ['repo/kit'] }] });
    expect(await entry('Kit')).toMatchObject({ state: 'AVAILABLE', bound: false, family: null, launchableFamilies: ['glm'], freeFamilies: ['glm'] });
  });

  it('NO_FAMILY: bound, but its session reported no model family', async () => {
    await bind('Kit', null);
    expect((await entry('Kit')).state).toBe('NO_FAMILY');
  });

  it('ASSIGNED_NOT_STARTED: the assignee of a pending task', async () => {
    await bind('Kit', 'codex');
    const t = await task({ assigneeWorkerId: w.Kit.id, assignedAt: new Date() });
    expect(await entry('Kit')).toMatchObject({ state: 'ASSIGNED_NOT_STARTED', pendingTaskIds: [t.id], free: false });
  });

  it('WORKING: the assignee of a started task', async () => {
    await bind('Kit', 'codex');
    const t = await task({ assigneeWorkerId: w.Kit.id, assignedAt: ago(10), status: 'started', startedAt: ago(9) });
    expect(await entry('Kit')).toMatchObject({ state: 'WORKING', startedTaskIds: [t.id] });
  });

  it('WAITING: a started task with an open child; shows on what and since when', async () => {
    await bind('Kit', 'codex');
    const parent = await task({ assigneeWorkerId: w.Kit.id, assignedAt: ago(30), status: 'started', startedAt: ago(29) });
    const child = await db.agentTask.create({
      data: { appId: app.id, title: 'child', parentTaskId: parent.id, ownerWorkerId: w.Kit.id, assigneeWorkerId: w.Rook.id, assignedAt: ago(20), createdAt: ago(20) },
    });
    expect(await entry('Kit')).toMatchObject({ state: 'WAITING', waitingOnTaskIds: [child.id], waitingSince: child.createdAt });
  });

  it('UNAVAILABLE: its own record (reason and until shown)', async () => {
    await bind('Kit', 'codex');
    const until = new Date(Date.now() + 3_600_000);
    await db.workerAvailability.create({
      data: { workerId: w.Kit.id, state: 'unavailable', reason: 'out-of-tokens', until, setAt: new Date(), setBy: 'holder', setByUserId: mia.id },
    });
    expect(await entry('Kit')).toMatchObject({ state: 'UNAVAILABLE', unavailable: { reason: 'out-of-tokens', until } });
  });

  it('UNAVAILABLE: every family it can run as is unavailable in the App', async () => {
    await bind('Kit', 'codex');
    await db.modelFamilyAvailability.create({
      data: { appId: app.id, family: 'codex', state: 'unavailable', reason: 'other', setAt: new Date(), setByUserId: admin.id },
    });
    expect(await entry('Kit')).toMatchObject({ state: 'UNAVAILABLE', unavailable: null, unavailableFamilies: ['codex'] });
  });

  it('YOUR_MOVE: woken on an unacknowledged alarm; the stalled assignee reads UNAVAILABLE', async () => {
    // Anne owns a task assigned to Rook 20 minutes ago that never started: a
    // not-started alarm, which wakes Anne and marks Rook stalled.
    await bind('Rook', 'claude', 25);
    await db.agentTask.create({
      data: { appId: app.id, title: 'Review', ownerWorkerId: w.Anne.id, assigneeWorkerId: w.Rook.id, assignedAt: ago(20), createdAt: ago(20) },
    });
    expect((await taskStallTick(db)).raised).toBe(1);
    const alarm = await db.agentTeamEvent.findFirstOrThrow({ where: { severity: 'alarm' } });
    expect(await entry('Anne')).toMatchObject({ state: 'YOUR_MOVE', alarmEventIds: [alarm.id] });
    expect(await entry('Rook')).toMatchObject({ state: 'UNAVAILABLE', unavailable: { reason: 'stalled' } });
    // Acknowledged, it is no longer Anne's move.
    await db.agentTeamEvent.update({ where: { id: alarm.id }, data: { acknowledgedAt: new Date(), acknowledgedByUserId: mia.id } });
    expect((await entry('Anne')).state).toBe('NOT_LAUNCHABLE');
  });

  it('YOUR_MOVE only for an owner already woken: a higher owner not yet due is not', async () => {
    // #2200: the alarm's episode start is the task's assignment, to the millisecond (the key the live classification reads).
    const assignedAt = ago(30);
    const t = await db.agentTask.create({
      data: { appId: app.id, title: 'Review', ownerWorkerId: w.Anne.id, assigneeWorkerId: w.Rook.id, assignedAt, createdAt: assignedAt },
    });
    const alarm = await db.agentTeamEvent.create({
      data: {
        appId: app.id, taskId: t.id, type: 'stall.not-started', severity: 'alarm', episodeStart: assignedAt,
        chain: [{ workerId: w.Anne.id }, { workerId: w.Kit.id }], payload: { windowMinutes: 15 },
      },
    });
    await db.agentTeamAlarmSchedule.createMany({
      data: [
        { eventId: alarm.id, chainIndex: 0, dueAt: ago(15), wokenAt: ago(15) },
        { eventId: alarm.id, chainIndex: 1, dueAt: new Date(Date.now() + 15 * MIN) },
      ],
    });
    expect(await entry('Anne')).toMatchObject({ state: 'YOUR_MOVE', alarmEventIds: [alarm.id] });
    expect(await entry('Kit')).toMatchObject({ state: 'NOT_LAUNCHABLE', alarmEventIds: [] });
  });

  it('YOUR_MOVE: a child of its task finished after it last moved (cor:agt:050:16)', async () => {
    await bind('Kit', 'codex', 40);
    const parent = await task({ assigneeWorkerId: w.Kit.id, assignedAt: ago(50), status: 'started', startedAt: ago(45) });
    const child = await db.agentTask.create({
      data: {
        appId: app.id, title: 'child', parentTaskId: parent.id, ownerWorkerId: w.Kit.id, assigneeWorkerId: w.Rook.id,
        assignedAt: ago(44), status: 'finished', startedAt: ago(43), finishedAt: ago(5), resultOutcome: 'succeeded',
      },
    });
    expect(await entry('Kit')).toMatchObject({ state: 'YOUR_MOVE', unreactedChildTaskId: child.id });
    // Once Kit moves (drives its session) after the finish, it is just working.
    await bind('Kit', 'codex', 1);
    expect(await entry('Kit')).toMatchObject({ state: 'WORKING', unreactedChildTaskId: null });
  });

  it('YOUR_MOVE: the CHILD OWNER\'s move, not the parent assignee\'s, after a reassignment (#1831)', async () => {
    await bind('Kit', 'codex', 40);
    await bind('Rook', 'codex', 1);
    const parent = await task({ assigneeWorkerId: w.Rook.id, assignedAt: ago(30), status: 'started', startedAt: ago(29) });
    const child = await db.agentTask.create({
      data: {
        appId: app.id, title: 'child', parentTaskId: parent.id, ownerWorkerId: w.Kit.id, assigneeWorkerId: w.Anne.id,
        assignedAt: ago(44), status: 'finished', startedAt: ago(43), finishedAt: ago(5), resultOutcome: 'succeeded',
      },
    });
    expect(await entry('Kit')).toMatchObject({ state: 'YOUR_MOVE', unreactedChildTaskId: child.id });
    expect(await entry('Rook')).toMatchObject({ unreactedChildTaskId: null });
  });

  it('YOUR_MOVE: a worker child owner still sees it when the parent is reassigned to a PERSON (#1831, Anne P2)', async () => {
    await bind('Kit', 'codex', 40);
    const parent = await task({ assigneeUserId: mia.id, assignedAt: ago(30), status: 'started', startedAt: ago(29) });
    const child = await db.agentTask.create({
      data: {
        appId: app.id, title: 'child', parentTaskId: parent.id, ownerWorkerId: w.Kit.id, assigneeWorkerId: w.Anne.id,
        assignedAt: ago(44), status: 'finished', startedAt: ago(43), finishedAt: ago(5), resultOutcome: 'succeeded',
      },
    });
    expect(await entry('Kit')).toMatchObject({ state: 'YOUR_MOVE', unreactedChildTaskId: child.id });
  });

  it('YOUR_MOVE: a cancelled child counts the same (#1760)', async () => {
    await bind('Kit', 'codex', 40);
    const parent = await task({ assigneeWorkerId: w.Kit.id, assignedAt: ago(50), status: 'started', startedAt: ago(45) });
    const child = await db.agentTask.create({
      data: {
        appId: app.id, title: 'child', parentTaskId: parent.id, ownerWorkerId: w.Kit.id, assigneeWorkerId: w.Rook.id,
        assignedAt: ago(44), status: 'cancelled', cancelledAt: ago(5),
      },
    });
    expect(await entry('Kit')).toMatchObject({ state: 'YOUR_MOVE', unreactedChildTaskId: child.id });
  });
});

describe('teamRoster — order, audience, shape', () => {
  it('the first state that holds wins, in the documented order', () => {
    const none = { alarmEventIds: [], unreactedChildTaskId: null, unavailable: false, waiting: false, started: false, pending: false, free: false, bound: false };
    expect(rosterState({ ...none, alarmEventIds: ['a'], unavailable: true, started: true })).toBe('YOUR_MOVE');
    expect(rosterState({ ...none, unavailable: true, pending: true })).toBe('UNAVAILABLE');
    expect(rosterState({ ...none, unavailable: true, waiting: true, started: true })).toBe('UNAVAILABLE');
    expect(rosterState({ ...none, waiting: true, started: true })).toBe('WAITING');
    expect(rosterState({ ...none, started: true, pending: true })).toBe('WORKING');
    expect(rosterState({ ...none, pending: true, bound: true })).toBe('ASSIGNED_NOT_STARTED');
    expect(rosterState({ ...none, free: true })).toBe('AVAILABLE');
    expect(rosterState({ ...none, bound: true })).toBe('NO_FAMILY');
    expect(rosterState(none)).toBe('NOT_LAUNCHABLE');
  });

  it('every worker that is not retired, by name; the worker is a sanitized party with its URN', async () => {
    await db.worker.update({ where: { id: w.Rook.id }, data: { retiredAt: new Date() } });
    const r = await roster();
    expect(r.appId).toBe(app.id);
    expect(r.workers.map((e: { name: string }) => e.name)).toEqual(['Anne', 'Kit']);
    const party = F.TeamRosterEntry.worker(r.workers[0]);
    expect(party).toEqual({ kind: 'WORKER', id: w.Anne.id, name: 'Anne', urn: `hrn:worker:${appUrn.replace(':team', '')}:team:anne` });
  });

  it('reads with the App\'s task audience: an outsider gets APP_NOT_FOUND, like an absent App', async () => {
    await expect(roster(outsider.id)).rejects.toSatisfy(
      (e: unknown) => e instanceof GraphQLError && e.extensions?.code === 'APP_NOT_FOUND',
    );
  });
});
