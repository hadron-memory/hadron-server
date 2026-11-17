/**
 * #4202 — an event counts for a task only when the task is in the EVENT's App (cor:agt:050:01, :11, :12, :13, :15, :21).
 *
 * `agent_team_events.task_id` is a plain column with no foreign key, so a legacy or hand-made row can name a task of
 * another App. No write path makes one; the reads must still count it for nothing: no wake, no foreign task metadata,
 * no progress, no episode end, no activity. Every pin below plants such a row by raw insert and pairs it with a
 * same-App control that must keep working.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../id.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../workerSignature.js';
import { endedAlarmEpisodeInstants, effectiveWindows, loadStallInputs, STALL_EVENT_TYPE, stallCandidates, wakeDueOwners } from './stall.js';
import { pendingTaskWakes } from './taskWakes.js';
import { loadTeamRoster } from './roster.js';
import { resolvers, type Context } from '../../api/graphql/schema/resolvers.js';

vi.mock('../../lib/bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));

const MIN = 60_000;
const now = new Date();
const ago = (minutes: number) => new Date(now.getTime() - minutes * MIN);

type Side = { app: { id: string }; worker: { id: string }; user: { id: string } };
let A: Side;
let B: Side;

async function makeSide(label: string): Promise<Side> {
  const suffix = `${label}-${generateId().slice(-8)}`;
  const org = await db.organization.create({ data: { id: generateId(), name: `org-${suffix}`, urn: `org-${suffix}.test` } });
  const user = await db.user.create({ data: { id: generateId(), handle: `u-${suffix}` } });
  const agent = await db.agent.create({ data: { id: generateId(), organizationId: org.id, name: `Agent ${label}`, urn: `${org.urn}:agent`, visibility: 'ORGANIZATION' } });
  const app = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: `App ${label}`, urn: `${org.urn}:app` } });
  await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
  await db.appMember.create({ data: { appId: app.id, userId: user.id, role: 'member' } });
  const worker = await db.worker.create({
    data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId: app.id, agentId: agent.id, name: `W${label}`, slug: `w-${suffix}`, role: 'engineer', heldByUserId: user.id, heldAt: new Date() },
    select: { id: true },
  });
  return { app, worker, user };
}

/** A started task of `side`, assigned to its worker, started `startedMinutesAgo` ago. */
function makeTask(side: Side, title: string, over: Record<string, unknown> = {}) {
  return db.agentTask.create({
    data: {
      id: generateId(), appId: side.app.id, title, status: 'started',
      assigneeWorkerId: side.worker.id, ownerWorkerId: side.worker.id,
      assignedAt: ago(300), startedAt: ago(240), createdAt: ago(320),
      ...(over.status === 'finished' ? { resultOutcome: 'succeeded' } : {}), ...over,
    } as never,
  });
}

/** A raw event row: the schema accepts any task_id, which is the precondition of the issue. */
async function plant(e: { appId: string; type: string; taskId: string | null; at: Date; actorWorkerId?: string; actorUserId?: string; subjectWorkerId?: string; severity?: string; chain?: unknown; episodeStart?: Date; payload?: unknown }) {
  const id = generateId();
  await db.agentTeamEvent.create({
    data: {
      id, appId: e.appId, type: e.type, taskId: e.taskId, createdAt: e.at, actorWorkerId: e.actorWorkerId ?? null, actorUserId: e.actorUserId ?? null,
      subjectWorkerId: e.subjectWorkerId ?? null, severity: e.severity ?? null, chain: (e.chain ?? undefined) as never, episodeStart: e.episodeStart ?? null,
      payload: (e.payload ?? {}) as never,
    },
  });
  return id;
}

beforeEach(async () => {
  await cleanDb(db);
  A = await makeSide('a');
  B = await makeSide('b');
});

