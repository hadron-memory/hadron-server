/**
 * #1261 — immutable OAuth grants are enforced at the HTTP surface boundary.
 * `mcp` is accepted only by /mcp; `account` and empty legacy/portal grants are
 * accepted anywhere a user key is accepted. Unknown non-empty grants fail
 * closed on both surfaces.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createServer } from '../../server.js';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../helpers.js';
import { generateId } from '../../lib/id.js';
import {
  hashUserApiKey,
  USER_API_KEY_PREFIX,
} from '../../middleware/auth.js';

let server: Server;
let baseUrl: string;
let userId: string;

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
  const user = await db.user.create({
    data: {
      id: generateId(),
      handle: `scope-${generateId().slice(-8)}`,
      githubUsername: `scope-${generateId().slice(-8)}`,
      roles: ['READER'],
    },
  });
  userId = user.id;
});

async function issueKey(oauthScopes: string[], fill: string): Promise<string> {
  const rawKey = `${USER_API_KEY_PREFIX}${fill.repeat(64)}`;
  await db.userApiKey.create({
    data: {
      userId,
      keyHash: hashUserApiKey(rawKey),
      keyPreview: rawKey.slice(-4),
      label: `${oauthScopes.join('+') || 'unscoped'} test`,
      createdBy: userId,
      issuedVia: oauthScopes.length > 0 ? 'oauth:test-client' : 'portal',
      oauthScopes,
    },
  });
  return rawKey;
}

function schemaRequest(token: string): Promise<Response> {
  return fetch(`${baseUrl}/graphql/schema`, {
    headers: { authorization: `Bearer ${token}` },
  });
}

function graphqlRequest(token: string): Promise<Response> {
  return fetch(`${baseUrl}/graphql`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ query: 'query { authContext { principalType } }' }),
  });
}

function initializeMcp(token: string): Promise<Response> {
  return fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'oauth-scope-test', version: '1.0.0' },
      },
    }),
  });
}

describe('#1261 OAuth scope boundary', () => {
  it('refuses an mcp-only key at GraphQL schema and query boundaries', async () => {
    const token = await issueKey(['mcp'], 'a');
    const schema = await schemaRequest(token);
    expect(schema.status).toBe(403);

    const graphql = await graphqlRequest(token);
    const body = (await graphql.json()) as {
      errors?: Array<{ extensions?: { code?: string } }>;
    };
    expect(body.errors?.[0]?.extensions?.code).toBe('FORBIDDEN');
  });

  it('accepts mcp-only and account keys at the MCP boundary', async () => {
    const mcpToken = await issueKey(['mcp'], 'b');
    const accountToken = await issueKey(['account'], 'c');
    expect((await initializeMcp(mcpToken)).status).toBe(200);
    expect((await initializeMcp(accountToken)).status).toBe(200);
  });

  it('accepts account and unscoped legacy/portal keys on account surfaces', async () => {
    const accountToken = await issueKey(['account'], 'd');
    const unscopedToken = await issueKey([], 'e');
    expect((await schemaRequest(accountToken)).status).toBe(200);
    expect((await schemaRequest(unscopedToken)).status).toBe(200);
    expect((await graphqlRequest(accountToken)).status).toBe(200);
    expect((await graphqlRequest(unscopedToken)).status).toBe(200);
  });

  it('fails closed for an unknown non-empty stored OAuth grant', async () => {
    const token = await issueKey(['future-scope'], 'f');
    expect((await schemaRequest(token)).status).toBe(403);
    const mcp = await initializeMcp(token);
    expect(mcp.status).toBe(403);
    expect(mcp.headers.get('www-authenticate')).toBe(
      'Bearer error="insufficient_scope", scope="mcp"',
    );
  });

  it('fails closed when an unknown stored value accompanies a known scope', async () => {
    const token = await issueKey(['mcp', 'future-scope'], '1');
    expect((await schemaRequest(token)).status).toBe(403);
    expect((await initializeMcp(token)).status).toBe(403);
  });
});
