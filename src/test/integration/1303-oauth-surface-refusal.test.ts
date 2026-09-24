/**
 * #1303 — a credential refused a surface says WHY, as data, on the wire.
 *
 * The CLI (hadron-cli#681 / cli#683) has to tell "this key cannot reach this
 * surface" from an ordinary permission denial, and until now could only match
 * prose. These are the wire fixtures: real `createServer`, real HTTP, a real
 * `UserApiKey` per scope. No key material is asserted or printed.
 *
 * What is deliberately NOT changed, and pinned so a change is a visible act:
 * the prose, `code: FORBIDDEN`, and the HTTP 500 that Apollo gives any error
 * thrown from its context function (a separate decision, team chat #1292).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createServer } from '../../server.js';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../helpers.js';
import { generateId } from '../../lib/id.js';
import { mintUserApiKey, type OAuthScope } from '../../middleware/auth.js';
import { resolvers, type Context } from '../../api/graphql/schema/resolvers.js';

let server: Server;
let baseUrl: string;
let userId: string;
const keys: Record<string, string> = {};

const PROSE = 'This OAuth credential is limited to the MCP surface.';

async function gql(key: string, query: string) {
  const res = await fetch(`${baseUrl}/graphql`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ query }),
  });
  return { status: res.status, body: (await res.json()) as { data?: unknown; errors?: { message: string; extensions?: Record<string, unknown> }[] } };
}

beforeAll(async () => {
  await cleanDb(db);
  userId = (await db.user.create({ data: { id: generateId(), handle: 'oa-user', githubUsername: 'oa-user' } })).id;
  const scopes: Record<string, string[]> = { mcp: ['mcp'], account: ['account'], unscoped: [], unsupported: ['mcp', 'telepathy'] };
  for (const [name, oauthScopes] of Object.entries(scopes)) {
    // `telepathy` is not an OAuthScope: the cast is how a stored unknown scope
    // (a future or foreign grant) reaches the server.
    keys[name] = (await mintUserApiKey(db, { userId, label: name, createdBy: userId, issuedVia: 'test', oauthScopes: oauthScopes as OAuthScope[] })).rawKey;
  }
  const app = await createServer();
  server = createHttpServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

describe('#1303 — POST /graphql', () => {
  it('an mcp-only key: FORBIDDEN as before, plus a matchable reason and the scopes', async () => {
    const r = await gql(keys.mcp!, '{ me { id } }');
    // Unchanged on purpose (see header): Apollo's context-failure status.
    expect(r.status).toBe(500);
    expect(r.body.errors).toHaveLength(1);
    const e = r.body.errors![0]!;
    expect(e.message).toContain(PROSE);
    expect(e.extensions).toEqual({
      code: 'FORBIDDEN',
      reason: 'OAUTH_SCOPE_INSUFFICIENT',
      requiredScope: 'account',
      grantedScopes: ['mcp'],
    });
  });

  it('a key carrying an unsupported scope: a DIFFERENT reason, naming the scope', async () => {
    const e = (await gql(keys.unsupported!, '{ me { id } }')).body.errors![0]!;
    expect(e.extensions).toEqual({
      code: 'FORBIDDEN',
      reason: 'OAUTH_SCOPE_UNSUPPORTED',
      requiredScope: 'account',
      grantedScopes: ['mcp', 'telepathy'],
      unsupportedScopes: ['telepathy'],
    });
  });

  it('account and unscoped keys are still accepted', async () => {
    for (const k of ['account', 'unscoped']) {
      const r = await gql(keys[k]!, '{ me { id } }');
      expect(r.status, k).toBe(200);
      expect(r.body.errors, k).toBeUndefined();
    }
  });

  it('CONTROL: an ordinary denial carries no OAuth reason, so the two are distinguishable', async () => {
    const e = (await gql(keys.account!, '{ organization(ref: "someone-elses.example") { id } }')).body.errors![0]!;
    expect(e.extensions?.code).not.toBe('FORBIDDEN');
    expect(e.extensions).not.toHaveProperty('reason');
  });
});

describe('#1303 — the REST surfaces answer 403 with the same fields', () => {
  it('GET /graphql/schema', async () => {
    const res = await fetch(`${baseUrl}/graphql/schema`, { headers: { Authorization: `Bearer ${keys.mcp}` } });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: PROSE,
      code: 'FORBIDDEN',
      reason: 'OAUTH_SCOPE_INSUFFICIENT',
      requiredScope: 'account',
      grantedScopes: ['mcp'],
    });
  });

  it('POST /reload', async () => {
    const res = await fetch(`${baseUrl}/reload`, { method: 'POST', headers: { Authorization: `Bearer ${keys.mcp}` } });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'FORBIDDEN', reason: 'OAUTH_SCOPE_INSUFFICIENT' });
  });
});

describe('#1303 — createUserApiKey (defence in depth behind the context gate)', () => {
  it('refuses an mcp-scoped caller with the same reason fields', async () => {
    const ctx = { db, userId, roles: ['READER'], oauthScopes: ['mcp'] } as unknown as Context;
    const M = resolvers.Mutation as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
    await expect(M.createUserApiKey({}, { label: 'x' }, ctx)).rejects.toMatchObject({
      message: 'This OAuth credential is limited to the MCP surface and cannot create API keys.',
      extensions: { code: 'FORBIDDEN', reason: 'OAUTH_SCOPE_INSUFFICIENT', requiredScope: 'account', grantedScopes: ['mcp'] },
    });
  });
});