describe('#4202 progress (stall.ts loadStallInputs, the no-progress rule)', () => {
  it('a task.progress event of another App naming the task does not move lastProgressAt or clear the due candidate', async () => {
    const task = await makeTask(A, 'A task');
    const baseline = (await loadStallInputs(db, { id: task.id }, now))[0];
    expect(baseline.lastProgressAt).toBeNull();
    expect(stallCandidates(baseline, effectiveWindows(null), now).map((c) => c.rule)).toContain('no-progress');

    await plant({ appId: B.app.id, type: 'task.progress', taskId: task.id, at: ago(1) });

    const after = (await loadStallInputs(db, { id: task.id }, now))[0];
    expect(after.lastProgressAt).toBeNull();
    expect(stallCandidates(after, effectiveWindows(null), now).map((c) => c.rule)).toContain('no-progress');
  });

  it('control: a same-App note resets its own window', async () => {
    const task = await makeTask(A, 'A task');
    await plant({ appId: A.app.id, type: 'task.progress', taskId: task.id, at: ago(1), actorWorkerId: A.worker.id });
    const after = (await loadStallInputs(db, { id: task.id }, now))[0];
    expect(after.lastProgressAt?.getTime()).toBe(ago(1).getTime());
    expect(stallCandidates(after, effectiveWindows(null), now).map((c) => c.rule)).not.toContain('no-progress');
  });

  it('control: an event in App A naming an unrelated task of B changes nothing for A\'s task', async () => {
    const task = await makeTask(A, 'A task');
    const other = await makeTask(B, 'B task');
    await plant({ appId: A.app.id, type: 'task.progress', taskId: other.id, at: ago(1) });
    expect((await loadStallInputs(db, { id: task.id }, now))[0].lastProgressAt).toBeNull();
  });

  it('startBy and finishBy edits of another App naming the task are not read', async () => {
    const task = await makeTask(A, 'A task', { finishBy: new Date(now.getTime() + 60 * MIN) });
    await plant({ appId: B.app.id, type: 'task.edited', taskId: task.id, at: ago(2), payload: { fields: ['startBy', 'finishBy'] } });
    const input = (await loadStallInputs(db, { id: task.id }, now))[0];
    expect(input.startByEditedAt ?? null).toBeNull();
    expect(input.finishByEditedAt ?? null).toBeNull();
  });
});

describe('#4315 item 8: a foreign assignment.queued event and foreign finish-by alarm history are read for nothing', () => {
  const queuedTask = (side: Side) => makeTask(side, 'queued task', { status: 'pending', assigneeWorkerId: null, ownerWorkerId: null, ownerUserId: side.user.id, assignedAt: null, startedAt: null });

  it('a foreign assignment.queued naming the task does not become its queuedAt (the unassignable episode starts at the task\'s own creation)', async () => {
    const task = await queuedTask(A);
    await plant({ appId: B.app.id, type: 'assignment.queued', taskId: task.id, at: ago(60) });
    const input = (await loadStallInputs(db, { id: task.id }, now))[0];
    expect(input.queuedAt ?? null).toBeNull();
    const unassignable = stallCandidates(input, effectiveWindows(null), now).find((c) => c.rule === 'unassignable');
    expect(unassignable?.episodeStart.getTime()).toBe(task.createdAt.getTime());
  });

  it('control: a same-App assignment.queued IS the queuedAt, and the unassignable episode starts there', async () => {
    const task = await queuedTask(A);
    await plant({ appId: A.app.id, type: 'assignment.queued', taskId: task.id, at: ago(60) });
    const input = (await loadStallInputs(db, { id: task.id }, now))[0];
    expect(input.queuedAt?.getTime()).toBe(ago(60).getTime());
    const unassignable = stallCandidates(input, effectiveWindows(null), now).find((c) => c.rule === 'unassignable');
    expect(unassignable?.episodeStart.getTime()).toBe(ago(60).getTime());
  });

  it('a foreign finish-by alarm in the history does not become the finish-by episode start', async () => {
    const finishBy = ago(30);
    const task = await makeTask(A, 'A task', { finishBy });
    await plant({ appId: B.app.id, type: STALL_EVENT_TYPE['finish-by'], taskId: task.id, at: ago(20), severity: 'alarm', episodeStart: ago(20), chain: [] });
    const input = (await loadStallInputs(db, { id: task.id }, now))[0];
    expect(input.finishByAlarmStart ?? null).toBeNull();
    const finishByCandidate = stallCandidates(input, effectiveWindows(null), now).find((c) => c.rule === 'finish-by');
    expect(finishByCandidate?.episodeStart.getTime()).toBe(finishBy.getTime());
  });

  it('control: a same-App finish-by alarm in the history IS the episode start', async () => {
    const finishBy = ago(30);
    const task = await makeTask(A, 'A task', { finishBy });
    await plant({ appId: A.app.id, type: STALL_EVENT_TYPE['finish-by'], taskId: task.id, at: ago(20), severity: 'alarm', episodeStart: ago(20), chain: [] });
    const input = (await loadStallInputs(db, { id: task.id }, now))[0];
    expect(input.finishByAlarmStart?.getTime()).toBe(ago(20).getTime());
  });
});

