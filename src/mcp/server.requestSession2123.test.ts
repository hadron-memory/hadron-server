/** #2123: real mounted MCP requests, synthetic credentials and private test DB. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createServer } from '../server.js';
import { assertRateReadiness, RateConfigurationError } from '../lib/rateLimit/index.js';
import { readRateKeys } from '../lib/rateLimit/config.js';
import { signJwt } from '../auth/jwt.js';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { ensureChannelWithRoot } from '../lib/channels.js';
import { appendChatMessage } from '../lib/chatRoot.js';
import { getMemoryEncryptionInfo } from '../lib/nodeCrypto.js';
import { generateId } from '../lib/id.js';
import { APP_KEY_PREFIX, hashAppKey } from '../middleware/auth.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../lib/workerSignature.js';

let server: Server;
let baseUrl: string;
let token: string;
let workerId: string;
let appId: string;
let userId: string;
let agentId: string;
const opened: Array<{ id: string; token: string }> = [];

// The suite and retained-state regression must exercise the same fixture path.
async function startRequestSessionFixture() {
  // A worker clone can retain a previous file's manifest after its env is restored.
  await cleanDb(db);
  return createServer();
}

beforeAll(async () => {
  server = createHttpServer(await startRequestSessionFixture());
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
  // Preserve the primary startup error when beforeAll never created a server.
  if (!server) return;
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
  agentId = agent.id;
  await db.appAgent.create({ data: { appId, agentId } });
  workerId = (await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId, agentId: agent.id,
    name: 'Fixture', slug: 'fixture', heldByUserId: userId, heldAt: new Date() } })).id;
  memoryUrn = `${org.urn}:team-shared`;
  memoryId = (await db.memory.create({ data: { urn: memoryUrn, name: 'team-shared', class: 'app', appId, organizationId: org.id, sharedMemoryOfAgentId: agent.id } })).id;
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
// #3082: the team tools this suite used as its probes (hadron_update_worker, hadron_task_create, hadron_ticker_create,
// hadron_stop_signal_lift, the inbox pair, hadron_due_wakes) are disabled on MCP. The request-local session refusal is a
// property of the transport and the shared session gate, so it is probed with a core session-gated write tool instead:
// hadron_create_node into the App's shared memory. `nodeCount` is the independent read of "nothing was written".
let memoryUrn: string;
let memoryId: string;
const write = (transport: string, name: string, session?: string, namedSession?: string, bearer = token) =>
  call(transport, 'hadron_create_node', { urn: `hrn:node:${memoryUrn}:probe:${name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`, name,
    ...(namedSession ? { session: namedSession } : {}) }, session, bearer);
const nodeCount = () => db.node.count({ where: { memoryId, loc: { startsWith: 'probe:' } } });


// #3082: deleted, with the reason in each case:
//  - 'a user-manager edit' / 'cannot become an unbound human-manager edit' / the edit leg of 'every write consumer':
//    hadron_update_worker is disabled; the manager gate they hit is resolvers.updateWorker's, pinned in resolvers.worker.test.ts.
//  - the late/sticky invalid-header refusals: they were enforced by the team tools' own session gate; a core write tool
//    (hadron_create_node) does not refuse an unusable header session (probed: it writes as the caller), so there is no
//    enabled tool that carries that rule and it cannot be re-asserted here. NOT PRESERVED.
//  - task / ticker / stop-signal writes: disabled tools; the same late/sticky header rule is asserted above on a core write.
//  - 'App-key N5 ... task and ticker reads': hadron_task_list / hadron_due_wakes are disabled; the key-vs-session rule is pinned in
//    resolvers.agentTaskAppKey1755.test.ts ('a key carrying a session is refused') and src/lib/appKeyScopes/appKeyScopes.test.ts.
//  - 'self inbox' / 'S1 explicit-body read and ack': hadron_team_chat_inbox(_ack) are disabled; delivery atomicity and refusal
//    floors are pinned in resolvers.deliveryBatchSelf.test.ts and src/lib/tickers/batchAck.test.ts.
// #3082: 'queued requests keep their own bearer/header decision' was suspended inside the team tools' session heartbeat, which
// no enabled tool reaches; its foreign-bearer-on-another's-transport leg (404) is pinned in server.appKeyScope1749.test.ts.

describe('startup fixture ownership (#3107)', () => {
  it('cleans a retained missing-key manifest before boot while raw startup refuses it', async () => {
    const savedRing = process.env.RATE_LIMIT_KEYRING;
    const restoreRing = () => {
      if (savedRing === undefined) delete process.env.RATE_LIMIT_KEYRING;
      else process.env.RATE_LIMIT_KEYRING = savedRing;
    };
    try {
      // Simulate an earlier file restoring its environment but leaving persisted state.
      try {
        process.env.RATE_LIMIT_KEYRING = JSON.stringify({ current: 'previous-file-3107', keys: { 'previous-file-3107': '3'.repeat(64) } });
        await assertRateReadiness(db);
      } finally {
        restoreRing();
      }
      const before = await db.rateLimitManifest.findUniqueOrThrow({ where: { id: 'global' } });
      expect(before.keyIds).toEqual(['previous-file-3107']);
      expect(before.keyIds.filter(id => readRateKeys().keys.has(id))).toEqual([]);
      await expect(createServer()).rejects.toBeInstanceOf(RateConfigurationError);
      const after = await db.rateLimitManifest.findUniqueOrThrow({ where: { id: 'global' } });
      expect(JSON.stringify(after) === JSON.stringify(before)).toBe(true);
      await expect(startRequestSessionFixture()).resolves.toBeDefined();
      expect((await db.rateLimitManifest.findUniqueOrThrow({ where: { id: 'global' } })).keyIds).toEqual([readRateKeys().current]);
    } finally {
      restoreRing();
      await cleanDb(db);
    }
  });
});
