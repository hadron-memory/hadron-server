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
    const dara = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId: app.appId, agentId: agent.id, name: 'Dara', slug: 'dara' } });
    const user = await db.session.findUniqueOrThrow({ where: { id: sessionId }, select: { userId: true } });
    const daraSession = generateId();
    await db.session.create({ data: { id: daraSession, appId: app.appId, userId: user.userId, workerId: dara.id, agentId: agent.id, type: 'DEVELOPER', startedAt: new Date() } });
    await call('hadron_create_node', { urn: `hrn:node:${appMemory.urn}:dac:header`, name: 'header' }, daraSession);
    expect(await attributionAt('dac:header', appMemory.id)).toEqual({ createdByWorkerId: dara.id, createdByAgentId: agent.id });
  });

  it('a request naming an invalid session writes as nobody, never as the connection worker (#1665 review)', async () => {
    const call = await mcpConnection();
    await call('hadron_start_session', { description: 'dac', workerRef: 'hrn:worker:attrhttp.example:team:iris', force: true });
    await call('hadron_create_node', { urn: `hrn:node:${appMemory.urn}:dac:unknown`, name: 'unknown' }, generateId());
    await db.session.update({ where: { id: sessionId }, data: { endedAt: new Date() } });
    await call('hadron_create_node', { urn: `hrn:node:${appMemory.urn}:dac:ended`, name: 'ended' }, sessionId);
    for (const loc of ['dac:unknown', 'dac:ended']) {
      expect(await attributionAt(loc, appMemory.id), loc).toEqual({ createdByWorkerId: null, createdByAgentId: null });
    }
  });

  it('a plain session stops an earlier worker\'s credit by making the connection ambiguous (#1665 review, superseded by #1702 QA)', async () => {
    // #1665 wanted a plain start to end the previous worker's credit. It used
    // to do that by wiping the binding; on a shared connection that silently
    // stripped OTHER chat sessions' workers too (Cody's P2 on #1702). Now the
    // plain session joins the bindings as "no worker", so an unnamed write is
    // refused, and naming the plain session writes as the user alone.
    const call = await mcpConnection();
    await call('hadron_start_session', { description: 'dac', workerRef: 'hrn:worker:attrhttp.example:team:iris', force: true });
    const plain = /Session started: ([0-9a-f]{32})/.exec(await call('hadron_start_session', { description: 'plain' }))![1];
    const refused = await call('hadron_create_node', { urn: `hrn:node:${appMemory.urn}:dac:plain-unsaid`, name: 'unsaid' }, undefined, { allowError: true });
    expect(refused).toContain('[session_ambiguous]');
    expect(refused).toContain('no worker (plain session)');
    expect(await db.node.findFirst({ where: { memoryId: appMemory.id, loc: 'dac:plain-unsaid' } })).toBeNull();
    await call('hadron_create_node', { urn: `hrn:node:${appMemory.urn}:dac:plain`, name: 'plain', session: plain });
    expect(await attributionAt('dac:plain', appMemory.id)).toEqual({ createdByWorkerId: null, createdByAgentId: null });
  });

  it('a bound session that goes dormant stops attributing on the connection (DY-5, #1665)', async () => {
    const call = await mcpConnection();
    const started = await call('hadron_start_session', { description: 'dac', workerRef: 'hrn:worker:attrhttp.example:team:iris', force: true });
    const bound = /Session started: ([0-9a-f]{32})/.exec(started)![1];
    await db.$executeRaw`UPDATE sessions SET started_at = now() - interval '400 days', updated_at = now() - interval '400 days' WHERE id = ${bound}`;
    await db.usageEvent.deleteMany({ where: { sessionId: bound } });
    await call('hadron_create_node', { urn: `hrn:node:${appMemory.urn}:dac:dormant`, name: 'dormant' });
    expect(await attributionAt('dac:dormant', appMemory.id)).toEqual({ createdByWorkerId: null, createdByAgentId: null });
  });

  it('binds only its own connection: a second connection of the same user stays unattributed', async () => {
    const first = await mcpConnection();
    await first('hadron_start_session', { description: 'dac', workerRef: 'hrn:worker:attrhttp.example:team:iris', force: true });
    const second = await mcpConnection();
    await second('hadron_create_node', { urn: `hrn:node:${appMemory.urn}:dac:other`, name: 'other' });
    expect(await attributionAt('dac:other', appMemory.id)).toEqual({ createdByWorkerId: null, createdByAgentId: null });
  });
});

