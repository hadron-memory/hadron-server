/** #2123: real mounted MCP requests, synthetic credentials and private test DB. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createServer } from '../server.js';
import { signJwt } from '../auth/jwt.js';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../lib/workerSignature.js';

let server: Server;
let baseUrl: string;
let token: string;
let workerId: string;
let appId: string;
let userId: string;
const opened: Array<{ id: string; token: string }> = [];

beforeAll(async () => {
  server = createHttpServer(await createServer());
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  for (const transport of opened.splice(0)) {
    const response = await fetch(`${baseUrl}/mcp`, { method: 'DELETE', headers: {
      accept: 'application/json, text/event-stream', authorization: `Bearer ${transport.token}`, 'mcp-session-id': transport.id,
    } });
    await response.text();
  }
});
afterAll(async () => {
  server.closeAllConnections?.();
  await new Promise<void>(resolve => server.close(() => resolve()));
});
beforeEach(async () => {
  await cleanDb(db);
  const suffix = generateId();
  const user = await db.user.create({ data: { githubId: 2123001, githubUsername: `session-${suffix}`, handle: `session-${suffix}`, roles: ['READER'] } });
  userId = user.id;
  const org = await db.organization.create({ data: { name: 'Session headers', urn: `session-${suffix}.test` } });
  await db.orgMember.create({ data: { organizationId: org.id, userId, role: 'ADMIN' } });
  const app = await db.app.create({ data: { name: 'Team', urn: `${org.urn}:team`, organizationId: org.id } });
  appId = app.id;
  await db.appMember.create({ data: { appId, userId, role: 'owner' } });
  const agent = await db.agent.create({ data: { name: 'Engineer', urn: `${org.urn}:engineer`, organizationId: org.id, visibility: 'ORGANIZATION' } });
  await db.appAgent.create({ data: { appId, agentId: agent.id } });
  workerId = (await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId, agentId: agent.id,
    name: 'Fixture', slug: 'fixture', heldByUserId: userId, heldAt: new Date() } })).id;
  token = await signJwt({ sub: userId, githubId: 2123001, githubUsername: `session-${suffix}`, roles: ['READER'] });
});

let rpc = 1;
async function post(body: unknown, transport?: string, session?: string, bearer = token) {
  return fetch(`${baseUrl}/mcp`, { method: 'POST', headers: {
    accept: 'application/json, text/event-stream', 'content-type': 'application/json', authorization: `Bearer ${bearer}`,
    ...(transport ? { 'mcp-session-id': transport } : {}), ...(session ? { 'x-hadron-session': session } : {}),
  }, body: JSON.stringify(body) });
}
async function open(session?: string, bearer = token) {
  const response = await post({ jsonrpc: '2.0', id: rpc++, method: 'initialize', params: {
    protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'session2123', version: '1' },
  } }, undefined, session, bearer);
  expect(response.status).toBe(200);
  await response.text();
  const id = response.headers.get('mcp-session-id')!;
  expect(id).toBeTruthy();
  opened.push({ id, token: bearer });
  const initialized = await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, id, session, bearer);
  await initialized.text();
  return id;
}
async function call(transport: string, name: string, args: Record<string, unknown>, session?: string, bearer = token) {
  const response = await post({ jsonrpc: '2.0', id: rpc++, method: 'tools/call', params: { name, arguments: args } }, transport, session, bearer);
  const raw = await response.text();
  if (response.status !== 200) return { status: response.status, result: null, text: raw };
  const body = JSON.parse(raw.split('\n').find(line => line.startsWith('data:'))?.slice(5) ?? raw);
  return { status: response.status, result: body.result, text: body.result?.content?.[0]?.text ?? '' };
}
const edit = (transport: string, signature: string, session?: string) =>
  call(transport, 'hadron_update_worker', { workerRef: workerId, signature, promptOverride: signature }, session);


describe('#2123 request-local session refusal', () => {
  it('a late unknown session refuses a user-manager edit after a clean initialize', async () => {
    const transport = await open();
    const allowed = await edit(transport, 'human manager control');
    expect(allowed.result?.isError).not.toBe(true);
    expect(await db.worker.findUniqueOrThrow({ where: { id: workerId } })).toMatchObject({ signature: 'human manager control', promptOverride: 'human manager control' });
    const denied = await edit(transport, 'must not commit', generateId());
    expect(denied.status).toBe(200);
    expect(await db.worker.findUniqueOrThrow({ where: { id: workerId } })).toMatchObject({ signature: 'human manager control', promptOverride: 'human manager control' });
    expect(denied.result?.isError).toBe(true);
  });
});
