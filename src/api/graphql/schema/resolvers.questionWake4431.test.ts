/**
 * #4431 (Questions S7): an answer wakes the asking worker's task. A worker links a question to one of its own open
 * tasks (`taskRef`); an answer or a take-back appends one `question.answered` / `question.answer-retracted` event on
 * that task, inside the answer's transaction, carrying ids, the code, the revision and the state only (cor:agt:050:11,
 * never the answer); `pendingTaskWakes` makes the task's CURRENT assignee due an ANSWERED wake for an answer, never for
 * a take-back, until delivered or the assignee acts on the task (Vera's draft cor:agt:050:34, modelled on :33).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GraphQLError } from 'graphql';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { runAsActor } from '../../../lib/requestActor.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
import { questionDataSchema } from '../../../lib/questions/codec.js';
import { pendingTaskWakes } from '../../../lib/agentTasks/taskWakes.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../lib/bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));

const MIN = 60_000;
const M = resolvers.Mutation as unknown as Record<string, (p: unknown, a: unknown, c: Context) => Promise<any>>;
const D = (resolvers as unknown as { Question: Record<string, (v: any, a: unknown, ctx: Context) => any> }).Question;

let admin: { id: string };
let holder: { id: string };
let decider: { id: string };
let app: { id: string };
let otherApp: { id: string };
let agent: { id: string };
let asker: { id: string };
let bea: { id: string };
let foreign: { id: string };
let memory: { id: string };
let logId: string;

const as = (userId: string): Context => ({ db, userId, roles: [] }) as Context;
const asWorker = <T>(workerId: string, fn: () => Promise<T>) => runAsActor({ workerId, agentId: agent.id, userId: holder.id }, fn);

const errorOf = async (p: Promise<unknown>): Promise<GraphQLError | null> => {
  try { await p; return null; } catch (e) { return e as GraphQLError; }
};

const mkUser = (n: number) =>
  db.user.create({ data: { id: generateId(), githubId: 4_431_000 + n, githubUsername: `qw-${n}`, handle: `qw-${n}`, roles: [] }, select: { id: true } });
const mkWorker = (appId: string, name: string) =>
  db.worker.create({
    data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId, agentId: agent.id, name, slug: name.toLowerCase(), heldByUserId: holder.id, heldAt: new Date() },
    select: { id: true },
  });
const mkTask = (data: Record<string, unknown> = {}) =>
  db.agentTask.create({
    data: { appId: app.id, title: 'Build #42', ownerUserId: admin.id, status: 'started', assigneeWorkerId: asker.id, assignedAt: new Date(Date.now() - 60 * MIN), startedAt: new Date(Date.now() - 50 * MIN), ...data },
    select: { id: true, handle: true },
  });

const ASK = { title: 'Which datastore?', options: [{ key: 'pg', label: 'Postgres' }, { key: 'kv', label: 'A key-value store' }], recommendation: { key: 'pg', reason: 'already run it' } };
const ask = (input: Record<string, unknown>, workerId: string | null = asker.id) =>
  workerId ? asWorker(workerId, () => M.askQuestion(null, { logRef: logId, input: { ...ASK, ...input } }, as(holder.id)))
    : M.askQuestion(null, { logRef: logId, input: { ...ASK, ...input } }, as(holder.id));
const answer = (id: string, revision: number, input: Record<string, unknown> = { optionKey: 'pg' }) =>
  M.answerQuestion(null, { ref: id, input, expectedRevision: revision }, as(decider.id));
const retract = (id: string, revision: number) => M.retractQuestionAnswer(null, { ref: id, expectedRevision: revision, reason: 'not yet' }, as(decider.id));
const questionEvents = (taskId: string) =>
  db.agentTeamEvent.findMany({ where: { taskId, type: { startsWith: 'question.' } }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
const wakesOf = async (workerId: string, now = new Date(Date.now() + MIN)) =>
  ((await pendingTaskWakes(db, [workerId], now)).get(workerId) ?? []).map((w) => ({ taskId: w.taskId, eventId: w.eventId, event: w.event }));

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), name: 'Wake Org', urn: `wake-${generateId().slice(-8).toLowerCase()}.example` } });
  [admin, holder, decider] = [await mkUser(1), await mkUser(2), await mkUser(3)];
  await db.orgMember.createMany({ data: [
    { organizationId: org.id, userId: admin.id, role: 'ADMIN' },
    { organizationId: org.id, userId: holder.id, role: 'CONTRIBUTOR' },
    { organizationId: org.id, userId: decider.id, role: 'CONTRIBUTOR' },
  ] });
  agent = await db.agent.create({ data: { id: generateId(), organizationId: org.id, name: 'Team', urn: `${org.urn}:team`, visibility: 'ORGANIZATION' }, select: { id: true } });
  app = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Team', urn: `${org.urn}:team` }, select: { id: true } });
  otherApp = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Other', urn: `${org.urn}:other` }, select: { id: true } });
  for (const a of [app, otherApp]) {
    await db.appAgent.create({ data: { appId: a.id, agentId: agent.id } });
    await db.appMember.createMany({ data: [holder, decider, admin].map((u) => ({ appId: a.id, userId: u.id, role: 'member' })) });
  }
  asker = await mkWorker(app.id, 'Asker');
  bea = await mkWorker(app.id, 'Bea');
  foreign = await mkWorker(otherApp.id, 'Foreign');
  // An App memory: its App's participants write it, so the decider and the asking worker's holder both can.
  memory = await db.memory.create({ data: { id: generateId(), class: 'app', appId: app.id, organizationId: org.id, name: 'team questions', urn: `${org.urn}:team-questions` }, select: { id: true } });
  logId = (await M.createQuestionLog(null, { memoryRef: memory.id, loc: 'questions', defaultDeciders: [decider.id] }, as(admin.id))).row.id;
});

const LINK_MESSAGE = 'taskRef must be an open task assigned to the asking worker, in the App this memory belongs to';

describe('#4431 §1: a worker links a question to its own open task', () => {
  it('accepted by id or by handle: the payload stores the resolved id and Question.taskId returns it', async () => {
    const t = await mkTask();
    const byId = await ask({ taskRef: t.id });
    expect(D.taskId(byId, {}, as(holder.id))).toBe(t.id);
    expect(questionDataSchema.parse((await db.node.findUniqueOrThrow({ where: { id: byId.row.id } })).data).taskId).toBe(t.id);
    const byHandle = await ask({ taskRef: t.handle });
    expect(D.taskId(byHandle, {}, as(holder.id))).toBe(t.id);
    // The renderer names the task under what the question blocks; the state is OPEN with no findings.
    expect(byId.row.content).toContain(`**Blocks task:** ${t.id}`);
    expect(D.state(byId, {}, as(holder.id))).toBe('OPEN');
  });

  it('refused QUESTION_INVALID at /taskRef with one fixed message, whatever the reason', async () => {
    const others = await mkTask({ assigneeWorkerId: bea.id });
    const finished = await mkTask({ status: 'finished', finishedAt: new Date(), resultOutcome: 'done' });
    const foreignTask = await db.agentTask.create({ data: { appId: otherApp.id, title: 'Theirs', ownerUserId: admin.id, status: 'started', assigneeWorkerId: foreign.id, assignedAt: new Date(), startedAt: new Date() }, select: { id: true } });
    const own = await mkTask();
    const cases: Array<[string, Promise<unknown>]> = [
      ['another worker\'s task', ask({ taskRef: others.id })],
      ['a finished task', ask({ taskRef: finished.id })],
      ['a task of another App (asked by its own assignee)', ask({ taskRef: foreignTask.id }, foreign.id)],
      ['a task id that does not exist', ask({ taskRef: generateId() })],
      ['a caller with no worker', ask({ taskRef: own.id }, null)],
    ];
    for (const [label, p] of cases) {
      const e = await errorOf(p);
      expect(e, label).not.toBeNull();
      expect(e!.extensions.code, label).toBe('QUESTION_INVALID');
      expect(e!.extensions.pointers ?? e!.extensions.errors, label).toEqual([{ pointer: '/taskRef', message: LINK_MESSAGE }]);
    }
  });

  it('amendQuestion cannot change the link', async () => {
    const t = await mkTask();
    const q = await ask({});
    const e = await errorOf(asWorker(asker.id, () => M.amendQuestion(null, { ref: q.row.id, input: { taskRef: t.id }, expectedRevision: q.row.revSeq, reason: 'link it' }, as(holder.id))));
    expect(e?.extensions.code).toBe('QUESTION_INVALID');
  });
});

describe('#4431 §2: one event on the task per answer and per take-back, in the answer\'s transaction', () => {
  it('payload keys are exactly questionId, code, revision, state; never the option, the text or the reason', async () => {
    const t = await mkTask();
    const q = await ask({ taskRef: t.id });
    const after = await answer(q.row.id, q.row.revSeq, { optionKey: 'kv', text: 'ZEBRA-TEXT-4431', reason: 'QUOKKA-REASON-4431' });
    const [e, ...more] = await questionEvents(t.id);
    expect(more).toHaveLength(0);
    expect(e).toMatchObject({ type: 'question.answered', appId: app.id, taskId: t.id, actorUserId: decider.id, actorWorkerId: null });
    expect(Object.keys(e!.payload as object).sort()).toEqual(['code', 'questionId', 'revision', 'state']);
    expect(e!.payload).toEqual({ questionId: q.row.id, code: D.code(q, {}, as(holder.id)), revision: after.row.revSeq, state: D.state(after, {}, as(holder.id)) });
    const serialised = JSON.stringify(e);
    for (const secret of ['ZEBRA-TEXT-4431', 'QUOKKA-REASON-4431', '"kv"', 'key-value']) expect(serialised).not.toContain(secret);
  });

  it('a take-back records question.answer-retracted with the same shape', async () => {
    const t = await mkTask();
    const q = await ask({ taskRef: t.id });
    const a = await answer(q.row.id, q.row.revSeq);
    const r = await retract(a.row.id, a.row.revSeq);
    const events = await questionEvents(t.id);
    expect(events.map((x) => x.type)).toEqual(['question.answered', 'question.answer-retracted']);
    expect(events[1]!.payload).toEqual({ questionId: q.row.id, code: D.code(q, {}, as(holder.id)), revision: r.row.revSeq, state: 'OPEN' });
    expect(JSON.stringify(events[1])).not.toContain('not yet');
  });

  it('a failed answer (stale expectedRevision) writes no event', async () => {
    const t = await mkTask();
    const q = await ask({ taskRef: t.id });
    const e = await errorOf(answer(q.row.id, q.row.revSeq + 7));
    expect(e?.extensions.code).toBe('NODE_WRITE_CONFLICT');
    expect(await questionEvents(t.id)).toHaveLength(0);
  });

  it('a task that is no longer open gets no event, and the answer still succeeds', async () => {
    const t = await mkTask();
    const q = await ask({ taskRef: t.id });
    await db.agentTask.update({ where: { id: t.id }, data: { status: 'finished', finishedAt: new Date(), resultOutcome: 'done' } });
    const after = await answer(q.row.id, q.row.revSeq);
    expect(D.state(after, {}, as(holder.id))).toBe('DECIDED');
    expect(await questionEvents(t.id)).toHaveLength(0);
  });
});

describe('#4431 §3: the answer wakes the task\'s current assignee', () => {
  it('one ANSWERED wake naming the task and the event; gone once delivered', async () => {
    const t = await mkTask();
    const q = await ask({ taskRef: t.id });
    await answer(q.row.id, q.row.revSeq);
    const [e] = await questionEvents(t.id);
    expect(await wakesOf(asker.id)).toEqual([{ taskId: t.id, eventId: e!.id, event: 'ANSWERED' }]);
    await db.workerDeliveryTaskEvent.create({ data: { workerId: asker.id, eventId: e!.id, chainIndex: 0, deliveredAt: new Date() } });
    expect(await wakesOf(asker.id)).toEqual([]);
  });

  it('gone without delivery once the worker acts on the task after the answer', async () => {
    const t = await mkTask();
    const q = await ask({ taskRef: t.id });
    await answer(q.row.id, q.row.revSeq);
    expect(await wakesOf(asker.id)).toHaveLength(1);
    await db.agentTeamEvent.create({ data: { appId: app.id, taskId: t.id, type: 'task.progress', actorWorkerId: asker.id, actorUserId: holder.id, createdAt: new Date(Date.now() + 1000) } });
    expect(await wakesOf(asker.id, new Date(Date.now() + 2 * MIN))).toEqual([]);
  });

  it('a re-answer is a new event and wakes again', async () => {
    const t = await mkTask();
    const q = await ask({ taskRef: t.id });
    const a = await answer(q.row.id, q.row.revSeq);
    const [first] = await questionEvents(t.id);
    await db.workerDeliveryTaskEvent.create({ data: { workerId: asker.id, eventId: first!.id, chainIndex: 0, deliveredAt: new Date() } });
    await answer(a.row.id, a.row.revSeq, { optionKey: 'kv' });
    const all = await questionEvents(t.id);
    expect(await wakesOf(asker.id)).toEqual([{ taskId: t.id, eventId: all[1]!.id, event: 'ANSWERED' }]);
  });

  it('§4 a task reassigned before the answer wakes its new assignee, not the asker', async () => {
    const t = await mkTask();
    const q = await ask({ taskRef: t.id });
    await db.agentTask.update({ where: { id: t.id }, data: { assigneeWorkerId: bea.id } });
    await answer(q.row.id, q.row.revSeq);
    expect((await wakesOf(bea.id)).map((w) => w.event)).toEqual(['ANSWERED']);
    expect(await wakesOf(asker.id)).toEqual([]);
  });
});

describe('#4431 §5: who is not woken', () => {
  it('a question with no task, a task ended before the answer, a take-back, a worker of another App', async () => {
    const plain = await ask({});
    await answer(plain.row.id, plain.row.revSeq);
    expect(await wakesOf(asker.id)).toEqual([]);

    const ended = await mkTask();
    const q1 = await ask({ taskRef: ended.id });
    await db.agentTask.update({ where: { id: ended.id }, data: { status: 'cancelled', cancelledAt: new Date() } });
    await answer(q1.row.id, q1.row.revSeq);
    expect(await questionEvents(ended.id)).toHaveLength(0);

    const t = await mkTask();
    const q2 = await ask({ taskRef: t.id });
    const a = await answer(q2.row.id, q2.row.revSeq);
    const [answered] = await questionEvents(t.id);
    await db.workerDeliveryTaskEvent.create({ data: { workerId: asker.id, eventId: answered!.id, chainIndex: 0, deliveredAt: new Date() } });
    await retract(a.row.id, a.row.revSeq);
    expect((await questionEvents(t.id)).map((e) => e.type)).toEqual(['question.answered', 'question.answer-retracted']);
    expect(await wakesOf(asker.id)).toEqual([]);

    // A worker of another App named as the assignee (not possible through the doors) is never due it.
    await db.agentTask.update({ where: { id: t.id }, data: { assigneeWorkerId: foreign.id } });
    await db.agentTeamEvent.create({ data: { appId: app.id, taskId: t.id, type: 'question.answered', actorUserId: decider.id, payload: {} } });
    expect(await wakesOf(foreign.id)).toEqual([]);
  });
});

describe('#4431 §6: an answer is passive history', () => {
  it('a question.answered event does not suppress the assignee\'s undelivered ASSIGNED wake', async () => {
    const t = await mkTask({ status: 'pending', startedAt: null });
    await db.agentTeamEvent.create({ data: { appId: app.id, taskId: t.id, type: 'task.assigned', actorUserId: holder.id, subjectWorkerId: asker.id, payload: { assignee: { workerId: asker.id } }, createdAt: new Date(Date.now() - 30 * MIN) } });
    const q = await ask({ taskRef: t.id });
    // The asker's own ask is no task event, so its ASSIGNED wake still stands.
    expect((await wakesOf(asker.id)).map((w) => w.event)).toEqual(['ASSIGNED']);
    await answer(q.row.id, q.row.revSeq);
    expect((await wakesOf(asker.id)).map((w) => w.event).sort()).toEqual(['ANSWERED', 'ASSIGNED']);
    // A decider is never a worker (NOT_A_PERSON), so the door writes these with no worker actor. The passive list is
    // what keeps a worker-attributed one from counting as the assignee acting: pin both types directly.
    for (const type of ['question.answered', 'question.answer-retracted']) {
      await db.agentTeamEvent.create({ data: { appId: app.id, taskId: t.id, type, actorWorkerId: asker.id, actorUserId: holder.id, payload: {} } });
    }
    expect((await wakesOf(asker.id)).map((w) => w.event)).toContain('ASSIGNED');
  });
});

describe('#4431 §7: earlier questions', () => {
  it('a question with taskId null still evaluates OPEN, answers, and writes no event', async () => {
    const t = await mkTask();
    const q = await ask({});
    expect(D.state(q, {}, as(holder.id))).toBe('OPEN');
    expect(D.taskId(q, {}, as(holder.id))).toBeNull();
    expect(q.row.content).not.toContain('Blocks task');
    const after = await answer(q.row.id, q.row.revSeq);
    expect(D.state(after, {}, as(holder.id))).toBe('DECIDED');
    expect(await db.agentTeamEvent.count({ where: { type: { startsWith: 'question.' } } })).toBe(0);
    void t;
  });
});
