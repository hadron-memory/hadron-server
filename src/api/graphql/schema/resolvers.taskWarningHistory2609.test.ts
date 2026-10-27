/** #2609 — warning history records successful fields, independently of response advice, and stays passive. */
import { ApolloServer } from '@apollo/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { runAsActor } from '../../../lib/requestActor.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
import { resolvers, type Context } from './resolvers.js';
import { typeDefs } from './typeDefs.js';
import { taskWarningsPlugin } from '../taskWarningsPlugin.js';
import { pendingTaskWakes } from '../../../lib/agentTasks/taskWakes.js';
import { loadStallInputs } from '../../../lib/agentTasks/stall.js';
import * as warnings from './resolvers.taskWarnings.js';
import * as workerGate from './resolvers.worker.js';
import { appendTaskEvent } from '../../../lib/agentTasks/events.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn() }));
const M = resolvers.Mutation as any;
const Q = resolvers.Query as any;
let app: { id: string };
let user: { id: string };
let outsider: { id: string };
let worker: { id: string };
let agentId: string;
const ctx = (): Context => ({ db, userId: user.id, roles: ['READER'] });
const create = (c = ctx(), input = {}) => M.createAgentTask({}, { input: { appRef: app.id, title: 'Synthetic task', status: 'BACKLOG', ...input } }, c);
const history = () => db.agentTeamEvent.findMany({ where: { appId: app.id, type: 'task.warning' }, orderBy: { createdAt: 'asc' } });
const flush = (c: Context, errored = new Set<string>()) => (warnings as any).flushTaskWarningHistory(c, errored);
const server = new ApolloServer<Context>({ typeDefs, resolvers, plugins: [taskWarningsPlugin] });
async function graphql(query: string, c = ctx()) {
  const r = await server.executeOperation({ query }, { contextValue: c });
  if (r.body.kind !== 'single') throw new Error('single response required');
  return r.body.singleResult;
}
const field = (alias: string) => `${alias}: createAgentTask(input:{appRef:"${app.id}",title:"Synthetic task",status:BACKLOG}) {id}`;

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { name: 'History', urn: `history-${generateId()}.example` } });
  user = await db.user.create({ data: { githubId: 2609001, githubUsername: 'history-member', roles: [] } });
  outsider = await db.user.create({ data: { githubId: 2609002, githubUsername: 'history-outsider', roles: [] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: user.id, role: 'ADMIN' } });
  const agent = await M.createAgent({}, { orgId: org.id, name: 'History agent' }, ctx());
  agentId = agent.id;
  app = await db.app.create({ data: { organizationId: org.id, name: 'History', urn: `${org.urn}:team` } });
  await db.appAgent.create({ data: { appId: app.id, agentId } });
  worker = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: app.id, agentId, name: 'Worker', slug: 'worker' } });
});

