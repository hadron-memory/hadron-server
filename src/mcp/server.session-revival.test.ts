/**
 * MCP session revival after a server restart.
 *
 * The session registry (`transports`) is in-memory, so a deploy/restart
 * wipes every session ID. The MCP streamable-HTTP spec defines the
 * recovery contract: a request carrying an unknown `Mcp-Session-Id` MUST
 * get HTTP 404 ("Session not found"), upon which the client transparently
 * starts a new session with a fresh InitializeRequest.
 *
 * Before this fix, handleMcpRequest fed the stale non-initialize request
 * to a brand-new (uninitialized) SDK transport, whose validateSession
 * answered HTTP 400 "Bad Request: Server not initialized" — a generic
 * protocol error clients do NOT recover from. Active MCP connections were
 * permanently severed by every deploy.
 *
 * Runs against the real Express server + real SDK transport (same harness
 * as the 025 OAuth integration tests) — a fresh `transports` map per
 * process IS the post-restart state, so the suite exercises the genuine
 * restart contract, not a simulation.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createServer } from '../server.js';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import { APP_KEY_PREFIX, hashAppKey } from '../middleware/auth.js';

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = await createServer();
  server = createHttpServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
});

beforeEach(async () => {
  await cleanDb(db);
});

const toolCallBody = {
  jsonrpc: '2.0',
  id: 7,
  method: 'tools/call',
  params: { name: 'hadron_server_info', arguments: {} },
};

const initializeBody = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'test-client', version: '1.0.0' },
  },
};

function mcpFetch(opts: {
  method?: 'POST' | 'GET';
  body?: unknown;
  sessionId?: string;
  authorization?: string;
}): Promise<globalThis.Response> {
  const headers: Record<string, string> = {
    accept: 'application/json, text/event-stream',
    'content-type': 'application/json',
  };
  if (opts.sessionId) headers['mcp-session-id'] = opts.sessionId;
  if (opts.authorization) headers.authorization = opts.authorization;
  return fetch(`${baseUrl}/mcp`, {
    method: opts.method ?? 'POST',
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
}

async function mintAppKey(): Promise<string> {
  const org = await db.organization.create({
    data: { id: generateId(), name: 'Acme', urn: 'acme-revival' },
  });
  const app = await db.app.create({
    data: {
      id: generateId(),
      organizationId: org.id,
      name: 'bot-app',
      urn: 'acme-revival:bot-app',
    },
  });
  const rawKey = `${APP_KEY_PREFIX}${generateId()}${generateId()}`;
  await db.appKey.create({
    data: {
      id: generateId(),
      appId: app.id,
      keyHash: hashAppKey(rawKey),
      keyPreview: rawKey.slice(-4),
    },
  });
  return rawKey;
}

describe('stale Mcp-Session-Id → 404 Session not found (MCP revival contract)', () => {
  it('POST tools/call with an unknown session ID returns 404 + JSON-RPC -32001', async () => {
    const res = await mcpFetch({
      sessionId: 'pre-restart-session',
      body: toolCallBody,
      authorization: 'Bearer whatever', // 404 fires before auth — stale-session is not an auth question
    });

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      jsonrpc: '2.0',
      error: { code: -32001, message: 'Session not found' },
      id: null,
    });
  });

  it('GET (SSE stream open) with an unknown session ID returns 404', async () => {
    const res = await mcpFetch({ method: 'GET', sessionId: 'pre-restart-session' });

    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: number } };
    expect(body.error.code).toBe(-32001);
  });

  it('batch body containing an initialize request is NOT 404ed', async () => {
    // Batch with an initialize must fall through to the new-session path
    // (here unauthenticated → 401, proving the 404 guard stepped aside).
    const res = await mcpFetch({
      sessionId: 'pre-restart-session',
      body: [initializeBody],
    });

    expect(res.status).toBe(401);
  });

  it('full revival round-trip: stale tools/call → 404 → re-initialize → tool call works', async () => {
    const rawKey = await mintAppKey();

    // 1. Restarted server, client sends a tool call with its old session.
    const stale = await mcpFetch({
      sessionId: 'pre-restart-session',
      body: toolCallBody,
      authorization: `Bearer ${rawKey}`,
    });
    expect(stale.status).toBe(404);

    // 2. Spec-compliant client reacts to the 404 by re-initializing
    //    WITHOUT a session ID, and receives a fresh session ID.
    const init = await mcpFetch({ body: initializeBody, authorization: `Bearer ${rawKey}` });
    expect(init.status).toBe(200);
    const newSessionId = init.headers.get('mcp-session-id');
    expect(newSessionId).toBeTruthy();

    // 3. The next tool call on the NEW session succeeds — connection revived.
    const call = await mcpFetch({
      sessionId: newSessionId!,
      body: toolCallBody,
      authorization: `Bearer ${rawKey}`,
    });
    expect(call.status).toBe(200);
    const text = await call.text();
    expect(text).toContain('"result"');
    expect(text).not.toContain('"error"');
  });

  it('initialize presenting a STALE session ID still opens a session', async () => {
    // Some clients re-init while still sending their old session header;
    // the reuse path (sessionIdGenerator returns the presented ID) keeps
    // them working rather than 404-looping.
    const rawKey = await mintAppKey();
    const res = await mcpFetch({
      sessionId: 'pre-restart-session',
      body: initializeBody,
      authorization: `Bearer ${rawKey}`,
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('mcp-session-id')).toBe('pre-restart-session');
  });
});
