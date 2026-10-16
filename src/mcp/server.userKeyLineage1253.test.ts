/** #1253 actual GraphQL HTTP + existing MCP transport acceptance, synthetic users only. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer as httpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createServer } from '../server.js';
import { signJwt } from '../auth/jwt.js';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import { mintUserApiKey } from '../middleware/auth.js';

let server: Server;
let url: string;
beforeAll(async () => {
  await cleanDb(db);
  server = httpServer(await createServer());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); });
async function gql(token: string, query: string, variables: Record<string, unknown> = {}) {
  const response = await fetch(`${url}/graphql`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ query, variables }),
  });
  return { status: response.status, body: await response.json() as any };
}
const mintQuery = `mutation($label: String) { createUserApiKey(label: $label) {
  rawKey userApiKey { id mintedByKeyId issuedVia oauthScopes }
} }`;
async function mint(token: string) {
  const result = await gql(token, mintQuery, { label: 'synthetic transport descendant' });
  expect(result.body.errors).toBeUndefined();
  return result.body.data.createUserApiKey as {
    rawKey: string; userApiKey: { id: string; mintedByKeyId: string | null; issuedVia: string; oauthScopes: string[] };
  };
}
async function mcp(token: string, sessionId?: string, initialize = false) {
  const response = await fetch(`${url}/mcp`, {
    method: 'POST',
    headers: {
      accept: 'application/json, text/event-stream', 'content-type': 'application/json',
      authorization: `Bearer ${token}`, ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
    },
    body: JSON.stringify(initialize ? {
      jsonrpc: '2.0', id: 1, method: 'initialize', params: {
        protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'lineage1253', version: '1' },
      },
    } : { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
  });
  await response.text();
  return { status: response.status, sessionId: response.headers.get('mcp-session-id') };
}

describe('#1253 HTTP credential lifecycle', () => {
  it('revokes GraphQL descendants and existing MCP sessions without touching unrelated roots', async () => {
    const userId = generateId();
    await db.user.create({ data: { id: userId, githubId: 1253051, githubUsername: 'transport1253' } });
    const jwt = await signJwt({ sub: userId, githubId: 1253051, githubUsername: 'transport1253', roles: ['READER'] });
    const parent = await mintUserApiKey(db, {
      userId, createdBy: userId, label: null, issuedVia: 'oauth:transport-client', oauthScopes: ['account'],
    });
    const independent = await mint(jwt);
    expect(independent.userApiKey.mintedByKeyId).toBeNull();
    const first = await mint(parent.rawKey);
    const second = await mint(first.rawKey);
    expect(first.userApiKey.mintedByKeyId).toBe(parent.userApiKey.id);
    expect(second.userApiKey.mintedByKeyId).toBe(first.userApiKey.id);
    expect(first.userApiKey.issuedVia).toBe('oauth:transport-client');
    expect(first.userApiKey.oauthScopes).toEqual([]);

    const sessions = [];
    for (const key of [parent, first, second, independent]) {
      const opened = await mcp(key.rawKey, undefined, true);
      expect(opened.status).toBe(200);
      expect(opened.sessionId).toBeTruthy();
      sessions.push({ key, id: opened.sessionId! });
      expect((await mcp(key.rawKey, opened.sessionId!)).status).toBe(200);
    }
    const revoked = await gql(jwt, `mutation($id: ID!) { revokeUserApiKey(id: $id) { id revokedAt } }`, {
      id: parent.userApiKey.id,
    });
    expect(revoked.body.errors).toBeUndefined();
    expect(revoked.body.data.revokeUserApiKey.revokedAt).toBeTruthy();
    for (const { key, id } of sessions.slice(0, 3)) {
      const read = await gql(key.rawKey, '{ authContext { apiKey { id } } }');
      expect(read.body.data?.authContext ?? null).toBeNull();
      expect((await mcp(key.rawKey, id)).status).toBe(401);
      const retryMint = await gql(key.rawKey, mintQuery);
      expect(retryMint.body.errors?.length).toBeGreaterThan(0);
      expect(JSON.stringify(read.body)).not.toContain(key.rawKey);
      expect(JSON.stringify(retryMint.body)).not.toContain(key.rawKey);
    }
    expect((await gql(independent.rawKey, '{ authContext { apiKey { id } } }')).body.data.authContext.apiKey.id)
      .toBe(independent.userApiKey.id);
    expect((await mcp(independent.rawKey, sessions[3].id)).status).toBe(200);
    // No wire input exists for selecting a parent; GraphQL rejects forgery.
    const forged = await gql(independent.rawKey,
      `mutation { createUserApiKey(mintedByKeyId: "foreign") { userApiKey { id } } }`);
    expect(forged.body.errors?.length).toBeGreaterThan(0);
    expect(await db.userApiKey.count()).toBe(4);
    for (const { id } of sessions) {
      const response = await fetch(`${url}/mcp`, { method: 'DELETE', headers: {
        accept: 'application/json, text/event-stream', authorization: `Bearer ${jwt}`, 'mcp-session-id': id,
      } });
      await response.text();
      expect(response.status).toBe(200);
    }
  }, 20000);
});
