import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
/**
 * #2651 — a started task's assignee hands it back (cor:agt:050:29, with :13 and :01), per the CHECKED gate (Xan,
 * 2026-10-31): GraphQL only (#2937 drops the MCP legs). Acceptance, red first: there is no started-to-pending path
 * on main.
 *
 * - The assignee of a STARTED task hands it back with a code from the closed set: no assignee, pending, queued, the
 *   returning WORKER added to `requirements.excludeWorkerIds` (a person is never added), one `task.handed-back`
 *   event carrying the code only, no `result*` written. Optional text (<= 2,000 characters) is stored on the task,
 *   never in an event; a later hand-back replaces code and text.
 * - The matcher then assigns another matching worker, never the returning one; with no other match the
 *   couldn't-be-assigned alarm is raised once the App's window passes (S5).
 * - Refused, with nothing changed: a non-assignee, and a pending, backlog, finished or cancelled task; a code outside
 *   the set; text over the cap.
 * - A stall alarm raised before the hand-back does not survive it (its episode ends).
 * - A task with open children may be handed back; its children (and their owner) are untouched.
 * - A concurrent hand-back and finish: exactly one wins.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GraphQLError } from 'graphql';
import { ApolloServer } from '@apollo/server';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { runAsActor } from '../../../lib/requestActor.js';
import { currentAlarmEpisodes, alarmEpisodeKey } from '../../../lib/agentTasks/stall.js';
import { taskStallTick } from '../../../jobs/taskStallEvaluator.js';
import { resolvers, type Context } from './resolvers.js';
import { typeDefs } from './typeDefs.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({ syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }) }));

const M = resolvers.Mutation as any;
const F = resolvers as any;
const MIN = 60_000;

const ctx = (userId?: string): Context => ({ db, userId, roles: ['READER'] }) as Context;

async function expectCode(p: Promise<unknown>, code: string) {
  try {
    await p;
    expect.fail(`expected rejection with extensions.code=${code}`);
  } catch (e) {
    expect(e).toBeInstanceOf(GraphQLError);
    expect((e as GraphQLError).extensions?.code).toBe(code);
  }
}

let teamAgent: { id: string };
let app: { id: string };
let mia: { id: string };
let anne: { id: string };
let liam: { id: string };
let rook: { id: string };

const asWorker = <T>(w: { id: string }, fn: () => Promise<T>): Promise<T> => runAsActor({ workerId: w.id, agentId: teamAgent.id }, fn);
const handBack = (taskRef: string, reason: { code: string; text?: string | null }, c = ctx(mia.id)) =>
  M.handBackAgentTask({}, { taskRef, reason }, c);
const events = (taskId: string) => db.agentTeamEvent.findMany({ where: { taskId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
const row = (id: string) => db.agentTask.findUniqueOrThrow({ where: { id } });

beforeEach(async () => {
  await cleanDb(db);
  const n = Math.floor(Math.random() * 1_000_000);
  const org = await db.organization.create({ data: { name: 'HandBack', urn: `hb-${n}.example` } });
  const admin = await db.user.create({ data: { githubId: 2_651_000 + n, githubUsername: `hb-admin-${n}`, roles: ['READER'] } });
  mia = await db.user.create({ data: { githubId: 2_652_000 + n, githubUsername: `hb-mia-${n}`, roles: ['READER'] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  teamAgent = { id: (await M.createAgent({}, { orgId: org.id, name: 'Team Agent' }, ctx(admin.id))).id };
  app = await db.app.create({ data: { organizationId: org.id, name: 'Team', urn: `hb-${n}.example:team` }, select: { id: true } });
  await db.appMember.create({ data: { appId: app.id, userId: mia.id, role: 'member' } });
  const worker = (name: string) =>
    db.worker.create({
      data: { ...WORKER_SIGNATURE_DEFAULTS, appId: app.id, agentId: teamAgent.id, name, slug: name.toLowerCase(), role: 'engineer', heldByUserId: mia.id },
      select: { id: true },
    });
  anne = await worker('Anne');
  liam = await worker('Liam');
  rook = await worker('Rook');
});

/** A task owned by Mia, assigned to Anne; started unless `start: false`. */
async function anneTask(opts: { start?: boolean } = {}) {
  const t = await M.createAgentTask({}, { input: { appRef: app.id, title: 'Fix the widget', assignee: { worker: anne.id } } }, ctx(mia.id));
  if (opts.start !== false) await asWorker(anne, () => M.startAgentTask({}, { taskId: t.id }, ctx(mia.id)));
  return t as { id: string };
}

