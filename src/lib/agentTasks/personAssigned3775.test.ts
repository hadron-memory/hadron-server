/**
 * #3775 part B (cor:agt:050:14, :15 exception; Holger R5, 2026-11-09): a task assigned to a PERSON raises no stall alarm of
 * any kind (not-started, no-progress, owner-unreactive, finish-by). Worker-assigned and queued tasks alarm as before.
 * Same cast and controllable clock as finishBy2648.test.ts.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../id.js';
import { resolvers, type Context } from '../../api/graphql/schema/resolvers.js';
import { taskStallTick } from '../../jobs/taskStallEvaluator.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../workerSignature.js';

const M = resolvers.Mutation as any;
const at = (hhmm: string): Date => new Date(`2026-10-09T${hhmm}:00Z`);
const ctx = (userId?: string): Context => ({ db, userId, roles: ['READER'] });

let app: { id: string };
let agentId: string;
let ada: { id: string };
let anne: { id: string };
let miaId: string;

beforeEach(async () => {
  await cleanDb(db);
  const n = Math.floor(Math.random() * 1_000_000);
  const org = await db.organization.create({ data: { name: 'PersonAssigned', urn: `person3775-${n}.example` } });
  const admin = await db.user.create({ data: { githubId: 700_000 + n, githubUsername: `pa-admin-${n}`, roles: ['READER'] } });
  const mia = await db.user.create({ data: { githubId: 800_000 + n, githubUsername: `pa-mia-${n}`, roles: ['READER'] } });
  miaId = mia.id;
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  const agent = await M.createAgent({}, { orgId: org.id, name: 'Team Agent' }, ctx(admin.id));
  agentId = agent.id;
  app = await db.app.create({ data: { organizationId: org.id, name: 'Team', urn: `person3775-${n}.example:team` }, select: { id: true } });
  await db.appMember.create({ data: { appId: app.id, userId: mia.id, role: 'member' } });
  const worker = (name: string) =>
    db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: app.id, agentId, name, slug: name.toLowerCase(), heldByUserId: mia.id }, select: { id: true } });
  ada = await worker('Ada');
  anne = await worker('Anne');
});

type TaskData = Record<string, unknown>;
const task = (data: TaskData) =>
  db.agentTask.create({ data: { appId: app.id, title: 'T', createdAt: at('09:00'), ...data }, select: { id: true } });
const toMia = (assignedAt: string, extra: TaskData = {}) =>
  task({ ownerWorkerId: ada.id, assigneeUserId: miaId, assignedAt: at(assignedAt), createdAt: at(assignedAt), ...extra });
const toAnne = (assignedAt: string, extra: TaskData = {}) =>
  task({ ownerWorkerId: ada.id, assigneeWorkerId: anne.id, assignedAt: at(assignedAt), createdAt: at(assignedAt), ...extra });
const tick = (t: string) => taskStallTick(db, at(t));
const alarms = () => db.agentTeamEvent.findMany({ where: { severity: 'alarm', taskId: { not: null } }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });

describe('#3775 B — a person-assigned task raises no stall alarm', () => {
  it('a pending person-assigned task past its not-started window raises nothing; the worker-assigned control does', async () => {
    await toMia('10:00');
    await tick('10:20');
    await tick('12:00');
    expect(await alarms()).toEqual([]);
    const control = await toAnne('10:00');
    await tick('12:00');
    expect((await alarms()).map((a) => [a.type, a.taskId])).toEqual([['stall.not-started', control.id]]);
  });

  it('a started person-assigned task past its no-progress window raises nothing; the worker-assigned control does', async () => {
    await toMia('09:30', { status: 'started', startedAt: at('10:00') });
    await tick('11:30');
    await tick('15:00');
    expect(await alarms()).toEqual([]);
    const control = await toAnne('09:30', { status: 'started', startedAt: at('10:00') });
    await tick('15:00');
    expect((await alarms()).map((a) => [a.type, a.taskId])).toEqual([['stall.no-progress', control.id]]);
  });

  it('a person-assigned task past its finish-by time raises no finish-by alarm; the worker-assigned control does', async () => {
    await toMia('10:00', { finishBy: at('12:00') });
    await tick('12:00');
    await tick('14:00');
    expect(await alarms()).toEqual([]);
    const control = await toAnne('10:00', { finishBy: at('12:00') });
    await tick('14:00');
    expect((await alarms()).map((a) => [a.type, a.taskId])).toEqual([['stall.finish-by', control.id]]);
  });

  it('a person-assigned parent with an unreacted ended child raises no owner-unreactive alarm', async () => {
    const parent = await toMia('09:30', { status: 'started', startedAt: at('10:00') });
    await task({ ownerWorkerId: anne.id, assigneeWorkerId: anne.id, parentTaskId: parent.id, status: 'finished', startedAt: at('10:00'), finishedAt: at('10:30'), resultOutcome: 'succeeded', createdAt: at('10:00'), assignedAt: at('10:00') });
    await tick('12:00');
    await tick('16:00');
    expect(await alarms()).toEqual([]);
  });

  it('a queued (unassigned) task still raises unassignable', async () => {
    const queued = await task({ ownerWorkerId: ada.id, createdAt: at('10:00') });
    await db.agentTeamEvent.create({ data: { appId: app.id, taskId: queued.id, type: 'assignment.queued', createdAt: at('10:00') } });
    await tick('11:00');
    expect((await alarms()).map((a) => a.type)).toEqual(['assignment.unassignable']);
  });

  it('reassigning from the person to a worker restores the ordinary windows from the assignment', async () => {
    const t = await toMia('10:00');
    await tick('12:00');
    expect(await alarms()).toEqual([]);
    await db.agentTask.update({ where: { id: t.id }, data: { assigneeUserId: null, assigneeWorkerId: anne.id, assignedAt: at('12:00') } });
    await tick('12:10');
    expect(await alarms()).toEqual([]); // the window counts from the reassignment, not from the old person assignment
    await tick('12:20');
    expect((await alarms()).map((a) => a.type)).toEqual(['stall.not-started']);
  });
});
