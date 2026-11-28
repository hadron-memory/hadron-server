/**
 * #5360 B4 — the implicit-Agent MCP path of `hadron_get_instructions`, end to end over the REAL Streamable
 * HTTP transport: a bound worker omits `agentRef` and the answer comes from ITS OWN Agent (the actor the
 * validated X-Hadron-Session binding publishes), not from anything the client asserts. The render's
 * "Read through" line is the proof the tool resolved the asking Agent implicitly (agentDefinitionTools.ts:
 * the agentId behind it comes from currentActor(), never from a named ref).
 *
 * The worker session is started through GraphQL (the CLI's path, startWorkerSessionGql) and PRESENTED per
 * request (#3082: MCP itself binds no worker).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resetEmbeddingClientForTests } from '../lib/embedding/index.js';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { serveEveryAgent } from '../test/servedBootPrompt.js';
import { generateId } from '../lib/id.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../lib/workerSignature.js';
import { mintUserApiKey } from '../middleware/auth.js';
import { resolvers, type Context } from '../api/graphql/schema/resolvers.js';
import { startWorkerSessionGql } from '../test/startWorkerSessionGql.js';
import { closeServerIfStarted, createServerOnCleanDb } from '../test/startServerFixture.js';

vi.mock('../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));

let server: Server;
let baseUrl: string;
let token: string;
let workerSessionId: string;
let engineerMemoryUrn: string;
let coderMemoryUrn: string;

beforeAll(async () => {
  server = createHttpServer(await createServerOnCleanDb());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { await closeServerIfStarted(server); });
// #5408 (Byron's F8): the stub alone does not reach an embedding client cached before it — reset alongside the
// stub, and again after, so this file's "No task matches" shape never depends on the ambient env or a leak.
afterEach(() => { vi.unstubAllEnvs(); resetEmbeddingClientForTests(); });

beforeEach(async () => {
  vi.stubEnv('EMBEDDING_API_URL', ''); // no embeddings on this stack: the keyword fallback shapes the answer
  resetEmbeddingClientForTests();
  await cleanDb(db);
  const s = generateId().toLowerCase();
  const org = await db.organization.create({ data: { id: generateId(), name: 'Implicit Org', urn: `implicit-${s}.example` } });
  const user = await db.user.create({ data: { handle: `implicit-${s}`, roles: ['READER'] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: user.id, role: 'ADMIN' } });
  const ctx: Context = { db, userId: user.id, roles: ['READER'] };
  const app = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Team', urn: `${org.urn}:team` } });

  // Coder extends Engineer; the task lives in the BASE's memory, so serving it marks it inherited and the
  // render must print the "Read through" address in the CHILD's memory — which only the implicitly resolved
  // agentId can know.
  const engineer = await resolvers.Mutation.createAgent(null, { orgRef: org.id, name: 'Engineer' }, ctx);
  const coder = await resolvers.Mutation.createAgent(null, { orgRef: org.id, name: 'Coder' }, ctx);
  await db.agent.update({ where: { id: coder.id }, data: { extendsAgentId: engineer.id } });
  engineerMemoryUrn = (await db.memory.findUniqueOrThrow({ where: { id: engineer.systemMemoryId! } })).urn;
  coderMemoryUrn = (await db.memory.findUniqueOrThrow({ where: { id: coder.systemMemoryId! } })).urn;
  await db.node.create({
    data: { id: generateId(), memoryId: engineer.systemMemoryId!, loc: 'tasks:deploy', name: 'tasks:deploy', content: '# Deploy steps', isRunnable: true, abstract: 'Fix a failed deploy' },
  });

  const worker = await db.worker.create({
    data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId: app.id, agentId: coder.id, name: 'Quinn', slug: `quinn-${s}` },
  });
  await serveEveryAgent(db); // #2712: binds are served the Agent's boot prompt — set BEFORE the bind
  workerSessionId = await startWorkerSessionGql({ workerRef: worker.id, userId: user.id, appId: app.id });
  ({ rawKey: token } = await mintUserApiKey(db, { userId: user.id, label: null, createdBy: user.id, issuedVia: 'test' }));
});

/** One MCP connection (initialize → mcp-session-id); each call may present the worker session by header. */
async function mcpCall(name: string, args: Record<string, unknown>, hadronSession?: string): Promise<string> {
  const base = { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  const init = await fetch(`${baseUrl}/mcp`, {
    method: 'POST', headers: base,
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'implicit-5360', version: '1' } } }),
  });
  expect(init.status).toBe(200);
  const sid = init.headers.get('mcp-session-id')!;
  const res = await fetch(`${baseUrl}/mcp`, {
    method: 'POST', headers: { ...base, 'mcp-session-id': sid, ...(hadronSession ? { 'x-hadron-session': hadronSession } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } }),
  });
  expect(res.status).toBe(200);
  const text = await res.text();
  // #5408 (Byron's F8): close the transport this call opened — the registry keeps an unclosed session until the
  // idle sweep, which never runs under NODE_ENV=test.
  await fetch(`${baseUrl}/mcp`, { method: 'DELETE', headers: { ...base, 'mcp-session-id': sid } });
  return text;
}

describe('#5360 B4: hadron_get_instructions with no agentRef, over the real transport', () => {
  it('a bound worker that omits agentRef gets its OWN Agent\'s answer, with the implicit Read-through address', async () => {
    const text = await mcpCall('hadron_get_instructions', { phrase: 'deploy' }, workerSessionId);
    expect(text, text).not.toContain('"isError":true');
    expect(text).toContain('No task matches this phrase.'); // no embeddings: keyword hits are nearest, never a match
    expect(text).toContain(`hrn:node:${engineerMemoryUrn}:tasks:deploy`); // the inherited task, under its own URN
    expect(text).toContain('Inherited from:');
    // The proof of the implicit path: the Read-through address is in the CHILD's memory, and only the
    // agentId resolved from the session binding (never a named ref) can name it.
    expect(text).toContain(`Read through: hrn:node:${coderMemoryUrn}:tasks:deploy`);
  });

  it('the same connection with no session presented and no agentRef is refused as GraphQL refuses it', async () => {
    const text = await mcpCall('hadron_get_instructions', { phrase: 'deploy' });
    expect(text).toContain('[BAD_USER_INPUT]');
  });
});

describe('#5360 B7 over MCP: hadron_agent_tasks validates before it reads', () => {
  it('an over-long phrase is the 512 input refusal even for an unknown Agent (the check runs before the ref resolution)', async () => {
    const text = await mcpCall('hadron_agent_tasks', { agentRef: generateId(), phrase: 'x'.repeat(513) }, workerSessionId);
    expect(text, text).toContain('at most 512 characters'); // the input refusal's own text
    expect(text).toContain('"isError":true'); // the refusal itself, not merely the absence of the not-found one
    // The tool renders a refusal's raw message, and the not-found message carries its code — its absence is
    // the proof the input check ran BEFORE the ref was resolved.
    expect(text).not.toContain('AGENT_NOT_FOUND');
  });
});