describe('#4202 episode end (stall.ts, the first-transition read)', () => {
  it("a foreign task.progress after the episode began does not become the end of a finished task's alarm", async () => {
    const finishedAt = ago(10);
    const task = await makeTask(A, 'A task', { status: 'finished', finishedAt });
    const episodeStart = ago(200);
    await plant({ appId: B.app.id, type: 'task.progress', taskId: task.id, at: ago(50) });
    const ends = await endedAlarmEpisodeInstants(db, [{ appId: task.appId, taskId: task.id, type: 'stall.no-progress', episodeStart }], now);
    expect([...ends.values()].map((d) => d.getTime())).toEqual([finishedAt.getTime()]);
  });

  it('control: a same-App note after the episode began is the end', async () => {
    const task = await makeTask(A, 'A task', { status: 'finished', finishedAt: ago(10) });
    const episodeStart = ago(200);
    await plant({ appId: A.app.id, type: 'task.progress', taskId: task.id, at: ago(50), actorWorkerId: A.worker.id });
    const ends = await endedAlarmEpisodeInstants(db, [{ appId: task.appId, taskId: task.id, type: 'stall.no-progress', episodeStart }], now);
    expect([...ends.values()].map((d) => d.getTime())).toEqual([ago(50).getTime()]);
  });

  it("a foreign task.reassigned naming the task does not move the holder's stint, so the assignee's own earlier activity is still the end", async () => {
    const task = await makeTask(A, 'A task', { status: 'finished', finishedAt: ago(10) });
    const episodeStart = ago(200);
    const w = await db.worker.findUniqueOrThrow({ where: { id: A.worker.id }, select: { agentId: true } });
    await db.session.create({ data: { id: generateId(), appId: A.app.id, userId: A.user.id, workerId: A.worker.id, agentId: w.agentId, type: 'DEVELOPER', startedAt: ago(150), updatedAt: ago(150) } });
    await plant({ appId: B.app.id, type: 'task.reassigned', taskId: task.id, at: ago(100), payload: { from: { workerId: B.worker.id }, to: { workerId: A.worker.id } } });
    const ends = await endedAlarmEpisodeInstants(db, [{ appId: task.appId, taskId: task.id, type: 'stall.no-progress', episodeStart }], now);
    expect([...ends.values()].map((d) => d.getTime())).toEqual([ago(150).getTime()]);
  });

  it('an alarm whose App differs from its task\'s App is not classified from the task', async () => {
    const task = await makeTask(B, 'B task', { status: 'finished', finishedAt: ago(10) });
    const ends = await endedAlarmEpisodeInstants(db, [{ taskId: task.id, type: 'stall.no-progress', episodeStart: ago(200), appId: A.app.id }], now);
    expect(ends.size).toBe(0);
  });
});

describe('#4202 a person owner\'s activity (cor:agt:050:12)', () => {
  it('a call of the owner recorded against a task of another App is not their activity in this App', async () => {
    const parent = await makeTask(A, 'parent');
    const foreignTask = await makeTask(B, 'B task');
    await makeTask(A, 'child', { parentTaskId: parent.id, status: 'finished', finishedAt: ago(100), ownerWorkerId: null, ownerUserId: A.user.id, assigneeWorkerId: null, assigneeUserId: A.user.id });
    await plant({ appId: A.app.id, type: 'task.progress', taskId: foreignTask.id, at: ago(5), actorUserId: A.user.id });
    const input = (await loadStallInputs(db, { id: parent.id }, now))[0];
    expect(input.endedChildren.map((c) => c.ownerActivityAt)).toEqual([null]);
  });

  it('control: a call recorded against a task of this App is', async () => {
    const parent = await makeTask(A, 'parent');
    await makeTask(A, 'child', { parentTaskId: parent.id, status: 'finished', finishedAt: ago(100), ownerWorkerId: null, ownerUserId: A.user.id, assigneeWorkerId: null, assigneeUserId: A.user.id });
    await plant({ appId: A.app.id, type: 'task.progress', taskId: parent.id, at: ago(5), actorUserId: A.user.id });
    const input = (await loadStallInputs(db, { id: parent.id }, now))[0];
    expect(input.endedChildren.map((c) => c.ownerActivityAt?.getTime())).toEqual([ago(5).getTime()]);
  });
});