/** Bind `w` in a live session of `family`, driven now, so the event-driven matcher sees it free for work. */
async function bind(w: { id: string }, family = 'codex') {
  const now = new Date();
  await db.session.create({ data: { id: generateId(), appId: app.id, workerId: w.id, agentId: teamAgent.id, family, startedAt: now, updatedAt: now } });
}

/** The comparable state of a task row plus its events: what "nothing changed" means. */
async function snapshot(id: string) {
  const { updatedAt: _u, ...r } = await row(id);
  return { r, ev: (await events(id)).map((e) => e.id) };
}

describe('acceptance 1: the assignee hands back a started task (S1)', () => {
  it('no assignee, pending, queued, the worker excluded, one event with the code only, no result written', async () => {
    const t = await anneTask();
    const before = (await events(t.id)).length;
    const out = await asWorker(anne, () => handBack(t.id, { code: 'missing_input', text: 'The fixture repo is not reachable from my host.' }));
    expect(out).toMatchObject({ id: t.id, status: 'pending', assigneeWorkerId: null, assigneeUserId: null, startedAt: null });
    const after = await row(t.id);
    expect(after).toMatchObject({ resultOutcome: null, resultSummary: null, resultEvidence: null });
    expect((after.requirements as { excludeWorkerIds?: string[] } | null)?.excludeWorkerIds).toEqual([anne.id]);
    expect(F.AgentTask.queued(after)).toBe(true);
    const fresh = (await events(t.id)).slice(before);
    const handed = fresh.filter((e) => e.type === 'task.handed-back');
    expect(handed).toHaveLength(1);
    expect(handed[0].payload).toEqual({ code: 'missing_input' });
    expect(handed[0].actorWorkerId).toBe(anne.id);
    // The task re-enters the queue: the unassignable rule's new episode starts here (cor:agt:050:17).
    expect(fresh.map((e) => e.type)).toContain('assignment.queued');
    // The text is on the task, never in any event.
    for (const e of await events(t.id)) expect(JSON.stringify(e.payload)).not.toContain('fixture repo');
    expect(F.AgentTask.handBack(after)).toMatchObject({ code: 'MISSING_INPUT', text: 'The fixture repo is not reachable from my host.' });
    expect(F.AgentTask.handBack(after).handedBackAt).toBeInstanceOf(Date);
  });

  it('keeps existing requirements and adds the worker once', async () => {
    const t = await anneTask();
    await db.agentTask.update({ where: { id: t.id }, data: { requirements: { role: 'engineer', excludeWorkerIds: [rook.id] } } });
    await asWorker(anne, () => handBack(t.id, { code: 'cannot_do' }));
    expect((await row(t.id)).requirements).toEqual({ role: 'engineer', excludeWorkerIds: [rook.id, anne.id] });
    expect(F.AgentTask.handBack(await row(t.id))).toMatchObject({ code: 'CANNOT_DO', text: null });
  });

  it('a person who hands a task back is not excluded (the platform assigns only workers)', async () => {
    const t = await M.createAgentTask({}, { input: { appRef: app.id, title: 'Read the contract', assignee: { user: mia.id } } }, ctx(mia.id));
    await M.startAgentTask({}, { taskId: t.id }, ctx(mia.id));
    const out = await handBack(t.id, { code: 'out_of_scope' });
    expect(out).toMatchObject({ status: 'pending', assigneeUserId: null });
    expect(out.requirements ?? null).toBeNull();
    expect((await events(t.id)).filter((e) => e.type === 'task.handed-back').map((e) => e.payload)).toEqual([{ code: 'out_of_scope' }]);
  });

  it('a later hand-back replaces the code and text; the earlier code stays in the events', async () => {
    const t = await anneTask();
    await asWorker(anne, () => handBack(t.id, { code: 'missing_input', text: 'first' }));
    await M.assignAgentTask({}, { taskId: t.id, assignee: { worker: liam.id } }, ctx(mia.id));
    await asWorker(liam, () => M.startAgentTask({}, { taskId: t.id }, ctx(mia.id)));
    await asWorker(liam, () => handBack(t.id, { code: 'duplicate' }));
    const after = await row(t.id);
    expect(F.AgentTask.handBack(after)).toMatchObject({ code: 'DUPLICATE', text: null });
    expect((after.requirements as { excludeWorkerIds: string[] }).excludeWorkerIds).toEqual([anne.id, liam.id]);
    expect((await events(t.id)).filter((e) => e.type === 'task.handed-back').map((e) => e.payload)).toEqual([{ code: 'missing_input' }, { code: 'duplicate' }]);
  });

  it('a never-handed-back task reads handBack null', async () => {
    const t = await anneTask();
    expect(F.AgentTask.handBack(await row(t.id))).toBeNull();
  });
});