describe('successful-field history', () => {
  it.each([undefined, null])('a response with missing context (%s) is an unchanged no-op', async contextValue => {
    const listener = await taskWarningsPlugin.requestDidStart!({} as never) as any;
    const response = { body: { kind: 'single', singleResult: { errors: [{ message: 'synthetic request failure' }] } } };
    const original = JSON.parse(JSON.stringify(response));
    await expect(listener.willSendResponse({ contextValue, response })).resolves.toBeUndefined();
    expect(response).toEqual(original);
  });

  it('history still records after optional enrichment has exhausted its request budget, without charging it', async () => {
    const c = ctx();
    c.taskWarningState = { spentMs: warnings.REQUEST_READ_BUDGET_MS + 50, gate: new Map(), registers: new Map(), team: new Map() };
    const task = await runAsActor({ workerId: worker.id, agentId }, () => create(c));
    expect(c.taskWarnings?.[0].warning.register).toBeUndefined();
    await flush(c);
    expect(await history()).toHaveLength(1);
    expect((await history())[0]).toMatchObject({ taskId: task.id, actorWorkerId: worker.id, payload: { code: 'task.create.no-source' } });
    expect(c.taskWarningState.spentMs).toBe(warnings.REQUEST_READ_BUDGET_MS + 50);
  });

  it('records each alias, including beyond the response cap, with closed payload and null-worker attribution', async () => {
    const r = await graphql(`mutation { ${Array.from({ length: 23 }, (_, i) => field(`a${i}`)).join(' ')} }`);
    expect(r.errors).toBeUndefined();
    expect(r.extensions?.warnings).toHaveLength(20);
    const rows = await history();
    expect(rows).toHaveLength(23);
    for (const row of rows) {
      expect(row.payload).toEqual({ code: 'task.create.no-source' });
      expect(row.actorUserId).toBe(user.id);
      expect(row.actorWorkerId).toBeNull();
      expect(row.actorAgentId).toBeNull();
      expect(row.actorRunId).toBeNull();
      expect(row.taskId).toBeTruthy();
      expect(row.severity).toBeNull();
      expect(row.createdAt).toBeInstanceOf(Date);
    }
  });

  it('drops a field whose result errors after commit, while keeping its successful sibling', async () => {
    const badResolvers = { ...resolvers, AgentTask: { ...resolvers.AgentTask, title: () => { throw new Error('synthetic result failure'); } } };
    const s = new ApolloServer<Context>({ typeDefs, resolvers: badResolvers, plugins: [taskWarningsPlugin] });
    try {
      const r = await s.executeOperation({ query: `mutation { ${field('ok')} bad:createAgentTask(input:{appRef:"${app.id}",title:"bad",status:BACKLOG}) {id title} }` }, { contextValue: ctx() });
      expect(r.body.kind).toBe('single');
      const rows = await history();
      expect(await db.agentTask.count({ where: { appId: app.id, title: { in: ['Synthetic task', 'bad'] } } })).toBe(2);
      expect(rows).toHaveLength(1);
      expect(rows[0].taskId).toBe((await db.agentTask.findFirstOrThrow({ where: { appId: app.id, title: 'Synthetic task' } })).id);
    } finally { await s.stop(); }
  });

  it('captures a worker actor before flush leaves its request scope, deduplicates code/path, and flushes once', async () => {
    const c = ctx();
    const task = await runAsActor({ workerId: worker.id, agentId }, () => create(c));
    await runAsActor({ workerId: worker.id, agentId }, () => warnings.emitTaskWarnings(c, undefined, app.id, { codes: ['task.create.no-source', 'task.create.no-source'], taskId: task.id } as any));
    await flush(c);
    await flush(c);
    const rows = await history();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actorUserId: user.id, actorWorkerId: worker.id, actorAgentId: agentId, actorRunId: null });
  });

  it('the typed writer retains a run actor and rejects unapproved codes at runtime', async () => {
    const task = await create(ctx(), { source: 'synthetic' });
    const runId = generateId();
    await db.$transaction(tx => appendTaskEvent(tx, { appId: app.id, taskId: task.id,
      actor: { userId: null, workerId: null, agentId: null, runId }, event: { type: 'task.warning', code: 'task.create.no-source' } }));
    expect((await history())[0]).toMatchObject({ actorRunId: runId, actorUserId: null, actorWorkerId: null, actorAgentId: null, payload: { code: 'task.create.no-source' } });
    await expect(db.$transaction(tx => appendTaskEvent(tx, { appId: app.id, taskId: task.id,
      actor: { userId: user.id, workerId: null, agentId: null }, event: { type: 'task.warning', code: 'task.assign.assignee-busy' as any } }))).rejects.toThrow('Unsupported task warning');
    expect(await history()).toHaveLength(1);
  });

  it('does not persist assignee-state codes, even when the caller can read them; no warning means no row', async () => {
    const c = ctx();
    const task = await create(c, { source: 'synthetic', assignee: undefined });
    await warnings.emitTaskWarnings(c, undefined, app.id, { taskId: task.id, codes: ['task.assign.assignee-busy', 'task.assign.assignee-paused', 'task.assign.assignee-unavailable'] } as any);
    await flush(c);
    expect(await history()).toEqual([]);
  });

  it('a synthetic denial of worker internals cannot leak assignee facts through the broader event read', async () => {
    const deny = vi.spyOn(workerGate, 'maySeeWorkerInternals').mockResolvedValue(false);
    try {
      const c = ctx();
      const task = await create(c, { source: 'synthetic' });
      await warnings.emitTaskWarnings(c, undefined, app.id, { taskId: task.id,
        codes: ['task.create.no-source', 'task.assign.assignee-busy', 'task.assign.assignee-unavailable', 'task.assign.assignee-paused'] } as any);
      await flush(c);
      expect(c.taskWarnings?.map(w => w.warning.code)).toEqual(['task.create.no-source']);
      const rows = await Q.agentTeamEvents({}, { appRef: app.id, types: ['task.warning'] }, ctx());
      expect(rows.map((r: any) => r.payload)).toEqual([{ code: 'task.create.no-source' }]);
    } finally { deny.mockRestore(); }
  });

  it('keeps canonical App read gates and task filtering for history', async () => {
    const r = await graphql(`mutation { ${field('ok')} }`);
    const taskId = (r.data as any).ok.id;
    const rows = await Q.agentTeamEvents({}, { appRef: app.id, types: ['task.warning'], taskId }, ctx());
    expect(rows).toHaveLength(1);
    await expect(Q.agentTeamEvents({}, { appRef: app.id, types: ['task.warning'] }, { ...ctx(), userId: outsider.id })).rejects.toThrow();
    const other = await db.app.create({ data: { ownerUserId: outsider.id, name: 'Other', urn: `history-other-${generateId()}` } });
    await expect(Q.agentTeamEvents({}, { appRef: other.id, types: ['task.warning'], taskId }, ctx())).rejects.toThrow();
  });

  it('recording failure never changes the response and is not retried', async () => {
    const real = db.$transaction.bind(db);
    let attempts = 0;
    const spy = vi.spyOn(db, '$transaction').mockImplementation(((fn: any, options: any) => real(async (tx: any) => {
      const delegate = tx.agentTeamEvent;
      const eventModel = new Proxy({}, { get: (_, key) => key === 'create' ? createEvent : delegate[key] });
      const wrapped = new Proxy({}, { get: (_, key) => key === 'agentTeamEvent' ? eventModel : tx[key] });
      const createEvent = (args: any) => {
        if (args.data.type === 'task.warning') { attempts++; throw new Error('synthetic recording failure'); }
        return delegate.create(args);
      };
      return fn(wrapped);
    }, options)) as any);
    try {
      const r = await graphql(`mutation { ${field('ok')} }`);
      expect(r.errors).toBeUndefined();
      expect((r.data as any).ok.id).toBeTruthy();
      expect(r.extensions?.warnings).toEqual([{ path: 'ok', code: 'task.create.no-source', text: warnings.TASK_WARNING_TEXT['task.create.no-source'] }]);
      expect(attempts).toBe(1);
      expect(await history()).toEqual([]);
    } finally { spy.mockRestore(); }
  });

  it('the post-commit statement timeout cuts a stalled history write without rolling back the task', async () => {
    const real = db.$transaction.bind(db);
    let reached = false;
    const spy = vi.spyOn(db, '$transaction').mockImplementation(((fn: any, options: any) => real(async (tx: any) => {
      const delegate = tx.agentTeamEvent;
      const eventModel = new Proxy({}, { get: (_, key) => key === 'create' ? createEvent : delegate[key] });
      const wrapped = new Proxy({}, { get: (_, key) => key === 'agentTeamEvent' ? eventModel : tx[key] });
      const createEvent = async (args: any) => {
        if (args.data.type === 'task.warning') { reached = true; await tx.$executeRawUnsafe('SELECT pg_sleep(4)'); }
        return delegate.create(args);
      };
      return fn(wrapped);
    }, options)) as any);
    try {
      const started = Date.now();
      const r = await graphql(`mutation { ${field('ok')} }`);
      expect(r.errors).toBeUndefined();
      expect(reached).toBe(true);
      expect(Date.now() - started).toBeLessThan(3000);
      expect(await db.agentTask.count({ where: { appId: app.id, title: 'Synthetic task' } })).toBe(1);
      expect(await history()).toEqual([]);
    } finally { spy.mockRestore(); }
  });
});