describe('#4202 task wakes (taskWakes.ts)', () => {
  const taskIds = (m: Map<string, { taskId: string }[]>, worker: string) => (m.get(worker) ?? []).map((w) => w.taskId);

  it('an assignment event of another App naming the worker\'s task does not wake it', async () => {
    const task = await makeTask(B, 'B task', { status: 'pending', startedAt: null });
    await plant({ appId: A.app.id, type: 'task.assigned', taskId: task.id, at: ago(3), subjectWorkerId: B.worker.id, payload: { assignee: { workerId: B.worker.id } } });
    expect(taskIds(await pendingTaskWakes(db, [B.worker.id], now), B.worker.id)).toEqual([]);
  });

  it('control: the same event in the task\'s own App wakes it', async () => {
    const task = await makeTask(B, 'B task', { status: 'pending', startedAt: null });
    await plant({ appId: B.app.id, type: 'task.assigned', taskId: task.id, at: ago(3), subjectWorkerId: B.worker.id, payload: { assignee: { workerId: B.worker.id } } });
    expect(taskIds(await pendingTaskWakes(db, [B.worker.id], now), B.worker.id)).toEqual([task.id]);
  });

  it('an activity row of another App naming the task does not suppress a real wake', async () => {
    const task = await makeTask(B, 'B task', { status: 'pending', startedAt: null });
    await plant({ appId: B.app.id, type: 'task.assigned', taskId: task.id, at: ago(10), subjectWorkerId: B.worker.id, payload: { assignee: { workerId: B.worker.id } } });
    await plant({ appId: A.app.id, type: 'task.progress', taskId: task.id, at: ago(5), actorWorkerId: B.worker.id });
    expect(taskIds(await pendingTaskWakes(db, [B.worker.id], now), B.worker.id)).toEqual([task.id]);
  });

  it('a child\'s finish recorded in another App does not wake the owner', async () => {
    const parent = await makeTask(B, 'parent');
    const child = await makeTask(B, 'child', { parentTaskId: parent.id, status: 'finished', finishedAt: ago(4) });
    await plant({ appId: A.app.id, type: 'task.finished', taskId: child.id, at: ago(4), actorWorkerId: A.worker.id });
    expect(taskIds(await pendingTaskWakes(db, [B.worker.id], now), B.worker.id)).toEqual([]);
  });

  it("an owner's activity on the parent recorded in another App does not suppress the child-finish wake", async () => {
    const parent = await makeTask(B, 'parent');
    const child = await makeTask(B, 'child', { parentTaskId: parent.id, status: 'finished', finishedAt: ago(10) });
    await plant({ appId: B.app.id, type: 'task.finished', taskId: child.id, at: ago(10), actorWorkerId: A.worker.id });
    await plant({ appId: A.app.id, type: 'task.progress', taskId: parent.id, at: ago(5), actorWorkerId: B.worker.id });
    expect(taskIds(await pendingTaskWakes(db, [B.worker.id], now), B.worker.id)).toEqual([child.id]);
  });

  it('control: a child\'s finish in its own App wakes the owner', async () => {
    const parent = await makeTask(B, 'parent');
    const child = await makeTask(B, 'child', { parentTaskId: parent.id, status: 'finished', finishedAt: ago(4) });
    await plant({ appId: B.app.id, type: 'task.finished', taskId: child.id, at: ago(4), actorWorkerId: A.worker.id });
    expect(taskIds(await pendingTaskWakes(db, [B.worker.id], now), B.worker.id)).toEqual([child.id]);
  });

  it('an alarm in App A naming task B never carries B\'s id, title or handle into worker A\'s wake', async () => {
    const taskB = await makeTask(B, 'B secret title');
    // A real, current no-progress episode of task B, so the only thing refusing the row is the App match.
    const episodeStart = (stallCandidates((await loadStallInputs(db, { id: taskB.id }, now))[0], effectiveWindows(null), now).find((c) => c.rule === 'no-progress'))!.episodeStart;
    const alarm = await plant({
      appId: A.app.id, type: 'stall.no-progress', taskId: taskB.id, at: ago(2), severity: 'alarm', episodeStart,
      chain: [{ workerId: A.worker.id }],
    });
    await db.$executeRaw`INSERT INTO agent_team_alarm_schedule (event_id, chain_index, due_at, woken_at) VALUES (${alarm}, 0, ${ago(2)}, ${ago(2)})`;
    const wakes = await pendingTaskWakes(db, [A.worker.id], now);
    expect(JSON.stringify([...wakes.values()])).not.toContain('B secret title');
    expect(taskIds(wakes, A.worker.id)).toEqual([]);
  });
});

