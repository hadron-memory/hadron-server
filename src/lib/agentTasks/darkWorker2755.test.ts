/**
 * #2755 — the dark-worker alarm, OVERDUE trigger: one task-less alarm per worker per episode, who it is for, and
 * the exceptions (NO_SESSION and the pause-type PENDING reasons). The unacked-wake trigger is pinned in
 * darkWorkerWake2755.test.ts. Every timestamp is relative to a fixed `now` passed to the evaluator.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../id.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../workerSignature.js';
import { ensureChannelWithRoot } from '../channels.js';
import { evaluateDarkWorkers } from './darkWorker.js';

vi.mock('../../lib/bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));

const MIN = 60_000;
const NOW = new Date('2026-10-29T12:00:00.000Z');
const at = (minutesAgo: number) => new Date(NOW.getTime() - minutesAgo * MIN);

let org: { id: string; urn: string };
let app: { id: string };
let user: { id: string };
let agent: { id: string };
let teamChannel: { id: string };
const w: Record<string, { id: string }> = {};

beforeEach(async () => {
  await cleanDb(db);
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
  org = await db.organization.create({ data: { id: generateId(), name: 'dark-org', urn: `dark-${suffix}.com` } });
  user = await db.user.create({ data: { id: generateId(), githubId: 98_100 + Math.floor(Math.random() * 1000), githubUsername: `dark-${suffix}`, roles: ['READER'] } });
  agent = await db.agent.create({ data: { id: generateId(), organizationId: org.id, name: 'Engineer', urn: `${org.urn}:engineer`, visibility: 'ORGANIZATION' } });
  app = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Team', urn: `${org.urn}:team` } });
  await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: user.id, role: 'ADMIN' } });
  const memory = await db.memory.create({
    data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:team-shared`, name: 'shared', class: 'app', appId: app.id, sharedMemoryOfAgentId: agent.id },
  });
  teamChannel = (await ensureChannelWithRoot(db, { memoryId: memory.id, loc: 'chats:team', name: 'team', createdBy: user.id, asDefaultOfAppId: app.id })).channel;
  // Ada leads; Liam reports to Ada; Tove and Sam report to nobody.
  w.Ada = await mkWorker('Ada', null);
  w.Liam = await mkWorker('Liam', w.Ada.id);
  w.Tove = await mkWorker('Tove', null);
});

const mkWorker = (name: string, reportsTo: string | null) =>
  db.worker.create({
    data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId: app.id, agentId: agent.id, name, slug: name.toLowerCase(), role: 'engineer', heldByUserId: user.id, reportsToWorkerId: reportsTo },
    select: { id: true },
  });
/** A live session started `minutesAgo` minutes before NOW and touched at NOW. */
const bind = (name: string, minutesAgo = 120) =>
  db.session.create({
    data: { id: generateId(), appId: app.id, userId: user.id, workerId: w[name].id, agentId: agent.id, type: 'DEVELOPER', startedAt: at(minutesAgo), updatedAt: NOW },
  });
const assign = (name: string, minutesAgo: number) =>
  db.agentTask.create({ data: { appId: app.id, title: 'T', ownerUserId: user.id, assigneeWorkerId: w[name].id, assignedAt: at(minutesAgo) } });
const checked = async (name: string, minutesAgo: number) => {
  const where = { workerId: w[name].id, channelId: teamChannel.id };
  const n = await db.channelReadState.updateMany({ where, data: { lastCheckedAt: at(minutesAgo) } });
  if (n.count === 0) await db.channelReadState.create({ data: { ...where, appId: app.id, lastSeenSeq: 0, lastCheckedAt: at(minutesAgo) } });
};
const alarms = (name: string) =>
  db.agentTeamEvent.findMany({ where: { subjectWorkerId: w[name].id, type: 'alarm.dark-worker' }, orderBy: { createdAt: 'asc' } });

