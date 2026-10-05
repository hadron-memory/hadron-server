/**
 * #1610: the actor reaches node writes over the REAL HTTP surfaces — the
 * per-request holder opened on `/graphql` and `/mcp` and filled from the
 * X-Hadron-Session binding — not only in direct resolver calls.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createServer } from '../server.js';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import { mintUserApiKey } from '../middleware/auth.js';
import { resolvers, type Context } from '../api/graphql/schema/resolvers.js';

vi.mock('../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

let server: Server;
let baseUrl: string;
let token: string;
let memory: { id: string; urn: string };
let appMemory: { id: string; urn: string };
let worker: { id: string };
let agent: { id: string };
let sessionId: string;

beforeAll(async () => {
  server = createHttpServer(await createServer());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); });

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), name: 'Attr HTTP', urn: 'attrhttp.example' } });
  const user = await db.user.create({ data: { githubId: 161101, githubUsername: 'attr-http', handle: 'attr-http', roles: ['READER'] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: user.id, role: 'ADMIN' } });
  const ctx: Context = { db, userId: user.id, roles: [] };
  memory = await resolvers.Mutation.createMemory(null, { orgId: org.id, name: 'attr-http' }, ctx);
  agent = await db.agent.create({ data: { id: generateId(), urn: 'attrhttp.example:server-engineer', name: 'server-engineer', organizationId: org.id } });
  const app = await db.app.create({ data: { id: generateId(), name: 'Team', urn: 'attrhttp.example:team', organizationId: org.id } });
  // A worker session pins MCP to its App, so the MCP case writes where a
  // worker normally does: the App's own memory.
  appMemory = await db.memory.create({ data: {
    id: generateId(), urn: 'attrhttp.example:team-shared', name: 'team-shared', class: 'app', appId: app.id, organizationId: org.id,
  } });
  await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
  worker = await db.worker.create({ data: { id: generateId(), appId: app.id, agentId: agent.id, name: 'Iris', slug: 'iris' } });
  sessionId = generateId();
  await db.session.create({
    data: { id: sessionId, appId: app.id, userId: user.id, workerId: worker.id, agentId: agent.id, type: 'DEVELOPER', startedAt: new Date() },
  });
  ({ rawKey: token } = await mintUserApiKey(db, { userId: user.id, label: null, createdBy: user.id, issuedVia: 'test' }));
});

const headers = (withSession: boolean, extra: Record<string, string> = {}) => ({
  authorization: `Bearer ${token}`,
  'content-type': 'application/json',
  ...(withSession ? { 'x-hadron-session': sessionId } : {}),
  ...extra,
});
const attributionAt = (loc: string, memoryId = memory.id) => db.node.findFirstOrThrow({
  where: { memoryId, loc },
  select: { createdByWorkerId: true, createdByAgentId: true },
});

async function graphqlCreate(loc: string, withSession: boolean): Promise<void> {
  const res = await fetch(`${baseUrl}/graphql`, {
    method: 'POST', headers: headers(withSession),
    body: JSON.stringify({
      query: 'mutation($input: CreateNodeInput!) { createNode(input: $input) { id } }',
      variables: { input: { memoryId: memory.id, loc, name: loc } },
    }),
  });
  const body = await res.json() as { errors?: unknown };
  expect(body.errors).toBeUndefined();
}

async function mcpCreate(loc: string, withSession: boolean): Promise<void> {
  const mcpHeaders = headers(withSession, { accept: 'application/json, text/event-stream' });
  const init = await fetch(`${baseUrl}/mcp`, {
    method: 'POST', headers: mcpHeaders,
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: '1610', version: '1' } } }),
  });
  expect(init.status).toBe(200);
  const mcpSession = init.headers.get('mcp-session-id')!;
  const call = await fetch(`${baseUrl}/mcp`, {
    method: 'POST', headers: { ...mcpHeaders, 'mcp-session-id': mcpSession },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: {
      name: 'hadron_create_node', arguments: { urn: `hrn:node:${appMemory.urn}:${loc}`, name: loc },
    } }),
  });
  expect(call.status).toBe(200);
  const text = await call.text();
  expect(text, text).not.toContain('"isError":true');
}

describe('#1610 attribution over HTTP', () => {
  it('GraphQL: a bound worker session records the worker and agent; an unbound request records none', async () => {
    await graphqlCreate('gql:bound', true);
    expect(await attributionAt('gql:bound')).toEqual({ createdByWorkerId: worker.id, createdByAgentId: agent.id });
    await graphqlCreate('gql:plain', false);
    expect(await attributionAt('gql:plain')).toEqual({ createdByWorkerId: null, createdByAgentId: null });
  });

  it('MCP: the same, through the Streamable HTTP transport', async () => {
    await mcpCreate('mcp:bound', true);
    expect(await attributionAt('mcp:bound', appMemory.id)).toEqual({ createdByWorkerId: worker.id, createdByAgentId: agent.id });
    await mcpCreate('mcp:plain', false);
    expect(await attributionAt('mcp:plain', appMemory.id)).toEqual({ createdByWorkerId: null, createdByAgentId: null });
  });
});

/** One MCP connection, no X-Hadron-Session header anywhere (the desktop shape). */
async function mcpConnection() {
  const mcpHeaders = headers(false, { accept: 'application/json, text/event-stream' });
  const init = await fetch(`${baseUrl}/mcp`, {
    method: 'POST', headers: mcpHeaders,
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'dac', version: '1' } } }),
  });
  expect(init.status).toBe(200);
  const sid = init.headers.get('mcp-session-id')!;
  let id = 10;
  return async (name: string, args: Record<string, unknown>, hadronSessionHeader?: string): Promise<string> => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { ...mcpHeaders, 'mcp-session-id': sid, ...(hadronSessionHeader ? { 'x-hadron-session': hadronSessionHeader } : {}) },
      body: JSON.stringify({ jsonrpc: '2.0', id: id++, method: 'tools/call', params: { name, arguments: args } }),
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text, text).not.toContain('"isError":true');
    return text;
  };
}

