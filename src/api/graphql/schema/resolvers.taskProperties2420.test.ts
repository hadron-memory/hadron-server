/**
 * #2420 (cor:agt:050:28): every agent task holds its own optional `properties` JSON object. The platform stores,
 * returns and (when the Team Agent's system memory carries `schema:task-properties`) validates it; it never reads it
 * for matching or authorization. Written by the cor:agt:050:09 set and by the task's assignee, nobody else.
 */
import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApolloServer } from '@apollo/server';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { pendingTaskWakes } from '../../../lib/agentTasks/taskWakes.js';
import { generateId } from '../../../lib/id.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
import { runAsActor } from '../../../lib/requestActor.js';
import { createMcpServerInstance } from '../../../mcp/server.js';
import { resolvers } from './resolvers.js';
import { typeDefs } from './typeDefs.js';
vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));

const M = resolvers.Mutation as any;
const Q = resolvers.Query as any;
let org: any, app: any, owner: any, manager: any, assignee: any, sibling: any, outsider: any, agent: any, systemMemory: any;
let head: any, worker: any, task: any;
const ctx = (userId = owner.id) => ({ db, userId, roles: ['READER'] });
const canonical = (v: unknown): string => {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as any)[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
};
const fingerprint = (v: unknown) => ({ bytes: Buffer.byteLength(canonical(v), 'utf8'), sha256: createHash('sha256').update(canonical(v)).digest('hex') });
const setProps = (properties: unknown, userId = owner.id, taskId = task.id) =>
  M.updateAgentTask({}, { taskId, input: { properties } }, ctx(userId));
const stored = async (id = task.id) => (await db.agentTask.findUniqueOrThrow({ where: { id } })) as any;
const changed = (id = task.id) => db.agentTeamEvent.findMany({ where: { taskId: id, type: 'task.properties-changed' }, orderBy: { createdAt: 'asc' } });
const putSchema = (data: unknown, memoryId = systemMemory.id) =>
  db.node.create({ data: { id: generateId(), memoryId, loc: 'schema:task-properties', name: 'Task properties schema', data: data as any } });
const code = (c: string) => ({ extensions: { code: c } });

beforeEach(async () => {
  await cleanDb(db);
  org = await db.organization.create({ data: { name: 'Props', urn: `props-${generateId()}.test` } });
  [owner, manager, assignee, sibling, outsider] = await Promise.all(
    ['owner', 'manager', 'assignee', 'sibling', 'outsider'].map((handle) => db.user.create({ data: { handle } })),
  );
  app = await db.app.create({ data: { organizationId: org.id, name: 'Props', urn: `${org.urn}:props` } });
  for (const [u, role] of [[owner, 'member'], [manager, 'owner'], [assignee, 'member'], [sibling, 'member']] as const) {
    await db.appMember.create({ data: { appId: app.id, userId: u.id, role } });
  }
  systemMemory = await db.memory.create({ data: { organizationId: org.id, name: 'Team system', urn: `${org.urn}:team-system`, class: 'system' } });
  await db.node.create({ data: { id: generateId(), memoryId: systemMemory.id, loc: 'roles:lead', name: 'Lead' } });
  agent = await db.agent.create({ data: { organizationId: org.id, name: 'Team', urn: `${org.urn}:team`, systemMemoryId: systemMemory.id } });
  await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
  head = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: app.id, agentId: agent.id, name: 'Head', slug: 'head', heldByUserId: owner.id } });
  worker = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: app.id, agentId: agent.id, name: 'Worker', slug: 'worker', heldByUserId: owner.id, reportsToWorkerId: head.id } });
  task = await M.createAgentTask({}, { input: { appRef: app.id, title: 'Props task', source: 'fixed', assignee: { user: assignee.id } } }, ctx());
});

