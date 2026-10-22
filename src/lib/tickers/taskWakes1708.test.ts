import { WORKER_SIGNATURE_DEFAULTS } from '../workerSignature.js';
/**
 * #1708 — Task Management T5: task events as the second relevance source of the
 * due-wake computation, with per-event acknowledgement (design:agent-tasks §6;
 * cor:agt:050:16, :19, :20, :21; cor:agt:080:09, :11, :13, :15–:17, :23).
 *
 * One block per acceptance heading of the issue, plus the pre-delivery
 * re-checks folded from the T2 review (Rook §10 P3-1 on #1720).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../id.js';
import { resolvers, type Context } from '../../api/graphql/schema/resolvers.js';
import { computeDueWakes, WAKE_TASK_REASONS_MAX } from './dueWakes.js';
import { MAX_PROOF_CHARS, signWakeProof, verifyWakeProof } from './wakeProof.js';
import { taskStallTick } from '../../jobs/taskStallEvaluator.js';
import { evaluateStalls, wakeDueOwners } from '../agentTasks/stall.js';
import { recordUndeliverableTaskWakes } from '../agentTasks/taskWakes.js';
import { APP_KEY_PREFIX, hashAppKey } from '../../middleware/auth.js';
import { randomBytes } from 'node:crypto';

vi.mock('../bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));
vi.mock('../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));

const M = resolvers.Mutation as any;
const Q = resolvers.Query as any;
const MIN = 60_000;
const DAY = 86_400_000;

const ctx = (userId?: string): Context => ({ db, userId, roles: ['READER'] }) as Context;

let org: { id: string; urn: string };
let manager: { id: string };
let holder: { id: string };
let outsider: { id: string };
let app: { id: string; organizationId: string | null; ownerUserId: string | null };
let agent: { id: string };
let liam: { id: string; name: string };
let rook: { id: string; name: string };

async function mkUser(n: number) {
  return db.user.create({
    data: { id: generateId(), githubId: 1_708_000 + n * 1000 + Math.floor(Math.random() * 1000), githubUsername: `tw-${n}-${generateId().slice(-8)}`, roles: ['READER'] },
    select: { id: true },
  });
}
const mkWorker = (name: string, extra: Record<string, unknown> = {}) =>
  db.worker.create({
    data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId: app.id, agentId: agent.id, name, slug: name.toLowerCase(), heldByUserId: holder.id, heldAt: new Date(), ...extra },
    select: { id: true, name: true },
  });

beforeEach(async () => {
  await cleanDb(db);
  const suffix = generateId().slice(-10).toLowerCase();
  org = await db.organization.create({ data: { id: generateId(), name: 'tw-org', urn: `tw-org-${suffix}.com` } });
  [manager, holder, outsider] = [await mkUser(1), await mkUser(2), await mkUser(3)];
  await db.orgMember.create({ data: { id: generateId(), organizationId: org.id, userId: manager.id, role: 'ADMIN' } });
  agent = await db.agent.create({ data: { id: generateId(), organizationId: org.id, name: 'Team', urn: `${org.urn}:team`, visibility: 'ORGANIZATION' } });
  app = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Team', urn: `${org.urn}:team` }, select: { id: true, organizationId: true, ownerUserId: true } });
  await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
  await db.appMember.create({ data: { appId: app.id, userId: holder.id, role: 'member' } });
  liam = await mkWorker('Liam');
  rook = await mkWorker('Rook');
});

/** The due wakes the App's manager reads, at `now`. */
const dueFor = (c: Context = ctx(manager.id), now = new Date()) =>
  computeDueWakes({ ctx: c, app, reader: { manager: true, userId: c.userId ?? null }, requester: { userId: c.userId! }, now });

type TaskReason = { kind: 'TASK'; taskId: string; eventId: string; chainIndex: number; event: string; title: string };
const taskReasons = (page: Awaited<ReturnType<typeof dueFor>>, workerId: string): TaskReason[] =>
  (page.wakes.find((w) => w.workerId === workerId)?.wake.reasons ?? []).filter((r) => r.kind === 'TASK') as unknown as TaskReason[];
const dueIds = (page: Awaited<ReturnType<typeof dueFor>>) => page.wakes.map((w) => w.workerId).sort();

