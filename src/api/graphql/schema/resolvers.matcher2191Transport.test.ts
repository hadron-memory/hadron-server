/** #2191: real GraphQL validation/auth + registered MCP handler dispatch, private DB only. */
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createServer } from '../../../server.js';
import { mintUserApiKey } from '../../../middleware/auth.js';
import { createTestableMcpServer } from '../../../mcp/server.js';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { serveEveryAgent } from '../../../test/servedBootPrompt.js';
import { generateId } from '../../../lib/id.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
let server: Server;
let url: string;
let userId: string;
let appId: string;
let workerId: string;
let key: string;
let agentId: string;
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
  appId = (await db.app.create({ data: { name: 'Transport', urn: `transport-${userId}:app`, ownerUserId: userId } })).id;
  agentId = (await db.agent.create({ data: { name: 'Agent', urn: `transport-${userId}:agent`, ownerUserId: userId, usesTasks: false } })).id;
  workerId = (await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, name: 'Worker', slug: 'worker', appId, agentId, heldByUserId: userId } })).id;
  key = (await mintUserApiKey(db, { userId, label: null, createdBy: userId, issuedVia: 'test' })).rawKey;
  await serveEveryAgent(db); // #2712: binds are served the Agent's boot prompt
});
afterAll(() => { delete process.env.DISABLE_TASK_MATCHER; });
async function post(query: string, variables: Record<string, unknown>) {
  const response = await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify({ query, variables }) });
  expect(response.status).toBe(200);
  return response.json() as Promise<any>;
}
const CREATE = 'mutation($i: CreateAgentTaskInput!) { createAgentTask(input: $i) { id requirements { familyIn familyNotIn } assignee { id } } }';
it('GraphQL stores and returns canonical requirements while explicit assignment to usesTasks:false succeeds', async () => {
  const result = await post(CREATE, { i: { appRef: appId, title: 'Explicit', assignee: { worker: workerId }, requirements: { familyNotIn: [' Anthropic ', 'openai', 'custom-7'] } } });
  expect(result.errors).toBeUndefined();
  expect(result.data.createAgentTask).toMatchObject({ assignee: { id: workerId }, requirements: { familyNotIn: ['claude', 'codex', 'custom-7'] } });
  expect((await db.agentTask.findUniqueOrThrow({ where: { id: result.data.createAgentTask.id } })).requirements).toEqual({ familyNotIn: ['claude', 'codex', 'custom-7'] });
});
it('GraphQL refuses invalid syntax and both family lists without creating a task', async () => {
  for (const requirements of [{ familyIn: ['not valid'] }, { familyIn: ['claude'], familyNotIn: ['codex'] }]) {
    const result = await post(CREATE, { i: { appRef: appId, title: 'Invalid', requirements } });
    expect(result.errors[0].extensions.code).toBe('BAD_USER_INPUT');
  }
  expect(await db.agentTask.count()).toBe(0);
});


it('GraphQL session start, update and open resume share explicit alias normalization', async () => {
  const started = await post('mutation($i: SessionInput!) { startSession(input: $i) { id family } }', { i: { id: generateId(), appRef: appId, workerRef: workerId, family: ' Anthropic ' } });
  expect(started.errors).toBeUndefined();
  const session = started.data.startSession;
  expect(session.family).toBe('claude');
  const updated = await post('mutation($id: ID!) { updateSession(id: $id, family: " OpenAI ") { family } }', { id: session.id });
  expect(updated.errors).toBeUndefined();
  expect(updated.data.updateSession.family).toBe('codex');
  const resumed = await post('mutation($i: ResumeSessionInput) { resumeSession(input: $i) { outcome session { id family } } }', { i: { session: session.id, family: 'Anthropic' } });
  expect(resumed.errors).toBeUndefined();
  expect(resumed.data.resumeSession).toMatchObject({ outcome: 'RESUMED', session: { id: session.id, family: 'claude' } });
});