/** Liam is OVERDUE: a task, a live session, last checked 40 minutes ago (limit: 2 × 10 + 5 = 25 minutes). */
async function liamOverdue() {
  await bind('Liam');
  await assign('Liam', 100);
  await checked('Liam', 40);
}

describe('#2755 OVERDUE raises one task-less alarm per episode', () => {
  it('raises on the first pass that sees OVERDUE, with the reason and evidence, and a second pass inserts nothing', async () => {
    await liamOverdue();
    const raised = await evaluateDarkWorkers(db, NOW);
    expect(raised).toHaveLength(1);
    const [alarm] = await alarms('Liam');
    expect(alarm).toMatchObject({ taskId: null, severity: 'alarm', subjectWorkerId: w.Liam.id, appId: app.id });
    expect(alarm.payload).toMatchObject({ reason: 'overdue' });
    expect((alarm.payload as any).lastCheckedAt).toBe(at(40).toISOString());
    expect(await evaluateDarkWorkers(db, new Date(NOW.getTime() + 5 * MIN))).toEqual([]);
    expect(await alarms('Liam')).toHaveLength(1);
  });

  it('raises nothing for a worker that is OK (checked within the limit)', async () => {
    await bind('Liam');
    await assign('Liam', 100);
    await checked('Liam', 20);
    expect(await evaluateDarkWorkers(db, NOW)).toEqual([]);
  });

  it('opens one episode row, and the database admits only one open episode per worker', async () => {
    await liamOverdue();
    await evaluateDarkWorkers(db, NOW);
    const open = await db.darkWorkerEpisode.findMany({ where: { workerId: w.Liam.id, endedAt: null } });
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ reason: 'overdue', appId: app.id });
    const [alarm] = await alarms('Liam');
    await expect(db.darkWorkerEpisode.create({ data: { appId: app.id, workerId: w.Liam.id, eventId: alarm.id, reason: 'wake-unacked', openedAt: NOW } })).rejects.toThrow();
  });

  it('ends the episode when it clears, and a later OVERDUE opens a NEW episode and alarm', async () => {
    await liamOverdue();
    await evaluateDarkWorkers(db, NOW);
    await checked('Liam', 0); // checks again: OK
    expect(await evaluateDarkWorkers(db, NOW)).toEqual([]);
    expect(await db.darkWorkerEpisode.count({ where: { workerId: w.Liam.id, endedAt: null } })).toBe(0);
    expect(await db.darkWorkerEpisode.count({ where: { workerId: w.Liam.id, endedAt: { not: null } } })).toBe(1);
    const later = new Date(NOW.getTime() + 60 * MIN);
    await db.session.updateMany({ where: { workerId: w.Liam.id }, data: { updatedAt: later } });
    expect(await evaluateDarkWorkers(db, later)).toHaveLength(1);
    expect(await alarms('Liam')).toHaveLength(2);
  });
});

describe('#2755 exceptions: no alarm, no time counted', () => {
  it('NO_SESSION raises none', async () => {
    await assign('Liam', 100);
    await checked('Liam', 40);
    expect(await evaluateDarkWorkers(db, NOW)).toEqual([]);
  });

  it('a team pause, the worker\'s own pause and isolation raise none', async () => {
    await liamOverdue();
    await db.workerWakeSettings.create({ data: { workerId: w.Liam.id, pausedUntil: new Date(NOW.getTime() + 60 * MIN) } });
    expect(await evaluateDarkWorkers(db, NOW)).toEqual([]);
    await db.workerWakeSettings.update({ where: { workerId: w.Liam.id }, data: { pausedUntil: null, isolatedUntil: new Date(NOW.getTime() + 60 * MIN) } });
    expect(await evaluateDarkWorkers(db, NOW)).toEqual([]);
    await db.workerWakeSettings.update({ where: { workerId: w.Liam.id }, data: { isolatedUntil: null } });
    await db.app.update({ where: { id: app.id }, data: { teamPausedAt: at(10) } });
    expect(await evaluateDarkWorkers(db, NOW)).toEqual([]);
    expect(await alarms('Liam')).toHaveLength(0);
  });

  it('a worker with no task is never OVERDUE, so the OVERDUE trigger raises none', async () => {
    await bind('Tove');
    await checked('Tove', 600);
    expect(await evaluateDarkWorkers(db, NOW)).toEqual([]);
  });

  it('a retired worker, or a worker of an uninstalled App, raises none', async () => {
    await liamOverdue();
    await db.worker.update({ where: { id: w.Liam.id }, data: { retiredAt: at(1) } });
    expect(await evaluateDarkWorkers(db, NOW)).toEqual([]);
    await db.worker.update({ where: { id: w.Liam.id }, data: { retiredAt: null } });
    await db.app.update({ where: { id: app.id }, data: { uninstalledAt: at(1) } });
    expect(await evaluateDarkWorkers(db, NOW)).toEqual([]);
  });
});

