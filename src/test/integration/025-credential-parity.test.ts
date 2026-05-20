/**
 * Spec 025-oauth-for-mcp Phase 2F — cross-format credential parity
 * (T047 per tasks.md, US4 / FR-015 / SC-001).
 *
 * The structural guarantee behind FR-015 is that an OAuth-issued
 * token and a portal-minted key are byte-identical at the
 * credential layer:
 *
 *   - Same prefix (`hdr_user_`) + same entropy (256 bits) + same
 *     hashing primitive (SHA-256) — pinned by `mintUserApiKey`
 *     being the single insert path (Phase 2D PR #158).
 *   - Same persisted-row shape, differing ONLY in the
 *     discriminator fields `issuedVia` (`portal` vs
 *     `oauth:<clientId>`) and `label`.
 *   - Same `resolveAuthContext` resolution path: both produce the
 *     same `{ userId, clientId, roles }` context for the same User.
 *   - Same revocation semantics: after `revokedAt` is set, both
 *     produce the identical 401 + WWW-Authenticate from
 *     `handleMcpRequest`, with no shape that distinguishes
 *     "revoked-OAuth-token" from "revoked-portal-token".
 *
 * The deeper coverage already lives in:
 *   - src/middleware/auth.test.ts (resolveUserApiKey unit tests)
 *   - src/mcp/server.401.test.ts (401 + WWW-Authenticate shape for
 *     unknown / revoked tokens)
 *   - src/test/integration/025-oauth-token.test.ts (cross-format
 *     parity unit-level check inside the token-redemption suite)
 *
 * This file is the **aggregated cross-surface parity check** — one
 * test mints BOTH credential formats for the SAME user and asserts
 * they're indistinguishable at every observable layer. If a future
 * change diverges the two paths, this file fails fast and points
 * directly at the divergence.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type { Request, Response } from 'express';
import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from '../../server.js';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../helpers.js';
import { generateId } from '../../lib/id.js';
import { signJwt } from '../../auth/jwt.js';
import { resolvers, type Context } from '../../api/graphql/schema/resolvers.js';
import {
  resolveAuthContext,
  USER_API_KEY_PREFIX,
} from '../../middleware/auth.js';
import { handleMcpRequest } from '../../mcp/server.js';

// ── Test fixtures + helpers ──────────────────────────────────────────

let server: Server;
let baseUrl: string;

const REGISTERED_REDIRECT = 'https://client.example.com/callback';
const RESOURCE_URL = 'https://hadron.example/mcp';
const TEST_CLIENT_ID = `dcr_${'a'.repeat(32)}`;

let testUser: { id: string };
let testJwt: string;

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
  testUser = await db.user.create({
    data: {
      id: generateId(),
      handle: 'alice',
      githubUsername: 'alice',
      roles: ['CONTRIBUTOR'],
    },
  });
  await db.oAuthClient.create({
    data: {
      clientId: TEST_CLIENT_ID,
      clientName: 'Parity Test Client',
      redirectUris: [REGISTERED_REDIRECT],
    },
  });
  testJwt = await signJwt({ sub: testUser.id, roles: ['CONTRIBUTOR'] });
});

/**
 * Mint a UserApiKey via the GraphQL `createUserApiKey` resolver
 * (the portal path). Returns the raw token.
 */
async function mintViaPortal(label: string): Promise<string> {
  const ctx: Context = {
    db,
    userId: testUser.id,
    roles: ['CONTRIBUTOR'],
  } as Context;
  const result = (await resolvers.Mutation.createUserApiKey(
    undefined,
    { label },
    ctx,
  )) as { rawKey: string };
  return result.rawKey;
}

/**
 * Mint a UserApiKey via the FULL OAuth dance — GET /authorize
 * (consent render + CSRF token issuance) → POST /authorize
 * (approve + AuthCode mint) → POST /token (PKCE verify +
 * mint hdr_user_<…>). Returns the raw token.
 *
 * This is THE point of the parity test: prove that a token issued
 * via the user-facing OAuth flow is byte-identical at the
 * credential layer to one minted directly via the resolver.
 */