async function task(data: Record<string, unknown>) {
  return db.agentTask.create({ data: { appId: app.id, title: 'Review #42', ...data }, select: { id: true } });
}
async function event(data: Record<string, unknown> & { type: string }) {
  return db.agentTeamEvent.create({ data: { appId: app.id, ...data }, select: { id: true } });
}
/** A task assigned to `w` now, with its assignment event, owned by Rook. */
async function assignedTo(w: { id: string }, type = 'task.assigned', extra: Record<string, unknown> = {}) {
  const t = await task({ ownerWorkerId: rook.id, assigneeWorkerId: w.id, assignedAt: new Date(), ...extra });
  const e = await event({ taskId: t.id, type, subjectWorkerId: w.id, actorUserId: manager.id });
  return { taskId: t.id, eventId: e.id };
}
/** The columns a finished row carries (chk_agent_tasks_shape): started, finished, with an outcome. */
const FINISHED = () => ({ status: 'finished', startedAt: new Date(Date.now() - 10 * MIN), finishedAt: new Date(), resultOutcome: 'done' });
const ack = (proof: string, c: Context = ctx(manager.id)) => M.acknowledgeWakes({}, { proofs: [proof] }, c);

describe('each waking event makes exactly its subject due', () => {
  it('task.assigned wakes the new assignee only, and the reason names the task by title', async () => {
    const { taskId, eventId } = await assignedTo(liam);
    const page = await dueFor();
    expect(dueIds(page)).toEqual([liam.id]);
    expect(taskReasons(page, liam.id)).toEqual([
      { kind: 'TASK', taskId, eventId, chainIndex: 0, event: 'ASSIGNED', title: 'Review #42' },
    ]);
  });

  it('task.reassigned wakes the new assignee, never the previous one', async () => {
    const t = await task({ ownerWorkerId: rook.id, assigneeWorkerId: liam.id, assignedAt: new Date() });
    await event({ taskId: t.id, type: 'task.reassigned', subjectWorkerId: liam.id, actorUserId: manager.id, payload: { from: { workerId: rook.id }, to: { workerId: liam.id } } });
    const page = await dueFor();
    expect(dueIds(page)).toEqual([liam.id]);
    expect(taskReasons(page, liam.id).map((r) => r.event)).toEqual(['REASSIGNED']);
  });

  it('assignment.matched (the matcher\'s assignment record, #1707) wakes its subject', async () => {
    await assignedTo(liam, 'assignment.matched');
    const page = await dueFor();
    expect(taskReasons(page, liam.id).map((r) => r.event)).toEqual(['MATCHED']);
  });

  it('only the LATEST assignment counts: a task reassigned away does not wake its earlier assignee', async () => {
    const { taskId } = await assignedTo(liam);
    await db.agentTask.update({ where: { id: taskId }, data: { assigneeWorkerId: rook.id } });
    await event({ taskId, type: 'task.reassigned', subjectWorkerId: rook.id, actorUserId: manager.id, createdAt: new Date(Date.now() + 1000) });
    const page = await dueFor(ctx(manager.id), new Date(Date.now() + 2000));
    expect(dueIds(page)).toEqual([rook.id]);
  });

  it('an assignee who already acted on the task is not woken for it', async () => {
    const { taskId } = await assignedTo(liam);
    await event({ taskId, type: 'task.started', actorWorkerId: liam.id, actorUserId: holder.id, createdAt: new Date(Date.now() + 1000) });
    expect(dueIds(await dueFor(ctx(manager.id), new Date(Date.now() + 2000)))).toEqual([]);
  });

  it('an ended task wakes nobody', async () => {
    const { taskId } = await assignedTo(liam);
    await db.agentTask.update({ where: { id: taskId }, data: { status: 'cancelled', cancelledAt: new Date() } });
    expect(dueIds(await dueFor())).toEqual([]);
  });

  it('events that ask nothing of anyone (created, progress, queued) wake nobody', async () => {
    const t = await task({ ownerWorkerId: rook.id });
    await event({ taskId: t.id, type: 'task.created', actorUserId: manager.id });
    await event({ taskId: t.id, type: 'assignment.queued' });
    expect(dueIds(await dueFor())).toEqual([]);
  });
});