describe('#2755 who is told: the reporting line, nearest first', () => {
  it('chains the worker\'s reportsTo line, then whoever manages the App, and wakes the nearest at once', async () => {
    await db.worker.update({ where: { id: w.Ada.id }, data: { reportsToWorkerId: w.Tove.id } });
    await liamOverdue();
    await evaluateDarkWorkers(db, NOW);
    const [alarm] = await alarms('Liam');
    const chain = alarm.chain as Array<{ workerId?: string; userId?: string; via?: string }>;
    expect(chain.slice(0, 2)).toEqual([{ workerId: w.Ada.id }, { workerId: w.Tove.id }]);
    expect(chain.slice(2).every((p) => p.userId && p.via === 'manager')).toBe(true);
    const rows = await db.agentTeamAlarmSchedule.findMany({ where: { eventId: alarm.id }, orderBy: { chainIndex: 'asc' } });
    expect(rows[0].wokenAt).toEqual(NOW);
    expect(rows[1].wokenAt).toBeNull();
    // one window (the App's darkAlarmWindowSeconds, 1800 s) per step up the line
    expect(rows[1].dueAt.getTime() - NOW.getTime()).toBe(30 * MIN);
  });

  it('a worker that reports to nobody goes to whoever manages the App', async () => {
    await bind('Tove');
    await assign('Tove', 100);
    await checked('Tove', 40);
    await evaluateDarkWorkers(db, NOW);
    const [alarm] = await alarms('Tove');
    expect(alarm.chain).toEqual([{ userId: user.id, via: 'manager' }]);
  });
});

describe('#2755 the stall evaluator tick runs it', () => {
  it('taskStallTick raises the alarm and reports the count', async () => {
    const { taskStallTick } = await import('../../jobs/taskStallEvaluator.js');
    await liamOverdue();
    expect(await taskStallTick(db, NOW)).toMatchObject({ darkRaised: 1 });
    expect(await taskStallTick(db, NOW)).toMatchObject({ darkRaised: 0 });
  });
});