describe('acceptance 2: the matcher never gives it back to the returning worker (S2, S5)', () => {
  it('assigns another matching worker, though the returning one was assigned less recently', async () => {
    await bind(anne);
    await bind(liam);
    const t = await anneTask();
    // Liam was assigned after Anne, so "assigned least recently" (cor:agt:060:06) prefers Anne: only the exclusion stops her.
    await db.agentTeamEvent.create({
      data: { appId: app.id, type: 'task.assigned', subjectWorkerId: liam.id, createdAt: new Date(Date.now() + MIN), payload: { assignee: { workerId: liam.id } } },
    });
    await asWorker(anne, () => handBack(t.id, { code: 'cannot_do' }));
    expect((await row(t.id)).assigneeWorkerId).toBe(liam.id);
  });

  it('with no other match it stays queued, and the couldn\'t-be-assigned alarm is raised once the window passes', async () => {
    await bind(anne);
    const t = await anneTask();
    await asWorker(anne, () => handBack(t.id, { code: 'refused' }));
    expect((await row(t.id)).assigneeWorkerId).toBeNull();
    const queuedAt = (await events(t.id)).filter((e) => e.type === 'assignment.queued').at(-1)!.createdAt;
    await taskStallTick(db, new Date(queuedAt.getTime() + 29 * MIN));
    expect(await db.agentTeamEvent.count({ where: { taskId: t.id, type: 'assignment.unassignable' } })).toBe(0);
    await taskStallTick(db, new Date(queuedAt.getTime() + 31 * MIN));
    expect(await db.agentTeamEvent.count({ where: { taskId: t.id, type: 'assignment.unassignable' } })).toBe(1);
  });
});

describe('acceptance 3: refused, nothing changed', () => {
  it('a worker that is not the assignee', async () => {
    const t = await anneTask();
    const before = await snapshot(t.id);
    await expectCode(asWorker(rook, () => handBack(t.id, { code: 'cannot_do' })), 'TASK_NOT_ASSIGNEE');
    expect(await snapshot(t.id)).toEqual(before);
  });

  it('the owner, a person who is not the assignee', async () => {
    const t = await anneTask();
    const before = await snapshot(t.id);
    await expectCode(handBack(t.id, { code: 'cannot_do' }), 'TASK_NOT_ASSIGNEE');
    expect(await snapshot(t.id)).toEqual(before);
  });

  it('a pending task, though its assignee asks', async () => {
    const t = await anneTask({ start: false });
    const before = await snapshot(t.id);
    await expectCode(asWorker(anne, () => handBack(t.id, { code: 'cannot_do' })), 'TASK_INVALID_TRANSITION');
    expect(await snapshot(t.id)).toEqual(before);
  });

  it('a finished task', async () => {
    const t = await anneTask();
    await asWorker(anne, () => M.finishAgentTask({}, { taskId: t.id, result: { outcome: 'succeeded' } }, ctx(mia.id)));
    const before = await snapshot(t.id);
    await expectCode(asWorker(anne, () => handBack(t.id, { code: 'cannot_do' })), 'TASK_ENDED');
    expect(await snapshot(t.id)).toEqual(before);
  });

  it('a cancelled task', async () => {
    const t = await anneTask();
    await M.cancelAgentTask({}, { taskId: t.id }, ctx(mia.id));
    const before = await snapshot(t.id);
    await expectCode(asWorker(anne, () => handBack(t.id, { code: 'cannot_do' })), 'TASK_ENDED');
    expect(await snapshot(t.id)).toEqual(before);
  });

  it('a backlog task (no assignee)', async () => {
    const t = await M.createAgentTask({}, { input: { appRef: app.id, title: 'Later', status: 'BACKLOG' } }, ctx(mia.id));
    const before = await snapshot(t.id);
    await expectCode(asWorker(anne, () => handBack(t.id, { code: 'cannot_do' })), 'TASK_NOT_ASSIGNEE');
    expect(await snapshot(t.id)).toEqual(before);
  });

  it.each(['bored', 'MISSING_INPUT', '', 'missing input'])('a code outside the set (%j), and the task stays started (S4)', async (code) => {
    const t = await anneTask();
    const before = await snapshot(t.id);
    await expectCode(asWorker(anne, () => handBack(t.id, { code })), 'BAD_USER_INPUT');
    expect(await snapshot(t.id)).toEqual(before);
  });

  it('reason text over 2,000 characters; exactly 2,000 is accepted', async () => {
    const t = await anneTask();
    const before = await snapshot(t.id);
    await expectCode(asWorker(anne, () => handBack(t.id, { code: 'cannot_do', text: 'x'.repeat(2001) })), 'BAD_USER_INPUT');
    expect(await snapshot(t.id)).toEqual(before);
    await asWorker(anne, () => handBack(t.id, { code: 'cannot_do', text: 'y'.repeat(2000) }));
    expect((await row(t.id)).status).toBe('pending');
  });
});