describe('create and read #2420', () => {
  it('stores properties unchanged on create and returns null when omitted', async () => {
    expect((await stored()).properties).toBeNull();
    const value = { review: { tier: 'T2', seats: ['local', 'blind'], sec10: true }, complexity: { score: 7, subscores: {} } };
    const made = await M.createAgentTask({}, { input: { appRef: app.id, title: 'With', source: 's', properties: value } }, ctx());
    expect((await stored(made.id)).properties).toEqual(value);
    const events = await changed(made.id);
    expect(events).toHaveLength(1);
    expect(events[0].payload).toEqual({ from: null, to: fingerprint(value) });
  });

  it('every task returns its own value: a child and a grandchild never read their root', async () => {
    await M.updateAgentTask({}, { taskId: task.id, input: { properties: { root: true } } }, ctx());
    const child = await M.createAgentTask({}, { input: { parentTaskId: task.id, title: 'Child' } }, ctx(assignee.id));
    expect((await stored(child.id)).properties).toBeNull();
    await M.updateAgentTask({}, { taskId: child.id, input: { properties: { child: true } } }, ctx(assignee.id));
    await M.updateAgentTask({}, { taskId: task.id, input: { properties: { root: 2 } } }, ctx());
    expect((await stored(child.id)).properties).toEqual({ child: true });
    expect((await stored()).properties).toEqual({ root: 2 });
  });

  it('a creator outside the writer set gets the properties left out, not refused', async () => {
    const made = await M.createAgentTask({}, {
      input: { appRef: app.id, title: 'Named owner', owner: { user: manager.id }, source: 's', properties: { review: { tier: 'T1' } } },
    }, ctx(sibling.id));
    expect(made.ownerUserId).toBe(manager.id);
    expect((await stored(made.id)).properties).toBeNull();
    expect(await changed(made.id)).toHaveLength(0);
  });

  it('an App manager naming another owner may set them; the new assignee may too', async () => {
    const viaManager = await M.createAgentTask({}, {
      input: { appRef: app.id, title: 'Mgr', owner: { user: owner.id }, source: 's', properties: { a: 1 } },
    }, ctx(manager.id));
    expect((await stored(viaManager.id)).properties).toEqual({ a: 1 });
    const viaAssignee = await M.createAgentTask({}, {
      input: { appRef: app.id, title: 'Self', owner: { user: manager.id }, assignee: { user: sibling.id }, source: 's', properties: { b: 2 } },
    }, ctx(sibling.id));
    expect((await stored(viaAssignee.id)).properties).toEqual({ b: 2 });
  });

  it('exposes properties through GraphQL create and read', async () => {
    const apollo = new ApolloServer({ typeDefs, resolvers });
    const created = await apollo.executeOperation({
      query: 'mutation($app:ID!,$p:JSON){createAgentTask(input:{appRef:$app,title:"Gql",source:"s",properties:$p}){id properties}}',
      variables: { app: app.id, p: { review: { head: 'abc' } } },
    }, { contextValue: ctx() });
    const out = (created.body as any).singleResult;
    expect(out.errors).toBeUndefined();
    expect(out.data.createAgentTask.properties).toEqual({ review: { head: 'abc' } });
    await apollo.stop();
  });
});

describe('update semantics #2420', () => {
  it('omitted leaves it unchanged, an object replaces the whole value, null clears; each real change is one content-free event', async () => {
    await setProps({ a: { PRIVATE: 1 }, b: 2 });
    await M.updateAgentTask({}, { taskId: task.id, input: { description: 'other field' } }, ctx());
    expect((await stored()).properties).toEqual({ a: { PRIVATE: 1 }, b: 2 });
    await setProps({ c: 3 });
    expect((await stored()).properties).toEqual({ c: 3 });
    await setProps(null);
    expect((await stored()).properties).toBeNull();
    const events = await changed();
    expect(events.map((e) => e.payload)).toEqual([
      { from: null, to: fingerprint({ a: { PRIVATE: 1 }, b: 2 }) },
      { from: fingerprint({ a: { PRIVATE: 1 }, b: 2 }), to: fingerprint({ c: 3 }) },
      { from: fingerprint({ c: 3 }), to: null },
    ]);
    expect(JSON.stringify(events)).not.toContain('PRIVATE');
  });

  it('hashes the canonical JSON, so key order never changes the fingerprint, and an identical write is no event', async () => {
    await setProps({ b: 1, a: 2 });
    await setProps({ a: 2, b: 1 });
    await setProps(null);
    await setProps(null);
    const events = await changed();
    expect(events).toHaveLength(2);
    expect((events[0].payload as any).to).toEqual(fingerprint({ a: 2, b: 1 }));
  });

  it('is passive history: it wakes nobody and clears no wake', async () => {
    const at = (n: number) => new Date(Date.now() - 10_000 + n * 1000);
    const t = await db.agentTask.create({ data: { appId: app.id, title: 'Wake', ownerWorkerId: worker.id, assigneeWorkerId: worker.id, assignedAt: at(1) } });
    const assigned = await db.agentTeamEvent.create({ data: { appId: app.id, taskId: t.id, type: 'task.assigned', subjectWorkerId: worker.id, createdAt: at(1) } });
    await runAsActor({ workerId: worker.id, agentId: agent.id }, () => setProps({ x: 1 }, owner.id, t.id));
    const wakes = (await pendingTaskWakes(db, [worker.id], new Date())).get(worker.id) ?? [];
    expect(wakes.map((w) => w.eventId)).toContain(assigned.id);
    expect(wakes.map((w) => w.eventId)).not.toContain((await changed(t.id))[0].id);
  });

  it.each(['finished', 'cancelled'])('refuses a write to a %s task, for its owner and its assignee', async (status) => {
    await db.agentTask.update({
      where: { id: task.id },
      data: status === 'finished'
        ? { status, startedAt: new Date(), finishedAt: new Date(), resultOutcome: 'done' }
        : { status, cancelledAt: new Date() },
    });
    await expect(setProps({ x: 1 })).rejects.toMatchObject(code('TASK_ENDED'));
    await expect(setProps({ x: 1 }, assignee.id)).rejects.toMatchObject(code('TASK_ENDED'));
    expect((await stored()).properties).toBeNull();
    expect(await changed()).toHaveLength(0);
  });
});

