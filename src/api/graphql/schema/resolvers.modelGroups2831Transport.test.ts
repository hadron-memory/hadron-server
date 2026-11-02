/**
 * #2831 S2 — `modelGroupIn` / `modelGroupNotIn` through the REAL GraphQL transport and the registered MCP handlers
 * (create, update, read). A name no effective group of the App carries is refused at create and at update with
 * MODEL_GROUP_NOT_FOUND naming it, and a refusal leaves the task and its events as they were.
 */
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createServer } from '../../../server.js';
import { mintUserApiKey } from '../../../middleware/auth.js';
import { createTestableMcpServer } from '../../../mcp/server.js';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));

let server: Server;
let url: string;
let userId: string;
let appId: string;
let key: string;

beforeAll(async () => {
  server = createHttpServer(await createServer());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/graphql`;
});
afterAll(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); });
beforeEach(async () => {
  await cleanDb(db);
  process.env.DISABLE_TASK_MATCHER = 'true';
  userId = (await db.user.create({ data: { roles: ['READER'] } })).id;
  appId = (await db.app.create({ data: { name: 'Tier', urn: `tier-${userId}:app`, ownerUserId: userId } })).id;
  key = (await mintUserApiKey(db, { userId, label: null, createdBy: userId, issuedVia: 'test' })).rawKey;
});
afterAll(() => { delete process.env.DISABLE_TASK_MATCHER; });

async function post(query: string, variables: Record<string, unknown>) {
  const response = await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify({ query, variables }) });
  expect([200, 400]).toContain(response.status); // validation failures answer 400
  return response.json() as Promise<any>;
}
const F = 'requirements { role modelGroupIn modelGroupNotIn }';
const CREATE = `mutation($i: CreateAgentTaskInput!) { createAgentTask(input: $i) { id ${F} } }`;
const UPDATE = `mutation($id: ID!, $i: UpdateAgentTaskInput!) { updateAgentTask(taskId: $id, input: $i) { id ${F} } }`;
const READ = `query($id: ID!) { agentTask(id: $id) { ${F} } }`;
const mcpFor = () => createTestableMcpServer({ userId, roles: ['READER'], clientId: `user:${userId}` });
const eventCount = () => db.agentTeamEvent.count({ where: { appId } });
const group = (name: string) => db.modelGroup.create({ data: { appId, name, patterns: ['*opus*'] } });

it('GraphQL stores lowercase deduped names on create, update and read', async () => {
  await group('large');
  await group('small');
  const created = await post(CREATE, { i: { appRef: appId, title: 'G', requirements: { modelGroupIn: ['Large', 'large'], modelGroupNotIn: ['small'] } } });
  expect(created.errors).toBeUndefined();
  expect(created.data.createAgentTask.requirements).toMatchObject({ modelGroupIn: ['large'], modelGroupNotIn: ['small'] });
  const id = created.data.createAgentTask.id as string;
  expect((await db.agentTask.findUniqueOrThrow({ where: { id } })).requirements).toEqual({ modelGroupIn: ['large'], modelGroupNotIn: ['small'] });
  expect((await post(READ, { id })).data.agentTask.requirements).toMatchObject({ modelGroupIn: ['large'] });
  const updated = await post(UPDATE, { id, i: { requirements: { modelGroupIn: ['small'] } } });
  expect(updated.errors).toBeUndefined();
  expect((await db.agentTask.findUniqueOrThrow({ where: { id } })).requirements).toEqual({ modelGroupIn: ['small'] });
});

it('GraphQL: a task without groups reads both null', async () => {
  const created = await post(CREATE, { i: { appRef: appId, title: 'Plain', requirements: { role: 'reviewer' } } });
  expect(created.data.createAgentTask.requirements).toMatchObject({ role: 'reviewer', modelGroupIn: null, modelGroupNotIn: null });
});

it('GraphQL refuses an unknown name at create, naming it, and creates nothing', async () => {
  await group('large');
  for (const field of ['modelGroupIn', 'modelGroupNotIn']) {
    const r = await post(CREATE, { i: { appRef: appId, title: 'Bad', requirements: { [field]: ['large', 'ghost'] } } });
    expect(r.errors?.[0]?.extensions?.code, field).toBe('MODEL_GROUP_NOT_FOUND');
    expect(r.errors?.[0]?.extensions?.name).toBe('ghost');
  }
  expect(await db.agentTask.count()).toBe(0);
});

it('GraphQL refuses an unknown name at update and leaves the task and its events as they were', async () => {
  await group('large');
  const created = await post(CREATE, { i: { appRef: appId, title: 'Keep', requirements: { modelGroupIn: ['large'] } } });
  const id = created.data.createAgentTask.id as string;
  const events = await eventCount();
  const r = await post(UPDATE, { id, i: { requirements: { modelGroupIn: ['ghost'] } } });
  expect(r.errors?.[0]?.extensions?.code).toBe('MODEL_GROUP_NOT_FOUND');
  expect((await db.agentTask.findUniqueOrThrow({ where: { id } })).requirements).toEqual({ modelGroupIn: ['large'] });
  expect(await eventCount()).toBe(events);
});

it('GraphQL refuses a malformed name as BAD_USER_INPUT', async () => {
  const r = await post(CREATE, { i: { appRef: appId, title: 'Bad', requirements: { modelGroupIn: ['not a name'] } } });
  expect(r.errors?.[0]?.extensions?.code).toBe('BAD_USER_INPUT');
  expect(await db.agentTask.count()).toBe(0);
});

it('MCP task-create stores the groups, task-get shows them, update replaces them', async () => {
  await group('large');
  await group('small');
  const session = await db.session.create({ data: { id: generateId(), userId, appId } });
  const mcp = mcpFor();
  expect(await mcp.callToolText('hadron_task_create', { session: session.id, appRef: appId, title: 'MCP g', requirements: { modelGroupIn: ['large'], modelGroupNotIn: ['small'] } })).toContain('Created');
  const row = await db.agentTask.findFirstOrThrow({ where: { title: 'MCP g' } });
  expect(row.requirements).toEqual({ modelGroupIn: ['large'], modelGroupNotIn: ['small'] });
  expect(await mcp.callToolText('hadron_task_get', { session: session.id, taskId: row.id })).toContain('"modelGroupIn":["large"]');
  await mcp.callToolText('hadron_task_update', { session: session.id, taskId: row.id, input: { requirements: { modelGroupIn: ['small'] } } });
  expect((await db.agentTask.findUniqueOrThrow({ where: { id: row.id } })).requirements).toEqual({ modelGroupIn: ['small'] });
});

it('MCP refuses an unknown name on create and update and stores nothing', async () => {
  await group('large');
  const session = await db.session.create({ data: { id: generateId(), userId, appId } });
  const mcp = mcpFor();
  const created = await mcp.callToolText('hadron_task_create', { session: session.id, appRef: appId, title: 'MCP ghost', requirements: { modelGroupIn: ['ghost'] } }).catch((e: unknown) => String(e));
  expect(created).not.toContain('Created');
  expect(created).toContain('ghost');
  expect(await db.agentTask.count({ where: { title: 'MCP ghost' } })).toBe(0);
  await mcp.callToolText('hadron_task_create', { session: session.id, appRef: appId, title: 'MCP ok', requirements: { modelGroupIn: ['large'] } });
  const row = await db.agentTask.findFirstOrThrow({ where: { title: 'MCP ok' } });
  const edit = await mcp.callToolText('hadron_task_update', { session: session.id, taskId: row.id, input: { requirements: { modelGroupNotIn: ['ghost'] } } }).catch((e: unknown) => String(e));
  expect(edit).not.toContain('Updated');
  expect((await db.agentTask.findUniqueOrThrow({ where: { id: row.id } })).requirements).toEqual({ modelGroupIn: ['large'] });
});