describe('#4202 the due-wake pass and the acknowledgement freeze (BLIND F1 and LOCAL P3-1 on #4212 at 82201be6)', () => {
  const noProgressStart = async (task: { id: string }) =>
    (stallCandidates((await loadStallInputs(db, { id: task.id }, now))[0], effectiveWindows(null), now).find((c) => c.rule === 'no-progress'))!.episodeStart;
  /** Two UNWOKEN rows of `alarm`, both due. The column is a naive timestamp, so the bind is naive-UTC text. */
  const dueRows = async (alarm: string) => {
    const due = ago(2).toISOString().replace('Z', '');
    await db.$executeRaw`INSERT INTO agent_team_alarm_schedule (event_id, chain_index, due_at) VALUES (${alarm}, 0, ${due}::timestamp), (${alarm}, 1, ${due}::timestamp)`;
  };
  const rowsOf = (alarm: string) => db.agentTeamAlarmSchedule.findMany({ where: { eventId: alarm }, select: { wokenAt: true, endedAt: true }, orderBy: { chainIndex: 'asc' } });

  it('an alarm of App A naming a running task of App B: wakeDueOwners stamps none of its due rows', async () => {
    const taskB = await makeTask(B, 'B task');
    const alarm = await plant({
      appId: A.app.id, type: 'stall.no-progress', taskId: taskB.id, at: ago(5), severity: 'alarm', episodeStart: await noProgressStart(taskB),
      chain: [{ workerId: A.worker.id }, { workerId: A.worker.id }],
    });
    await dueRows(alarm);
    expect(await wakeDueOwners(db, now)).toBe(0);
    expect(await rowsOf(alarm)).toEqual([{ wokenAt: null, endedAt: null }, { wokenAt: null, endedAt: null }]);
  });

  it('control: the same alarm naming a running task of its own App is woken', async () => {
    const taskA = await makeTask(A, 'A task');
    const alarm = await plant({
      appId: A.app.id, type: 'stall.no-progress', taskId: taskA.id, at: ago(5), severity: 'alarm', episodeStart: await noProgressStart(taskA),
      chain: [{ workerId: A.worker.id }, { workerId: A.worker.id }],
    });
    await dueRows(alarm);
    expect(await wakeDueOwners(db, now)).toBe(2);
    expect((await rowsOf(alarm)).map((r) => r.wokenAt !== null)).toEqual([true, true]);
  });

  it('acknowledging an alarm of App A naming a FINISHED task of App B records no episode end from that task', async () => {
    const taskB = await makeTask(B, 'B task', { status: 'finished', finishedAt: ago(10) });
    const alarm = await plant({ appId: A.app.id, type: 'stall.no-progress', taskId: taskB.id, at: ago(100), severity: 'alarm', episodeStart: ago(200), chain: [{ userId: A.user.id }] });
    await (resolvers.Mutation as any).acknowledgeAlarm({}, { eventId: alarm }, { db, userId: A.user.id, roles: ['READER'] } as Context);
    expect((await db.agentTeamEvent.findUniqueOrThrow({ where: { id: alarm } })).acknowledgedAt).not.toBeNull();
    expect(await db.alarmEscalationEnd.count({ where: { eventId: alarm } })).toBe(0);
  });

  it('control: acknowledging the same alarm naming a finished task of its own App records the end', async () => {
    const taskA = await makeTask(A, 'A task', { status: 'finished', finishedAt: ago(10) });
    const alarm = await plant({ appId: A.app.id, type: 'stall.no-progress', taskId: taskA.id, at: ago(100), severity: 'alarm', episodeStart: ago(200), chain: [{ userId: A.user.id }] });
    await (resolvers.Mutation as any).acknowledgeAlarm({}, { eventId: alarm }, { db, userId: A.user.id, roles: ['READER'] } as Context);
    expect(await db.alarmEscalationEnd.count({ where: { eventId: alarm } })).toBe(1);
  });
});