async function mintViaOAuth(): Promise<string> {
  // PKCE: 32 bytes → 43-char base64url verifier, SHA-256 → challenge.
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const state = 'parity-state';

  // 1. GET /oauth/authorize — render consent + issue CSRF.
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: TEST_CLIENT_ID,
    redirect_uri: REGISTERED_REDIRECT,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    resource: RESOURCE_URL,
    state,
  });
  const getRes = await fetch(`${baseUrl}/oauth/authorize?${query.toString()}`, {
    redirect: 'manual',
    headers: { cookie: `hadron_token=${testJwt}` },
  });
  expect(getRes.status, 'consent GET').toBe(200);
  const html = await getRes.text();
  const csrfTokenMatch = html.match(/name="_csrf"\s+value="([^"]+)"/);
  expect(csrfTokenMatch).not.toBeNull();
  const csrfToken = csrfTokenMatch![1];
  const setCookie = getRes.headers.get('set-cookie');
  expect(setCookie).not.toBeNull();
  const csrfCookieMatch = setCookie!.match(/_hadron_csrf=([^;]+)/);
  expect(csrfCookieMatch).not.toBeNull();
  const csrfCookieValue = csrfCookieMatch![1];

  // 2. POST /oauth/authorize — approve.
  const approveBody = new URLSearchParams({
    _csrf: csrfToken,
    decision: 'approve',
    client_id: TEST_CLIENT_ID,
    redirect_uri: REGISTERED_REDIRECT,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    resource: RESOURCE_URL,
    scope: 'mcp',
    state,
  });
  const postRes = await fetch(`${baseUrl}/oauth/authorize`, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      cookie: `hadron_token=${testJwt}; _hadron_csrf=${csrfCookieValue}`,
    },
    body: approveBody.toString(),
  });
  expect(postRes.status, 'consent POST').toBe(302);
  const location = postRes.headers.get('location');
  expect(location).not.toBeNull();
  const redirectUrl = new URL(location!);
  const rawAuthCode = redirectUrl.searchParams.get('code');
  expect(rawAuthCode).not.toBeNull();

  // 3. POST /oauth/token — redeem.
  const tokenBody = new URLSearchParams({
    grant_type: 'authorization_code',
    code: rawAuthCode!,
    client_id: TEST_CLIENT_ID,
    redirect_uri: REGISTERED_REDIRECT,
    code_verifier: verifier,
    resource: RESOURCE_URL,
  });
  const tokenRes = await fetch(`${baseUrl}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: tokenBody.toString(),
  });
  expect(tokenRes.status, 'token redemption').toBe(200);
  const tokenJson = (await tokenRes.json()) as { access_token: string };
  return tokenJson.access_token;
}

/**
 * Build a minimal Express Request + Response stub the way
 * src/mcp/server.401.test.ts does. The Request carries a Bearer
 * token; the Response captures status + headers + body for
 * assertion.
 */
function makeMcpReq(authorization: string): Request {
  return {
    method: 'POST',
    headers: { authorization },
    protocol: 'http',
    body: { jsonrpc: '2.0', method: 'initialize', id: 1 },
    get: (name: string) => {
      if (name.toLowerCase() === 'host') return 'localhost:4000';
      return undefined;
    },
  } as unknown as Request;
}

function makeMcpRes(): Response & {
  _status: number;
  _headers: Record<string, string>;
  _body: unknown;
} {
  const headers: Record<string, string> = {};
  let status = 200;
  let body: unknown;
  const res = {
    setHeader: vi.fn((name: string, value: string) => {
      headers[name] = value;
      return res;
    }),
    status: vi.fn((code: number) => {
      status = code;
      return res;
    }),
    json: vi.fn((payload: unknown) => {
      body = payload;
      return res;
    }),
    get _status() {
      return status;
    },
    get _headers() {
      return headers;
    },
    get _body() {
      return body;
    },
  };
  return res as unknown as Response & {
    _status: number;
    _headers: Record<string, string>;
    _body: unknown;
  };
}

// ── Parity assertions ────────────────────────────────────────────────

describe('025-credential-parity: portal-minted vs OAuth-minted tokens', () => {
  it('both raw tokens match the hdr_user_<64 hex> format', async () => {
    const portalKey = await mintViaPortal('portal-key');
    const oauthKey = await mintViaOAuth();
    const format = new RegExp(`^${USER_API_KEY_PREFIX}[0-9a-f]{64}$`);
    expect(portalKey, 'portal').toMatch(format);
    expect(oauthKey, 'oauth').toMatch(format);
    // Distinct entropy — they're independent random draws.
    expect(portalKey).not.toBe(oauthKey);
  });

  it('persisted UserApiKey rows are identical at the credential layer (modulo discriminators)', async () => {
    const portalKey = await mintViaPortal('portal-key');
    const oauthKey = await mintViaOAuth();

    const rows = await db.userApiKey.findMany({
      where: { userId: testUser.id },
      orderBy: { createdAt: 'asc' },
    });
    expect(rows).toHaveLength(2);
    const portalRow = rows.find((r) => r.issuedVia === 'portal');
    const oauthRow = rows.find((r) => r.issuedVia === `oauth:${TEST_CLIENT_ID}`);
    expect(portalRow, 'portal row').toBeDefined();
    expect(oauthRow, 'oauth row').toBeDefined();

    // SAME shape at every credential field.
    expect(portalRow!.userId).toBe(oauthRow!.userId);
    expect(portalRow!.createdBy).toBe(oauthRow!.createdBy); // both = testUser.id
    expect(portalRow!.revokedAt).toBeNull();
    expect(oauthRow!.revokedAt).toBeNull();
    // SAME hashing primitive — verified by computing each from the
    // raw token.
    expect(portalRow!.keyHash).toBe(
      createHash('sha256').update(portalKey).digest('hex'),
    );
    expect(oauthRow!.keyHash).toBe(
      createHash('sha256').update(oauthKey).digest('hex'),
    );
    // SAME preview shape — last 4 chars of the raw token.
    expect(portalRow!.keyPreview).toBe(portalKey.slice(-4));
    expect(oauthRow!.keyPreview).toBe(oauthKey.slice(-4));

    // ONLY discriminator fields differ. (Pinning this list of
    // expected differences makes any future schema drift loud:
    // if a new column gets divergent values from the two paths, a
    // test here can be added to that column explicitly.)
    expect(portalRow!.issuedVia).toBe('portal');
    expect(oauthRow!.issuedVia).toBe(`oauth:${TEST_CLIENT_ID}`);
    // Labels are caller-set, so they always differ in practice.
    expect(portalRow!.label).toBe('portal-key');
    expect(oauthRow!.label).toBe('OAuth: Parity Test Client');
  });

  it('resolveAuthContext returns identical { userId, clientId, roles } for both tokens', async () => {
    const portalKey = await mintViaPortal('portal-key');
    const oauthKey = await mintViaOAuth();

    const portalCtx = await resolveAuthContext(
      makeMcpReq(`Bearer ${portalKey}`),
      db,
    );
    const oauthCtx = await resolveAuthContext(
      makeMcpReq(`Bearer ${oauthKey}`),
      db,
    );

    expect(portalCtx.userId).toBe(testUser.id);
    expect(oauthCtx.userId).toBe(testUser.id);
    expect(portalCtx.clientId).toBe(oauthCtx.clientId);
    expect(portalCtx.clientId).toBe('github:alice'); // synthesized from User.githubUsername
    expect(portalCtx.roles).toEqual(oauthCtx.roles);
    expect(portalCtx.roles).toEqual(['CONTRIBUTOR']);
    // Neither path sets appId at the middleware layer — App
    // resolution happens at the MCP boundary per FR-020.
    expect(portalCtx.appId).toBeUndefined();
    expect(oauthCtx.appId).toBeUndefined();
  });

  it('after revocation, both tokens produce identical 401 + WWW-Authenticate from /mcp', async () => {
    // The revocation parity test. Per spec Edge Cases, the 401
    // shape for a revoked credential MUST be byte-identical to the
    // shape for an unknown / never-issued credential — no field
    // value can distinguish the two. This test pins that contract
    // ACROSS both credential formats: a revoked OAuth token and a
    // revoked portal key must produce indistinguishable 401s.
    const portalKey = await mintViaPortal('portal-key');
    const oauthKey = await mintViaOAuth();

    // Revoke each. We use direct DB updates so the assertion
    // depends only on the persisted state, not on the resolver
    // call path (which has its own tests).
    // UserApiKey has no `updatedBy` column (credentials model, not
    // an audited resource). Revocation just sets `revokedAt`.
    await db.userApiKey.updateMany({
      where: { userId: testUser.id },
      data: { revokedAt: new Date() },
    });

    const portalRes = makeMcpRes();
    await handleMcpRequest(makeMcpReq(`Bearer ${portalKey}`), portalRes);

    const oauthRes = makeMcpRes();
    await handleMcpRequest(makeMcpReq(`Bearer ${oauthKey}`), oauthRes);

    // Status, headers, body all identical byte-for-byte.
    expect(portalRes._status).toBe(401);
    expect(oauthRes._status).toBe(401);
    expect(portalRes._status).toBe(oauthRes._status);
    expect(portalRes._headers['WWW-Authenticate']).toBe(
      oauthRes._headers['WWW-Authenticate'],
    );
    expect(portalRes._headers['WWW-Authenticate']).toMatch(/Bearer realm="hadron"/);
    expect(portalRes._headers['WWW-Authenticate']).toMatch(/error="invalid_token"/);
    expect(portalRes._headers['WWW-Authenticate']).toMatch(
      /resource_metadata="http:\/\/localhost:4000\/\.well-known\/oauth-protected-resource"/,
    );
    expect(portalRes._body).toEqual(oauthRes._body);
    expect(portalRes._body).toEqual({ error: 'Authentication required' });
  });

  it('an OAuth-revoked token is indistinguishable from a never-existed token at /mcp', async () => {
    // Cross-check: not just "the two formats agree on the revoked
    // shape" but "the revoked shape matches the never-existed
    // shape." Same posture as the existing mcp/server.401.test.ts
    // tests; verified here from end-to-end (full OAuth dance →
    // revoke → 401) to close the loop.
    const oauthKey = await mintViaOAuth();
    // UserApiKey has no `updatedBy` column (credentials model, not
    // an audited resource). Revocation just sets `revokedAt`.
    await db.userApiKey.updateMany({
      where: { userId: testUser.id },
      data: { revokedAt: new Date() },
    });

    const revokedRes = makeMcpRes();
    await handleMcpRequest(makeMcpReq(`Bearer ${oauthKey}`), revokedRes);

    const fakeKey = `${USER_API_KEY_PREFIX}${'0'.repeat(64)}`;
    const unknownRes = makeMcpRes();
    await handleMcpRequest(makeMcpReq(`Bearer ${fakeKey}`), unknownRes);

    expect(revokedRes._status).toBe(unknownRes._status);
    expect(revokedRes._headers['WWW-Authenticate']).toBe(
      unknownRes._headers['WWW-Authenticate'],
    );
    expect(revokedRes._body).toEqual(unknownRes._body);
  });
});
