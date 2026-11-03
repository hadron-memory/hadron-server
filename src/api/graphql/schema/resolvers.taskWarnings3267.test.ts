import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
/**
 * #3267 (action register phase 3, S1) — warnings on task start and task progress.
 *
 * `task.start.other-started`: the assignee already holds another STARTED task in this App.
 * `task.start.parent-ended`: the task's parent has finished or been cancelled.
 * `task.progress.children-ended`: the task has children and every one has ended, so its own finish is probably due.
 *
 * Each is pinned both ways (fires / does not), the call still succeeds, a refused or rolled-back call files none, the
 * two that describe worker or other-task state sit behind `maySeeWorkerInternals` (the gate the assign codes use), and
 * none is recorded as a team event (gate ruling 2 on #3267).
 */
import { ApolloServer } from '@apollo/server';
import { GraphQLError } from 'graphql';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { runAsActor } from '../../../lib/requestActor.js';
import { resolvers, type Context } from './resolvers.js';
import { typeDefs } from './typeDefs.js';
import { taskWarningsPlugin } from '../taskWarningsPlugin.js';
import { emitTaskWarnings, TASK_WARNING_TEXT, type TaskWarningCode } from './resolvers.taskWarnings.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({ syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }) }));

const M = resolvers.Mutation as any;

let org: { id: string; urn: string };
let admin: { id: string };
let member: { id: string };
let outsider: { id: string };
let app: { id: string };
let otherApp: { id: string };
let teamAgentId: string;
let teamMemoryId: string;
let anne: { id: string };
let liam: { id: string };

const OTHER_STARTED = 'task.start.other-started' as TaskWarningCode;
const PARENT_ENDED = 'task.start.parent-ended' as TaskWarningCode;
const CHILDREN_ENDED = 'task.progress.children-ended' as TaskWarningCode;

const ctx = (userId: string): Context => ({ db, userId, roles: ['READER'] });
const asWorker = (w: { id: string }, fn: () => Promise<any>) => runAsActor({ workerId: w.id, agentId: teamAgentId }, fn);
const codes = (c: Context) => (c.taskWarnings ?? []).map((w) => w.warning.code as string);
const worker = (name: string, appId = app.id) =>
  db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId, agentId: teamAgentId, name, slug: name.toLowerCase() }, select: { id: true } });

/** A task row in `status`, with the columns the shape constraint (chk_agent_tasks_shape) requires. */
function task(status: string, data: Record<string, unknown> = {}, appId = app.id) {
  const now = new Date();
  const worked = status === 'started' || status === 'finished';
  // A started or finished row must be assigned: default it to Liam.
  const assignee = worked && !data.assigneeWorkerId && !data.assigneeUserId ? { assigneeWorkerId: liam.id } : {};
  const assigned = data.assigneeWorkerId || data.assigneeUserId || assignee.assigneeWorkerId ? { assignedAt: now } : {};
  const started = worked ? { startedAt: now } : {};
  return db.agentTask.create({
    data: {
      id: generateId(), appId, title: 'T', ownerUserId: member.id, status, ...assignee, ...assigned, ...started,
      ...(status === 'finished' ? { finishedAt: now, resultOutcome: 'succeeded' } : {}),
      ...(status === 'cancelled' ? { cancelledAt: now } : {}),
      ...data,
    } as any,
    select: { id: true },
  });
}
const start = (c: Context, w: { id: string }, id: string) => asWorker(w, () => M.startAgentTask({}, { taskId: id }, c));
const progress = (c: Context, w: { id: string }, id: string) => asWorker(w, () => M.recordAgentTaskProgress({}, { taskId: id }, c));

async function expectCode(p: Promise<unknown>, code: string) {
  const e = await p.then(() => null, (err) => err);
  expect(e).toBeInstanceOf(GraphQLError);
  expect((e as GraphQLError).extensions?.code).toBe(code);
}

