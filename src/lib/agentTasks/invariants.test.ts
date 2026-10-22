import { WORKER_SIGNATURE_DEFAULTS } from '../workerSignature.js';
/**
 * #1705 — the database half of the agent-task contract
 * (prisma/agent-task-invariants.sql), tested at the database rather than
 * through the resolvers: the shape CHECK on agent_tasks (cor:agt:050:01) and
 * the append-only trigger on agent_team_events (cor:agt:050:11).
 */

import { readFileSync } from 'fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../id.js';

let app: { id: string };
let owner: { id: string };

beforeEach(async () => {
  await cleanDb(db);
  owner = await db.user.create({ data: { id: generateId(), roles: ['READER'] }, select: { id: true } });
  app = await db.app.create({
    data: { id: generateId(), name: 'Inv', urn: `inv-${generateId().toLowerCase()}:team`, ownerUserId: owner.id },
    select: { id: true },
  });
});

async function expectCheckViolation(p: Promise<unknown>, pattern: RegExp) {
  await expect(p).rejects.toThrow(pattern);
}

const task = (data: Record<string, unknown> = {}) =>
  db.agentTask.create({ data: { appId: app.id, title: 'T', ownerUserId: owner.id, ...data } });

const event = (data: Record<string, unknown> = {}) =>
  db.agentTeamEvent.create({ data: { appId: app.id, type: 'task.created', ...data } });

describe('agent-task-invariants.sql', () => {
  // #1754 moved the pin to the latest agent-tasks migration: the file is the
  // source of truth, and the newest migration carries its current copy.
  it('the latest agent-tasks migration carries a byte-identical copy of the invariants file', () => {
    const source = readFileSync(new URL('../../../prisma/agent-task-invariants.sql', import.meta.url), 'utf8');
    const migration = readFileSync(
      new URL('../../../prisma/migrations/20261012020000_agent_task_backlog_status/migration.sql', import.meta.url),
      'utf8',
    );
    expect(migration.endsWith(source)).toBe(true);
  });
});

describe('chk_agent_tasks_shape (cor:agt:050:01)', () => {
  it('admits a plain pending task', async () => {
    await expect(task()).resolves.toMatchObject({ status: 'pending' });
  });

  it('exactly one owner', async () => {
    await expectCheckViolation(task({ ownerUserId: null }), /chk_agent_tasks_shape/);
    const w = await workerRow();
    await expectCheckViolation(task({ ownerWorkerId: w }), /chk_agent_tasks_shape/);
  });

  it('at most one assignee, and an assignee carries its assignment time', async () => {
    const w = await workerRow();
    await expectCheckViolation(
      task({ assigneeWorkerId: w, assigneeUserId: owner.id, assignedAt: new Date() }),
      /chk_agent_tasks_shape/,
    );
    await expectCheckViolation(task({ assigneeUserId: owner.id }), /chk_agent_tasks_shape/);
  });

  it('the status vocabulary and per-status timestamps', async () => {
    await expectCheckViolation(task({ status: 'waiting' }), /chk_agent_tasks_shape/);
    await expectCheckViolation(task({ status: 'started' }), /chk_agent_tasks_shape/);
    await expectCheckViolation(task({ startedAt: new Date() }), /chk_agent_tasks_shape/);
    await expectCheckViolation(task({ status: 'cancelled' }), /chk_agent_tasks_shape/);
  });

  it('a result exists only on a finished task, and a finished task has an outcome', async () => {
    await expectCheckViolation(task({ resultOutcome: 'succeeded' }), /chk_agent_tasks_shape/);
    await expectCheckViolation(task({ resultSummary: 'text' }), /chk_agent_tasks_shape/);
    const now = new Date();
    await expectCheckViolation(
      task({ status: 'finished', assigneeUserId: owner.id, assignedAt: now, startedAt: now, finishedAt: now }),
      /chk_agent_tasks_shape/,
    );
    await expect(
      task({ status: 'finished', assigneeUserId: owner.id, assignedAt: now, startedAt: now, finishedAt: now, resultOutcome: 'succeeded' }),
    ).resolves.toMatchObject({ status: 'finished' });
  });

  it('a started or finished task has an assignee', async () => {
    const now = new Date();
    await expectCheckViolation(task({ status: 'started', startedAt: now }), /chk_agent_tasks_shape/);
  });

  it('#1754 (cor:agt:050:02): a backlog task has no assignee, no assignment and no timestamps', async () => {
    await expect(task({ status: 'backlog' })).resolves.toMatchObject({ status: 'backlog' });
    const w = await workerRow();
    await expectCheckViolation(task({ status: 'backlog', assigneeWorkerId: w, assignedAt: new Date() }), /chk_agent_tasks_shape/);
    await expectCheckViolation(task({ status: 'backlog', assigneeUserId: owner.id }), /chk_agent_tasks_shape/);
    await expectCheckViolation(task({ status: 'backlog', assignedAt: new Date() }), /chk_agent_tasks_shape/);
    await expectCheckViolation(task({ status: 'backlog', startedAt: new Date() }), /chk_agent_tasks_shape/);
  });
});

