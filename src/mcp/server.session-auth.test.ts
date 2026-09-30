/** #1276 MCP session credential controls: synthetic principals, localhost HTTP only. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createServer as createHttpServer, type Server } from 'node:http';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { createServer } from '../server.js';
import { signJwt } from '../auth/jwt.js';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import { hashUserApiKey, USER_API_KEY_PREFIX } from '../middleware/auth.js';

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  server = createHttpServer(await createServer());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); });
beforeEach(async () => { await cleanDb(db); });

const initialize = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: '1276-audit', version: '1' } } };
const listTools = { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} };
async function userToken(githubId: number, expiry?: string): Promise<string> {
  const id = generateId();
  await db.user.create({ data: { id, githubId, githubUsername: `audit-${githubId}`, roles: ['READER'] } });
  return signJwt({ sub: id, githubId, githubUsername: `audit-${githubId}`, roles: ['READER'] }, expiry ? { expiresIn: expiry } : undefined);
}
async function request(method: 'POST' | 'DELETE', sessionId?: string, token?: string, body?: unknown): Promise<Response> {
  return fetch(`${baseUrl}/mcp`, {
    method,
    headers: {
      accept: 'application/json, text/event-stream',
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}
async function session(token: string): Promise<string> {
  const r = await request('POST', undefined, token, initialize);
  expect(r.status).toBe(200);
  return r.headers.get('mcp-session-id')!;
}

describe('#1276 MCP post-init authentication and session ownership', () => {
  it('a known session refuses POST with no credential', async () => {
    const token = await userToken(127601);
    const id = await session(token);
    const r = await request('POST', id, undefined, listTools);
    expect(r.status).toBe(401);
  });

  it('a known session refuses another valid principal and an invalid token', async () => {
    const token = await userToken(127602);
    const other = await userToken(127603);
    const id = await session(token);
    const foreign = await request('POST', id, other, listTools);
    expect(foreign.status).toBe(404);
    const invalid = await request('POST', id, 'invalid-token', listTools);
    expect(invalid.status).toBe(401);
  });

  it('a known session refuses POST with an expired JWT', async () => {
    const token = await userToken(127604);
    const expired = await userToken(127605, '-1s');
    const id = await session(token);
    const r = await request('POST', id, expired, listTools);
    expect(r.status).toBe(401);
  });

  it('a revoked session credential cannot execute POST', async () => {
    const userId = generateId();
    await db.user.create({ data: { id: userId, githubId: 127607, githubUsername: 'audit-revoked', roles: ['READER'] } });
    const raw = USER_API_KEY_PREFIX + randomBytes(32).toString('hex');
    const key = await db.userApiKey.create({ data: { userId, keyHash: hashUserApiKey(raw), keyPreview: raw.slice(-4), createdBy: userId, issuedVia: 'portal', oauthScopes: ['mcp'] } });
    const id = await session(raw);
    await db.userApiKey.update({ where: { id: key.id }, data: { revokedAt: new Date() } });
    const r = await request('POST', id, raw, listTools);
    expect(r.status).toBe(401);
    expect((await request('DELETE', id, raw)).status).toBe(401);
    // A different live credential for the same principal can still use and close it.
    const replacement = await signJwt({ sub: userId, githubId: 127607, githubUsername: 'audit-revoked', roles: ['READER'] });
    expect((await request('POST', id, replacement, listTools)).status).toBe(200);
    expect((await request('DELETE', id, replacement)).status).toBe(200);
  });

  it('a known session refuses GET SSE with no credential', async () => {
    const token = await userToken(127608);
    const id = await session(token);
    const abort = new AbortController();
    try {
      const r = await fetch(`${baseUrl}/mcp`, { method: 'GET', headers: { accept: 'text/event-stream', 'mcp-session-id': id }, signal: abort.signal });
      expect(r.status).toBe(401);
    } finally { abort.abort(); }
  });

  it('a known session refuses GET SSE from another principal', async () => {
    const token = await userToken(127611);
    const foreignToken = await userToken(127612);
    const id = await session(token);
    const denied = await fetch(`${baseUrl}/mcp`, { method: 'GET', headers: { accept: 'text/event-stream', 'mcp-session-id': id, authorization: `Bearer ${foreignToken}` } });
    expect(denied.status).toBe(404);
    expect((await request('POST', id, token, listTools)).status).toBe(200);
    expect((await request('DELETE', id, token)).status).toBe(200);
  });

  it('DELETE cannot close another principal’s session', async () => {
    const token = await userToken(127609);
    const foreignToken = await userToken(127610);
    const id = await session(token);
    const denied = await request('DELETE', id, foreignToken);
    expect(denied.status).toBe(404);
    expect((await request('POST', id, token, listTools)).status).toBe(200);
    expect((await request('DELETE', id, token)).status).toBe(200);
  });

  it('DELETE cannot close another caller session without a credential', async () => {
    const token = await userToken(127606);
    const id = await session(token);
    const denied = await request('DELETE', id);
    expect(denied.status).toBe(401);
    const stillLive = await request('POST', id, token, listTools);
    expect(stillLive.status).toBe(200);
    const closed = await request('DELETE', id, token);
    expect(closed.status).toBe(200);
  });
});