describe("a child's finish wakes the child's owner (the parent's assignee, 050:16 r2), not the parent's owner", () => {
  it('Liam (parent assignee, child owner) is due; Rook (parent owner) is not', async () => {
    const parent = await task({ ownerWorkerId: rook.id, assigneeWorkerId: liam.id, status: 'started', startedAt: new Date(Date.now() - 60 * MIN), assignedAt: new Date(Date.now() - 60 * MIN) });
    const child = await task({ parentTaskId: parent.id, ownerWorkerId: liam.id, assigneeWorkerId: rook.id, assignedAt: new Date(Date.now() - 20 * MIN), ...FINISHED(), title: 'Child' });
    const e = await event({ taskId: child.id, type: 'task.finished', actorUserId: manager.id, payload: { outcome: 'done' } });
    const page = await dueFor();
    expect(dueIds(page)).toEqual([liam.id]);
    expect(taskReasons(page, liam.id)).toEqual([
      { kind: 'TASK', taskId: child.id, eventId: e.id, chainIndex: 0, event: 'CHILD_FINISHED', title: 'Child' },
    ]);
  });

  it('the owner reacting on the parent after the finish ends the wake', async () => {
    const parent = await task({ ownerWorkerId: rook.id, assigneeWorkerId: liam.id, status: 'started', startedAt: new Date(Date.now() - 60 * MIN), assignedAt: new Date(Date.now() - 60 * MIN) });
    const child = await task({ parentTaskId: parent.id, ownerWorkerId: liam.id, assigneeWorkerId: rook.id, assignedAt: new Date(Date.now() - 20 * MIN), ...FINISHED() });
    await event({ taskId: child.id, type: 'task.finished', actorUserId: manager.id });
    await event({ taskId: parent.id, type: 'task.progress', actorWorkerId: liam.id, actorUserId: holder.id, createdAt: new Date(Date.now() + 1000) });
    expect(dueIds(await dueFor(ctx(manager.id), new Date(Date.now() + 2000)))).toEqual([]);
  });

  it('a child finishing under an ended parent wakes nobody', async () => {
    const parent = await task({ ownerWorkerId: rook.id, assigneeWorkerId: liam.id, assignedAt: new Date(Date.now() - 60 * MIN), ...FINISHED() });
    const child = await task({ parentTaskId: parent.id, ownerWorkerId: liam.id, assigneeWorkerId: rook.id, assignedAt: new Date(Date.now() - 20 * MIN), ...FINISHED() });
    await event({ taskId: child.id, type: 'task.finished', actorUserId: manager.id });
    expect(dueIds(await dueFor())).toEqual([]);
  });
});

describe('under the mention ceiling and budget (cor:agt:080:13, :15)', () => {
  it('a task wakes whatever the mentions setting (it is not a mention); a pause silences it like everything else', async () => {
    await db.workerWakeSettings.create({ data: { workerId: liam.id, mentions: 'OFF' } });
    await assignedTo(liam);
    expect(dueIds(await dueFor())).toEqual([liam.id]);
    await db.appWakeReservation.deleteMany();
    await db.workerWakeSettings.update({ where: { workerId: liam.id }, data: { pausedUntil: new Date(Date.now() + 3600_000) } });
    expect(dueIds(await dueFor())).toEqual([]);
  });


  it('a second task event inside the floor waits; past it, it is due', async () => {
    await assignedTo(liam);
    const first = await dueFor();
    expect(await ack(first.wakes[0]!.proof)).toEqual({ acknowledged: 1, unchanged: 0 });
    await assignedTo(liam);
    expect(dueIds(await dueFor())).toEqual([]); // inside the 120s floor
    expect(dueIds(await dueFor(ctx(manager.id), new Date(Date.now() + 3 * MIN)))).toEqual([liam.id]);
  });

  it('a spent budget withholds a task wake like a mention: it stays due', async () => {
    await db.app.update({ where: { id: app.id }, data: { wakeDailyBudget: 0 } });
    await assignedTo(liam);
    const page = await dueFor();
    expect(page.status).toBe('WAKE_BUDGET_EXHAUSTED');
    expect(page.withheld).toBe(1);
    expect(page.wakes).toEqual([]);
  });

  it('a task wake counts against the day\'s budget when acknowledged', async () => {
    await assignedTo(liam);
    await ack((await dueFor()).wakes[0]!.proof);
    const day = await db.appWakeDay.findFirst({ where: { appId: app.id } });
    expect(day?.wakes).toBe(1);
  });
});