describe('agent_team_events — append-only (cor:agt:050:11)', () => {
  it('refuses an UPDATE of any column but the acknowledgement', async () => {
    const e = await event();
    await expectCheckViolation(
      db.agentTeamEvent.update({ where: { id: e.id }, data: { payload: { tampered: true } } }),
      /append-only/,
    );
    await expectCheckViolation(
      db.$executeRawUnsafe(`UPDATE agent_team_events SET type = 'task.finished' WHERE id = $1`, e.id),
      /append-only/,
    );
  });

  it('refuses a DELETE while the App exists', async () => {
    const e = await event();
    await expectCheckViolation(db.agentTeamEvent.delete({ where: { id: e.id } }), /append-only/);
    expect(await db.agentTeamEvent.count()).toBe(1);
  });

  it('refuses an INSERT that arrives acknowledged', async () => {
    await expectCheckViolation(
      event({ type: 'stall.not-started', severity: 'alarm', acknowledgedAt: new Date(), acknowledgedByUserId: owner.id }),
      /already acknowledged/,
    );
  });

  it('lets an alarm be acknowledged exactly once', async () => {
    const alarm = await event({ type: 'stall.not-started', severity: 'alarm', chain: [{ userId: owner.id }] });
    await db.agentTeamEvent.update({
      where: { id: alarm.id },
      data: { acknowledgedAt: new Date(), acknowledgedByUserId: owner.id },
    });
    await expectCheckViolation(
      db.agentTeamEvent.update({ where: { id: alarm.id }, data: { acknowledgedByUserId: null, acknowledgedByWorkerId: 'w' } }),
      /set once/,
    );
  });

  it('only an alarm carries a chain or an acknowledgement; an acknowledgement names who gave it', async () => {
    await expectCheckViolation(event({ chain: [] }), /chk_agent_team_events_shape/);
    const ordinary = await event();
    await expectCheckViolation(
      db.agentTeamEvent.update({ where: { id: ordinary.id }, data: { acknowledgedAt: new Date(), acknowledgedByUserId: owner.id } }),
      /chk_agent_team_events_shape/,
    );
    const alarm = await event({ type: 'stall.no-progress', severity: 'alarm' });
    await expectCheckViolation(
      db.agentTeamEvent.update({ where: { id: alarm.id }, data: { acknowledgedAt: new Date() } }),
      /chk_agent_team_events_shape/,
    );
  });

  it('holds the type shape and an object payload', async () => {
    await expectCheckViolation(event({ type: 'Task Created' }), /chk_agent_team_events_shape/);
    await expectCheckViolation(event({ payload: ['x'] }), /chk_agent_team_events_shape/);
  });

  it('goes with its App: an App hard delete cascades the stream (the one DELETE the trigger admits)', async () => {
    const t = await task();
    await event({ taskId: t.id });
    await event();
    await db.app.delete({ where: { id: app.id } });
    expect(await db.agentTeamEvent.count()).toBe(0);
    expect(await db.agentTask.count()).toBe(0);
  });
});

async function workerRow(): Promise<string> {
  const agent = await db.agent.create({
    data: { id: generateId(), name: 'A', urn: `a-${generateId().toLowerCase()}`, ownerUserId: owner.id },
    select: { id: true },
  });
  const w = await db.worker.create({
    data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId: app.id, agentId: agent.id, name: 'W', slug: 'w' },
    select: { id: true },
  });
  return w.id;
}

// ── #1706: prisma/agent-task-stall-invariants.sql ─────────────────────────