describe('#4202 the roster and the external-id change feed', () => {
  it('an alarm of App A naming a task of App B is not worker A\'s move on the roster', async () => {
    const taskB = await makeTask(B, 'B task');
    const alarm = await plant({ appId: A.app.id, type: 'stall.no-progress', taskId: taskB.id, at: ago(2), severity: 'alarm', episodeStart: ago(100), chain: [{ workerId: A.worker.id }] });
    await db.$executeRaw`INSERT INTO agent_team_alarm_schedule (event_id, chain_index, due_at, woken_at) VALUES (${alarm}, 0, ${ago(2)}, ${ago(2)})`;
    const entry = (await loadTeamRoster(db, A.app.id, now)).find((r: { workerId?: string; id?: string }) => (r.workerId ?? r.id) === A.worker.id);
    expect(entry?.state).not.toBe('YOUR_MOVE');
  });

  it('control: the same alarm naming a task of its own App is', async () => {
    const taskA = await makeTask(A, 'A task');
    const episodeStart = stallCandidates((await loadStallInputs(db, { id: taskA.id }, now))[0], effectiveWindows(null), now).find((c) => c.rule === 'no-progress')!.episodeStart;
    const alarm = await plant({ appId: A.app.id, type: 'stall.no-progress', taskId: taskA.id, at: ago(2), severity: 'alarm', episodeStart, chain: [{ workerId: A.worker.id }] });
    await db.$executeRaw`INSERT INTO agent_team_alarm_schedule (event_id, chain_index, due_at, woken_at) VALUES (${alarm}, 0, ${ago(2)}, ${ago(2)})`;
    const entry = (await loadTeamRoster(db, A.app.id, now)).find((r: { workerId?: string; id?: string }) => (r.workerId ?? r.id) === A.worker.id);
    expect(entry?.state).toBe('YOUR_MOVE');
  });

  const X = 'https://example.test/issues/4202';
  // #4315 item 7: the wait for the transaction-visibility condition reports whether it was reached. It used to give up silently after
  // 200 x 50 ms (longer than the 5000 ms test timeout), so a negative pin could pass without examining the planted event, or time
  // out with nothing to say why. The bound is now inside the tests' own timeout and a miss throws.
  const FEED_TIMEOUT_MS = 30_000;
  const feed = async (wait: { attempts: number; intervalMs: number } = { attempts: 400, intervalMs: 50 }, snapshotDone: (x: string) => Promise<boolean> = async (x) => {
    const [{ done }] = await db.$queryRaw<{ done: boolean }[]>`SELECT pg_snapshot_xmin(pg_current_snapshot()) > ${x}::xid8 AS done`;
    return done;
  }) => {
    // xmin is cluster-wide: wait until every transaction that began before this call has ended (as the #4084 tests do).
    const [{ x }] = await db.$queryRaw<{ x: string }[]>`SELECT pg_current_xact_id()::text AS x`;
    let reached = false;
    for (let i = 0; i < wait.attempts && !reached; i++) {
      reached = await snapshotDone(x);
      if (!reached) await new Promise((r) => setTimeout(r, wait.intervalMs));
    }
    if (!reached) throw new Error(`the change feed's visibility condition was never reached (xmin did not pass ${x} within ${wait.attempts} x ${wait.intervalMs} ms): a transaction elsewhere on the cluster is still open, so this pin cannot examine the planted event`);
    const ctx = { db, userId: A.user.id, roles: ['READER'] } as Context;
    return (resolvers as any).Query.agentTaskExternalIdChanges(null, { appRef: A.app.id }, ctx);
  };

  it('#4315 item 7: when the visibility condition is never reached the helper throws its descriptive error, never a silent pass', async () => {
    await expect(feed({ attempts: 3, intervalMs: 1 }, async () => false)).rejects.toThrow(/visibility condition was never reached.*xmin did not pass/);
  });

  it('a change in App A naming a task of App B never carries B\'s external id into A\'s feed', async () => {
    const taskB = await makeTask(B, 'B task', { externalId: X });
    await plant({ appId: A.app.id, type: 'task.assigned', taskId: taskB.id, at: ago(1), payload: { type: 'task.assigned' } });
    expect(JSON.stringify(await feed(), (_k, v) => (typeof v === 'bigint' ? v.toString() : v))).not.toContain(X);
  }, FEED_TIMEOUT_MS);

  it('control: a change of a task of App A carries its external id', async () => {
    const taskA = await makeTask(A, 'A task', { externalId: X });
    await plant({ appId: A.app.id, type: 'task.assigned', taskId: taskA.id, at: ago(1), payload: { type: 'task.assigned' } });
    expect(JSON.stringify(await feed(), (_k, v) => (typeof v === 'bigint' ? v.toString() : v))).toContain(X);
  }, FEED_TIMEOUT_MS);
});
