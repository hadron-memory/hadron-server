/**
 * #2605 — sessionless serving of /mcp, behind `MCP_SERVING_MODE=sessionless` (off by default; ruling 8, Holger
 * 2026-11-20).
 *
 * Over the REAL HTTP boundary and the real Express app: what is under test is what a client sees, and that the server
 * holds nothing between two requests. The default mode is pinned too, so this path cannot start serving by accident.
 *
 * Not covered here, on purpose: a named session supplying the App and memory for a call (the next slice), and real
 * client applications (the client-compatibility slice).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import { mintUserApiKey, type OAuthScope } from '../middleware/auth.js';
import { signJwt } from '../auth/jwt.js';
import { closeServerIfStarted, createServerOnCleanDb } from '../test/startServerFixture.js';
import { mcpServingMode, mcpTransportStateForTests } from './server.js';

let server: Server;
let baseUrl: string;
const savedMode = process.env.MCP_SERVING_MODE;

beforeAll(async () => {
  const app = await createServerOnCleanDb();
  server = createHttpServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await closeServerIfStarted(server);
});

let appA: { id: string; urn: string };
let appB: { id: string; urn: string };
let user: { id: string };

const mintKey = async (issuedVia: string) =>
  (await mintUserApiKey(db, { userId: user.id, label: 'test', createdBy: user.id, issuedVia })).rawKey;

beforeEach(async () => {
  await cleanDb(db);
  const suffix = generateId().slice(-8);
  const org = await db.organization.create({ data: { id: generateId(), name: 'sl-org', urn: `sl-${suffix}.com` } });
  appA = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'App A', urn: `${org.urn}:app-a` } });
  appB = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'App B', urn: `${org.urn}:app-b` } });
  user = await db.user.create({ data: { id: generateId(), githubId: 26051, githubUsername: `sl-${suffix}`, roles: ['READER'] } });
  await db.orgMember.create({ data: { id: generateId(), organizationId: org.id, userId: user.id, role: 'CONTRIBUTOR' } });
  // Two Apps, so App scope is ambiguous without a selection and a carried selection is observable.
  await db.appMember.create({ data: { appId: appA.id, userId: user.id, role: 'owner' } });
  await db.appMember.create({ data: { appId: appB.id, userId: user.id, role: 'owner' } });
});

afterEach(() => {
  if (savedMode === undefined) delete process.env.MCP_SERVING_MODE;
  else process.env.MCP_SERVING_MODE = savedMode;
});

const sessionless = () => { process.env.MCP_SERVING_MODE = 'sessionless'; };

const initializeBody = {
  jsonrpc: '2.0', id: 1, method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw-2025', version: '1' } },
};
const rpc = (method: string, params?: unknown, id = 2) => ({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) });
const call = (name: string, args: Record<string, unknown> = {}) => rpc('tools/call', { name, arguments: args }, 7);

async function post(body: unknown, opts: { key?: string; headers?: Record<string, string> } = {}) {
  const res = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      accept: 'application/json, text/event-stream', 'content-type': 'application/json',
      ...(opts.key ? { authorization: `Bearer ${opts.key}` } : {}), ...opts.headers,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  // An SSE-framed answer carries the JSON-RPC message on its data line.
  const data = text.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).filter(Boolean);
  let json: any = null;
  try { json = JSON.parse(data.length ? data[data.length - 1] : text); } catch { /* not JSON */ }
  return { status: res.status, sessionHeader: res.headers.get('mcp-session-id'), wwwAuthenticate: res.headers.get('www-authenticate'), text, json };
}

describe('#2605 MCP_SERVING_MODE', () => {
  it('is sessionless only for the exact value; every other value, and unset, is sessionful', () => {
    for (const value of [undefined, '', 'sessionful', 'Sessionless', 'SESSIONLESS', ' sessionless', 'true', '1', 'stateless']) {
      if (value === undefined) delete process.env.MCP_SERVING_MODE; else process.env.MCP_SERVING_MODE = value;
      expect(mcpServingMode(), String(value)).toBe('sessionful');
    }
    process.env.MCP_SERVING_MODE = 'sessionless';
    expect(mcpServingMode()).toBe('sessionless');
  });

  it('unset, a connection is still opened with a session id and held (the live path is untouched)', async () => {
    delete process.env.MCP_SERVING_MODE;
    const key = await mintKey('portal');
    const init = await post(initializeBody, { key });
    expect(init.status).toBe(200);
    expect(init.sessionHeader).toBeTruthy();
    expect(mcpTransportStateForTests().sessionIds).toContain(init.sessionHeader);
    // And a request with no session id that is not an initialize is still refused there.
    expect((await post(rpc('tools/list'), { key })).status).not.toBe(200);
  });
});

