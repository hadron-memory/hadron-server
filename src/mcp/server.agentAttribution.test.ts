import { WORKER_SIGNATURE_DEFAULTS } from '../lib/workerSignature.js';
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
import { serveEveryAgent } from '../test/servedBootPrompt.js';
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
  worker = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId: app.id, agentId: agent.id, name: 'Iris', slug: 'iris' } });
  sessionId = generateId();
  await db.session.create({
    data: { id: sessionId, appId: app.id, userId: user.id, workerId: worker.id, agentId: agent.id, type: 'DEVELOPER', startedAt: new Date() },
  });
  ({ rawKey: token } = await mintUserApiKey(db, { userId: user.id, label: null, createdBy: user.id, issuedVia: 'test' }));
  await serveEveryAgent(db); // #2712: binds are served the Agent's boot prompt
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
  const call = async (name: string, args: Record<string, unknown>, hadronSessionHeader?: string, opts: { allowError?: boolean } = {}): Promise<string> => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { ...mcpHeaders, 'mcp-session-id': sid, ...(hadronSessionHeader ? { 'x-hadron-session': hadronSessionHeader } : {}) },
      body: JSON.stringify({ jsonrpc: '2.0', id: id++, method: 'tools/call', params: { name, arguments: args } }),
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    if (!opts.allowError) expect(text, text).not.toContain('"isError":true');
    return text;
  };
  /** Several tool calls in ONE POST — a JSON-RPC batch, which the SDK dispatches concurrently (#1702 review). */
  const batch = async (calls: Array<{ name: string; args: Record<string, unknown> }>): Promise<string> => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { ...mcpHeaders, 'mcp-session-id': sid },
      body: JSON.stringify(calls.map((c) => ({ jsonrpc: '2.0', id: id++, method: 'tools/call', params: { name: c.name, arguments: c.args } }))),
    });
    expect(res.status).toBe(200);
    return res.text();
  };
  return Object.assign(call, { batch });
}

/**
 * #1701 — a host that carries several chat sessions over ONE MCP connection
 * (the Claude desktop shape that credited Gil's node to Cody). The server
 * cannot see chat sessions, so the connection must never guess between the
 * workers bound on it.
 */
describe('#1701: several workers bound on one MCP connection', () => {
  const sessionIdOf = (receipt: string) => /Session started: ([0-9a-f]{32})/.exec(receipt)![1];
  const nodeAt = (loc: string) => db.node.findFirst({ where: { memoryId: appMemory.id, loc } });

  /** Two CLI-path sessions, named independently by each core call. */
  async function sharedConnection() {
    const owner = await db.session.findUniqueOrThrow({ where: { id: sessionId } });
    const dara = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: owner.appId!, agentId: agent.id, name: 'Dara', slug: 'dara' } });
    const ctx: Context = { db, userId: owner.userId!, appId: owner.appId!, roles: ['READER'] };
    const irisSession = (await resolvers.Mutation.startSession({}, { input: { id: generateId(), workerRef: worker.id, tool: 'vitest', force: true } }, ctx)).id;
    const daraSession = (await resolvers.Mutation.startSession({}, { input: { id: generateId(), workerRef: dara.id, tool: 'vitest' } }, ctx)).id;
    return { call: await mcpConnection(), dara, irisSession, daraSession };
  }

  it('a write naming its session is attributed to that session\'s worker, whichever bound last', async () => {
    const { call, dara, irisSession, daraSession } = await sharedConnection();
    await call('hadron_create_node', { urn: `hrn:node:${appMemory.urn}:shared:a`, name: 'a', session: irisSession });
    await call('hadron_create_node', { urn: `hrn:node:${appMemory.urn}:shared:b`, name: 'b', session: daraSession });
    expect(await attributionAt('shared:a', appMemory.id)).toEqual({ createdByWorkerId: worker.id, createdByAgentId: agent.id });
    expect(await attributionAt('shared:b', appMemory.id)).toEqual({ createdByWorkerId: dara.id, createdByAgentId: agent.id });

    // Updates carry it too: updatedBy follows the session named on the update.
    await call('hadron_update_node', { urn: `hrn:node:${appMemory.urn}:shared:a`, description: 'by Dara', session: daraSession });
    const a = await db.node.findFirstOrThrow({ where: { memoryId: appMemory.id, loc: 'shared:a' }, select: { createdByWorkerId: true, updatedByWorkerId: true } });
    expect(a).toEqual({ createdByWorkerId: worker.id, updatedByWorkerId: dara.id });
  });

  it('a named session that cannot attribute is refused, and nothing is written', async () => {
    const { call } = await sharedConnection();
    const refused = await call('hadron_create_node', { urn: `hrn:node:${appMemory.urn}:shared:bogus`, name: 'bogus', session: generateId() }, undefined, { allowError: true });
    expect(refused).toContain('[session_not_bound]');
    expect(await nodeAt('shared:bogus')).toBeNull();
  });

  it('calls batched into one POST retain each named actor after CLI-path starts (#3082)', async () => {
    const { call, dara, irisSession, daraSession } = await sharedConnection();
    for (let round = 0; round < 5; round++) await call.batch([
      { name: 'hadron_create_node', args: { urn: `hrn:node:${appMemory.urn}:batch:${round}:a`, name: 'a', session: irisSession } },
      { name: 'hadron_create_node', args: { urn: `hrn:node:${appMemory.urn}:batch:${round}:b`, name: 'b', session: daraSession } },
    ]);
    for (let round = 0; round < 5; round++) {
      expect(await attributionAt(`batch:${round}:a`, appMemory.id)).toEqual({ createdByWorkerId: worker.id, createdByAgentId: agent.id });
      expect(await attributionAt(`batch:${round}:b`, appMemory.id)).toEqual({ createdByWorkerId: dara.id, createdByAgentId: agent.id });
    }
  });
});