describe('passive history with real SQL admission', () => {
  const at = (seconds: number) => new Date(Date.UTC(2026, 9, 27, 12, 0, seconds));
  async function rawTask(extra = {}) { return db.agentTask.create({ data: { appId: app.id, title: 'Synthetic', ownerUserId: user.id, ...extra } }); }
  async function event(taskId: string, type: string, extra = {}) {
    return db.agentTeamEvent.create({ data: { appId: app.id, taskId, type, ...extra } });
  }
  it('a later warning neither suppresses an assignment wake nor creates a delivery row; actual action still suppresses', async () => {
    const t = await rawTask({ assigneeWorkerId: worker.id, assignedAt: at(1) });
    const assigned = await event(t.id, 'task.assigned', { subjectWorkerId: worker.id, createdAt: at(1) });
    await event(t.id, 'task.warning', { actorWorkerId: worker.id, createdAt: at(2), payload: { code: 'task.create.no-source' } });
    expect((await pendingTaskWakes(db, [worker.id], at(4))).get(worker.id)?.map(w => w.eventId)).toEqual([assigned.id]);
    expect(await db.workerDeliveryTaskEvent.count()).toBe(0);
    await event(t.id, 'task.progress', { actorWorkerId: worker.id, createdAt: at(3) });
    expect((await pendingTaskWakes(db, [worker.id], at(4))).get(worker.id)).toBeUndefined();
  });
  it('a later parent warning preserves a child-finished wake; actual parent action still clears it', async () => {
    const p = await rawTask();
    const child = await rawTask({ parentTaskId: p.id, ownerUserId: null, ownerWorkerId: worker.id, assigneeUserId: user.id, assignedAt: at(0), status: 'finished', startedAt: at(0), finishedAt: at(1), resultOutcome: 'done' });
    const finished = await event(child.id, 'task.finished', { createdAt: at(1) });
    await event(p.id, 'task.warning', { actorWorkerId: worker.id, createdAt: at(2), payload: { code: 'task.finish.open-children' } });
    expect((await pendingTaskWakes(db, [worker.id], at(4))).get(worker.id)?.map(w => w.eventId)).toEqual([finished.id]);
    await event(p.id, 'task.started', { actorWorkerId: worker.id, createdAt: at(3) });
    expect((await pendingTaskWakes(db, [worker.id], at(4))).get(worker.id)).toBeUndefined();
  });
  it('a warning alone creates no wake', async () => {
    const t = await rawTask({ assigneeWorkerId: worker.id, assignedAt: at(1) });
    await event(t.id, 'task.warning', { actorWorkerId: worker.id, createdAt: at(2), payload: { code: 'task.create.no-source' } });
    expect((await pendingTaskWakes(db, [worker.id], at(4))).size).toBe(0);
    expect(await db.workerDeliveryTaskEvent.count()).toBe(0);
  });
  it('a worker-owner warning cannot reset the session-derived stall/activity clock; genuine session activity does', async () => {
    const p = await rawTask();
    await rawTask({ parentTaskId: p.id, ownerUserId: null, ownerWorkerId: worker.id, assigneeUserId: user.id, assignedAt: at(0), status: 'finished', startedAt: at(0), finishedAt: at(1), resultOutcome: 'done' });
    const session = await db.session.create({ data: { id: generateId(), userId: user.id, appId: app.id, workerId: worker.id, agentId, startedAt: at(0), updatedAt: at(0) } });
    const before = (await loadStallInputs(db, { id: p.id }, at(4)))[0].endedChildren[0].ownerActivityAt;
    expect(before).toEqual(at(0));
    await event(p.id, 'task.warning', { actorWorkerId: worker.id, actorUserId: user.id, actorAgentId: agentId, createdAt: at(2), payload: { code: 'task.finish.open-children' } });
    expect((await loadStallInputs(db, { id: p.id }, at(4)))[0].endedChildren[0].ownerActivityAt).toEqual(before);
    await db.session.update({ where: { id: session.id }, data: { updatedAt: at(3) } });
    expect((await loadStallInputs(db, { id: p.id }, at(4)))[0].endedChildren[0].ownerActivityAt).toEqual(at(3));
  });

  it('a human warning does not reset the person-owner stall clock, but a real task call does', async () => {
    const p = await rawTask();
    await rawTask({ parentTaskId: p.id, assigneeUserId: user.id, assignedAt: at(0), status: 'finished', startedAt: at(0), finishedAt: at(1), resultOutcome: 'done' });
    await event(p.id, 'task.warning', { actorUserId: user.id, createdAt: at(2), payload: { code: 'task.finish.open-children' } });
    const inputs = await loadStallInputs(db, { id: p.id }, at(4));
    expect(inputs[0].endedChildren[0].ownerActivityAt).toBeNull();
    await event(p.id, 'task.progress', { actorUserId: user.id, createdAt: at(3) });
    expect((await loadStallInputs(db, { id: p.id }, at(4)))[0].endedChildren[0].ownerActivityAt).toEqual(at(3));
  });
});
