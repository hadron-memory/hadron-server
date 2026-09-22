/**
 * #1251 — an MCP transport outlives the AuthContext captured at initialize.
 *
 * This crosses the real HTTP + SDK boundary because a testable MCP server is
 * constructed directly from an AuthContext and therefore cannot prove that an
 * existing transport refreshes it before the next tool dispatch.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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

describe('#1251 — existing MCP sessions refresh platform roles', () => {
  it('revokes platform-wide search on the next request after ADMIN is removed', async () => {
    const suffix = generateId().slice(-8);
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

    const initialized = await mcpFetch(token, initializeBody);
    expect(initialized.status).toBe(200);
    const sessionId = initialized.headers.get('mcp-session-id');
    expect(sessionId).toBeTruthy();

    const before = await mcpFetch(token, searchBody, sessionId!);
    expect(before.status).toBe(200);
    expect(await before.text()).toContain('hrn:node:');

    // Keep the same signed token and the same open MCP transport. Only the
    // authoritative row changes; a cached-role implementation still passes.
    await db.user.update({ where: { id: user.id }, data: { roles: ['READER'] } });

    const after = await mcpFetch(token, searchBody, sessionId!);
    expect(after.status).toBe(200);
    const text = await after.text();
    expect(text).toContain('No nodes found');
    expect(text).not.toContain('hrn:node:');
  });
});