describe('who may write #2420', () => {
  it('admits the assignee, an App manager and the reporting chain', async () => {
    await setProps({ by: 'assignee' }, assignee.id);
    expect((await stored()).properties).toEqual({ by: 'assignee' });
    await setProps({ by: 'manager' }, manager.id);
    expect((await stored()).properties).toEqual({ by: 'manager' });
    await db.agentTask.update({ where: { id: task.id }, data: { ownerUserId: null, ownerWorkerId: worker.id } });
    await runAsActor({ workerId: head.id, agentId: agent.id }, () => setProps({ by: 'chain' }));
    expect((await stored()).properties).toEqual({ by: 'chain' });
    expect((await changed()).map((e) => e.actorWorkerId)).toEqual([null, null, head.id]);
  });

  it('admits the assignee ONLY for properties: any other field in the same patch refuses the whole call', async () => {
    await expect(M.updateAgentTask({}, { taskId: task.id, input: { properties: { a: 1 }, title: 'Hijack' } }, ctx(assignee.id)))
      .rejects.toMatchObject(code('TASK_NOT_OWNER'));
    await expect(M.updateAgentTask({}, { taskId: task.id, input: {} }, ctx(assignee.id))).rejects.toMatchObject(code('TASK_NOT_OWNER'));
    const row = await stored();
    expect(row.title).toBe('Props task');
    expect(row.properties).toBeNull();
    expect(await changed()).toHaveLength(0);
  });

  it('refuses a non-owner non-assignee, including the assignee of a sibling or of the root, and a revoked manager', async () => {
    const child = await M.createAgentTask({}, { input: { parentTaskId: task.id, title: 'Child', assignee: { user: sibling.id } } }, ctx(assignee.id));
    await expect(setProps({ a: 1 }, sibling.id, task.id)).rejects.toMatchObject(code('TASK_NOT_OWNER'));
    await expect(setProps({ a: 1 }, assignee.id, child.id)).resolves.toBeDefined(); // the parent's assignee owns its child
    await expect(setProps({ a: 1 }, outsider.id)).rejects.toBeDefined();
    await db.appMember.update({ where: { appId_userId: { appId: app.id, userId: manager.id } }, data: { role: 'member' } });
    await expect(setProps({ a: 1 }, manager.id)).rejects.toMatchObject(code('TASK_NOT_OWNER'));
    expect((await stored()).properties).toBeNull();
  });

  it('refuses a reassigned-away assignee, and the App key', async () => {
    await M.reassignAgentTask({}, { taskId: task.id, assignee: { user: sibling.id } }, ctx());
    await expect(setProps({ a: 1 }, assignee.id)).rejects.toMatchObject(code('TASK_NOT_OWNER'));
    await setProps({ a: 1 }, sibling.id);
    const key = await db.appKey.create({ data: { appId: app.id, keyHash: generateId(), keyPreview: 'test' } });
    await expect(M.updateAgentTask({}, { taskId: task.id, input: { properties: { k: 1 } } }, { db, appId: app.id, appKeyId: key.id, roles: [] }))
      .rejects.toMatchObject(code('TASK_NOT_FOUND'));
    expect((await stored()).properties).toEqual({ a: 1 });
  });

  it('refuses an impersonation session even when the impersonated user is the assignee', async () => {
    const impersonation = { sessionId: generateId(), actorUserId: manager.id, orgId: app.organizationId, expiresAt: new Date(Date.now() + 3600_000) };
    await expect(M.updateAgentTask({}, { taskId: task.id, input: { properties: { a: 1 } } }, { ...ctx(assignee.id), impersonation }))
      .rejects.toMatchObject(code('FORBIDDEN'));
    expect((await stored()).properties).toBeNull();
  });

  it('conceals an unreadable task byte-identically to an absent one', async () => {
    const hidden = await setProps({ a: 1 }, outsider.id).catch((e: any) => e);
    const absent = await M.assignAgentTask({}, { taskId: task.id, assignee: { user: outsider.id } }, ctx(outsider.id)).catch((e: any) => e);
    expect({ message: hidden.message, extensions: hidden.extensions }).toEqual({ message: absent.message, extensions: absent.extensions });
  });

  it('a read of a task the caller cannot read exposes nothing', async () => {
    await setProps({ secret: 'PRIVATE' });
    const apollo = new ApolloServer({ typeDefs, resolvers });
    const out = await apollo.executeOperation({ query: 'query($id:ID!){agentTask(taskRef:$id){id properties}}', variables: { id: task.id } }, { contextValue: ctx(outsider.id) });
    await apollo.stop();
    expect(JSON.stringify((out.body as any).singleResult)).not.toContain('PRIVATE');
  });
});

