/**
 * #2252 Slice D1 — `minTier` through the REAL GraphQL transport (validation, resolver, stored JSON, output) and the
 * registered MCP handlers (create, update, read). There is no `maxTier` anywhere: GraphQL validation and the MCP
 * schema refuse it, and a refusal leaves the task, its assignment and its events as they were.
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
const CREATE = 'mutation($i: CreateAgentTaskInput!) { createAgentTask(input: $i) { id requirements { role minTier familyIn } } }';
const UPDATE = 'mutation($id: ID!, $i: UpdateAgentTaskInput!) { updateAgentTask(taskId: $id, input: $i) { id requirements { role minTier familyIn } } }';
const READ = 'query($id: ID!) { agentTask(id: $id) { requirements { role minTier } } }';
const mcpFor = () => createTestableMcpServer({ userId, roles: ['READER'], clientId: `user:${userId}` });
const eventCount = () => db.agentTeamEvent.count({ where: { appId } });

it('GraphQL stores minTier in the requirements JSON and returns it on create, update and read', async () => {
  const created = await post(CREATE, { i: { appRef: appId, title: 'Tiered', requirements: { role: 'reviewer', minTier: 'mid' } } });
  expect(created.errors).toBeUndefined();
  expect(created.data.createAgentTask.requirements).toMatchObject({ role: 'reviewer', minTier: 'mid' });
  const id = created.data.createAgentTask.id as string;
  expect((await db.agentTask.findUniqueOrThrow({ where: { id } })).requirements).toEqual({ role: 'reviewer', minTier: 'mid' });
  const read = await post(READ, { id });
  expect(read.data.agentTask.requirements).toMatchObject({ minTier: 'mid' });
  const updated = await post(UPDATE, { id, i: { requirements: { role: 'reviewer', minTier: 'high' } } });
  expect(updated.errors).toBeUndefined();
  expect(updated.data.updateAgentTask.requirements).toMatchObject({ minTier: 'high' });
  expect((await db.agentTask.findUniqueOrThrow({ where: { id } })).requirements).toEqual({ role: 'reviewer', minTier: 'high' });
});

it('GraphQL: a task without minTier reads minTier null', async () => {
  const created = await post(CREATE, { i: { appRef: appId, title: 'Plain', requirements: { role: 'reviewer' } } });
  expect(created.data.createAgentTask.requirements).toMatchObject({ role: 'reviewer', minTier: null });
});

it('GraphQL refuses a malformed minTier (BAD_USER_INPUT) and creates nothing', async () => {
  for (const minTier of ['medium', 'HIGH', '', ' mid']) {
    const result = await post(CREATE, { i: { appRef: appId, title: 'Bad', requirements: { minTier } } });
    expect(result.errors?.[0]?.extensions?.code, JSON.stringify(minTier)).toBe('BAD_USER_INPUT');
  }
  expect(await db.agentTask.count()).toBe(0);
});

it('GraphQL has no maxTier: input is refused by validation, output has no such field, nothing is created or changed', async () => {
  const refused = await post(CREATE, { i: { appRef: appId, title: 'Cap', requirements: { maxTier: 'high' } } });
  expect(refused.errors?.length).toBeGreaterThan(0);
  expect(refused.data?.createAgentTask ?? null).toBeNull();
  expect(await db.agentTask.count()).toBe(0);
  const created = await post(CREATE, { i: { appRef: appId, title: 'Keep', requirements: { minTier: 'low' } } });
  const id = created.data.createAgentTask.id as string;
  const events = await eventCount();
  const edit = await post(UPDATE, { id, i: { requirements: { minTier: 'high', maxTier: 'high' } } });
  expect(edit.errors?.length).toBeGreaterThan(0);
  expect((await db.agentTask.findUniqueOrThrow({ where: { id } })).requirements).toEqual({ minTier: 'low' });
  expect(await eventCount()).toBe(events);
  const output = await post('query($id: ID!) { agentTask(id: $id) { requirements { maxTier } } }', { id });
  expect(output.errors?.length).toBeGreaterThan(0);
});

it('MCP task-create stores minTier and task-get shows it', async () => {
  const session = await db.session.create({ data: { id: generateId(), userId, appId } });
  const mcp = mcpFor();
  const text = await mcp.callToolText('hadron_task_create', { session: session.id, appRef: appId, title: 'MCP tier', requirements: { role: 'reviewer', minTier: 'mid' } });
  expect(text).toContain('Created');
  const row = await db.agentTask.findFirstOrThrow({ where: { title: 'MCP tier' } });
  expect(row.requirements).toEqual({ role: 'reviewer', minTier: 'mid' });
  expect(await mcp.callToolText('hadron_task_get', { session: session.id, taskId: row.id })).toContain('"minTier":"mid"');
});

it('MCP task-update replaces the requirements with a new minTier', async () => {
  const session = await db.session.create({ data: { id: generateId(), userId, appId } });
  const mcp = mcpFor();
  await mcp.callToolText('hadron_task_create', { session: session.id, appRef: appId, title: 'MCP edit', requirements: { minTier: 'low' } });
  const row = await db.agentTask.findFirstOrThrow({ where: { title: 'MCP edit' } });
  await mcp.callToolText('hadron_task_update', { session: session.id, taskId: row.id, input: { requirements: { minTier: 'high' } } });
  expect((await db.agentTask.findUniqueOrThrow({ where: { id: row.id } })).requirements).toEqual({ minTier: 'high' });
});

it('MCP refuses maxTier on create and update and stores nothing', async () => {
  const session = await db.session.create({ data: { id: generateId(), userId, appId } });
  const mcp = mcpFor();
  const created = await mcp.callToolText('hadron_task_create', { session: session.id, appRef: appId, title: 'MCP cap', requirements: { maxTier: 'high' } }).catch((e: unknown) => String(e));
  expect(created).not.toContain('Created');
  expect(await db.agentTask.count({ where: { title: 'MCP cap' } })).toBe(0);
  await mcp.callToolText('hadron_task_create', { session: session.id, appRef: appId, title: 'MCP cap2', requirements: { minTier: 'low' } });
  const row = await db.agentTask.findFirstOrThrow({ where: { title: 'MCP cap2' } });
  const events = await eventCount();
  const edit = await mcp.callToolText('hadron_task_update', { session: session.id, taskId: row.id, input: { requirements: { minTier: 'high', maxTier: 'high' } } }).catch((e: unknown) => String(e));
  expect(edit).not.toContain('Updated');
  expect((await db.agentTask.findUniqueOrThrow({ where: { id: row.id } })).requirements).toEqual({ minTier: 'low' });
  expect(await eventCount()).toBe(events);
});

it('MCP refuses a malformed minTier', async () => {
  const session = await db.session.create({ data: { id: generateId(), userId, appId } });
  const out = await mcpFor().callToolText('hadron_task_create', { session: session.id, appRef: appId, title: 'MCP bad', requirements: { minTier: 'medium' } }).catch((e: unknown) => String(e));
  expect(out).not.toContain('Created');
  expect(await db.agentTask.count({ where: { title: 'MCP bad' } })).toBe(0);
});
