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
afterAll(async () => { server.closeAllConnections?.(); await new Promise<void>((resolve) => server.close(() => resolve())); });

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
  ({ rawKey: token } = await mintUserApiKey(db, { userId: user.id, label: null, createdBy: user.id, issuedVia: 'test' }));
  await serveEveryAgent(db);
  sessionId = (await resolvers.Mutation.startSession({}, { input: { id: generateId(), workerRef: worker.id, tool: 'vitest', llmModel: 'test', family: 'codex' } }, { ...ctx, appId: app.id })).id;
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

async function mcpCreate(loc: string, withSession: boolean, named = false, requireSuccess = true): Promise<void> {
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
      name: 'hadron_create_node', arguments: { urn: `hrn:node:${appMemory.urn}:${loc}`, name: loc, ...(named ? { session: sessionId } : {}) },
    } }),
  });
  expect(call.status).toBe(200);
  const text = await call.text();
  if (requireSuccess) expect(text, text).not.toContain('"isError":true');
  await fetch(`${baseUrl}/mcp`, { method: 'DELETE', headers: { ...mcpHeaders, 'mcp-session-id': mcpSession } });
}

describe('#3082 retained worker attribution over HTTP', () => {
  it.each(['header', 'argument'])('a GraphQL-started worker attributes a core write through %s', async form => {
    await mcpCreate('cut:live', form === 'header', form === 'argument');
    expect(await attributionAt('cut:live', appMemory.id)).toEqual({ createdByWorkerId: worker.id, createdByAgentId: agent.id });
  });
  it.each(['ended', 'expired', 'dormant'])('%s headers cannot revive or attribute', async state => {
    const old = new Date(Date.now() - 400 * 86400000);
    await db.session.update({ where: { id: sessionId }, data: state === 'ended' ? { endedAt: new Date() } : state === 'expired' ? { expiresAt: old } : { startedAt: old, updatedAt: old, expiresAt: null } });
    const before = await db.session.findUniqueOrThrow({ where: { id: sessionId } });
    // Invalid headers may refuse the write or allow a person write; neither may attribute it.
    await mcpCreate('cut:invalid', true, false, false);
    const row = await db.node.findFirst({ where: { memoryId: appMemory.id, loc: 'cut:invalid' } });
    expect(row?.createdByWorkerId ?? null).toBeNull();
    expect(row?.createdByAgentId ?? null).toBeNull();
    expect(await db.session.findUniqueOrThrow({ where: { id: sessionId } })).toEqual(before);
  });
});