describe('contract #2420', () => {
  it('refuses a non-object with PROPERTIES_NOT_AN_OBJECT', async () => {
    for (const bad of [[1], 'text', 7, true]) {
      await expect(setProps(bad)).rejects.toMatchObject(code('PROPERTIES_NOT_AN_OBJECT'));
    }
    expect((await stored()).properties).toBeNull();
    expect(await changed()).toHaveLength(0);
  });

  it('bounds the canonical JSON at 16 KiB of UTF-8: exactly at the bound is accepted, one byte over is PROPERTIES_TOO_LARGE', async () => {
    const wrap = (n: number) => ({ k: 'x'.repeat(n) });
    const overhead = Buffer.byteLength(canonical(wrap(0)), 'utf8');
    await setProps(wrap(16_384 - overhead));
    await expect(setProps(wrap(16_384 - overhead + 1), owner.id)).rejects.toMatchObject(code('PROPERTIES_TOO_LARGE'));
    const multibyte = { k: 'é'.repeat(8_192) };
    await expect(setProps(multibyte)).rejects.toMatchObject(code('PROPERTIES_TOO_LARGE'));
    expect(Buffer.byteLength(canonical((await stored()).properties), 'utf8')).toBe(16_384);
  });

  it('with no schema node, any object within the bound is accepted', async () => {
    await setProps({ anything: [1, 2, { deep: true }] });
    expect((await stored()).properties).toEqual({ anything: [1, 2, { deep: true }] });
  });

  it('with a schema, a violating write is refused PROPERTIES_SCHEMA_VIOLATION and the old value stays', async () => {
    await putSchema({ type: 'object', properties: { review: { type: 'object', properties: { tier: { enum: ['T1', 'T2', 'T3'] } } } } });
    await setProps({ review: { tier: 'T2' } });
    await expect(setProps({ review: { tier: 'T9' } })).rejects.toMatchObject(code('PROPERTIES_SCHEMA_VIOLATION'));
    expect((await stored()).properties).toEqual({ review: { tier: 'T2' } });
    expect(await changed()).toHaveLength(1);
  });

  it('validates with the platform\'s own read: an assignee who cannot read the schema memory is validated all the same', async () => {
    await putSchema({ type: 'object', required: ['review'] });
    await expect(setProps({ other: 1 }, assignee.id)).rejects.toMatchObject(code('PROPERTIES_SCHEMA_VIOLATION'));
    await setProps({ review: {} }, assignee.id);
  });

  it('an unusable schema refuses every non-null write, never reads as no schema, and a clear still works', async () => {
    await setProps({ before: 1 });
    const node = await putSchema({ type: 'not-a-type' });
    await expect(setProps({ a: 1 })).rejects.toMatchObject(code('PROPERTIES_SCHEMA_UNUSABLE'));
    await db.node.update({ where: { id: node.id }, data: { data: ['not', 'a', 'schema'] as any } });
    await expect(setProps({ a: 1 })).rejects.toMatchObject(code('PROPERTIES_SCHEMA_UNUSABLE'));
    await db.node.update({ where: { id: node.id }, data: { data: { $ref: 'https://example.invalid/remote.json' } } });
    await expect(setProps({ a: 1 })).rejects.toMatchObject(code('PROPERTIES_SCHEMA_UNUSABLE'));
    await setProps(null);
    expect((await stored()).properties).toBeNull();
  });

  it('resolves the schema nearest-first through the Agent base chain; the Agent\'s own node wins', async () => {
    const baseMemory = await db.memory.create({ data: { organizationId: org.id, name: 'Base system', urn: `${org.urn}:base-system`, class: 'system' } });
    const base = await db.agent.create({ data: { organizationId: org.id, name: 'Base', urn: `${org.urn}:base`, systemMemoryId: baseMemory.id } });
    await db.agent.update({ where: { id: agent.id }, data: { extendsAgentId: base.id } });
    await putSchema({ type: 'object', required: ['fromBase'] }, baseMemory.id);
    await expect(setProps({ own: 1 })).rejects.toMatchObject(code('PROPERTIES_SCHEMA_VIOLATION'));
    await setProps({ fromBase: 1 });
    await putSchema({ type: 'object', required: ['own'] });
    await setProps({ own: 1 });
    await expect(setProps({ fromBase: 1 })).rejects.toMatchObject(code('PROPERTIES_SCHEMA_VIOLATION'));
  });

  it('a soft-deleted schema node does not apply', async () => {
    const node = await putSchema({ type: 'object', required: ['never'] });
    await db.node.update({ where: { id: node.id }, data: { deletedAt: new Date() } });
    await setProps({ ok: true });
  });

  it('a create that violates the schema is refused and writes nothing', async () => {
    await putSchema({ type: 'object', required: ['review'] });
    const before = await db.agentTask.count();
    await expect(M.createAgentTask({}, { input: { appRef: app.id, title: 'Bad', source: 's', properties: { nope: 1 } } }, ctx()))
      .rejects.toMatchObject(code('PROPERTIES_SCHEMA_VIOLATION'));
    expect(await db.agentTask.count()).toBe(before);
  });

  it('never changes matching: requirements and the chosen worker are the same with and without properties', async () => {
    const plain = await M.createAgentTask({}, { input: { appRef: app.id, title: 'Plain', source: 's', requirements: { role: 'server-engineer' } } }, ctx());
    const withProps = await M.createAgentTask({}, { input: { appRef: app.id, title: 'With', source: 's', requirements: { role: 'server-engineer' }, properties: { requirements: { role: 'other' }, familyIn: ['x'] } } }, ctx());
    expect((await stored(plain.id)).requirements).toEqual((await stored(withProps.id)).requirements);
    expect((await stored(withProps.id)).requirements).toEqual({ role: 'server-engineer' });
  });
});

