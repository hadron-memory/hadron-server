import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
/**
 * #2607 (action register phase 3) — warnings on task cancel and alarm acknowledgement.
 *
 * `task.cancel.open-children`: a cancel that leaves open (pending/started) children still succeeds and says so.
 * `alarm.ack.outside-chain`: an acknowledgement admitted only because the caller manages the App (cor:agt:050:24),
 * not as an owner in the alarm's chain, still succeeds and says so. Both are ungated fixed text, decided in the write
 * transaction and filed after it commits: a refused or rolled-back call files none.
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
import { TASK_WARNING_TEXT } from './resolvers.taskWarnings.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({ syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }) }));

const M = resolvers.Mutation as any;
const Q = resolvers.Query as any;

let org: { id: string; urn: string };
let admin: { id: string };
let member: { id: string };
let app: { id: string };
let teamAgentId: string;
let teamMemoryId: string;
let teamMemoryUrn: string;
let ada: { id: string };
let anne: { id: string };

const CANCEL = 'task.cancel.open-children';
const ACK = 'alarm.ack.outside-chain';

const ctx = (userId: string): Context => ({ db, userId, roles: ['READER'] });
const asWorker = (w: { id: string }, agentId: string | null, fn: () => Promise<any>) => runAsActor({ workerId: w.id, agentId }, fn);
const codes = (c: Context) => (c.taskWarnings ?? []).map((w) => w.warning.code as string);
const worker = (name: string) =>
  db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId: app.id, agentId: teamAgentId, name, slug: name.toLowerCase() }, select: { id: true } });
const task = (data: Record<string, unknown>) =>
  db.agentTask.create({ data: { id: generateId(), appId: app.id, title: 'T', ...data } as any, select: { id: true } });
/** A child task in `status`, with the columns the shape constraint (chk_agent_tasks_shape) requires. */
const child = (parentTaskId: string, owner: Record<string, unknown>, status: string) => {
  const now = new Date();
  const worked = status === 'started' || status === 'finished' ? { assigneeWorkerId: anne.id, assignedAt: now, startedAt: now } : {};
  return task({
    parentTaskId, ...owner, status, ...worked,
    ...(status === 'finished' ? { finishedAt: now, resultOutcome: 'succeeded' } : {}),
    ...(status === 'cancelled' ? { cancelledAt: now } : {}),
  });
};
const node = (memoryId: string, loc: string, extra: Record<string, unknown> = {}) =>
  db.node.create({ data: { id: generateId(), memoryId, loc, name: loc, content: '# x', ...extra } });

/** A ctx whose every write transaction runs to the end and then rolls back: the decision is made, nothing commits. */
const rollingBack = (userId: string): Context => ({
  ...ctx(userId),
  db: new Proxy(db, {
    get(target, prop, receiver) {
      if (prop !== '$transaction') return Reflect.get(target, prop, receiver);
      return (fn: (tx: unknown) => Promise<unknown>, opts?: unknown) =>
        db.$transaction(async (tx) => { await fn(tx); throw new Error('forced rollback'); }, opts as never);
    },
  }) as typeof db,
});

async function expectCode(p: Promise<unknown>, code: string) {
  const e = await p.then(() => null, (err) => err);
  expect(e).toBeInstanceOf(GraphQLError);
  expect((e as GraphQLError).extensions?.code).toBe(code);
}

/** A stall alarm on a task Ada owns: the chain lists Ada, then the admin as a manager entry (cor:agt:050:25). */
async function alarm(chain: unknown[] = [{ workerId: ada.id }, { userId: admin.id, via: 'manager' }], extra: Record<string, unknown> = {}) {
  const t = await task({ ownerWorkerId: ada.id, assigneeWorkerId: anne.id, status: 'pending', assignedAt: new Date() });
  return db.agentTeamEvent.create({
    data: { appId: app.id, taskId: t.id, type: 'stall.not-started', severity: 'alarm', chain: chain as never, episodeStart: new Date(), ...extra },
  });
}