describe('#2755 escalation, acknowledgement and delivery', () => {
  const later = new Date(NOW.getTime() + 31 * MIN);
  /** Keep Liam live and silent at `later`, so he is still OVERDUE then. */
  const stillDark = () => db.session.updateMany({ where: { workerId: w.Liam.id }, data: { updatedAt: later } });
  async function twoOwners() {
    await db.worker.update({ where: { id: w.Ada.id }, data: { reportsToWorkerId: w.Tove.id } });
    await liamOverdue();
    await evaluateDarkWorkers(db, NOW);
    return (await alarms('Liam'))[0];
  }

  it('wakes the next owner up the line after a further window while the episode lasts', async () => {
    const { wakeDueOwners } = await import('./stall.js');
    const alarm = await twoOwners();
    await stillDark();
    expect(await wakeDueOwners(db, new Date(NOW.getTime() + 29 * MIN))).toBe(0);
    expect(await wakeDueOwners(db, later)).toBe(1);
    const rows = await db.agentTeamAlarmSchedule.findMany({ where: { eventId: alarm.id }, orderBy: { chainIndex: 'asc' } });
    expect(rows.map((r) => r.wokenAt !== null)).toEqual([true, true, false]);
  });

  it('an acknowledged alarm wakes nobody further', async () => {
    const { wakeDueOwners } = await import('./stall.js');
    const alarm = await twoOwners();
    await db.agentTeamEvent.update({ where: { id: alarm.id }, data: { acknowledgedAt: NOW, acknowledgedByWorkerId: w.Ada.id } });
    await stillDark();
    expect(await wakeDueOwners(db, later)).toBe(0);
  });

  it('closes the unwoken rows, waking nobody, once the episode has ended', async () => {
    const { wakeDueOwners } = await import('./stall.js');
    const alarm = await twoOwners();
    await checked('Liam', -30); // checks at NOW + 30 min: OK again
    await stillDark();
    await evaluateDarkWorkers(db, later);
    expect(await db.darkWorkerEpisode.count({ where: { workerId: w.Liam.id, endedAt: { not: null } } })).toBe(1);
    expect(await wakeDueOwners(db, new Date(later.getTime() + 60 * MIN))).toBe(0);
    const rows = await db.agentTeamAlarmSchedule.findMany({ where: { eventId: alarm.id }, orderBy: { chainIndex: 'asc' } });
    expect(rows[1].wokenAt).toBeNull();
    expect(rows[1].endedAt).not.toBeNull();
  });

  it('delivers the alarm to the woken owner as an ALARM wake naming the dark worker, while the episode is open', async () => {
    const { pendingTaskWakes } = await import('./taskWakes.js');
    const alarm = await twoOwners();
    const [wake] = (await pendingTaskWakes(db, [w.Ada.id], NOW)).get(w.Ada.id) ?? [];
    expect(wake).toMatchObject({ workerId: w.Ada.id, eventId: alarm.id, chainIndex: 0, event: 'ALARM', handle: 'DARK' });
    expect(wake.title).toContain('Liam');
    expect(wake.title).toContain('overdue');
    // the next owner is not woken yet
    expect((await pendingTaskWakes(db, [w.Tove.id], NOW)).get(w.Tove.id)).toBeUndefined();
    // acknowledging stops delivery
    await db.agentTeamEvent.update({ where: { id: alarm.id }, data: { acknowledgedAt: NOW, acknowledgedByWorkerId: w.Ada.id } });
    expect((await pendingTaskWakes(db, [w.Ada.id], NOW)).get(w.Ada.id)).toBeUndefined();
  });

  it('stops delivering once the episode has ended', async () => {
    const { pendingTaskWakes } = await import('./taskWakes.js');
    await twoOwners();
    await db.darkWorkerEpisode.updateMany({ data: { endedAt: later } });
    expect((await pendingTaskWakes(db, [w.Ada.id], NOW)).get(w.Ada.id)).toBeUndefined();
  });
});