describe('acceptance 4: a raised stall alarm does not survive the hand-back (cor:agt:050:13)', () => {
  it('the no-progress episode ends with the hand-back', async () => {
    const t = await anneTask();
    const startedAt = (await row(t.id)).startedAt!;
    await taskStallTick(db, new Date(startedAt.getTime() + 61 * MIN));
    const alarm = await db.agentTeamEvent.findFirstOrThrow({ where: { taskId: t.id, type: 'stall.no-progress' } });
    const key = alarmEpisodeKey(t.id, alarm.type, alarm.episodeStart!);
    const probe = [{ taskId: t.id, type: alarm.type, episodeStart: alarm.episodeStart }];
    expect(await currentAlarmEpisodes(db, probe, new Date(startedAt.getTime() + 62 * MIN))).toContain(key);
    await asWorker(anne, () => handBack(t.id, { code: 'missing_input' }));
    expect(await currentAlarmEpisodes(db, probe, new Date(startedAt.getTime() + 62 * MIN))).not.toContain(key);
  });
});

describe('children are untouched (cor:agt:050:29 details)', () => {
  it('a task with an open child may be handed back; the child keeps its status and its owner', async () => {
    const t = await anneTask();
    const child = await asWorker(anne, () =>
      M.createAgentTask({}, { input: { appRef: app.id, parentTaskId: t.id, title: 'Sub-step', assignee: { worker: rook.id } } }, ctx(mia.id)));
    const before = await row(child.id);
    await asWorker(anne, () => handBack(t.id, { code: 'cannot_do' }));
    const after = await row(child.id);
    expect(after).toMatchObject({ status: before.status, ownerWorkerId: anne.id, assigneeWorkerId: rook.id, requirements: before.requirements });
  });
});

