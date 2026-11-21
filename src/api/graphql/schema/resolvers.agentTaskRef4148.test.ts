/**
 * #4148 (entity refs S7; cor:api:140:01, cor:agt:050:01): the agent-task family's 15 arguments take refs. Per the gate:
 *  - pin 1: the 11 mutations take `taskRef`; `agentTask(ref:)`; `agentTasks(parentTaskRef:)`; `agentTeamEvents{,Page}(taskRef:)`;
 *  - pin 2: "a handle/URN and a PK both work" means the PK, the bare handle and the HANDLE URN
 *    `hrn:agenttask:<app-urn>:<handle>`. The id-form URN is not claimed (cor:agt:050:01 records it as partly built);
 *  - pin 3: an unresolvable list filter falls back to the raw string and answers an empty list, never a refusal
 *    (unknown ≡ unreadable, cor:agt:050:21);
 *  - the old name is rejected as an unknown argument.
 * Exercised through the real schema (ApolloServer.executeOperation), so validation and the resolvers both run.
 *
 * Callers outside this repo (Billie's BLIND F2), a grep of every sibling repo's main on 2026-11-21 for the old names on
 * these 16 fields: hadron-cli 25 call sites (companion hadron-cli#2897); hadron-portal 24 (companion hadron-portal#2480);
 * hadron-client, hadron-relay, hadron-cloud and hadron-task-adapter-github 0; hadron-docs 0 (only generated reference,
 * regenerated from this SDL). Inside this repo none remain. Ship order (F3; precedent 0274): notices, then this server,
 * then the companions, which may fall back to the old name only on the GraphQL validation error. ticker-wake's behaviour
 * under the skew is documented beside its queries (scripts/ticker-wake/ticker-wake.ts).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApolloServer } from '@apollo/server';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';
import { typeDefs } from './typeDefs.js';
import { settleTeamEventHorizon, useTeamEventHorizonTimeout } from '../../../test/teamEventHorizon.js';

useTeamEventHorizonTimeout(); // the events cases wait on the commit-safe horizon (#4316)
vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));

const M = resolvers.Mutation as any;
const T = (resolvers as any).AgentTask as Record<string, (t: any, a: unknown, c: Context) => unknown>;
let api: ApolloServer<Context>;
let user: { id: string }; let app: { id: string; urn: string };
let parent: { id: string }; let child: { id: string };
const ctx = (): Context => ({ db, userId: user.id, roles: ['READER'] });

async function run(query: string, variables: Record<string, unknown> = {}) {
  const res = await api.executeOperation({ query, variables }, { contextValue: ctx() });
  if (res.body.kind !== 'single') throw new Error('expected a single result');
  return res.body.singleResult;
}
/** The three accepted forms of a task reference (gate pin 2). */
async function forms(task: { id: string }) {
  const handle = T.handle(task, {}, ctx()) as string;
  return { pk: task.id, handle, urn: `hrn:agenttask:${app.urn}:${handle}` };
}

beforeAll(() => { api = new ApolloServer<Context>({ typeDefs, resolvers }); });
afterAll(async () => { await api.stop().catch(() => {}); });
beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), name: 'Ref4148', urn: `ref4148-${generateId().toLowerCase()}.example` } });
  user = await db.user.create({ data: { id: generateId(), githubId: 414801, githubUsername: 'ref4148', roles: ['READER'] }, select: { id: true } });
  await db.orgMember.create({ data: { id: generateId(), organizationId: org.id, userId: user.id, role: 'ADMIN' } });
  app = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Team', urn: `${org.urn}:team` } });
  await db.appMember.create({ data: { appId: app.id, userId: user.id, role: 'member' } });
  // Only the parent's assignee creates its children, so the parent is assigned to the test user.
  parent = await M.createAgentTask({}, { input: { appRef: app.id, title: 'parent', assignee: { user: user.id } } }, ctx());
  child = await M.createAgentTask({}, { input: { appRef: app.id, title: 'child', parentTaskId: parent.id } }, ctx());
});

describe('#4148 agentTask(ref:)', () => {
  it('reads the task by PK, bare handle and handle URN', async () => {
    for (const ref of Object.values(await forms(child))) {
      const r = await run('query($r:ID!){agentTask(ref:$r){id}}', { r: ref });
      expect(r.errors, ref).toBeUndefined();
      expect(r.data).toEqual({ agentTask: { id: child.id } });
    }
  });
  it('rejects the old argument name `id`', async () => {
    const r = await run('query($r:ID!){agentTask(id:$r){id}}', { r: child.id });
    expect(r.errors?.map(e => e.message).join('\n')).toMatch(/Unknown argument "id" on field "Query\.agentTask"/);
  });
});

