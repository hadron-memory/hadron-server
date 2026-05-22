/**
 * Spec 029-oauth-signin-prompt T003 + T008 + T009 — integration tests
 * for the sign-in prompt page at `GET /oauth/authorize`.
 *
 * Coverage:
 *   - US1: unauthenticated → 200 text/html prompt page (T003a/b);
 *     signed-in → existing consent (regression guard, T003c); invalid
 *     client_id → 400 JSON, no prompt (T003d).
 *   - US2: empty clientName → fallback identity uses redirect_uri host;
 *     no client_id GUID leak (T008).
 *   - US3: retry after sign-in abandonment → prompt renders cleanly on
 *     each attempt (T009a); stale `/auth/github/callback` → user-readable
 *     HTML, not 500 / stack trace (T009b).
 *
 * Pattern mirrors `src/test/integration/025-oauth-authorize.test.ts` —
 * real `createServer()` on a random port, redirects disabled to inspect
 * status codes.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createServer } from '../../server.js';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../helpers.js';
import { signJwt } from '../../auth/jwt.js';
import { generateId } from '../../lib/id.js';

// ── Test fixtures ────────────────────────────────────────────────────

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

// ── Helpers ──────────────────────────────────────────────────────────

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

// ── US1 / T003: prompt page rendering for unauthenticated users ──────

describe('GET /oauth/authorize — unauthenticated → sign-in prompt page (US1 / FR-001)', () => {
  it('no hadron_token cookie → 200 text/html prompt page', async () => {
    const res = await getAuthorize(buildAuthorizeQuery(), { cookie: null });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    const html = await res.text();
    expect(html).toContain('<title>Sign in to Hadron</title>');
    expect(html).toContain('<h1>Sign in to Hadron</h1>');
  });

  it('prompt page names the registered client by clientName (FR-002)', async () => {
    const res = await getAuthorize(buildAuthorizeQuery(), { cookie: null });
    const html = await res.text();
    expect(html).toContain('Test MCP Client is asking Hadron for access on your behalf.');
  });

  it('prompt page CTA points at /auth/github with URL-encoded return_to (FR-005)', async () => {
    const q = buildAuthorizeQuery();
    const res = await getAuthorize(q, { cookie: null });
    const html = await res.text();

    const ctaMatch = html.match(/href="\/auth\/github\?return_to=([^"]+)"/);
    expect(ctaMatch, 'sign-in CTA must be present').not.toBeNull();
    const decoded = decodeURIComponent(ctaMatch![1]);
    // The decoded return_to is the original /oauth/authorize URL path + query.
    expect(decoded.startsWith('/oauth/authorize?')).toBe(true);
    expect(decoded).toContain(`client_id=${testClientId}`);
    expect(decoded).toContain('state=opaque-state-value');
    expect(decoded).toContain('code_challenge=' + 'a'.repeat(43));
    expect(decoded).toContain('code_challenge_method=S256');
    expect(decoded).toContain('scope=mcp');
    expect(decoded).toContain(`resource=${encodeURIComponent(RESOURCE_URL)}`);
    expect(decoded).toContain(`redirect_uri=${encodeURIComponent(REGISTERED_REDIRECT)}`);
  });

  it('malformed hadron_token cookie → same prompt page (Acceptance Scenario 2)', async () => {
    const res = await getAuthorize(buildAuthorizeQuery(), {
      cookie: 'hadron_token=not.a.valid.jwt',
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    const html = await res.text();
    expect(html).toContain('<h1>Sign in to Hadron</h1>');
  });

  it('does NOT set any cookies on the prompt-page response (pre-sign-in page)', async () => {
    const res = await getAuthorize(buildAuthorizeQuery(), { cookie: null });
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('prompt body has no unescaped angle brackets from substitution slots (XSS guard)', async () => {
    // Re-seed the client with a clientName containing HTML-injection bait.
    await db.oAuthClient.update({
      where: { clientId: testClientId },
      data: { clientName: '<script>alert(1)</script>' },
    });
    const res = await getAuthorize(buildAuthorizeQuery(), { cookie: null });
    const html = await res.text();
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });
});

// ── US1 / T003c: signed-in path unchanged (FR-009 / SC-005 regression guard)

describe('GET /oauth/authorize — signed-in user still sees consent (regression guard)', () => {
  it('valid hadron_token cookie → existing consent template, NOT the prompt page', async () => {
    const res = await fetch(`${baseUrl}/oauth/authorize?${buildAuthorizeQuery()}`, {
      redirect: 'manual',
      headers: { cookie: testCookieHeader },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    // Consent page has the `Authorize <clientName>` heading; prompt
    // page has `Sign in to Hadron`. They are mutually exclusive.
    expect(html).toContain(`Authorize Test MCP Client`);
    expect(html).not.toContain('<h1>Sign in to Hadron</h1>');
    // Consent page also sets the _hadron_csrf cookie; the prompt page
    // never does. This is the second axis of separation.
    expect(res.headers.get('set-cookie')).toMatch(/_hadron_csrf=/);
  });
});

// ── US1 / T003d: invalid client_id short-circuits before prompt rendering

describe('GET /oauth/authorize — invalid client_id → 400 JSON, no prompt (FR-008)', () => {
  it('unknown client_id with no cookie → 400 application/json (NOT prompt page)', async () => {
    const res = await getAuthorize(
      buildAuthorizeQuery({ client_id: 'dcr_does_not_exist' }),
      { cookie: null },
    );
    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('invalid_client');
  });

  it('missing redirect_uri with no cookie → 400 application/json (NOT prompt page)', async () => {
    const res = await getAuthorize(
      buildAuthorizeQuery({ redirect_uri: undefined }),
      { cookie: null },
    );
    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
  });
});

// ── US2 / T008: clientName fallback to redirect_uri host ──────────────

describe('GET /oauth/authorize — empty clientName → redirect_uri host fallback (US2 / FR-002)', () => {
  it('empty clientName in DB → prompt body shows redirect_uri host as identity', async () => {
    await db.oAuthClient.update({
      where: { clientId: testClientId },
      data: { clientName: '' },
    });
    const res = await getAuthorize(buildAuthorizeQuery(), { cookie: null });
    expect(res.status).toBe(200);
    const html = await res.text();
    // Host of `https://client.example.com/callback` is `client.example.com`.
    expect(html).toContain(
      'An application at client.example.com is asking Hadron for access on your behalf.',
    );
  });

  it('empty clientName → response does NOT leak the raw client_id GUID', async () => {
    await db.oAuthClient.update({
      where: { clientId: testClientId },
      data: { clientName: '' },
    });
    const res = await getAuthorize(buildAuthorizeQuery(), { cookie: null });
    const html = await res.text();
    expect(html).not.toContain(testClientId);
  });
});

// ── US3 / T009a: retry after sign-in abandonment ──────────────────────

describe('GET /oauth/authorize — retry after abandonment (US3 / Acceptance Scenario 1)', () => {
  it('two consecutive unauthenticated GETs both render the prompt page cleanly', async () => {
    // First attempt — user lands on the prompt page.
    const first = await getAuthorize(buildAuthorizeQuery(), { cookie: null });
    expect(first.status).toBe(200);
    const firstHtml = await first.text();
    expect(firstHtml).toContain('<h1>Sign in to Hadron</h1>');

    // User clicks the CTA — drive `/auth/github` to insert a
    // `pendingStates` entry on the server. We don't follow the GitHub
    // redirect; we just confirm it succeeded so a pending entry exists.
    const ctaMatch = firstHtml.match(/href="\/auth\/github\?return_to=([^"]+)"/);
    expect(ctaMatch).not.toBeNull();
    const authGithubUrl = `${baseUrl}/auth/github?return_to=${ctaMatch![1]}`;
    const ghRes = await fetch(authGithubUrl, { redirect: 'manual' });
    expect(ghRes.status).toBe(302);
    expect(ghRes.headers.get('location')).toMatch(/github\.com\/login\/oauth\/authorize/);

    // User abandons GitHub sign-in (closes the tab) and re-triggers
    // the flow from their MCP client — second unauthenticated GET to
    // /oauth/authorize. The prompt page must render again with no
    // residual state from the first attempt.
    const second = await getAuthorize(buildAuthorizeQuery(), { cookie: null });
    expect(second.status).toBe(200);
    expect(second.headers.get('content-type')).toMatch(/text\/html/);
    const secondHtml = await second.text();
    expect(secondHtml).toContain('<h1>Sign in to Hadron</h1>');
    expect(secondHtml).toContain('Test MCP Client is asking Hadron for access');
  });
});

// ── US3 / T009b: stale pending-state callback recovery ────────────────

describe('GET /auth/github/callback — stale state → user-readable HTML (US3 / FR-010)', () => {
  it('callback with a state not in pendingStates → 400 text/html, NOT a 500 or JSON blob', async () => {
    // Hit the callback directly with a random `state` that the server
    // never created. Per server.ts: the state lookup misses and the
    // pre-029 code returned a JSON `{"error": "Invalid or expired state"}`;
    // the spec 029 patch returns a user-readable HTML page.
    const res = await fetch(
      `${baseUrl}/auth/github/callback?code=any&state=this-state-does-not-exist`,
      { redirect: 'manual' },
    );
    expect(res.status).toBe(400);
    // FR-010 wants a user-readable response, not a JSON blob.
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    const body = await res.text();
    expect(body).toContain('Sign-in session expired');
    // Recovery instruction must mention the MCP client (since that's
    // where the user has to go to retry).
    expect(body.toLowerCase()).toContain('mcp client');
    // Negative-space: no stack trace, no internal error detail.
    expect(body).not.toMatch(/at .*\.ts:\d+/);
    expect(body).not.toMatch(/TypeError|ReferenceError|Error: at /);
  });
});