beforeEach(async () => {
  await cleanDb(db);
  const suffix = generateId().toLowerCase();
  org = await db.organization.create({ data: { id: generateId(), name: 'tw3267-org', urn: `tw3267-${suffix}.example` } });
  admin = await db.user.create({ data: { githubId: 326701, githubUsername: 'tw3267-admin', handle: 'tw3267-admin', roles: ['READER'] } });
  member = await db.user.create({ data: { githubId: 326702, githubUsername: 'tw3267-member', handle: 'tw3267-member', roles: ['READER'] } });
  outsider = await db.user.create({ data: { githubId: 326703, githubUsername: 'tw3267-out', handle: 'tw3267-out', roles: ['READER'] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  const agent = await M.createAgent({}, { orgId: org.id, name: 'Team Agent' }, ctx(admin.id));
  teamAgentId = agent.id;
  teamMemoryId = (await db.agent.findUniqueOrThrow({ where: { id: teamAgentId } })).systemMemoryId as string;
  app = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Team', urn: `${org.urn}:team` } });
  otherApp = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Other', urn: `${org.urn}:other` } });
  await db.appMember.create({ data: { appId: app.id, userId: member.id, role: 'member' } });
  await db.appAgent.create({ data: { appId: app.id, agentId: teamAgentId } });
  await db.node.create({ data: { id: generateId(), memoryId: teamMemoryId, loc: 'roles', name: 'roles', content: 'x' } });
  anne = await worker('Anne');
  liam = await worker('Liam');
});

describe('task.start.other-started', () => {
  it('fires when the assignee already holds another started task; the start still succeeds', async () => {
    await task('started', { assigneeWorkerId: anne.id });
    const next = await task('pending', { assigneeWorkerId: anne.id });
    const c = ctx(member.id);
    const out = await start(c, anne, next.id);
    expect(out.status).toBe('started');
    expect(codes(c)).toEqual([OTHER_STARTED]);
    expect(c.taskWarnings![0].warning.text).toBe(TASK_WARNING_TEXT[OTHER_STARTED]);
    expect(c.taskWarnings![0].warning.text).toBe('You already have another task started; starting this one does not end it.');
  });

  it('does not fire without another started task: none, a pending one, an ended one, another worker\'s, another App\'s', async () => {
    const c0 = ctx(member.id);
    await start(c0, anne, (await task('pending', { assigneeWorkerId: anne.id })).id);
    expect(codes(c0)).toEqual([]);

    await task('pending', { assigneeWorkerId: liam.id });
    await task('finished', { assigneeWorkerId: liam.id });
    await task('cancelled', { assigneeWorkerId: liam.id });
    await task('started', { assigneeWorkerId: anne.id }, otherApp.id); // Anne's id on a row in another App
    const c1 = ctx(member.id);
    await start(c1, liam, (await task('pending', { assigneeWorkerId: liam.id })).id);
    expect(codes(c1)).toEqual([]);

    await task('started', { assigneeWorkerId: liam.id });
    const c2 = ctx(member.id);
    await start(c2, anne, (await task('pending', { assigneeWorkerId: anne.id })).id);
    expect(codes(c2)).toEqual([]); // Liam's started task is not Anne's
  });

  it('a user assignee has no worker state to describe: none', async () => {
    await task('started', { ownerUserId: member.id, assigneeUserId: member.id });
    const mine = await task('pending', { ownerUserId: member.id, assigneeUserId: member.id });
    const c = ctx(member.id);
    expect((await M.startAgentTask({}, { taskId: mine.id }, c)).status).toBe('started');
    expect(codes(c)).toEqual([]);
  });

  it('a refused start files none (not the assignee, already started, blocked)', async () => {
    await task('started', { assigneeWorkerId: anne.id });
    const t = await task('pending', { assigneeWorkerId: anne.id });
    const c = ctx(member.id);
    await expectCode(start(c, liam, t.id), 'TASK_NOT_ASSIGNEE');
    expect(codes(c)).toEqual([]);
    const started = await task('started', { assigneeWorkerId: anne.id });
    await expectCode(start(c, anne, started.id), 'TASK_INVALID_TRANSITION');
    expect(codes(c)).toEqual([]);
  });
});

describe('task.start.parent-ended', () => {
  it('fires when the parent has finished or been cancelled; the start still succeeds', async () => {
    for (const status of ['finished', 'cancelled'] as const) {
      const parent = await task(status);
      const t = await task('pending', { assigneeWorkerId: anne.id, parentTaskId: parent.id });
      const c = ctx(member.id);
      expect((await start(c, anne, t.id)).status).toBe('started');
      expect(codes(c)).toEqual([PARENT_ENDED]);
      expect(c.taskWarnings![0].warning.text).toBe('This task\'s parent has already ended.');
      await db.agentTask.update({ where: { id: t.id }, data: { status: 'finished', finishedAt: new Date(), resultOutcome: 'succeeded' } });
    }
  });

  it('does not fire for a live parent (backlog, pending, started) or a root task', async () => {
    for (const status of ['backlog', 'pending', 'started']) {
      const parent = await task(status);
      const t = await task('pending', { assigneeWorkerId: anne.id, parentTaskId: parent.id });
      const c = ctx(member.id);
      await start(c, anne, t.id);
      expect(codes(c)).toEqual([]);
      await db.agentTask.update({ where: { id: t.id }, data: { status: 'finished', finishedAt: new Date(), resultOutcome: 'succeeded' } });
    }
    const root = await task('pending', { assigneeWorkerId: anne.id });
    const c = ctx(member.id);
    await start(c, anne, root.id);
    expect(codes(c)).toEqual([]);
  });

  it('both start codes together, in the fixed order', async () => {
    await task('started', { assigneeWorkerId: anne.id });
    const parent = await task('cancelled');
    const t = await task('pending', { assigneeWorkerId: anne.id, parentTaskId: parent.id });
    const c = ctx(member.id);
    await start(c, anne, t.id);
    expect(codes(c)).toEqual([OTHER_STARTED, PARENT_ENDED]);
  });
});

describe('task.progress.children-ended', () => {
  it('fires when the task has children and every one has ended; progress still succeeds', async () => {
    const parent = await task('started', { assigneeWorkerId: anne.id });
    await task('finished', { assigneeWorkerId: liam.id, parentTaskId: parent.id });
    await task('cancelled', { parentTaskId: parent.id });
    const c = ctx(member.id);
    expect((await progress(c, anne, parent.id)).status).toBe('started');
    expect(codes(c)).toEqual([CHILDREN_ENDED]);
    expect(c.taskWarnings![0].warning.text).toBe('Every child of this task has ended, so it may be ready to finish.');
  });

  it('does not fire with no children, or with any child that has not ended (backlog, pending, started)', async () => {
    const solo = await task('started', { assigneeWorkerId: anne.id });
    const c0 = ctx(member.id);
    await progress(c0, anne, solo.id);
    expect(codes(c0)).toEqual([]);
    for (const status of ['backlog', 'pending', 'started']) {
      const parent = await task('started', { assigneeWorkerId: anne.id });
      await task('finished', { assigneeWorkerId: liam.id, parentTaskId: parent.id });
      await task(status, status === 'backlog' ? { parentTaskId: parent.id } : { assigneeWorkerId: liam.id, parentTaskId: parent.id });
      const c = ctx(member.id);
      await progress(c, anne, parent.id);
      expect(codes(c)).toEqual([]);
    }
  });

  it('a refused progress files none (not the assignee, not started)', async () => {
    const parent = await task('started', { assigneeWorkerId: anne.id });
    await task('finished', { assigneeWorkerId: liam.id, parentTaskId: parent.id });
    const c = ctx(member.id);
    await expectCode(progress(c, liam, parent.id), 'TASK_NOT_ASSIGNEE');
    const pending = await task('pending', { assigneeWorkerId: anne.id });
    await task('finished', { assigneeWorkerId: liam.id, parentTaskId: pending.id });
    await expectCode(progress(c, anne, pending.id), 'TASK_INVALID_TRANSITION');
    expect(codes(c)).toEqual([]);
  });
});

describe('privacy and recording', () => {
  it('the two codes that describe worker or other-task state need the roster gate; parent-ended does not', async () => {
    const out = ctx(outsider.id);
    await emitTaskWarnings(out, undefined, app.id, { codes: [CHILDREN_ENDED, PARENT_ENDED, OTHER_STARTED] });
    expect(codes(out)).toEqual([PARENT_ENDED]);
    const ok = ctx(member.id);
    await emitTaskWarnings(ok, undefined, app.id, { codes: [CHILDREN_ENDED, PARENT_ENDED, OTHER_STARTED] });
    expect(codes(ok)).toEqual([OTHER_STARTED, PARENT_ENDED, CHILDREN_ENDED]);
  });

  it('GraphQL carries them in extensions.warnings, per response key', async () => {
    await task('started', { assigneeWorkerId: anne.id });
    const parent = await task('finished');
    const t = await task('pending', { assigneeWorkerId: anne.id, parentTaskId: parent.id });
    const server = new ApolloServer<Context>({ typeDefs, resolvers, plugins: [taskWarningsPlugin] });
    const res = await runAsActor({ workerId: anne.id, agentId: teamAgentId }, () =>
      server.executeOperation({ query: `mutation { s: startAgentTask(taskId: "${t.id}") { id status } }` }, { contextValue: ctx(member.id) }));
    expect(res.body.kind).toBe('single');
    const single = (res.body as any).singleResult;
    expect(single.errors).toBeUndefined();
    expect(single.data.s.status).toBe('STARTED');
    expect(single.extensions.warnings.map((w: any) => [w.path, w.code])).toEqual([['s', OTHER_STARTED], ['s', PARENT_ENDED]]);
    // gate ruling 2: an advisory on start is not task history, so none of the three is recorded as a team event
    expect(await db.agentTeamEvent.count({ where: { appId: app.id, type: 'task.warning' } })).toBe(0);
  });
});
