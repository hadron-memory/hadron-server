import { WORKER_SIGNATURE_DEFAULTS } from '../lib/workerSignature.js';
/**
 * #1755 cycle 1 (Diego P2, Chip QA) — the App key's task reads across the REAL MCP HTTP boundary. The explicit
 * `session` argument must never be dropped: a key that names ANY session (plain, worker, invalid) is refused, exactly
 * as the same session in the X-Hadron-Session header is, never served as if unbound.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { createServer } from '../server.js';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import { APP_KEY_PREFIX, hashAppKey } from '../middleware/auth.js';
import { resolvers } from '../api/graphql/schema/resolvers.js';

vi.mock('../lib/bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));
vi.mock('../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));

const M = resolvers.Mutation as any;

let server: Server;
let baseUrl: string;
beforeAll(async () => {
  server = createHttpServer(await createServer());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

let appId: string;
let taskId: string;
let key: string;
let plainSession: string;
let workerSession: string;

beforeEach(async () => {
  await cleanDb(db);
  const suffix = generateId().toLowerCase();
  const org = await db.organization.create({ data: { id: generateId(), name: 'mcp-tk', urn: `mcp-tk-${suffix}` } });
  const user = await db.user.create({ data: { id: generateId(), githubId: 99_200, githubUsername: `tk-${suffix}`, roles: ['READER'] }, select: { id: true } });
  await db.orgMember.create({ data: { id: generateId(), organizationId: org.id, userId: user.id, role: 'ADMIN' } });
  const agent = await M.createAgent({}, { orgId: org.id, name: 'Team Agent' }, { db, userId: user.id, roles: ['READER'] });
  const app = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Team', urn: `${org.urn}:team` } });
  appId = app.id;
  await db.appMember.create({ data: { appId, userId: user.id, role: 'member' } });
  const worker = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId, agentId: agent.id, name: 'Anne', slug: 'anne' }, select: { id: true } });
  taskId = (await M.createAgentTask({}, { input: { appRef: appId, title: 'visible' } }, { db, userId: user.id, roles: ['READER'] })).id;
  const raw = `${APP_KEY_PREFIX}${randomBytes(32).toString('hex')}`;
  await db.appKey.create({ data: { id: generateId(), appId, keyHash: hashAppKey(raw), keyPreview: raw.slice(-4) } });
  key = raw;
  plainSession = (await db.session.create({ data: { id: generateId(), appId }, select: { id: true } })).id;
  workerSession = (await db.session.create({ data: { id: generateId(), appId, workerId: worker.id }, select: { id: true } })).id;
});

const initializeBody = {
  jsonrpc: '2.0', id: 1, method: 'initialize',
  params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'router', version: '1.0.0' } },
};
async function post(body: unknown, opts: { mcpSession?: string; hadronSession?: string }) {
  const headers: Record<string, string> = {
    accept: 'application/json, text/event-stream', 'content-type': 'application/json', authorization: `Bearer ${key}`,
  };
  if (opts.mcpSession) headers['mcp-session-id'] = opts.mcpSession;
  if (opts.hadronSession) headers['x-hadron-session'] = opts.hadronSession;
  return fetch(`${baseUrl}/mcp`, { method: 'POST', headers, body: JSON.stringify(body) });
}
async function open(): Promise<string> {
  const res = await post(initializeBody, {});
  expect(res.status).toBe(200);
  const id = res.headers.get('mcp-session-id')!;
  await res.text();
  await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, { mcpSession: id });
  return id;
}
let rpc = 10;
async function call(mcpSession: string, name: string, args: Record<string, unknown>, hadronSession?: string) {
  const res = await post({ jsonrpc: '2.0', id: rpc++, method: 'tools/call', params: { name, arguments: args } }, { mcpSession, hadronSession });
  const raw = await res.text();
  const data = raw.split('\n').find((l) => l.startsWith('data:'))?.slice(5) ?? raw;
  const result = JSON.parse(data).result;
  return { isError: result?.isError === true, text: (result?.content?.[0]?.text ?? '') as string };
}

const reads = (): Array<[string, Record<string, unknown>]> => [
  ['hadron_task_get', { taskId }],
  ['hadron_task_get', { taskId, tree: true }],
  ['hadron_task_list', { appRef: appId }],
  ['hadron_team_events', { appRef: appId }],
  ['hadron_team_availability', { appRef: appId }],
];

describe('an App key reads tasks and events over MCP, and never through a session (#1755)', () => {
  it('served with no session', async () => {
    const m = await open();
    for (const [tool, args] of reads()) {
      const r = await call(m, tool, args);
      expect(r.isError, `${tool}: ${r.text}`).toBe(false);
      expect(r.text).not.toContain('app_key_session_bound');
    }
    expect((await call(m, 'hadron_task_list', { appRef: appId })).text).toContain('visible');
  });

  it.each([
    ['a plain own-App session', () => plainSession],
    ['a worker session', () => workerSession],
    ['an invalid session', () => generateId()],
  ])('%s named as the session argument is refused on get, tree, list and events', async (_n, pick) => {
    const m = await open();
    for (const [tool, args] of reads()) {
      const r = await call(m, tool, { ...args, session: pick() });
      expect(r.isError, tool).toBe(true);
      expect(r.text, tool).toContain('[app_key_session_bound]');
    }
  });

  it('the same session in the X-Hadron-Session header is refused too', async () => {
    const m = await open();
    for (const [tool, args] of reads()) {
      const r = await call(m, tool, args, plainSession);
      expect(r.isError, tool).toBe(true);
      expect(r.text, tool).toContain('[app_key_session_bound]');
    }
  });
});