/**
 * #1701 — a host that carries several chat sessions over ONE MCP connection
 * (the Claude desktop shape that credited Gil's node to Cody). The server
 * cannot see chat sessions, so the connection must never guess between the
 * workers bound on it.
 */
describe('#1701: several workers bound on one MCP connection', () => {
  const sessionIdOf = (receipt: string) => /Session started: ([0-9a-f]{32})/.exec(receipt)![1];
  const nodeAt = (loc: string) => db.node.findFirst({ where: { memoryId: appMemory.id, loc } });

  /** One connection with Iris bound (chat session A), then Dara (chat session B). */
  async function sharedConnection() {
    const app = await db.worker.findUniqueOrThrow({ where: { id: worker.id }, select: { appId: true } });
    const dara = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId: app.appId, agentId: agent.id, name: 'Dara', slug: 'dara' } });
    const call = await mcpConnection();
    const irisReceipt = await call('hadron_start_session', { description: 'chat A', workerRef: 'hrn:worker:attrhttp.example:team:iris', force: true });
    const daraReceipt = await call('hadron_start_session', { description: 'chat B', workerRef: 'hrn:worker:attrhttp.example:team:dara' });
    return { call, dara, irisSession: sessionIdOf(irisReceipt), daraSession: sessionIdOf(daraReceipt), irisReceipt, daraReceipt };
  }

  it('the second bind does not take over the first chat session\'s writes; a write without session is refused, not guessed', async () => {
    const { call, daraReceipt } = await sharedConnection();
    // The receipt is the one place the caller is certain to look.
    expect(daraReceipt).toContain('SHARED CONNECTION');
    expect(daraReceipt).toContain('Iris (session');

    // The issue's repro: chat A writes after chat B bound. Before #1701 this
    // was silently credited to Dara, the last binder.
    const refused = await call('hadron_create_node', { urn: `hrn:node:${appMemory.urn}:shared:unsaid`, name: 'unsaid' }, undefined, { allowError: true });
    expect(refused).toContain('"isError":true');
    expect(refused).toContain('[session_ambiguous]');
    expect(refused).toContain('Iris (session');
    expect(refused).toContain('Dara (session');
    expect(await nodeAt('shared:unsaid')).toBeNull();
  });

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

  it('ending one binding does NOT make a shared connection unambiguous (PR #1702 review, Codex P1)', async () => {
    // Ending a Hadron session does not end the chat session that drove it:
    // chat A may still be calling after it ends Iris, so with only Dara live
    // an unnamed write could be A's. It must be refused, not given to Dara.
    const { call, dara, irisSession, daraSession } = await sharedConnection();
    // end_session needs no `session`: its own `id` says who is ending.
    await call('hadron_end_session', { id: irisSession, handoff: 'chat A done' });
    const refused = await call('hadron_create_node', { urn: `hrn:node:${appMemory.urn}:shared:after-end`, name: 'after-end' }, undefined, { allowError: true });
    expect(refused).toContain('[session_ambiguous]');
    expect(await nodeAt('shared:after-end')).toBeNull();
    await call('hadron_create_node', { urn: `hrn:node:${appMemory.urn}:shared:dara-named`, name: 'dara-named', session: daraSession });
    expect(await attributionAt('shared:dara-named', appMemory.id)).toEqual({ createdByWorkerId: dara.id, createdByAgentId: agent.id });
  });

  it('a shared connection whose worker sessions have ALL ended writes as nobody, not refused', async () => {
    const { call, irisSession, daraSession } = await sharedConnection();
    await call('hadron_end_session', { id: irisSession });
    await call('hadron_end_session', { id: daraSession });
    await call('hadron_create_node', { urn: `hrn:node:${appMemory.urn}:shared:all-ended`, name: 'all-ended' });
    expect(await attributionAt('shared:all-ended', appMemory.id)).toEqual({ createdByWorkerId: null, createdByAgentId: null });
  });

  it('a plain session that ends leaves the connection ambiguous, not credited to the worker (PR #1702 review, Codex P1)', async () => {
    const call = await mcpConnection();
    await call('hadron_start_session', { description: 'dac', workerRef: 'hrn:worker:attrhttp.example:team:iris', force: true });
    const plain = /Session started: ([0-9a-f]{32})/.exec(await call('hadron_start_session', { description: 'plain' }))![1];
    await call('hadron_end_session', { id: plain });
    const refused = await call('hadron_create_node', { urn: `hrn:node:${appMemory.urn}:dac:plain-ended`, name: 'plain-ended' }, undefined, { allowError: true });
    expect(refused).toContain('[session_ambiguous]');
    expect(await db.node.findFirst({ where: { memoryId: appMemory.id, loc: 'dac:plain-ended' } })).toBeNull();
  });

  it('a second worker bound AFTER the first ended still makes the connection shared (PR #1702 review, Codex P1)', async () => {
    // Chat A binds Iris and ends it; chat B binds Dara. To the server that is
    // indistinguishable from ONE chat session switching workers, so an unnamed
    // write must be refused either way, never credited to Dara.
    const app = await db.worker.findUniqueOrThrow({ where: { id: worker.id }, select: { appId: true } });
    const dara = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId: app.appId, agentId: agent.id, name: 'Dara', slug: 'dara' } });
    const call = await mcpConnection();
    const iris = /Session started: ([0-9a-f]{32})/.exec(await call('hadron_start_session', { description: 'chat A', workerRef: 'hrn:worker:attrhttp.example:team:iris', force: true }))![1];
    await call('hadron_end_session', { id: iris });
    const daraReceipt = await call('hadron_start_session', { description: 'chat B', workerRef: 'hrn:worker:attrhttp.example:team:dara' });
    const daraSession = /Session started: ([0-9a-f]{32})/.exec(daraReceipt)![1];
    expect(daraReceipt).toContain('SHARED CONNECTION');
    const refused = await call('hadron_create_node', { urn: `hrn:node:${appMemory.urn}:seq:unsaid`, name: 'unsaid' }, undefined, { allowError: true });
    expect(refused).toContain('[session_ambiguous]');
    expect(await nodeAt('seq:unsaid')).toBeNull();
    await call('hadron_create_node', { urn: `hrn:node:${appMemory.urn}:seq:dara`, name: 'dara', session: daraSession });
    expect(await attributionAt('seq:dara', appMemory.id)).toEqual({ createdByWorkerId: dara.id, createdByAgentId: agent.id });
  });

  it('re-binding the SAME worker (a rotation) never marks the connection shared', async () => {
    const call = await mcpConnection();
    const first = /Session started: ([0-9a-f]{32})/.exec(await call('hadron_start_session', { description: 'stint 1', workerRef: 'hrn:worker:attrhttp.example:team:iris', force: true }))![1];
    await call('hadron_end_session', { id: first });
    const again = await call('hadron_start_session', { description: 'stint 2', workerRef: 'hrn:worker:attrhttp.example:team:iris' });
    expect(again).not.toContain('SHARED CONNECTION');
    await call('hadron_create_node', { urn: `hrn:node:${appMemory.urn}:rot:iris`, name: 'iris' });
    expect(await attributionAt('rot:iris', appMemory.id)).toEqual({ createdByWorkerId: worker.id, createdByAgentId: agent.id });
  });

  it('on a connection bound to ONE worker, a named session still overrides the binding', async () => {
    const call = await mcpConnection();
    await call('hadron_start_session', { description: 'one', workerRef: 'hrn:worker:attrhttp.example:team:iris', force: true });
    const app = await db.worker.findUniqueOrThrow({ where: { id: worker.id }, select: { appId: true } });
    const dara = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId: app.appId, agentId: agent.id, name: 'Dara', slug: 'dara' } });
    const user = await db.session.findUniqueOrThrow({ where: { id: sessionId }, select: { userId: true } });
    const daraSession = generateId();
    await db.session.create({ data: { id: daraSession, appId: app.appId, userId: user.userId, workerId: dara.id, agentId: agent.id, type: 'DEVELOPER', startedAt: new Date() } });
    await call('hadron_create_node', { urn: `hrn:node:${appMemory.urn}:one:named`, name: 'named', session: daraSession });
    await call('hadron_create_node', { urn: `hrn:node:${appMemory.urn}:one:unnamed`, name: 'unnamed' });
    expect(await attributionAt('one:named', appMemory.id)).toEqual({ createdByWorkerId: dara.id, createdByAgentId: agent.id });
    expect(await attributionAt('one:unnamed', appMemory.id)).toEqual({ createdByWorkerId: worker.id, createdByAgentId: agent.id });
  });

  it('calls batched into one POST each keep their own actor (PR #1702 review, Codex P1)', async () => {
    const { call, dara, irisSession, daraSession } = await sharedConnection();
    // Several rounds: the SDK runs a batch's calls concurrently, and a shared
    // actor holder only misattributes when their DB awaits interleave.
    for (let round = 0; round < 5; round++) {
      await call.batch([
        { name: 'hadron_create_node', args: { urn: `hrn:node:${appMemory.urn}:batch:${round}:a`, name: 'a', session: irisSession } },
        { name: 'hadron_create_node', args: { urn: `hrn:node:${appMemory.urn}:batch:${round}:b`, name: 'b', session: daraSession } },
        // Unnamed, on an ambiguous connection: a named sibling must not clear the ambiguity for it.
        { name: 'hadron_create_node', args: { urn: `hrn:node:${appMemory.urn}:batch:${round}:unsaid`, name: 'unsaid' } },
      ]);
    }
    for (let round = 0; round < 5; round++) {
      expect(await attributionAt(`batch:${round}:a`, appMemory.id), `round ${round} a`).toEqual({ createdByWorkerId: worker.id, createdByAgentId: agent.id });
      expect(await attributionAt(`batch:${round}:b`, appMemory.id), `round ${round} b`).toEqual({ createdByWorkerId: dara.id, createdByAgentId: agent.id });
      expect(await nodeAt(`batch:${round}:unsaid`), `round ${round} unsaid`).toBeNull();
    }
  });

  it('no number of live bindings evicts the first one (PR #1702 review, Codex P2)', async () => {
    // Superseded binds cannot fill the list (each bind request prunes ended
    // sessions first; the binding's own test above relies on that), so the
    // eviction a cap could cause needs MANY LIVE bindings: here, 33 workers
    // bound on one connection after Iris, one past the old 32-entry cap.
    // Iris must still be a candidate. Slow by nature (each bind re-validates
    // every live binding), hence the explicit timeout.
    const { call } = await sharedConnection();
    const app = await db.worker.findUniqueOrThrow({ where: { id: worker.id }, select: { appId: true } });
    for (let i = 0; i < 33; i++) {
      await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId: app.appId, agentId: agent.id, name: `Extra${i}`, slug: `extra${i}` } });
      await call('hadron_start_session', { description: `chat ${i}`, workerRef: `hrn:worker:attrhttp.example:team:extra${i}` });
    }
    const refused = await call('hadron_create_node', { urn: `hrn:node:${appMemory.urn}:evict:unsaid`, name: 'unsaid' }, undefined, { allowError: true });
    expect(refused).toContain('[session_ambiguous]');
    expect(refused).toContain('Iris (session');
    expect(await nodeAt('evict:unsaid')).toBeNull();
  }, 60_000);

  it('a plain start from a third chat session does not strip the others\' workers (#1702 QA, Cody P2)', async () => {
    const { call, dara, irisSession, daraSession } = await sharedConnection();
    const plainReceipt = await call('hadron_start_session', { description: 'chat C, no worker' });
    expect(plainReceipt).toContain('SHARED CONNECTION');
    const refused = await call('hadron_create_node', { urn: `hrn:node:${appMemory.urn}:plain3:unsaid`, name: 'unsaid' }, undefined, { allowError: true });
    expect(refused).toContain('[session_ambiguous]');
    expect(await nodeAt('plain3:unsaid')).toBeNull();
    // Chat sessions A and B still write as their own workers.
    await call('hadron_create_node', { urn: `hrn:node:${appMemory.urn}:plain3:a`, name: 'a', session: irisSession });
    await call('hadron_create_node', { urn: `hrn:node:${appMemory.urn}:plain3:b`, name: 'b', session: daraSession });
    expect(await attributionAt('plain3:a', appMemory.id)).toEqual({ createdByWorkerId: worker.id, createdByAgentId: agent.id });
    expect(await attributionAt('plain3:b', appMemory.id)).toEqual({ createdByWorkerId: dara.id, createdByAgentId: agent.id });
  });

  it('team chat without session is refused on a shared connection, not posted as the human (#1702 QA note)', async () => {
    const { call } = await sharedConnection();
    const refused = await call('hadron_team_chat_post', { body: 'who am I?' }, undefined, { allowError: true });
    expect(refused).toContain('[session_ambiguous]');
  });

  it('reads stay open on an ambiguous connection', async () => {
    const { call } = await sharedConnection();
    const text = await call('hadron_whoami', {});
    expect(text).toContain('Iris');
  });
});
