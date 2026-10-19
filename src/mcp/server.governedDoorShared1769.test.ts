import { WORKER_SIGNATURE_DEFAULTS } from '../lib/workerSignature.js';
/**
 * #1769 S1/S2: the four governed doors on a SHARED MCP connection.
 *
 * A connection carrying two workers' sessions cannot tell which of them sent a
 * call. Without `session` the doors refuse SESSION_AMBIGUOUS and write nothing
 * (S1); naming a session, the remedy that refusal prescribes, must write and
 * attribute to that worker (S2). Before the fix S2 crashed in the node upsert,
 * so no governed node could be written at all. Over the real Streamable HTTP
 * transport, because the shared-connection registry lives in that layer.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createServer } from '../server.js';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import { mintUserApiKey } from '../middleware/auth.js';

vi.mock('../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

let server: Server;
let baseUrl: string;
let token: string;
const MEMORY_URN = 'shared1769.example:team-shared';
const IRIS_REF = 'hrn:worker:shared1769.example:team:iris';
const DARA_REF = 'hrn:worker:shared1769.example:team:dara';
let workers: { iris: string; dara: string };
let memoryId: string;

beforeAll(async () => {
  server = createHttpServer(await createServer());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); });

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), name: 'Shared 1769', urn: 'shared1769.example' } });
  const user = await db.user.create({ data: { githubId: 176902, githubUsername: 'shared-1769', handle: 'shared-1769', roles: ['READER'] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: user.id, role: 'ADMIN' } });
  const agent = await db.agent.create({ data: { id: generateId(), urn: 'shared1769.example:engineer', name: 'engineer', organizationId: org.id } });
  const app = await db.app.create({ data: { id: generateId(), name: 'Team', urn: 'shared1769.example:team', organizationId: org.id } });
  await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
  await db.appMember.create({ data: { appId: app.id, userId: user.id, role: 'owner' } });
  memoryId = (await db.memory.create({ data: {
    id: generateId(), urn: MEMORY_URN, name: 'team-shared', class: 'app',
    appId: app.id, organizationId: org.id, sharedMemoryOfAgentId: agent.id,
  } })).id;
  const iris = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId: app.id, agentId: agent.id, name: 'Iris', slug: 'iris' } });
  const dara = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId: app.id, agentId: agent.id, name: 'Dara', slug: 'dara' } });
  workers = { iris: iris.id, dara: dara.id };
  ({ rawKey: token } = await mintUserApiKey(db, { userId: user.id, label: null, createdBy: user.id, issuedVia: 'test' }));
});

async function connection() {
  const h = { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  const init = await fetch(`${baseUrl}/mcp`, {
    method: 'POST', headers: h,
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: '1769', version: '1' } } }),
  });
  expect(init.status).toBe(200);
  const sid = init.headers.get('mcp-session-id')!;
  let id = 10;
  return async (name: string, args: Record<string, unknown>): Promise<string> => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST', headers: { ...h, 'mcp-session-id': sid },
      body: JSON.stringify({ jsonrpc: '2.0', id: id++, method: 'tools/call', params: { name, arguments: args } }),
    });
    expect(res.status).toBe(200);
    return res.text();
  };
}

/** One connection carrying two chat sessions' worker bindings, Iris then Dara. */
async function shared() {
  const call = await connection();
  const iris = /Session started: ([0-9a-f]{32})/.exec(await call('hadron_start_session', { description: 'chat A', workerRef: IRIS_REF, force: true }))![1];
  const dara = /Session started: ([0-9a-f]{32})/.exec(await call('hadron_start_session', { description: 'chat B', workerRef: DARA_REF }))![1];
  return { call, iris, dara };
}

const urn = (loc: string) => `hrn:node:${MEMORY_URN}:${loc}`;
const nodes = (loc: string) => db.node.findMany({ where: { memoryId, loc } });

describe.each([
  ['hadron_create_review', 'review'],
  ['hadron_create_task', 'task'],
])('#1769 shared connection: %s', (tool, kind) => {
  it('S1: without a session it is refused SESSION_AMBIGUOUS and nothing is written', async () => {
    const { call } = await shared();
    const loc = `shared:s1:${kind}`;
    expect(await call(tool, { urn: urn(loc), name: loc })).toContain('[session_ambiguous]');
    expect(await nodes(loc)).toEqual([]);
  });

  it('S2: naming a session writes, attributed to that worker (not the other one)', async () => {
    const { call, dara } = await shared();
    const loc = `shared:s2:${kind}`;
    const text = await call(tool, { urn: urn(loc), name: loc, session: dara });
    expect(text).toMatch(/created/);
    expect(text).not.toMatch(/Unknown argument|Invalid `/);
    const [node] = await nodes(loc);
    expect(node.createdByWorkerId).toBe(workers.dara);
  });
});

describe.each([
  ['hadron_update_review', 'hadron_create_review', 'review'],
  ['hadron_update_task', 'hadron_create_task', 'task'],
])('#1769 shared connection: %s', (update, create, kind) => {
  it('S1/S2: unnamed edit refused and unwritten; a named edit lands attributed to the named worker', async () => {
    const { call, iris, dara } = await shared();
    const loc = `shared:edit:${kind}`;
    await call(create, { urn: urn(loc), name: loc, session: iris });
    expect(await call(update, { urn: urn(loc), content: 'unsaid' })).toContain('[session_ambiguous]');
    expect((await nodes(loc))[0].content).not.toBe('unsaid');
    const text = await call(update, { urn: urn(loc), content: 'said', session: dara });
    expect(text).toMatch(/updated/);
    const [node] = await nodes(loc);
    expect(node.content).toBe('said');
    expect(node.createdByWorkerId).toBe(workers.iris);
    expect(node.updatedByWorkerId).toBe(workers.dara);
  });
});
