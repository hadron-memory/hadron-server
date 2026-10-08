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
  it('the migration carries a byte-identical copy of the invariants file', () => {
    const source = readFileSync(new URL('../../../prisma/agent-task-invariants.sql', import.meta.url), 'utf8');
    const migration = readFileSync(
      new URL('../../../prisma/migrations/20261008010000_agent_tasks/migration.sql', import.meta.url),
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
    data: { id: generateId(), appId: app.id, agentId: agent.id, name: 'W', slug: 'w' },
    select: { id: true },
  });
  return w.id;
}
