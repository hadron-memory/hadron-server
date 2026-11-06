/**
 * #2252 Slice D1 — `minTier` through the REAL GraphQL transport (validation, resolver, stored JSON, output). The MCP
 * wrappers were disabled by #3082; the same rules stay pinned here through GraphQL. There is no `maxTier` anywhere: GraphQL validation
 * refuses it, and a refusal leaves the task, its assignment and its events as they were.
 */
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createServer } from '../../../server.js';
import { mintUserApiKey } from '../../../middleware/auth.js';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';

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