describe('#4148 the 11 mutations take taskRef', () => {
  const mutations = ['updateAgentTask', 'assignAgentTask', 'reassignAgentTask', 'startAgentTask', 'recordAgentTaskProgress',
    'finishAgentTask', 'cancelAgentTask', 'releaseAgentTaskExternalId', 'parkAgentTask', 'cloneAgentTask', 'makeAgentTaskReady'];
  it.each(mutations)('%s rejects the old argument name `taskId`', async m => {
    const r = await run(`mutation($t:ID!){${m}(taskId:$t){id}}`, { t: child.id });
    expect(r.errors?.map(e => e.message).join('\n')).toMatch(new RegExp(`Unknown argument "taskId" on field "Mutation\\.${m}"`));
  });
  it('updateAgentTask(taskRef:) edits the task by PK, bare handle and handle URN', async () => {
    for (const [form, ref] of Object.entries(await forms(child))) {
      const r = await run('mutation($t:ID!,$i:UpdateAgentTaskInput!){updateAgentTask(taskRef:$t,input:$i){id title}}', { t: ref, i: { title: `via ${form}` } });
      expect(r.errors, form).toBeUndefined();
      expect(r.data).toEqual({ updateAgentTask: { id: child.id, title: `via ${form}` } });
    }
  });
});

describe('#4148 list filters take refs and keep concealment parity', () => {
  it('agentTasks(parentTaskRef:) lists the children by PK, bare handle and handle URN; an unresolvable ref is an empty list', async () => {
    for (const ref of Object.values(await forms(parent))) {
      const r = await run('query($a:ID!,$p:ID){agentTasks(appRef:$a,parentTaskRef:$p){id}}', { a: app.id, p: ref });
      expect(r.errors, ref).toBeUndefined();
      expect(r.data).toEqual({ agentTasks: [{ id: child.id }] });
    }
    for (const ref of ['AT999', `hrn:agenttask:${app.urn}:AT999`, generateId()]) {
      const r = await run('query($a:ID!,$p:ID){agentTasks(appRef:$a,parentTaskRef:$p){id}}', { a: app.id, p: ref });
      expect(r.errors, ref).toBeUndefined();
      expect(r.data).toEqual({ agentTasks: [] });
    }
  });
  it('agentTasksPage(parentTaskRef:) pages the children by PK, bare handle and handle URN; unresolvable is empty; old name rejected (Bridget LOCAL P2-1)', async () => {
    // agentTasksPage shares agentTasks' ListArgs, so it must take the same argument or its filter is silently ignored.
    for (const ref of Object.values(await forms(parent))) {
      const r = await run('query($a:ID!,$p:ID){agentTasksPage(appRef:$a,parentTaskRef:$p){items{id}}}', { a: app.id, p: ref });
      expect(r.errors, ref).toBeUndefined();
      expect(r.data).toEqual({ agentTasksPage: { items: [{ id: child.id }] } });
    }
    const none = await run('query($a:ID!,$p:ID){agentTasksPage(appRef:$a,parentTaskRef:$p){items{id}}}', { a: app.id, p: 'AT999' });
    expect(none.errors).toBeUndefined();
    expect(none.data).toEqual({ agentTasksPage: { items: [] } });
    const old = await run('query($a:ID!,$p:ID){agentTasksPage(appRef:$a,parentTaskId:$p){items{id}}}', { a: app.id, p: parent.id });
    expect(old.errors?.map(e => e.message).join('\n')).toMatch(/Unknown argument "parentTaskId" on field "Query\.agentTasksPage"/);
  });
  it('agentTasks rejects the old argument name `parentTaskId`', async () => {
    const r = await run('query($a:ID!,$p:ID){agentTasks(appRef:$a,parentTaskId:$p){id}}', { a: app.id, p: parent.id });
    expect(r.errors?.map(e => e.message).join('\n')).toMatch(/Unknown argument "parentTaskId" on field "Query\.agentTasks"/);
  });
  it.each(['agentTeamEvents', 'agentTeamEventsPage'])('%s(taskRef:) filters by PK, bare handle and handle URN; unresolvable is empty; old name rejected', async field => {
    const sel = field === 'agentTeamEvents' ? '{taskId}' : '{events{taskId}}';
    const rows = (d: any) => (field === 'agentTeamEvents' ? d[field] : d[field].events) as Array<{ taskId: string }>;
    await settleTeamEventHorizon(db); // the forward feed is commit-safe: wait until the fixture's events are past the horizon
    for (const ref of Object.values(await forms(child))) {
      const r = await run(`query($a:ID!,$t:ID){${field}(appRef:$a,taskRef:$t)${sel}}`, { a: app.id, t: ref });
      expect(r.errors, ref).toBeUndefined();
      expect(rows(r.data).length, ref).toBeGreaterThan(0);
      expect(rows(r.data).every(e => e.taskId === child.id), ref).toBe(true);
    }
    const none = await run(`query($a:ID!,$t:ID){${field}(appRef:$a,taskRef:$t)${sel}}`, { a: app.id, t: 'AT999' });
    expect(none.errors).toBeUndefined();
    expect(rows(none.data)).toEqual([]);
    const old = await run(`query($a:ID!,$t:ID){${field}(appRef:$a,taskId:$t)${sel}}`, { a: app.id, t: child.id });
    expect(old.errors?.map(e => e.message).join('\n')).toMatch(new RegExp(`Unknown argument "taskId" on field "Query\\.${field}"`));
  });
});