describe('#2755 one platform post per episode in the team channel', () => {
  const posts = async () =>
    (await db.node.findMany({ where: { messageChannelId: teamChannel.id, nodeType: 'chat-message' }, orderBy: { seq: 'asc' } }))
      .filter((n) => (n.data as any)?.authorSystem === true);

  it('posts once, as the platform, naming the worker and the reason and nothing else', async () => {
    await liamOverdue();
    await evaluateDarkWorkers(db, NOW);
    const [post, ...rest] = await posts();
    expect(rest).toEqual([]);
    expect(post.content).toBe('Liam has gone dark (overdue).');
    expect((post.data as any).mentions ?? []).toEqual([]);
    // evidence stays on the alarm: no times, no ages
    expect(post.content).not.toMatch(/\d{2}:\d{2}|minute|second|checked/i);
    await evaluateDarkWorkers(db, new Date(NOW.getTime() + 5 * MIN));
    expect(await posts()).toHaveLength(1);
  });

  it('a later episode of the same worker posts again; an ended episode never posts late', async () => {
    await liamOverdue();
    await evaluateDarkWorkers(db, NOW);
    await checked('Liam', 0);
    await evaluateDarkWorkers(db, NOW);
    expect(await posts()).toHaveLength(1);
    const later = new Date(NOW.getTime() + 60 * MIN);
    await db.session.updateMany({ where: { workerId: w.Liam.id }, data: { updatedAt: later } });
    await evaluateDarkWorkers(db, later);
    expect(await posts()).toHaveLength(2);
  });

  it('retries a post that failed, on the next pass, without a second alarm', async () => {
    const chat = await import('../../api/graphql/schema/resolvers.teamChat.js');
    await liamOverdue();
    await db.channel.update({ where: { id: teamChannel.id }, data: { deletedAt: new Date() } });
    await evaluateDarkWorkers(db, NOW); // no live team chat: nothing posted, nothing claimed
    expect(await posts()).toHaveLength(0);
    expect(await alarms('Liam')).toHaveLength(1);
    await db.channel.update({ where: { id: teamChannel.id }, data: { deletedAt: null } });
    await evaluateDarkWorkers(db, new Date(NOW.getTime() + MIN));
    expect(await posts()).toHaveLength(1);
    expect(await alarms('Liam')).toHaveLength(1);
    expect(chat.postSystemNotice).toBeTypeOf('function');
  });
});

describe('#2755 the alarm reads show the reason; the evidence only to a reader of the worker\'s internals', () => {
  async function aliveAlarm() {
    await liamOverdue();
    await evaluateDarkWorkers(db, NOW);
    return (await alarms('Liam'))[0];
  }
  const { resolvers } = { resolvers: null as any };
  const fields = async () => (await import('../../api/graphql/schema/resolvers.js')).resolvers as any;

  it('GraphQL payload: a participant sees reason and evidence; a caller who cannot read the internals sees the reason only', async () => {
    const alarm = await aliveAlarm();
    const outsider = await db.user.create({ data: { id: generateId(), githubId: 98_999, githubUsername: `out-${generateId()}`, roles: ['READER'] } });
    await db.appMember.create({ data: { appId: app.id, userId: user.id, role: 'member' } });
    const F = await fields();
    const asUser = { db, userId: user.id, roles: ['READER'] } as any;
    const asOutsider = { db, userId: outsider.id, roles: ['READER'] } as any;
    const seen = await F.AgentTeamEvent.payload(alarm, {}, asUser);
    expect(seen).toMatchObject({ reason: 'overdue', lastCheckedAt: at(40).toISOString() });
    expect(seen).toHaveProperty('oldestWakeAgeSeconds');
    const hidden = await F.AgentTeamEvent.payload(alarm, {}, asOutsider);
    expect(hidden).toMatchObject({ reason: 'overdue' });
    expect(hidden).not.toHaveProperty('lastCheckedAt');
    expect(hidden).not.toHaveProperty('oldestWakeAgeSeconds');
  });

  it('every other event keeps its payload as written', async () => {
    const F = await fields();
    const outsider = await db.user.create({ data: { id: generateId(), githubId: 98_998, githubUsername: `out-${generateId()}`, roles: ['READER'] } });
    const e = { type: 'task.finished', appId: app.id, payload: { outcome: 'succeeded' } };
    expect(await F.AgentTeamEvent.payload(e, {}, { db, userId: outsider.id, roles: ['READER'] })).toEqual({ outcome: 'succeeded' });
  });

  it('the MCP event line carries the same masking', async () => {
    const alarm = await aliveAlarm();
    const { renderEvent } = await import('../../mcp/agentTaskTools.js');
    const outsider = await db.user.create({ data: { id: generateId(), githubId: 98_997, githubUsername: `out-${generateId()}`, roles: ['READER'] } });
    const line = await renderEvent(alarm as never, { db, userId: outsider.id, roles: ['READER'] } as any);
    expect(line).toContain('"reason":"overdue"');
    expect(line).not.toContain('lastCheckedAt');
    expect(line).not.toContain('oldestWakeAgeSeconds');
  });
});