describe('acknowledgement per event (wake proof v2)', () => {
  it('acknowledging records delivery on (event, worker), and the event no longer wakes', async () => {
    const { eventId } = await assignedTo(liam);
    const page = await dueFor();
    const proof = verifyWakeProof(page.wakes[0]!.proof);
    expect(proof.v).toBe(3); // #2072: v3 carries the wake key and no channel range
    expect(proof.channels).toEqual([]);
    expect(proof.tasks).toEqual([{ eventId, chainIndex: 0 }]);
    await ack(page.wakes[0]!.proof);
    const row = await db.workerDeliveryTaskEvent.findUnique({ where: { workerId_eventId_chainIndex: { workerId: liam.id, eventId, chainIndex: 0 } } });
    expect(row).toMatchObject({ ackedByUserId: manager.id });
    expect(row?.deliveredAt).toBeInstanceOf(Date);
    expect(dueIds(await dueFor(ctx(manager.id), new Date(Date.now() + 3 * MIN)))).toEqual([]);
  });

  it('a repeat acknowledgement changes nothing', async () => {
    await assignedTo(liam);
    const { proof } = (await dueFor()).wakes[0]!;
    await ack(proof);
    expect(await ack(proof)).toEqual({ acknowledged: 0, unchanged: 1 });
  });

  it('a v1 proof (issued before this deploy) still verifies and acknowledges', async () => {
    const v1 = signWakeProof({ v: 1, kind: 'wake-proof', appId: app.id, workerId: liam.id, requester: { userId: manager.id }, channels: [], ticks: [], exempt: false, issuedAt: Date.now() } as any);
    expect(verifyWakeProof(v1).tasks).toEqual([]);
    // #2072 (R53): its wake's receipt is recorded once, though it names nothing; a repeat changes nothing.
    expect(await ack(v1)).toEqual({ acknowledged: 1, unchanged: 0 });
    expect(await ack(v1)).toEqual({ acknowledged: 0, unchanged: 1 });
  });

  it('a proof naming an event of another App records nothing for it', async () => {
    const other = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Other', urn: `${org.urn}:other` } });
    const foreign = await db.agentTeamEvent.create({ data: { appId: other.id, type: 'task.assigned' } });
    const forged = signWakeProof({ v: 2, kind: 'wake-proof', appId: app.id, workerId: liam.id, requester: { userId: manager.id }, channels: [], ticks: [], tasks: [{ eventId: foreign.id, chainIndex: 0 }], exempt: false, issuedAt: Date.now() });
    await ack(forged);
    expect(await db.workerDeliveryTaskEvent.count()).toBe(0);
  });
});

describe('a requester who cannot read the task gets no reason for it (050:21)', () => {
  it('an outsider reading as if a manager sees no task reason, and so no wake', async () => {
    await assignedTo(liam);
    const page = await dueFor(ctx(outsider.id));
    expect(page.wakes).toEqual([]);
  });
});

// ── Alarms: the currently-woken chain position, and the pre-delivery re-checks ──

/** Rook's not-started stall on a task Liam owns: assigned 30 minutes ago, never started. */
async function stalledAlarm() {
  const t = await task({ ownerWorkerId: liam.id, assigneeWorkerId: rook.id, assignedAt: new Date(Date.now() - 30 * MIN), createdAt: new Date(Date.now() - 30 * MIN) });
  const [eventId] = await evaluateStalls(db, new Date());
  expect(eventId).toBeTruthy();
  return { taskId: t.id, eventId: eventId! };
}

