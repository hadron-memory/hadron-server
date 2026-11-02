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
import { startWorkerSessionGql } from '../test/startWorkerSessionGql.js';

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
let userId: string;
let appId: string;

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
  userId = user.id;
  const ctx: Context = { db, userId: user.id, roles: [] };
  memory = await resolvers.Mutation.createMemory(null, { orgId: org.id, name: 'attr-http' }, ctx);
  agent = await db.agent.create({ data: { id: generateId(), urn: 'attrhttp.example:server-engineer', name: 'server-engineer', organizationId: org.id } });
  const app = await db.app.create({ data: { id: generateId(), name: 'Team', urn: 'attrhttp.example:team', organizationId: org.id } });
  appId = app.id;
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

// #3082: hadron_start_session no longer binds a worker to an MCP connection (MCP_WORKER_BINDING_UNSUPPORTED; pinned in
// server.mcpTeamCut3082.test.ts R2), so a worker session is started through GraphQL (the CLI's path, startWorkerSessionGql) and
// PRESENTED per request: the X-Hadron-Session header or the `session` argument (#1081). What is gone with the bind, and is
// deleted rather than moved: the connection-level binding (attribution "until the session ends" on later unnamed writes), a
// second connection staying unattributed, and the whole #1701/#1702 shared-connection ambiguity family (`[session_ambiguous]`,
// SHARED CONNECTION receipts, eviction cap, a plain start joining the bindings, batch siblings clearing ambiguity). Those need
// two worker bindings on one connection, which MCP can no longer create; R2 pins the refusal that makes them unreachable.
describe('worker sessions presented to a core MCP tool (#1610 follow-on, re-seated for #3082)', () => {
  const uri = (loc: string) => `hrn:node:${appMemory.urn}:${loc}`;
  const nullActor = { createdByWorkerId: null, createdByAgentId: null };
  const mkDara = async () => {
    const dara = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId, agentId: agent.id, name: 'Dara', slug: 'dara' } });
    const daraSession = await startWorkerSessionGql({ workerRef: dara.id, userId, appId });
    return { dara, daraSession };
  };

  it('a worker session started over GraphQL attributes a write that presents it, and an ended one stops attributing at once', async () => {
    const call = await mcpConnection();
    const irisSession = await startWorkerSessionGql({ workerRef: worker.id, force: true, userId, appId });
    await call('hadron_create_node', { urn: uri('dac:before'), name: 'before' });
    await call('hadron_create_node', { urn: uri('dac:bound'), name: 'bound' }, irisSession);
    await call('hadron_end_session', { id: irisSession });
    expect((await db.session.findUniqueOrThrow({ where: { id: irisSession } })).endedAt).not.toBeNull();
    await call('hadron_create_node', { urn: uri('dac:after'), name: 'after' }, irisSession);

    expect(await attributionAt('dac:before', appMemory.id)).toEqual(nullActor);
    expect(await attributionAt('dac:bound', appMemory.id)).toEqual({ createdByWorkerId: worker.id, createdByAgentId: agent.id });
    // Re-validated per request: an ended session stops attributing at once.
    expect(await attributionAt('dac:after', appMemory.id)).toEqual(nullActor);
  });

  it('an explicit X-Hadron-Session header on a request attributes to that session\'s worker', async () => {
    const call = await mcpConnection();
    const { dara } = await mkDara();
    const daraSession = (await db.session.findFirstOrThrow({ where: { workerId: dara.id } })).id;
    await call('hadron_create_node', { urn: uri('dac:header'), name: 'header' }, daraSession);
    expect(await attributionAt('dac:header', appMemory.id)).toEqual({ createdByWorkerId: dara.id, createdByAgentId: agent.id });
  });

  it('a request naming an invalid session writes as nobody (#1665 review)', async () => {
    const call = await mcpConnection();
    await call('hadron_create_node', { urn: uri('dac:unknown'), name: 'unknown' }, generateId());
    await db.session.update({ where: { id: sessionId }, data: { endedAt: new Date() } });
    await call('hadron_create_node', { urn: uri('dac:ended'), name: 'ended' }, sessionId);
    for (const loc of ['dac:unknown', 'dac:ended']) {
      expect(await attributionAt(loc, appMemory.id), loc).toEqual(nullActor);
    }
  });

  it('a worker session that goes dormant stops attributing (DY-5, #1665)', async () => {
    const call = await mcpConnection();
    const bound = await startWorkerSessionGql({ workerRef: worker.id, force: true, userId, appId });
    await db.$executeRaw`UPDATE sessions SET started_at = now() - interval '400 days', updated_at = now() - interval '400 days' WHERE id = ${bound}`;
    await db.usageEvent.deleteMany({ where: { sessionId: bound } });
    await call('hadron_create_node', { urn: uri('dac:dormant'), name: 'dormant' }, bound);
    expect(await attributionAt('dac:dormant', appMemory.id)).toEqual(nullActor);
  });

  it('a write naming its session is attributed to that session\'s worker, per request, on one connection', async () => {
    const call = await mcpConnection();
    const irisSession = await startWorkerSessionGql({ workerRef: worker.id, force: true, userId, appId });
    const { dara, daraSession } = await mkDara();
    await call('hadron_create_node', { urn: uri('shared:a'), name: 'a', session: irisSession });
    await call('hadron_create_node', { urn: uri('shared:b'), name: 'b', session: daraSession });
    expect(await attributionAt('shared:a', appMemory.id)).toEqual({ createdByWorkerId: worker.id, createdByAgentId: agent.id });
    expect(await attributionAt('shared:b', appMemory.id)).toEqual({ createdByWorkerId: dara.id, createdByAgentId: agent.id });

    // Updates carry it too: updatedBy follows the session named on the update.
    await call('hadron_update_node', { urn: uri('shared:a'), description: 'by Dara', session: daraSession });
    const a = await db.node.findFirstOrThrow({ where: { memoryId: appMemory.id, loc: 'shared:a' }, select: { createdByWorkerId: true, updatedByWorkerId: true } });
    expect(a).toEqual({ createdByWorkerId: worker.id, updatedByWorkerId: dara.id });
    // An unnamed write on the same connection is nobody's: nothing is carried over from the earlier named ones.
    await call('hadron_create_node', { urn: uri('shared:unnamed'), name: 'unnamed' });
    expect(await attributionAt('shared:unnamed', appMemory.id)).toEqual(nullActor);
  });

  it('a named session that cannot attribute is refused, and nothing is written', async () => {
    const call = await mcpConnection();
    const refused = await call('hadron_create_node', { urn: uri('shared:bogus'), name: 'bogus', session: generateId() }, undefined, { allowError: true });
    expect(refused).toContain('[session_not_bound]');
    expect(await db.node.findFirst({ where: { memoryId: appMemory.id, loc: 'shared:bogus' } })).toBeNull();
  });

  it('calls batched into one POST each keep their own actor (PR #1702 review, Codex P1)', async () => {
    const call = await mcpConnection();
    const irisSession = await startWorkerSessionGql({ workerRef: worker.id, force: true, userId, appId });
    const { dara, daraSession } = await mkDara();
    // Several rounds: the SDK runs a batch's calls concurrently, and a shared
    // actor holder only misattributes when their DB awaits interleave.
    for (let round = 0; round < 5; round++) {
      await call.batch([
        { name: 'hadron_create_node', args: { urn: uri(`batch:${round}:a`), name: 'a', session: irisSession } },
        { name: 'hadron_create_node', args: { urn: uri(`batch:${round}:b`), name: 'b', session: daraSession } },
        { name: 'hadron_create_node', args: { urn: uri(`batch:${round}:unsaid`), name: 'unsaid' } },
      ]);
    }
    for (let round = 0; round < 5; round++) {
      expect(await attributionAt(`batch:${round}:a`, appMemory.id), `round ${round} a`).toEqual({ createdByWorkerId: worker.id, createdByAgentId: agent.id });
      expect(await attributionAt(`batch:${round}:b`, appMemory.id), `round ${round} b`).toEqual({ createdByWorkerId: dara.id, createdByAgentId: agent.id });
      expect(await attributionAt(`batch:${round}:unsaid`, appMemory.id), `round ${round} unsaid`).toEqual(nullActor);
    }
  });
});