describe('#2605 sessionless serving', () => {
  it('serves a 2025-era client with no session id, and holds nothing afterwards', async () => {
    sessionless();
    const key = await mintKey('portal');
    const before = mcpTransportStateForTests();

    const init = await post(initializeBody, { key });
    expect(init.status).toBe(200);
    expect(init.sessionHeader).toBeNull();
    expect(init.json.result.protocolVersion).toBe('2025-06-18');
    expect(init.json.result.serverInfo.name).toBe('hadron');

    const headers = { 'mcp-protocol-version': '2025-06-18' };
    expect((await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, { key, headers })).status).toBe(202);

    const list = await post(rpc('tools/list'), { key, headers });
    expect(list.status).toBe(200);
    expect(list.sessionHeader).toBeNull();
    const names: string[] = list.json.result.tools.map((t: { name: string }) => t.name);
    expect(names.length).toBeGreaterThan(50);
    expect(names).toContain('hadron_list_memories');

    const called = await post(call('hadron_list_memories'), { key, headers });
    expect(called.status).toBe(200);
    expect(called.json.result.content[0].text).toContain('no active App');

    // No connection, reservation or per-connection entry was created by any of it.
    expect(mcpTransportStateForTests()).toEqual(before);
  });

  it('ignores a session id the client still sends, and echoes none', async () => {
    sessionless();
    const key = await mintKey('portal');
    const list = await post(rpc('tools/list'), { key, headers: { 'mcp-session-id': '11111111-2222-3333-4444-555555555555' } });
    expect(list.status).toBe(200);
    expect(list.sessionHeader).toBeNull();
    expect(list.json.result.tools.length).toBeGreaterThan(50);
  });

  it('answers GET and DELETE 405 with Allow: POST, the same with or without a credential', async () => {
    sessionless();
    const key = await mintKey('portal');
    for (const method of ['GET', 'DELETE']) {
      const answers = [];
      for (const authorization of [`Bearer ${key}`, undefined]) {
        const res = await fetch(`${baseUrl}/mcp`, {
          method,
          headers: { accept: 'text/event-stream', 'mcp-session-id': 'x', ...(authorization ? { authorization } : {}) },
        });
        answers.push({ status: res.status, allow: res.headers.get('allow'), body: await res.text() });
      }
      expect(answers[0], method).toEqual({ status: 405, allow: 'POST', body: JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null }) });
      expect(answers[1], method).toEqual(answers[0]);
    }
  });

  it('refuses a request with no credential exactly as a connection being opened is refused', async () => {
    const sessionfulAnswer = await post(initializeBody);
    sessionless();
    for (const body of [initializeBody, rpc('tools/list'), call('hadron_list_memories')]) {
      const answer = await post(body);
      expect(answer.status).toBe(sessionfulAnswer.status);
      expect(answer.status).toBe(401);
      expect(answer.wwwAuthenticate).toBe(sessionfulAnswer.wwwAuthenticate);
      expect(answer.text).toBe(sessionfulAnswer.text);
    }
  });

  it('refuses an OAuth credential whose grant cannot reach MCP exactly as the sessionful path does', async () => {
    // Only a scope the server does not support fails the MCP surface (#1303); the cast is how a stored unknown scope looks.
    const key = (await mintUserApiKey(db, { userId: user.id, label: 'scoped', createdBy: user.id, issuedVia: 'test', oauthScopes: ['mcp', 'telepathy'] as unknown as OAuthScope[] })).rawKey;
    const sessionfulAnswer = await post(initializeBody, { key });
    expect(sessionfulAnswer.status).toBe(403);
    sessionless();
    for (const body of [initializeBody, rpc('tools/list'), call('hadron_list_memories')]) {
      const answer = await post(body, { key });
      expect(answer.status).toBe(403);
      expect(answer.wwwAuthenticate).toBe('Bearer error="insufficient_scope", scope="mcp"');
      expect(answer.text).toBe(sessionfulAnswer.text);
    }
  });

  it('refuses an impersonation credential exactly as the sessionful path does, and writes nothing', async () => {
    const org = await db.organization.create({ data: { id: generateId(), name: 'sl-imp', urn: `sl-imp-${generateId()}` } });
    const admin = await db.user.create({ data: { handle: `sl-admin-${generateId().slice(-6)}`, roles: ['ADMIN'] } });
    await db.orgMember.createMany({ data: [
      { organizationId: org.id, userId: admin.id, role: 'ADMIN' },
      { organizationId: org.id, userId: user.id, role: 'CONTRIBUTOR' },
    ] });
    const adminToken = await signJwt({ sub: admin.id, roles: ['ADMIN'] });
    const started = await fetch(`${baseUrl}/graphql`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ query: `mutation { startImpersonation(orgRef:"${org.id}", userRef:"${user.id}") { token } }` }),
    });
    const token: string = ((await started.json()) as any).data.startImpersonation.token;
    expect(token).toBeTruthy();

    const sessionfulAnswer = await post(initializeBody, { key: token });
    expect(sessionfulAnswer.status).toBe(401);
    sessionless();
    const selections = await db.mcpSessionState.count();
    for (const body of [initializeBody, rpc('tools/list'), call('hadron_set_active_app', { app: appA.urn })]) {
      const answer = await post(body, { key: token });
      expect(answer.status).toBe(401);
      expect(answer.text).toBe(sessionfulAnswer.text);
    }
    expect(await db.mcpSessionState.count()).toBe(selections);
  });

  it('refuses a garbage or revoked credential on the very next request', async () => {
    sessionless();
    const key = await mintKey('portal');
    expect((await post(rpc('tools/list'), { key })).status).toBe(200);
    await db.userApiKey.updateMany({ where: { userId: user.id }, data: { revokedAt: new Date() } });
    expect((await post(rpc('tools/list'), { key })).status).toBe(401);
    expect((await post(call('hadron_list_memories'), { key })).status).toBe(401);
    expect((await post(rpc('tools/list'), { key: 'hdr_user_' + 'f'.repeat(64) })).status).toBe(401);
  });

  it('carries a selection between requests through the stored selection of an OAuth client', async () => {
    sessionless();
    const key = await mintKey('oauth:dcr_desktop');
    const set = await post(call('hadron_set_active_app', { app: appA.urn }), { key });
    expect(set.json.result.content[0].text).toContain('Active App set to');
    const next = await post(call('hadron_list_memories'), { key });
    expect(next.json.result.content[0].text).toContain(appA.urn);
  });

  it('a caller with no stored-selection key starts every request with no selection (until a session carries it)', async () => {
    sessionless();
    const key = await mintKey('portal');
    const set = await post(call('hadron_set_active_app', { app: appA.urn }), { key });
    expect(set.json.result.content[0].text).toContain('Active App set to');
    const next = await post(call('hadron_list_memories'), { key });
    expect(next.json.result.content[0].text).toContain('no active App');
  });

  // KNOWN LIMIT, pinned so the session-handle slice (plan H1/H2) changes it on purpose. Two chats in one connector
  // present the same credential, so they share one stored selection, and here it is read on EVERY request: chat 1's
  // next call lands in the App chat 2 picked, with no warning. Sessionful serving reads it only when a connection is
  // opened. This is why the mode must stay off until a session handle carries each chat's context.
  it('KNOWN LIMIT: two chats on one OAuth client move each other\'s selection, request by request', async () => {
    sessionless();
    const connector = await mintKey('oauth:dcr_claude_ai');
    await post(call('hadron_set_active_app', { app: appA.urn }), { key: connector }); // chat 1
    await post(call('hadron_set_active_app', { app: appB.urn }), { key: connector }); // chat 2
    const chat1Next = await post(call('hadron_list_memories'), { key: connector });
    expect(chat1Next.json.result.content[0].text).toContain(appB.urn);
    expect(chat1Next.json.result.content[0].text).not.toContain(appA.urn);
  });

  it('answers an unknown tool with a JSON-RPC error and a bad argument with an error result', async () => {
    sessionless();
    const key = await mintKey('portal');
    const unknown = await post(call('no_such_tool'), { key });
    expect(unknown.json.error.code).toBe(-32602);
    const bad = await post(call('hadron_get_node', { urn: 42 }), { key });
    expect(bad.json.result.isError).toBe(true);
  });

  for (const [label, options, negotiated] of [
    ['its default, the 2025 handshake', undefined, '2025-11-25'],
    ['auto negotiation', { versionNegotiation: { mode: 'auto' } }, '2026-07-28'],
    ['a pin to 2026-07-28', { versionNegotiation: { mode: { pin: '2026-07-28' } } }, '2026-07-28'],
  ] as const) {
    it(`serves the SDK client using ${label} from the same endpoint`, async () => {
      sessionless();
      const key = await mintKey('portal');
      // The registry is process-wide and the sessionful control above left its connection in it: compare, not empty.
      const before = mcpTransportStateForTests().sessionIds;
      const client = new Client({ name: 'sdk-client', version: '1' }, options as never);
      const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), { requestInit: { headers: { authorization: `Bearer ${key}` } } });
      try {
        await client.connect(transport);
        expect(transport.sessionId).toBeUndefined();
        expect(client.getNegotiatedProtocolVersion()).toBe(negotiated);
        expect((await client.listTools()).tools.length).toBeGreaterThan(50);
        const result = await client.callTool({ name: 'hadron_list_memories', arguments: {} });
        expect(JSON.stringify(result.content)).toContain('no active App');
      } finally {
        await client.close().catch(() => undefined);
      }
      expect(mcpTransportStateForTests().sessionIds).toEqual(before);
    });
  }
});