describe('an alarm wakes its currently-woken chain position (050:19)', () => {
  it('the nearest owner (a worker) is due, with an ALARM reason at chain index 0', async () => {
    const { taskId, eventId } = await stalledAlarm();
    const page = await dueFor();
    expect(dueIds(page)).toEqual([liam.id]);
    expect(taskReasons(page, liam.id)).toEqual([
      { kind: 'TASK', taskId, eventId, chainIndex: 0, event: 'ALARM', title: 'Review #42' },
    ]);
  });

  it('a person in the chain is skipped: nobody is due, and the escalation timer keeps running', async () => {
    await task({ ownerUserId: holder.id, assigneeWorkerId: rook.id, assignedAt: new Date(Date.now() - 30 * MIN), createdAt: new Date(Date.now() - 30 * MIN) });
    const [eventId] = await evaluateStalls(db, new Date());
    expect(dueIds(await dueFor())).toEqual([]);
    expect(await wakeDueOwners(db, new Date(Date.now() + 16 * MIN))).toBe(1);
    const rows = await db.agentTeamAlarmSchedule.findMany({ where: { eventId }, orderBy: { chainIndex: 'asc' } });
    expect(rows[1]!.wokenAt).not.toBeNull();
  });
});

describe('a wake proof is never an alarm acknowledgement (050:20)', () => {
  it('acknowledging the wake leaves the alarm unacknowledged, and its escalation running', async () => {
    const { eventId } = await stalledAlarm();
    await ack((await dueFor()).wakes[0]!.proof);
    const alarm = await db.agentTeamEvent.findUniqueOrThrow({ where: { id: eventId } });
    expect(alarm.acknowledgedAt).toBeNull();
    expect(alarm.acknowledgedByUserId).toBeNull();
    expect(alarm.acknowledgedByWorkerId).toBeNull();
    expect(await wakeDueOwners(db, new Date(Date.now() + 16 * MIN))).toBe(1);
  });

  it('the delivered position is not due again; a later woken position is a new delivery', async () => {
    // Rook owns the parent, so the chain is Liam → Rook → the App manager.
    const root = await task({ ownerWorkerId: rook.id, assigneeWorkerId: liam.id, status: 'started', startedAt: new Date(Date.now() - 5 * MIN), assignedAt: new Date(Date.now() - 5 * MIN) });
    await event({ taskId: root.id, type: 'task.progress', actorWorkerId: liam.id, createdAt: new Date() });
    await task({ parentTaskId: root.id, ownerWorkerId: liam.id, assigneeWorkerId: rook.id, assignedAt: new Date(Date.now() - 30 * MIN), createdAt: new Date(Date.now() - 30 * MIN) });
    const [eventId] = await evaluateStalls(db, new Date());
    const first = await dueFor();
    expect(taskReasons(first, liam.id).map((r) => [r.event, r.chainIndex])).toEqual([['ALARM', 0]]);
    await ack(first.wakes.find((w) => w.workerId === liam.id)!.proof);
    const later = new Date(Date.now() + 16 * MIN);
    await wakeDueOwners(db, later);
    const next = await dueFor(ctx(manager.id), later);
    expect(taskReasons(next, liam.id)).toEqual([]);
    expect(taskReasons(next, rook.id).map((r) => [r.eventId, r.event, r.chainIndex])).toEqual([[eventId, 'ALARM', 1]]);
  });
});