describe('acceptance 5: a concurrent hand-back and finish, exactly one wins', () => {
  it.each(['hand-back first', 'finish first'] as const)('%s in the queue: one wins, the other is refused, the state is whole', async (order) => {
    const t = await anneTask();
    // Hold the task row so both writers queue on it, then release and let them race.
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    let locked!: () => void;
    const isLocked = new Promise<void>((r) => { locked = r; });
    const holder = db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM agent_tasks WHERE id = ${t.id} FOR UPDATE`;
      locked();
      await held;
    }, { timeout: 30_000 });
    await isLocked;
    const hb = () => asWorker(anne, () => handBack(t.id, { code: 'cannot_do' }));
    const fin = () => asWorker(anne, () => M.finishAgentTask({}, { taskId: t.id, result: { outcome: 'succeeded' } }, ctx(mia.id)));
    const first = order === 'hand-back first' ? hb() : fin();
    await waitForRowLockWaiters(1);
    const second = order === 'hand-back first' ? fin() : hb();
    await waitForRowLockWaiters(2);
    release();
    await holder;
    const [a, b] = await Promise.allSettled([first, second]);
    const outcomes = [a.status, b.status];
    expect(outcomes.filter((s) => s === 'fulfilled')).toHaveLength(1);
    const loser = (a.status === 'rejected' ? a : b) as PromiseRejectedResult;
    expect(loser.reason).toBeInstanceOf(GraphQLError);
    const final = await row(t.id);
    const types = (await events(t.id)).map((e) => e.type);
    if (final.status === 'finished') {
      expect(types).not.toContain('task.handed-back');
      expect(final.handBackReasonCode).toBeNull();
      expect(final.assigneeWorkerId).toBe(anne.id);
    } else {
      expect(final).toMatchObject({ status: 'pending', assigneeWorkerId: null, resultOutcome: null });
      expect(types).not.toContain('task.finished');
      expect(types.filter((x) => x === 'task.handed-back')).toHaveLength(1);
    }
    // The order the row lock grants decides the winner.
    expect(final.status).toBe(order === 'hand-back first' ? 'pending' : 'finished');
  });
});

describe('GraphQL contract (SDL)', () => {
  const api = () => new ApolloServer<Context>({ typeDefs, resolvers });
  const MUTATION = `mutation($t: ID!, $r: AgentTaskHandBackInput!) {
    handBackAgentTask(taskRef: $t, reason: $r) { id status queued assignee { kind } handBack { code text handedBackAt } requirements { excludeWorkerIds } result { outcome } }
  }`;

  it('hands back over GraphQL and reads the reason as the task is read', async () => {
    const t = await anneTask();
    const server = api();
    await server.start();
    try {
      const res = await asWorker(anne, () =>
        server.executeOperation({ query: MUTATION, variables: { t: t.id, r: { code: 'MISSING_INPUT', text: 'no access' } } }, { contextValue: ctx(mia.id) }));
      if (res.body.kind !== 'single') throw new Error('expected a single result');
      expect(res.body.singleResult.errors).toBeUndefined();
      expect(res.body.singleResult.data?.handBackAgentTask).toMatchObject({
        id: t.id, status: 'PENDING', queued: true, assignee: null, result: null,
        handBack: { code: 'MISSING_INPUT', text: 'no access' }, requirements: { excludeWorkerIds: [anne.id] },
      });
    } finally { await server.stop(); }
  });

  it('a code outside the enum is refused by validation, and the task stays started', async () => {
    const t = await anneTask();
    const server = api();
    await server.start();
    try {
      const res = await asWorker(anne, () =>
        server.executeOperation({ query: MUTATION, variables: { t: t.id, r: { code: 'BORED' } } }, { contextValue: ctx(mia.id) }));
      if (res.body.kind !== 'single') throw new Error('expected a single result');
      expect(res.body.singleResult.errors?.[0]?.message).toMatch(/BORED/);
      expect((await row(t.id)).status).toBe('started');
    } finally { await server.stop(); }
  });

  it('the SDL: the closed code enum and the mutation signature', () => {
    const en = /enum AgentTaskHandBackCode \{([\s\S]*?)\n  \}/.exec(typeDefs)?.[1] ?? '';
    expect([...en.matchAll(/^\s+([A-Z_]+)$/gm)].map((m) => m[1])).toEqual(['MISSING_INPUT', 'CANNOT_DO', 'REFUSED', 'OUT_OF_SCOPE', 'DUPLICATE']);
    expect(typeDefs).toMatch(/handBackAgentTask\(taskRef: ID!, reason: AgentTaskHandBackInput!\): AgentTask!/);
  });
});

/**
 * Poll until `n` backends of this test database wait on a heavyweight lock: the task row, or the per-worker
 * advisory lock the second writer queues on behind the first (both lock the assignee). The database is this
 * worker's own clone, so no other test file's backends are counted.
 */
async function waitForRowLockWaiters(n: number) {
  for (let i = 0; i < 200; i += 1) {
    const [{ waiting }] = await db.$queryRaw<{ waiting: bigint }[]>`
      SELECT count(*)::bigint AS waiting FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock'`;
    if (Number(waiting) >= n) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for ${n} row-lock waiters`);
}