beforeEach(async () => {
  await cleanDb(db);
  const suffix = generateId().toLowerCase();
  org = await db.organization.create({ data: { id: generateId(), name: 'tw7-org', urn: `tw7-${suffix}.example` } });
  admin = await db.user.create({ data: { githubId: 260701, githubUsername: 'tw7-admin', handle: 'tw7-admin', roles: ['READER'] } });
  member = await db.user.create({ data: { githubId: 260702, githubUsername: 'tw7-member', handle: 'tw7-member', roles: ['READER'] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  const agent = await M.createAgent({}, { orgId: org.id, name: 'Team Agent' }, ctx(admin.id));
  teamAgentId = agent.id;
  teamMemoryId = (await db.agent.findUniqueOrThrow({ where: { id: teamAgentId } })).systemMemoryId as string;
  teamMemoryUrn = (await db.memory.findUniqueOrThrow({ where: { id: teamMemoryId } })).urn;
  app = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Team', urn: `${org.urn}:team` } });
  await db.appMember.create({ data: { appId: app.id, userId: member.id, role: 'member' } });
  await db.appAgent.create({ data: { appId: app.id, agentId: teamAgentId } });
  await node(teamMemoryId, 'roles'); // the Team Agent marker (locateTeamAgent)
  ada = await worker('Ada');
  anne = await worker('Anne');
});

describe('task.cancel.open-children', () => {
  it('fires for a pending or a started child; the cancel still succeeds', async () => {
    for (const status of ['pending', 'started'] as const) {
      const parent = await task({ ownerUserId: member.id });
      await child(parent.id, { ownerUserId: member.id }, status);
      const c = ctx(member.id);
      const out = await M.cancelAgentTask({}, { taskId: parent.id }, c);
      expect(out.status).toBe('cancelled');
      expect(codes(c)).toEqual([CANCEL]);
      expect(c.taskWarnings![0].warning.text).toBe('This task still has open child tasks; cancelling it does not end them.');
    }
  });

  it('does not fire for zero children, or for children that are backlog, finished or cancelled (the finish predicate)', async () => {
    const solo = await task({ ownerUserId: member.id });
    const c0 = ctx(member.id);
    await M.cancelAgentTask({}, { taskId: solo.id }, c0);
    expect(codes(c0)).toEqual([]);
    const parent = await task({ ownerUserId: member.id });
    for (const status of ['backlog', 'finished', 'cancelled']) await child(parent.id, { ownerUserId: member.id }, status);
    const c = ctx(member.id);
    expect((await M.cancelAgentTask({}, { taskId: parent.id }, c)).status).toBe('cancelled');
    expect(codes(c)).toEqual([]);
  });

  it('a refused cancel files none', async () => {
    const parent = await task({ ownerUserId: member.id });
    await child(parent.id, { ownerUserId: member.id }, 'pending');
    const c = ctx(member.id);
    await expectCode(asWorker(anne, teamAgentId, () => M.cancelAgentTask({}, { taskId: parent.id }, c)), 'TASK_NOT_OWNER');
    expect(codes(c)).toEqual([]);
  });

  it('a cancel whose transaction rolls back after the decision files none', async () => {
    const parent = await task({ ownerUserId: member.id });
    await child(parent.id, { ownerUserId: member.id }, 'pending');
    const c = rollingBack(member.id);
    await expect(M.cancelAgentTask({}, { taskId: parent.id }, c)).rejects.toThrow('forced rollback');
    expect(codes(c)).toEqual([]);
    expect((await db.agentTask.findUniqueOrThrow({ where: { id: parent.id } })).status).toBe('pending');
  });

  it('register: mapped for a worker caller with an Agent, unmapped without an entry, none for a person', async () => {
    const parent = () => task({ ownerWorkerId: ada.id }).then(async (p) => {
      await child(p.id, { ownerWorkerId: ada.id }, 'pending');
      return p;
    });
    const unmapped = ctx(member.id);
    await asWorker(ada, teamAgentId, async () => M.cancelAgentTask({}, { taskId: (await parent()).id }, unmapped));
    expect(unmapped.taskWarnings![0].warning.register).toEqual({ state: 'unmapped' });

    await node(teamMemoryId, `register:${CANCEL}`, { data: { registerEntry: { code: CANCEL, taskLoc: 'tasks:cancel' } } });
    const unresolved = ctx(member.id);
    await asWorker(ada, teamAgentId, async () => M.cancelAgentTask({}, { taskId: (await parent()).id }, unresolved));
    expect(unresolved.taskWarnings![0].warning.register).toEqual({ state: 'unresolved' });

    await node(teamMemoryId, 'tasks:cancel', { isRunnable: true });
    const mapped = ctx(member.id);
    await asWorker(ada, teamAgentId, async () => M.cancelAgentTask({}, { taskId: (await parent()).id }, mapped));
    expect(mapped.taskWarnings![0].warning.register).toEqual({
      state: 'mapped', taskLoc: 'tasks:cancel', taskUrn: `hrn:node:${teamMemoryUrn}:tasks:cancel`,
    });

    const p = await task({ ownerUserId: member.id });
    await child(p.id, { ownerUserId: member.id }, 'pending');
    const person = ctx(member.id);
    await M.cancelAgentTask({}, { taskId: p.id }, person);
    expect(codes(person)).toEqual([CANCEL]);
    expect(person.taskWarnings![0].warning.register).toBeUndefined();
  });

  it('is advice only: no task.warning history event (warning events are not in this slice)', async () => {
    const parent = await task({ ownerUserId: member.id });
    await child(parent.id, { ownerUserId: member.id }, 'pending');
    const server = new ApolloServer<Context>({ typeDefs, resolvers, plugins: [taskWarningsPlugin] });
    await server.executeOperation({ query: `mutation { c: cancelAgentTask(taskId: "${parent.id}") { id } }` }, { contextValue: ctx(member.id) });
    expect(await db.agentTeamEvent.count({ where: { appId: app.id, type: 'task.warning' } })).toBe(0);
  });
});

describe('alarm.ack.outside-chain', () => {
  it('fires for a manager who is not an owner in the chain (a manager entry is not an owner); the ack still succeeds', async () => {
    const a = await alarm();
    const c = ctx(admin.id);
    const out = await M.acknowledgeAlarm({}, { eventId: a.id }, c);
    expect(out.acknowledgedAt).toBeInstanceOf(Date);
    expect(out.acknowledgedByUserId).toBe(admin.id);
    expect(codes(c)).toEqual([ACK]);
    expect(c.taskWarnings![0].warning.register).toBeUndefined(); // a person: code + text only
  });

  it('fires only for a caller who passes the alarm read gate: the manager reads the alarm row', async () => {
    const a = await alarm();
    const seen = await Q.agentTeamEvents({}, { appRef: app.id, alarmsOnly: true }, ctx(admin.id));
    expect(seen.map((e: { id: string }) => e.id)).toContain(a.id);
    const c = ctx(admin.id);
    await M.acknowledgeAlarm({}, { eventId: a.id }, c);
    expect(codes(c)).toEqual([ACK]);
  });

  it('its text is fixed and names no worker, owner or chain member', async () => {
    const a = await alarm();
    const c = ctx(admin.id);
    await M.acknowledgeAlarm({}, { eventId: a.id }, c);
    const text = c.taskWarnings![0].warning.text;
    expect(text).toBe('You acknowledged an alarm outside its chain, as a manager of the App.');
    expect(text).toBe(TASK_WARNING_TEXT[ACK]);
    for (const leak of ['Ada', 'Anne', 'tw7-admin', ada.id, anne.id, admin.id, a.id, a.taskId!]) expect(text).not.toContain(leak);
  });

  it('does not fire for an owner in the chain who also manages the App (decided from the chain)', async () => {
    const a = await alarm([{ userId: admin.id }, { userId: admin.id, via: 'manager' }]);
    const c = ctx(admin.id);
    await M.acknowledgeAlarm({}, { eventId: a.id }, c);
    expect(codes(c)).toEqual([]);
  });

  it('does not fire for a worker owner in the chain', async () => {
    const a = await alarm();
    const c = ctx(member.id);
    await asWorker(ada, teamAgentId, () => M.acknowledgeAlarm({}, { eventId: a.id }, c));
    expect(codes(c)).toEqual([]);
  });

  it('a refused ack files none: NOT_AN_ALARM, ALARM_NOT_IN_CHAIN, ALARM_ALREADY_ACKNOWLEDGED', async () => {
    const plain = await db.agentTeamEvent.create({ data: { appId: app.id, type: 'task.created' } });
    const c1 = ctx(admin.id);
    await expectCode(M.acknowledgeAlarm({}, { eventId: plain.id }, c1), 'NOT_AN_ALARM');
    expect(codes(c1)).toEqual([]);

    const a = await alarm();
    const c2 = ctx(member.id);
    await expectCode(M.acknowledgeAlarm({}, { eventId: a.id }, c2), 'ALARM_NOT_IN_CHAIN');
    expect(codes(c2)).toEqual([]);

    await M.acknowledgeAlarm({}, { eventId: a.id }, ctx(admin.id));
    const c3 = ctx(admin.id);
    await expectCode(M.acknowledgeAlarm({}, { eventId: a.id }, c3), 'ALARM_ALREADY_ACKNOWLEDGED');
    expect(codes(c3)).toEqual([]);
  });

  it('an ack whose transaction rolls back after the decision files none', async () => {
    const a = await alarm();
    const c = rollingBack(admin.id);
    await expect(M.acknowledgeAlarm({}, { eventId: a.id }, c)).rejects.toThrow('forced rollback');
    expect(codes(c)).toEqual([]);
    expect((await db.agentTeamEvent.findUniqueOrThrow({ where: { id: a.id } })).acknowledgedAt).toBeNull();
  });
});

describe('the carrier: extensions.warnings on a real GraphQL response', () => {
  it('cancel and ack each carry theirs under their own alias; data is unchanged', async () => {
    const parent = await task({ ownerUserId: admin.id });
    await child(parent.id, { ownerUserId: admin.id }, 'started');
    const a = await alarm();
    const server = new ApolloServer<Context>({ typeDefs, resolvers, plugins: [taskWarningsPlugin] });
    const res = await server.executeOperation({
      query: `mutation { c: cancelAgentTask(taskId: "${parent.id}") { id status } k: acknowledgeAlarm(eventId: "${a.id}") { id } }`,
    }, { contextValue: ctx(admin.id) });
    if (res.body.kind !== 'single') throw new Error('single expected');
    expect(res.body.singleResult.errors).toBeUndefined();
    expect((res.body.singleResult.data as any).c.status).toBe('CANCELLED');
    expect(res.body.singleResult.extensions?.warnings).toEqual([
      { path: 'c', code: CANCEL, text: TASK_WARNING_TEXT[CANCEL] },
      { path: 'k', code: ACK, text: TASK_WARNING_TEXT[ACK] },
    ]);
  });
});