describe('pre-delivery re-checks (Rook §10 P3-1 on #1720): a stale or revoked alarm wake is never delivered', () => {
  it('a current, authorized episode delivers (the control)', async () => {
    await stalledAlarm();
    expect(dueIds(await dueFor())).toEqual([liam.id]);
  });

  it('a changed episode (the task was reassigned since) suppresses it', async () => {
    const { taskId } = await stalledAlarm();
    await db.agentTask.update({ where: { id: taskId }, data: { assignedAt: new Date() } });
    expect(dueIds(await dueFor())).toEqual([]);
  });

  it('an episode that no longer holds (the task started) suppresses it', async () => {
    const { taskId } = await stalledAlarm();
    await db.agentTask.update({ where: { id: taskId }, data: { status: 'started', startedAt: new Date() } });
    expect(dueIds(await dueFor())).toEqual([]);
  });

  it('a finished task suppresses it', async () => {
    const { taskId } = await stalledAlarm();
    await db.agentTask.update({ where: { id: taskId }, data: FINISHED() });
    expect(dueIds(await dueFor())).toEqual([]);
  });

  it('a cancelled task suppresses it', async () => {
    const { taskId } = await stalledAlarm();
    await db.agentTask.update({ where: { id: taskId }, data: { status: 'cancelled', cancelledAt: new Date() } });
    expect(dueIds(await dueFor())).toEqual([]);
  });

  it('an uninstalled App suppresses it', async () => {
    await stalledAlarm();
    await db.app.update({ where: { id: app.id }, data: { uninstalledAt: new Date() } });
    expect(dueIds(await dueFor())).toEqual([]);
  });

  it("a revoked holder (no longer the App's participant) suppresses it", async () => {
    await stalledAlarm();
    await db.appMember.deleteMany({ where: { appId: app.id, userId: holder.id } });
    expect(dueIds(await dueFor())).toEqual([]);
  });

  it('a retired worker is never delivered to', async () => {
    await stalledAlarm();
    await db.worker.update({ where: { id: liam.id }, data: { retiredAt: new Date() } });
    expect(dueIds(await dueFor())).toEqual([]);
  });

  it('a wake issued (reserved) before the episode passed is not handed out again after it (the stored-wake path)', async () => {
    const { taskId } = await stalledAlarm();
    expect(dueIds(await dueFor())).toEqual([liam.id]); // issued: its budget slot is reserved, not yet acknowledged
    await db.agentTask.update({ where: { id: taskId }, data: { status: 'started', startedAt: new Date() } });
    await assignedTo(liam); // something new is due, so the stored wake would otherwise be re-handed in its place
    const page = await dueFor();
    expect(taskReasons(page, liam.id).map((r) => r.event)).toEqual(['ASSIGNED']);
  });

  it('an acknowledged alarm is not delivered', async () => {
    const { eventId } = await stalledAlarm();
    await db.agentTeamEvent.update({ where: { id: eventId }, data: { acknowledgedAt: new Date(), acknowledgedByUserId: manager.id } });
    expect(dueIds(await dueFor())).toEqual([]);
  });
});

describe('a dormant subject is undeliverable: recorded, never launched (cor:agt:080:11)', () => {
  it('is not due, and the stall tick records the event as undeliverable for it', async () => {
    await db.session.create({ data: { id: generateId(), appId: app.id, userId: holder.id, workerId: liam.id, agentId: agent.id, type: 'DEVELOPER', startedAt: new Date(Date.now() - 100 * DAY), updatedAt: new Date(Date.now() - 100 * DAY), endedAt: new Date(Date.now() - 100 * DAY) } });
    const { eventId } = await assignedTo(liam);
    expect(dueIds(await dueFor())).toEqual([]);
    expect(await recordUndeliverableTaskWakes(db, new Date())).toBe(1);
    const row = await db.workerDeliveryTaskEvent.findUniqueOrThrow({ where: { workerId_eventId_chainIndex: { workerId: liam.id, eventId, chainIndex: 0 } } });
    expect(row).toMatchObject({ deliveredAt: null, undeliverableReason: 'dormant' });
    expect(row.undeliverableAt).toBeInstanceOf(Date);
    // Recorded once, not once per tick.
    expect(await recordUndeliverableTaskWakes(db, new Date(Date.now() + MIN))).toBe(0);
  });

  it('a worker that is not dormant is never recorded undeliverable, held or not, with or without a session', async () => {
    await assignedTo(liam);
    await db.worker.update({ where: { id: rook.id }, data: { heldByUserId: null, heldAt: null } });
    await assignedTo(rook);
    expect(await recordUndeliverableTaskWakes(db, new Date())).toBe(0);
    expect(dueIds(await dueFor())).toEqual([liam.id, rook.id].sort());
  });
});

