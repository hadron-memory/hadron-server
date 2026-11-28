/**
 * #5466 (MCP scale U, SDK 2.x with serving unchanged): every protocol version a client of the 1.x server could
 * negotiate still connects over the real `/mcp` endpoint, sessionfully.
 *
 * For each of 2024-11-05, 2025-03-26, 2025-06-18 and 2025-11-25, a raw JSON-RPC client (no SDK on the client side, so
 * the pin does not move with the SDK's own client defaults) initializes, gets that version back and an
 * `Mcp-Session-Id`, sends `notifications/initialized`, and lists and calls a tool on the session. A version the server
 * does not know is answered with the server's latest supported version, never refused (the MCP negotiation rule).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import { APP_KEY_PREFIX, hashAppKey } from '../middleware/auth.js';
import { closeServerIfStarted, createServerOnCleanDb } from '../test/startServerFixture.js';

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = await createServerOnCleanDb();
  server = createHttpServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await closeServerIfStarted(server);
});

beforeEach(async () => {
  await cleanDb(db);
});

async function mintAppKey(): Promise<string> {
  const org = await db.organization.create({ data: { id: generateId(), name: 'Hs', urn: 'hs5466' } });
  const app = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'hs-app', urn: 'hs5466:hs-app' } });
  const rawKey = `${APP_KEY_PREFIX}${generateId()}${generateId()}`;
  await db.appKey.create({ data: { id: generateId(), appId: app.id, keyHash: hashAppKey(rawKey), keyPreview: rawKey.slice(-4) } });
  return rawKey;
}

function post(body: unknown, headers: Record<string, string>): Promise<globalThis.Response> {
  return fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: { accept: 'application/json, text/event-stream', 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

/** The one JSON-RPC message of a response, whether it came as JSON or as a single-event SSE stream. */
async function message(res: globalThis.Response): Promise<{ result?: Record<string, unknown>; error?: unknown }> {
  const text = await res.text();
  if ((res.headers.get('content-type') ?? '').includes('text/event-stream')) {
    const data = text.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).filter(Boolean);
    expect(data).toHaveLength(1);
    return JSON.parse(data[0]);
  }
  return JSON.parse(text);
}

const initialize = (protocolVersion: string) => ({
  jsonrpc: '2.0', id: 1, method: 'initialize',
  params: { protocolVersion, capabilities: {}, clientInfo: { name: 'handshake-5466', version: '1.0.0' } },
});

describe('#5466 handshakes 2024-11-05 through 2025-11-25 still connect, sessionfully', () => {
  for (const version of ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25']) {
    it(`${version}: initialize, initialized, tools/list and tools/call on the session`, async () => {
      const auth = { authorization: `Bearer ${await mintAppKey()}` };
      const init = await post(initialize(version), auth);
      expect(init.status).toBe(200);
      const sessionId = init.headers.get('mcp-session-id');
      expect(sessionId).toBeTruthy();
      const initMsg = await message(init);
      expect(initMsg.error).toBeUndefined();
      expect(initMsg.result?.protocolVersion).toBe(version);
      expect(initMsg.result?.capabilities).toEqual({ tools: { listChanged: true } });

      // 2024-11-05 and 2025-03-26 clients send no MCP-Protocol-Version header; later ones must.
      const onSession = { ...auth, 'mcp-session-id': sessionId!, ...(version >= '2025-06-18' ? { 'mcp-protocol-version': version } : {}) };
      const initialized = await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, onSession);
      expect(initialized.status).toBe(202);

      const list = await post({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, onSession);
      expect(list.status).toBe(200);
      const tools = (await message(list)).result?.tools as Array<{ name: string }>;
      expect(tools.map((t) => t.name)).toContain('hadron_server_info');

      const call = await post({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'hadron_server_info', arguments: {} } }, onSession);
      expect(call.status).toBe(200);
      const callMsg = await message(call);
      expect(callMsg.error).toBeUndefined();
      expect(callMsg.result?.isError).not.toBe(true);
    });
  }

  it('an unknown future version is answered with a supported version, not refused', async () => {
    const init = await post(initialize('2099-01-01'), { authorization: `Bearer ${await mintAppKey()}` });
    expect(init.status).toBe(200);
    expect(init.headers.get('mcp-session-id')).toBeTruthy();
    const msg = await message(init);
    expect(msg.error).toBeUndefined();
    expect(['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25']).toContain(msg.result?.protocolVersion);
  });
});
