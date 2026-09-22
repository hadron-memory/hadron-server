/**
 * #1251 — an MCP transport outlives the AuthContext captured at initialize.
 *
 * This crosses the real HTTP + SDK boundary because a testable MCP server is
 * constructed directly from an AuthContext and therefore cannot prove that an
 * existing transport refreshes it before the next tool dispatch.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createServer } from '../server.js';
import { signJwt } from '../auth/jwt.js';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from '../lib/id.js';

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = await createServer();
  server = createHttpServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
});

beforeEach(async () => {
  await cleanDb(db);
});

afterEach(() => {
  vi.restoreAllMocks();
});

const initializeBody = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'role-refresh-test', version: '1.0.0' },
  },
};

const searchBody = {
  jsonrpc: '2.0',
  id: 2,
  method: 'tools/call',
  params: {
    name: 'hadron_find_nodes',
    arguments: {
      query: 'RoleRefreshSecret',
      allMemories: true,
    },
  },
};

function listToolsBody(id: number) {
  return {
    jsonrpc: '2.0',
    id,
    method: 'tools/list',
    params: {},
  };
}

function mcpFetch(token: string, body: unknown, sessionId?: string): Promise<Response> {
  const headers: Record<string, string> = {
    accept: 'application/json, text/event-stream',
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
  };
  if (sessionId) headers['mcp-session-id'] = sessionId;
  return fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

async function createUserAndToken() {
  const suffix = generateId().slice(-8);
  const user = await db.user.create({
    data: {
      id: generateId(),
      githubId: 12_510,
      githubUsername: `role-refresh-${suffix}`,
      roles: ['ADMIN'],
    },
  });
  const token = await signJwt({
    sub: user.id,
    githubId: user.githubId!,
    githubUsername: user.githubUsername!,
    roles: ['ADMIN'],
  });
  return { suffix, token, user };
}

async function initializeSession(token: string): Promise<string> {
  const initialized = await mcpFetch(token, initializeBody);
  expect(initialized.status).toBe(200);
  const sessionId = initialized.headers.get('mcp-session-id');
  expect(sessionId).toBeTruthy();
  return sessionId!;
}

describe('#1251 — existing MCP sessions refresh platform roles', () => {
  it('revokes platform-wide search on the next request after ADMIN is removed', async () => {
    const { suffix, token, user } = await createUserAndToken();
    const org = await db.organization.create({
      data: { id: generateId(), name: 'foreign org', urn: `foreign-${suffix}.com` },
    });
    const memory = await db.memory.create({
      data: {
        id: generateId(),
        organizationId: org.id,
        urn: `${org.urn}:role-refresh-secret`,
        name: 'RoleRefreshSecret',
        class: 'knowledge',
      },
    });
    await db.node.create({
      data: {
        id: generateId(),
        memoryId: memory.id,
        loc: 'role-refresh-secret',
        name: 'RoleRefreshSecret',
        content: 'Only a current platform administrator may find this globally.',
      },
    });
    const sessionId = await initializeSession(token);

    const before = await mcpFetch(token, searchBody, sessionId);
    expect(before.status).toBe(200);
    expect(await before.text()).toContain('hrn:node:');

    // Keep the same signed token and the same open MCP transport. Only the
    // authoritative row changes; a cached-role implementation still passes.
    await db.user.update({ where: { id: user.id }, data: { roles: ['READER'] } });

    const after = await mcpFetch(token, searchBody, sessionId);
    expect(after.status).toBe(200);
    const text = await after.text();
    expect(text).toContain('No nodes found');
    expect(text).not.toContain('hrn:node:');
  });

  it('invalidates an existing transport when the authenticated user is deleted', async () => {
    const { token, user } = await createUserAndToken();
    const sessionId = await initializeSession(token);

    await db.user.update({
      where: { id: user.id },
      data: { deletedAt: new Date() },
    });

    const deleted = await mcpFetch(token, listToolsBody(10), sessionId);
    expect(deleted.status).toBe(401);
    expect(await deleted.json()).toEqual({ error: 'Authentication required' });

    // The first rejection closes and unregisters the transport. A queued or
    // subsequent request cannot reuse the captured identity.
    const stale = await mcpFetch(token, listToolsBody(11), sessionId);
    expect(stale.status).toBe(404);
    expect(await stale.json()).toMatchObject({
      error: { code: -32001, message: 'Session not found' },
    });
  });

  it('returns 503 without dispatch when the live-role lookup fails', async () => {
    const { token } = await createUserAndToken();
    const sessionId = await initializeSession(token);
    const findFirst = vi
      .spyOn(db.user, 'findFirst')
      .mockRejectedValueOnce(new Error('role lookup unavailable'));

    const unavailable = await mcpFetch(token, listToolsBody(20), sessionId);
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toEqual({
      error: 'Authentication temporarily unavailable',
    });

    // A transient lookup failure fails only that request; the still-live
    // session can recover once current authorization is readable again.
    findFirst.mockRestore();
    const recovered = await mcpFetch(token, listToolsBody(21), sessionId);
    expect(recovered.status).toBe(200);
  });

  it('serializes role refresh and dispatch for concurrent requests on one session', async () => {
    const { token } = await createUserAndToken();
    const sessionId = await initializeSession(token);
    let markFirstLookupStarted!: () => void;
    const firstLookupStarted = new Promise<void>((resolve) => {
      markFirstLookupStarted = resolve;
    });
    let releaseFirstLookup!: () => void;
    const firstLookupGate = new Promise<void>((resolve) => {
      releaseFirstLookup = resolve;
    });
    const findFirst = vi.spyOn(db.user, 'findFirst').mockImplementationOnce((async () => {
      markFirstLookupStarted();
      await firstLookupGate;
      return { roles: ['ADMIN'] };
    }) as never);

    const first = mcpFetch(token, listToolsBody(30), sessionId);
    await firstLookupStarted;
    const second = mcpFetch(token, listToolsBody(31), sessionId);

    // Give the second HTTP request time to reach Express while the first role
    // lookup is deliberately blocked. An unguarded implementation performs a
    // second lookup now; the per-session critical section keeps it queued.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const callsWhileFirstBlocked = findFirst.mock.calls.length;
    releaseFirstLookup();

    const [firstResponse, secondResponse] = await Promise.all([first, second]);
    expect(callsWhileFirstBlocked).toBe(1);
    expect(firstResponse.status).toBe(200);
    expect(secondResponse.status).toBe(200);
    expect(findFirst).toHaveBeenCalledTimes(2);
  });
});