describe("the router's surface: an App key with attention:deliver (cor:agt:080:22, #1755's read arm)", () => {
  it('reads the task reason through GraphQL, with the ref and title, and acknowledges it per event', async () => {
    const raw = `${APP_KEY_PREFIX}${randomBytes(32).toString('hex')}`;
    const key = await db.appKey.create({ data: { id: generateId(), appId: app.id, keyHash: hashAppKey(raw), keyPreview: raw.slice(-4), label: 'router' } });
    await db.appKeyScope.create({ data: { id: generateId(), appKeyId: key.id, scope: 'attention:deliver', grantedByUserId: manager.id } });
    const keyCtx = { db, appId: app.id, appKeyId: key.id, organizationId: org.id, roles: [] } as unknown as Context;
    const { taskId, eventId } = await assignedTo(liam);
    const page = await Q.dueWakes({}, { appRef: app.id }, keyCtx);
    expect(page.wakes).toHaveLength(1);
    expect(page.wakes[0].reasons).toEqual([
      { kind: 'TASK', ticker: null, task: { id: taskId, eventId, chainIndex: 0, event: 'ASSIGNED', title: 'Review #42', ref: `TASK:${taskId}:assigned` } },
    ]);
    expect(await M.acknowledgeWakes({}, { proofs: [page.wakes[0].proof] }, keyCtx)).toEqual({ acknowledged: 1, unchanged: 0 });
    const row = await db.workerDeliveryTaskEvent.findFirstOrThrow({ where: { eventId } });
    expect(row).toMatchObject({ workerId: liam.id, ackedByAppKeyId: key.id, ackedByUserId: null });
  });

});

describe('a task backlog drains in bounded batches (Colin / Riana P2-2 on #1859)', () => {
  it('120 pending assignments: wakes of 50, 50 and 20, each proof within the verifier\'s cap and acknowledgeable', async () => {
    const created = new Date(Date.now() - 60 * MIN);
    const tasks = Array.from({ length: 120 }, (_, n) => ({
      id: generateId(), appId: app.id, title: `Task ${n}`, ownerWorkerId: rook.id, assigneeWorkerId: liam.id, assignedAt: created,
    }));
    await db.agentTask.createMany({ data: tasks });
    await db.agentTeamEvent.createMany({
      data: tasks.map((t, n) => ({ appId: app.id, taskId: t.id, type: 'task.assigned', subjectWorkerId: liam.id, actorUserId: manager.id, createdAt: new Date(created.getTime() + n) })),
    });
    const sizes: number[] = [];
    let at = Date.now();
    try {
      for (;;) {
        const page = await dueFor(ctx(manager.id), new Date(at));
        if (page.wakes.length === 0) break;
        const w = page.wakes[0]!;
        expect(w.proof.length).toBeLessThanOrEqual(MAX_PROOF_CHARS);
        sizes.push(taskReasons(page, liam.id).length);
        // Acknowledged now; then the clock moves past the floor for the next batch.
        expect(await ack(w.proof)).toEqual({ acknowledged: 1, unchanged: 0 });
        at = Date.now() + 3 * MIN;
        vi.setSystemTime(new Date(at));
      }
    } finally {
      vi.useRealTimers();
    }
    expect(sizes).toEqual([WAKE_TASK_REASONS_MAX, WAKE_TASK_REASONS_MAX, 20]);
    expect(await db.workerDeliveryTaskEvent.count({ where: { workerId: liam.id, deliveredAt: { not: null } } })).toBe(120);
  });
});

