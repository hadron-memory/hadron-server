/**
 * Spec 030-oauth-portal-signin T002 + T008 + T009 — integration tests
 * for `GET /oauth/authorize` after the portal-redirect change.
 *
 * Replaces the pre-029/030 silent `302 → /auth/github?return_to=…`
 * bounce at the `!userId` branch with a `302 → ${FRONTEND_URL}/signin?redirect=…`
 * redirect. The portal owns the sign-in surface; the MCP server reads
 * the shared-domain `hadron_token` cookie post-sign-in.
 *
 * Coverage:
 *   - US1 (P1): portal-signed-in → `200` consent screen, NOT a redirect.
 *   - US1 (P1): invalid client_id (with no cookie) → `400 application/json`,
 *     NOT a redirect to portal (pre-redirect validation runs first per FR-008).
 *   - US1 (P1): expired hadron_token cookie → `302` to portal (same as no cookie).
 *   - US2 (P1): no cookie → `302 Location: ${FRONTEND_URL}/signin?redirect=…`,
 *     with the full original /authorize URL preserved in the `redirect` param.
 *   - US2 (P1): the redirect Location URL is absolute (cross-origin, includes
 *     `http://` or `https://`).
 *   - US3 (P3): `/auth/github/callback?state=unknown` → `400 text/html`
 *     "Sign-in session expired" page (FR-010 carryover from spec 029).
 *
 * Pattern mirrors `src/test/integration/025-oauth-authorize.test.ts` —
 * real `createServer()` on a random port, redirects disabled to inspect
 * status codes and Location headers.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createServer } from '../../server.js';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../helpers.js';
import { signJwt } from '../../auth/jwt.js';
import { generateId } from '../../lib/id.js';

let server: Server;
let baseUrl: string;

const REGISTERED_REDIRECT = 'https://client.example.com/callback';
const RESOURCE_URL = 'https://hadron.example/mcp';

let testClientId: string;
let testUser: { id: string };
let testJwt: string;
let testCookieHeader: string;

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

  testClientId = `dcr_${'a'.repeat(32)}`;
  await db.oAuthClient.create({
    data: {
      clientId: testClientId,
      clientName: 'Test MCP Client',
      redirectUris: [REGISTERED_REDIRECT],
    },
  });

  testJwt = await signJwt({ sub: testUser.id, roles: ['CONTRIBUTOR'] });
  testCookieHeader = `hadron_token=${testJwt}`;
});

function buildAuthorizeQuery(overrides: Record<string, string | undefined> = {}): string {
  const params = new URLSearchParams();
  const defaults: Record<string, string> = {
    response_type: 'code',
    client_id: testClientId,
    redirect_uri: REGISTERED_REDIRECT,
    code_challenge: 'a'.repeat(43),
    code_challenge_method: 'S256',
    resource: RESOURCE_URL,
    state: 'opaque-state-value',
    scope: 'mcp',
  };
  const merged = { ...defaults, ...overrides };
  for (const [k, v] of Object.entries(merged)) {
    if (v !== undefined) params.set(k, v);
  }
  return params.toString();
}

async function getAuthorize(
  query: string,
  opts: { cookie?: string | null } = {},
): Promise<Response> {
  const cookie = opts.cookie === undefined ? null : opts.cookie;
  return fetch(`${baseUrl}/oauth/authorize?${query}`, {
    redirect: 'manual',
    headers: cookie ? { cookie } : undefined,
  });
}

// ── US1: portal-signed-in path → consent screen, no redirect ─────────

describe('GET /oauth/authorize — portal-signed-in user (US1 / FR-001 / FR-009)', () => {
  it('valid hadron_token cookie → 200 consent screen, NOT a redirect', async () => {
    const res = await getAuthorize(buildAuthorizeQuery(), { cookie: testCookieHeader });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    expect(res.headers.get('location')).toBeNull();
    const html = await res.text();
    expect(html).toContain('Authorize Test MCP Client');
  });

  it('signed-in path issues a CSRF cookie via the consent flow (regression)', async () => {
    const res = await getAuthorize(buildAuthorizeQuery(), { cookie: testCookieHeader });
    expect(res.headers.get('set-cookie')).toMatch(/_hadron_csrf=/);
  });
});

// ── US1: pre-redirect validation must run first ──────────────────────

describe('GET /oauth/authorize — invalid client_id with no cookie (FR-008)', () => {
  it('unknown client_id + no cookie → 400 application/json, NOT a redirect to portal', async () => {
    const res = await getAuthorize(
      buildAuthorizeQuery({ client_id: 'dcr_does_not_exist' }),
      { cookie: null },
    );
    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    expect(res.headers.get('location')).toBeNull();
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('invalid_client');
  });

  it('missing redirect_uri + no cookie → 400 application/json, NOT a redirect to portal', async () => {
    const res = await getAuthorize(
      buildAuthorizeQuery({ redirect_uri: undefined }),
      { cookie: null },
    );
    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    expect(res.headers.get('location')).toBeNull();
  });
});

// ── US2: no cookie → 302 to portal /signin ───────────────────────────

describe('GET /oauth/authorize — no hadron_token cookie (US2 / FR-002 / FR-004)', () => {
  it('no cookie → 302 with Location pointing at portal /signin', async () => {
    const res = await getAuthorize(buildAuthorizeQuery(), { cookie: null });
    expect(res.status).toBe(302);

    const location = res.headers.get('location');
    expect(location).not.toBeNull();

    // Absolute URL (cross-origin to portal), starts with http:// or https://.
    expect(location).toMatch(/^https?:\/\//);

    // Path is /signin.
    const url = new URL(location!);
    expect(url.pathname).toBe('/signin');
  });

  it('the Location URL preserves the full original /authorize query string in the redirect param', async () => {
    const q = buildAuthorizeQuery();
    const res = await getAuthorize(q, { cookie: null });
    const location = res.headers.get('location')!;
    const url = new URL(location);

    const redirectParam = url.searchParams.get('redirect');
    expect(redirectParam).not.toBeNull();

    // Decoded redirect URL is the original /authorize URL with all query params.
    expect(redirectParam!.startsWith('/oauth/authorize?')).toBe(true);
    expect(redirectParam).toContain(`client_id=${testClientId}`);
    expect(redirectParam).toContain('state=opaque-state-value');
    expect(redirectParam).toContain('code_challenge=' + 'a'.repeat(43));
    expect(redirectParam).toContain('code_challenge_method=S256');
    expect(redirectParam).toContain('scope=mcp');
    expect(redirectParam).toContain(`resource=${encodeURIComponent(RESOURCE_URL)}`);
    expect(redirectParam).toContain(`redirect_uri=${encodeURIComponent(REGISTERED_REDIRECT)}`);
  });

  it('no cookie + redirect to portal → response has no Set-Cookie header', async () => {
    const res = await getAuthorize(buildAuthorizeQuery(), { cookie: null });
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('malformed hadron_token cookie → also 302 to portal /signin (Acceptance Scenario 2 for US2)', async () => {
    const res = await getAuthorize(buildAuthorizeQuery(), {
      cookie: 'hadron_token=not.a.valid.jwt',
    });
    expect(res.status).toBe(302);
    const location = res.headers.get('location')!;
    expect(location).toMatch(/\/signin\?redirect=/);
  });
});

// ── US3: stale-state recovery at /auth/github/callback ───────────────

describe('GET /auth/github/callback — stale state recovery (US3 / FR-010)', () => {
  it('callback with a state not in pendingStates → 400 text/html, NOT JSON, NOT 500', async () => {
    const res = await fetch(
      `${baseUrl}/auth/github/callback?code=any&state=this-state-does-not-exist`,
      { redirect: 'manual' },
    );
    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    const body = await res.text();
    expect(body).toContain('Sign-in session expired');
    expect(body.toLowerCase()).toContain('mcp client');
    expect(body).not.toMatch(/at .*\.ts:\d+/);
    expect(body).not.toMatch(/TypeError|ReferenceError|Error: at /);
  });
});