describe('agent-task-stall-invariants.sql (#1706)', () => {
  it('the latest stall-invariants migration carries a byte-identical copy of the invariants file', () => {
    const source = readFileSync(new URL('../../../prisma/agent-task-stall-invariants.sql', import.meta.url), 'utf8');
    const migration = readFileSync(
      new URL('../../../prisma/migrations/20261022100200_context_reset_availability/migration.sql', import.meta.url),
      'utf8',
    );
    expect(migration.endsWith(source)).toBe(true);
  });

  const alarm = (taskId: string, data: Record<string, unknown> = {}) =>
    event({ taskId, type: 'stall.not-started', severity: 'alarm', chain: [{ userId: owner.id }], episodeStart: new Date('2026-10-09T10:00:00Z'), ...data });

  it('cor:agt:050:13: one alarm per (task, rule, episode start), enforced by the unique key', async () => {
    const t = await task();
    await alarm(t.id);
    await expect(alarm(t.id)).rejects.toThrow(/Unique constraint/);
    // Another rule, or another episode, of the same task is a different key.
    await expect(alarm(t.id, { type: 'stall.no-progress' })).resolves.toBeTruthy();
    await expect(alarm(t.id, { episodeStart: new Date('2026-10-09T11:00:00Z') })).resolves.toBeTruthy();
    // Ordinary events carry no key, and never collide (NULLs are distinct).
    await event({ taskId: t.id });
    await event({ taskId: t.id });
  });

  it('only an alarm on a task, with its chain, carries an episode key', async () => {
    const t = await task();
    const ep = new Date('2026-10-09T10:00:00Z');
    await expectCheckViolation(event({ taskId: t.id, episodeStart: ep }), /chk_agent_team_events_episode/);
    await expectCheckViolation(event({ severity: 'alarm', chain: [], episodeStart: ep }), /chk_agent_team_events_episode/);
    await expectCheckViolation(event({ taskId: t.id, severity: 'alarm', episodeStart: ep }), /chk_agent_team_events_episode/);
  });

  it('the episode key is sealed like the rest of the event (append-only)', async () => {
    const t = await task();
    const a = await alarm(t.id);
    await expect(db.agentTeamEvent.update({ where: { id: a.id }, data: { episodeStart: new Date() } }))
      .rejects.toThrow(/append-only/);
  });

  it('agent_team_alarm_schedule: a chain index, woken no earlier than due; goes with its alarm on an App delete', async () => {
    const t = await task();
    const a = await alarm(t.id);
    const due = new Date('2026-10-09T10:15:00Z');
    await expectCheckViolation(db.agentTeamAlarmSchedule.create({ data: { eventId: a.id, chainIndex: -1, dueAt: due } }), /chk_agent_team_alarm_schedule_shape/);
    await expectCheckViolation(
      db.agentTeamAlarmSchedule.create({ data: { eventId: a.id, chainIndex: 0, dueAt: due, wokenAt: new Date('2026-10-09T10:14:00Z') } }),
      /chk_agent_team_alarm_schedule_shape/,
    );
    await db.agentTeamAlarmSchedule.create({ data: { eventId: a.id, chainIndex: 0, dueAt: due, wokenAt: due } });
    await db.app.delete({ where: { id: app.id } });
    expect(await db.agentTeamAlarmSchedule.count()).toBe(0);
  });

  it('worker_availability (cor:agt:060:02): a reason exactly when unavailable, from the closed set; no `held`', async () => {
    const w = await workerRow();
    const row = (data: Record<string, unknown>) =>
      db.workerAvailability.create({ data: { workerId: w, state: 'unavailable', reason: 'other', setAt: new Date(), setBy: 'holder', ...data } });
    await expectCheckViolation(row({ reason: null }), /chk_worker_availability_shape/);
    await expectCheckViolation(row({ reason: 'held' }), /chk_worker_availability_shape/);
    await expectCheckViolation(row({ state: 'available' }), /chk_worker_availability_shape/);
    await expectCheckViolation(row({ state: 'available', reason: null, until: new Date() }), /chk_worker_availability_shape/);
    await expectCheckViolation(row({ state: 'away' }), /chk_worker_availability_shape/);
    await expectCheckViolation(row({ setBy: 'coordinator' }), /chk_worker_availability_shape/);
    await expect(row({ reason: 'stalled', setBy: 'stall-rule' })).resolves.toBeTruthy();
  });

  it('worker_availability (#1766): `lapse` is a setter, for the record a passed until left available', async () => {
    const w = await workerRow();
    await expect(
      db.workerAvailability.create({ data: { workerId: w, state: 'available', setAt: new Date(), setBy: 'lapse' } }),
    ).resolves.toBeTruthy();
  });

  it('worker_availability (#1759): `reports-to` is a setter, for the stall mark the reports-to worker cleared', async () => {
    const w = await workerRow();
    await expect(
      db.workerAvailability.create({ data: { workerId: w, state: 'available', setAt: new Date(), setBy: 'reports-to' } }),
    ).resolves.toBeTruthy();
  });

  it('model_family_availability (cor:agt:060:03): a lowercase family token and the same state shape', async () => {
    const row = (data: Record<string, unknown>) =>
      db.modelFamilyAvailability.create({ data: { appId: app.id, family: 'claude', state: 'unavailable', reason: 'other', setAt: new Date(), ...data } });
    await expectCheckViolation(row({ family: 'Claude' }), /chk_model_family_availability_shape/);
    await expectCheckViolation(row({ reason: null }), /chk_model_family_availability_shape/);
    await expect(row({})).resolves.toBeTruthy();
  });

  it('agent_task_stall_schedule: 1 to 10080 minutes, or NULL for the default', async () => {
    const row = (data: Record<string, unknown>) => db.agentTaskStallSchedule.create({ data: { appId: app.id, ...data } });
    await expectCheckViolation(row({ notStartedMinutes: 0 }), /chk_agent_task_stall_schedule_range/);
    await expectCheckViolation(row({ assignmentMinutes: 10_081 }), /chk_agent_task_stall_schedule_range/);
    await expect(row({ noProgressMinutes: 90 })).resolves.toBeTruthy();
  });
});