describe('authority is decided at issuance, not before it (Riana P2-1 on #1859)', () => {
  it("a holder removed from the App while the read is in flight gets no task title or proof", async () => {
    await assignedTo(liam);
    // The removal commits at the issue transaction's entry: after every pre-transaction read, before the issue.
    const original = db.$transaction.bind(db);
    let fired = false;
    const spy = vi.spyOn(db, '$transaction').mockImplementation(((arg: unknown, opts?: unknown) => {
      if (!fired && typeof arg === 'function') {
        fired = true;
        return M.removeAppMember({}, { appId: app.id, userId: holder.id }, ctx(manager.id)).then(() => original(arg as never, opts as never));
      }
      return original(arg as never, opts as never);
    }) as never);
    try {
      const page = await Q.dueWakes({}, { appRef: app.id }, ctx(holder.id));
      expect(fired).toBe(true);
      expect(JSON.stringify(page)).not.toContain('Review #42');
      expect(page.wakes).toEqual([]);
    } finally {
      spy.mockRestore();
    }
    expect(await db.appMember.count({ where: { appId: app.id, userId: holder.id } })).toBe(0);
  });

  it('a platform ADMIN demoted while the read is in flight gets no task title or proof (Riana delta on #1859)', async () => {
    // Not a member of the App: a reader of its tasks only by the ADMIN role.
    const admin = await db.user.update({ where: { id: (await mkUser(4)).id }, data: { roles: ['ADMIN'] }, select: { id: true } });
    const demoter = await db.user.update({ where: { id: (await mkUser(5)).id }, data: { roles: ['ADMIN'] }, select: { id: true } });
    await assignedTo(liam);
    const adminCtx = { db, userId: admin.id, roles: ['ADMIN'] } as unknown as Context;
    expect(taskReasons(await dueFor(adminCtx), liam.id)).toHaveLength(1); // the control: the role reads it
    await db.appWakeReservation.deleteMany();
    const original = db.$transaction.bind(db);
    let fired = false;
    const spy = vi.spyOn(db, '$transaction').mockImplementation(((arg: unknown, opts?: unknown) => {
      if (!fired && typeof arg === 'function') {
        fired = true;
        const demoterCtx = { db, userId: demoter.id, roles: ['ADMIN'] } as unknown as Context;
        return M.updateUserRoles({}, { userId: admin.id, roles: ['READER'] }, demoterCtx).then(() => original(arg as never, opts as never));
      }
      return original(arg as never, opts as never);
    }) as never);
    try {
      const page = await Q.dueWakes({}, { appRef: app.id }, adminCtx);
      expect(fired).toBe(true);
      expect(JSON.stringify(page)).not.toContain('Review #42');
      expect(page.wakes).toEqual([]);
    } finally {
      spy.mockRestore();
    }
    expect((await db.user.findUniqueOrThrow({ where: { id: admin.id } })).roles).toEqual(['READER']);
  });

  it('the same read with the holder still a member does carry the task (the control)', async () => {
    await assignedTo(liam);
    const page = await Q.dueWakes({}, { appRef: app.id }, ctx(holder.id));
    expect(page.wakes.map((w: any) => w.reasons.map((r: any) => r.task?.title))).toEqual([['Review #42']]);
  });
});

describe('dueness follows Tickers, not session liveness (Colin P3 on #1859)', () => {
  it('a worker idle for two days (session lapsed, not dormant) is woken by a MATCHED assignment', async () => {
    await db.session.create({ data: { id: generateId(), appId: app.id, userId: holder.id, workerId: liam.id, agentId: agent.id, type: 'DEVELOPER', startedAt: new Date(Date.now() - 2 * DAY), updatedAt: new Date(Date.now() - 2 * DAY) } });
    await assignedTo(liam, 'assignment.matched');
    const page = await dueFor();
    expect(taskReasons(page, liam.id).map((r) => r.event)).toEqual(['MATCHED']);
    expect((await taskStallTick(db, new Date())).undeliverable).toBe(0);
  });

  it('a dormant subject: the read writes nothing; the full stall tick records it once', async () => {
    await db.session.create({ data: { id: generateId(), appId: app.id, userId: holder.id, workerId: liam.id, agentId: agent.id, type: 'DEVELOPER', startedAt: new Date(Date.now() - 100 * DAY), updatedAt: new Date(Date.now() - 100 * DAY), endedAt: new Date(Date.now() - 100 * DAY) } });
    await assignedTo(liam);
    expect(dueIds(await dueFor())).toEqual([]);
    expect(await db.workerDeliveryTaskEvent.count()).toBe(0); // a read never records
    expect((await taskStallTick(db, new Date())).undeliverable).toBe(1);
    expect((await taskStallTick(db, new Date(Date.now() + MIN))).undeliverable).toBe(0);
    expect(await db.workerDeliveryTaskEvent.count({ where: { undeliverableReason: 'dormant', deliveredAt: null } })).toBe(1);
  });
});

describe('#2138 §3.6 — a team pause silences task-event wakes too', () => {
  it('a task.assigned wake is due, not due while the team is paused, due again when it resumes', async () => {
    await assignedTo(liam);
    expect(dueIds(await dueFor())).toEqual([liam.id]);
    await db.app.update({ where: { id: app.id }, data: { teamPausedAt: new Date() } });
    expect(dueIds(await dueFor())).toEqual([]);
    await db.app.update({ where: { id: app.id }, data: { teamPausedAt: null } });
    expect(dueIds(await dueFor())).toEqual([liam.id]);
  });
});