describe('surfaces #2420', () => {
  it('GraphQL update with JSON null clears, and an absent key leaves it', async () => {
    await setProps({ a: 1 });
    const apollo = new ApolloServer({ typeDefs, resolvers });
    const run = (query: string, variables: any) => apollo.executeOperation({ query, variables }, { contextValue: ctx() }).then((o) => (o.body as any).singleResult);
    const keep = await run('mutation($id:ID!){updateAgentTask(taskId:$id,input:{title:"Renamed"}){properties}}', { id: task.id });
    expect(keep.errors).toBeUndefined();
    expect(keep.data.updateAgentTask.properties).toEqual({ a: 1 });
    const clear = await run('mutation($id:ID!,$p:JSON){updateAgentTask(taskId:$id,input:{properties:$p}){properties}}', { id: task.id, p: null });
    expect(clear.errors).toBeUndefined();
    expect(clear.data.updateAgentTask.properties).toBeNull();
    await apollo.stop();
  });

  it('MCP hadron_task_create and hadron_task_update carry properties through the same resolver', async () => {
    const session = await db.session.create({ data: { id: generateId(), userId: owner.id } });
    const server = createMcpServerInstance({ userId: owner.id, roles: ['READER'], clientId: `user:${owner.id}` } as any, () => undefined, { kind: 'multi-app' });
    const client = new Client({ name: 'props', version: '1' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(b);
    await client.connect(a);
    try {
      const upd = await client.callTool({ name: 'hadron_task_update', arguments: { taskId: task.id, input: { properties: { via: 'mcp' } }, session: session.id } });
      expect(upd.isError).not.toBe(true);
      expect((await stored()).properties).toEqual({ via: 'mcp' });
      const bad = await client.callTool({ name: 'hadron_task_update', arguments: { taskId: task.id, input: { properties: [1] }, session: session.id } });
      expect(bad.isError).toBe(true);
      expect(JSON.stringify(bad.content)).toContain('[properties_not_an_object]');
      const created = await client.callTool({ name: 'hadron_task_create', arguments: { appRef: app.id, title: 'Mcp', source: 's', properties: { made: 'mcp' }, session: session.id } });
      expect(created.isError).not.toBe(true);
      expect((await db.agentTask.findFirstOrThrow({ where: { title: 'Mcp' } }) as any).properties).toEqual({ made: 'mcp' });
    } finally {
      await client.close();
      await server.close();
    }
  });
});