// ── #1707: prisma/agent-task-matching-invariants.sql ──────────────────────

describe('agent-task-matching-invariants.sql (#1707)', () => {
  it('the latest matching-invariants migration (#1709) carries a byte-identical copy of the invariants file', () => {
    const source = readFileSync(new URL('../../../prisma/agent-task-matching-invariants.sql', import.meta.url), 'utf8');
    const migration = readFileSync(
      new URL('../../../prisma/migrations/20261014010000_host_registration_worktrees/migration.sql', import.meta.url),
      'utf8',
    );
    expect(migration.endsWith(source)).toBe(true);
  });

  it('sessions.family (cor:agt:060:04): a lowercase family token, or NULL', async () => {
    await expectCheckViolation(db.session.create({ data: { id: generateId(), family: 'Claude' } }), /chk_sessions_family/);
    await expect(db.session.create({ data: { id: generateId(), family: 'glm' } })).resolves.toBeTruthy();
    await expect(db.session.create({ data: { id: generateId() } })).resolves.toBeTruthy();
  });

  const registration = (data: Record<string, unknown> = {}) =>
    db.hostRegistration.create({
      data: { appId: app.id, hostId: 'orca1', label: 'orca1', pollIntervalSeconds: 60, refreshedAt: new Date(), ...data },
    });

  it('host_registrations (cor:agt:070:01): a host token, a 1–128 character label, a 1–86400 s poll interval', async () => {
    await expectCheckViolation(registration({ hostId: 'has space' }), /chk_host_registrations_shape/);
    await expectCheckViolation(registration({ label: '' }), /chk_host_registrations_shape/);
    await expectCheckViolation(registration({ pollIntervalSeconds: 0 }), /chk_host_registrations_shape/);
    await expectCheckViolation(registration({ pollIntervalSeconds: 86_401 }), /chk_host_registrations_shape/);
    await expect(registration()).resolves.toBeTruthy();
    await expect(registration()).rejects.toThrow(/Unique constraint/);
  });

  it('host_registration_workers: a family token, and only a worker of the registration\'s own App', async () => {
    const agent = await db.agent.create({ data: { id: generateId(), name: 'A', urn: `inv-agent-${generateId().toLowerCase()}`, ownerUserId: owner.id } });
    const other = await db.app.create({
      data: { id: generateId(), name: 'Other', urn: `inv-${generateId().toLowerCase()}:team`, ownerUserId: owner.id },
    });
    const mine = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: app.id, agentId: agent.id, name: 'Kit', slug: 'kit' } });
    const theirs = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: other.id, agentId: agent.id, name: 'Zed', slug: 'zed' } });
    const r = await registration();
    await expectCheckViolation(
      db.hostRegistrationWorker.create({ data: { registrationId: r.id, workerId: mine.id, family: 'Codex' } }),
      /chk_host_registration_workers_family/,
    );
    await expectCheckViolation(
      db.hostRegistrationWorker.create({ data: { registrationId: r.id, workerId: theirs.id, family: 'codex' } }),
      /chk_host_registration_workers_same_app|not in the registration's App/,
    );
    await expect(db.hostRegistrationWorker.create({ data: { registrationId: r.id, workerId: mine.id, family: 'codex' } })).resolves.toBeTruthy();
    // Moving a row to another App's worker is refused the same way.
    await expectCheckViolation(
      db.hostRegistrationWorker.update({ where: { registrationId_workerId: { registrationId: r.id, workerId: mine.id } }, data: { workerId: theirs.id } }),
      /chk_host_registration_workers_same_app|not in the registration's App/,
    );
  });
});