// `force: true`: the fixture already holds a live session on Iris (the header
// tests above use it), and a bind supersedes the caller's own.
describe('DAC: hadron_start_session binds the MCP connection (#1610 follow-on)', () => {
  it('attributes later writes on the connection to the worker, until the session ends', async () => {
    const call = await mcpConnection();
    await call('hadron_create_node', { urn: `hrn:node:${appMemory.urn}:dac:before`, name: 'before' });
    const started = await call('hadron_start_session', { description: 'dac', workerRef: 'hrn:worker:attrhttp.example:team:iris', force: true });
    const hadronSession = /Session started: ([0-9a-f]{32})/.exec(started)![1];
    await call('hadron_create_node', { urn: `hrn:node:${appMemory.urn}:dac:bound`, name: 'bound' });
    await call('hadron_end_session', { id: hadronSession });
    expect((await db.session.findUniqueOrThrow({ where: { id: hadronSession } })).endedAt).not.toBeNull();
    await call('hadron_create_node', { urn: `hrn:node:${appMemory.urn}:dac:after`, name: 'after' });

    expect(await attributionAt('dac:before', appMemory.id)).toEqual({ createdByWorkerId: null, createdByAgentId: null });
    expect(await attributionAt('dac:bound', appMemory.id)).toEqual({ createdByWorkerId: worker.id, createdByAgentId: agent.id });
    // Re-validated per request: an ended session stops attributing at once.
    expect(await attributionAt('dac:after', appMemory.id)).toEqual({ createdByWorkerId: null, createdByAgentId: null });
  });

  it('an explicit X-Hadron-Session header on a request wins over the connection binding', async () => {
    const call = await mcpConnection();
    await call('hadron_start_session', { description: 'dac', workerRef: 'hrn:worker:attrhttp.example:team:iris', force: true });
    const app = await db.worker.findUniqueOrThrow({ where: { id: worker.id }, select: { appId: true } });
    const dara = await db.worker.create({ data: { id: generateId(), appId: app.appId, agentId: agent.id, name: 'Dara', slug: 'dara' } });
    const user = await db.session.findUniqueOrThrow({ where: { id: sessionId }, select: { userId: true } });
    const daraSession = generateId();
    await db.session.create({ data: { id: daraSession, appId: app.appId, userId: user.userId, workerId: dara.id, agentId: agent.id, type: 'DEVELOPER', startedAt: new Date() } });
    await call('hadron_create_node', { urn: `hrn:node:${appMemory.urn}:dac:header`, name: 'header' }, daraSession);
    expect(await attributionAt('dac:header', appMemory.id)).toEqual({ createdByWorkerId: dara.id, createdByAgentId: agent.id });
  });

  it('binds only its own connection: a second connection of the same user stays unattributed', async () => {
    const first = await mcpConnection();
    await first('hadron_start_session', { description: 'dac', workerRef: 'hrn:worker:attrhttp.example:team:iris', force: true });
    const second = await mcpConnection();
    await second('hadron_create_node', { urn: `hrn:node:${appMemory.urn}:dac:other`, name: 'other' });
    expect(await attributionAt('dac:other', appMemory.id)).toEqual({ createdByWorkerId: null, createdByAgentId: null });
  });
});
