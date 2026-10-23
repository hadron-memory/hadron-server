/**
 * Spec 025-oauth-for-mcp Phase 2C — `/oauth/authorize` integration
 * tests (T041 per tasks.md).
 *
 * Coverage:
 *   - Pre-redirect 400s — unknown client_id, mismatched redirect_uri,
 *     multi-value resource. NEVER a redirect (open-redirect mitigation).
 *   - Post-client-validation OAuth-error redirects — missing/invalid
 *     code_challenge, code_challenge_method=plain, missing response_type,
 *     missing resource, unsupported scope.
 *   - Option-C sign-in redirect — caller without hadron_token cookie
 *     bounces through the selected login provider with return_to=<encoded>;
 *     GitHub remains the default.
 *   - Happy GET — consent HTML carries CSRF token + every hidden input.
 *   - POST CSRF — missing / invalid `_csrf` field → 403.
 *   - POST approve — AuthCode created with codeHash (not plaintext per
 *     REV-5), resource stored as array (REV-3), redirect with raw code.
 *   - POST deny / missing / non-literal "yes" — fail-closed: NO
 *     AuthCode minted, redirect with `?error=access_denied`.
 *   - POST redirect_uri tampered to non-registered value → 400 (the
 *     open-redirect mitigation must re-validate, not trust the form).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash } from 'node:crypto';
import { createServer } from '../../server.js';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../helpers.js';
import { signJwt } from '../../auth/jwt.js';
import { generateId } from '../../lib/id.js';

// ── Test fixtures ────────────────────────────────────────────────────

let server: Server;
let baseUrl: string;

const REGISTERED_REDIRECT = 'https://client.example.com/callback';
const SECOND_REGISTERED_REDIRECT = 'https://client.example.com/alt-callback';
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
      redirectUris: [REGISTERED_REDIRECT, SECOND_REGISTERED_REDIRECT],
    },
  });

  testJwt = await signJwt({ sub: testUser.id, roles: ['CONTRIBUTOR'] });
  testCookieHeader = `hadron_token=${testJwt}`;
});

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Build the canonical query string for a GET /oauth/authorize request
 * with sane defaults; per-test overrides via `overrides`.
 */
function buildAuthorizeQuery(overrides: Record<string, string | undefined> = {}): string {
  const params = new URLSearchParams();
  const defaults: Record<string, string> = {
    response_type: 'code',
    client_id: testClientId,
    redirect_uri: REGISTERED_REDIRECT,
    code_challenge: 'a'.repeat(43), // S256 challenges are 43-128 chars
    code_challenge_method: 'S256',
    resource: RESOURCE_URL,
    state: 'opaque-state-value',
  };
  const merged = { ...defaults, ...overrides };
  for (const [k, v] of Object.entries(merged)) {
    if (v !== undefined) params.set(k, v);
  }
  return params.toString();
}

/**
 * GET /oauth/authorize, never following redirects (we want to assert
 * on the redirect target). Sends the test user's hadron_token by
 * default; pass `{ cookie: null }` to simulate "not signed in".
 */
async function getAuthorize(
  query: string,
  opts: { cookie?: string | null } = {},
): Promise<Response> {
  const cookie = opts.cookie === undefined ? testCookieHeader : opts.cookie;
  return fetch(`${baseUrl}/oauth/authorize?${query}`, {
    redirect: 'manual',
    headers: cookie ? { cookie } : undefined,
  });
}

/**
 * Walk the consent-render GET → extract csrf token from form +
 * csrf cookie from Set-Cookie. Returns both, ready to attach to a
 * follow-up POST.
 */
async function startConsentFlow(
  query?: string,
): Promise<{ csrfToken: string; csrfCookieValue: string; grantProof: string; html: string }> {
  const q = query ?? buildAuthorizeQuery();
  const res = await getAuthorize(q);
  expect(res.status).toBe(200);
  const html = await res.text();

  // Extract the hidden `_csrf` form value.
  const tokenMatch = html.match(/name="_csrf"\s+value="([^"]+)"/);
  expect(tokenMatch, 'csrf token must be in rendered consent HTML').not.toBeNull();
  const csrfToken = tokenMatch![1];
  const grantProofMatch = html.match(/name="grant_proof"\s+value="([^"]+)"/);
  expect(grantProofMatch, 'grant proof must be in rendered consent HTML').not.toBeNull();
  const grantProof = grantProofMatch![1];

  // Extract the _hadron_csrf cookie value from Set-Cookie.
  const setCookieRaw = res.headers.get('set-cookie');
  expect(setCookieRaw, '_hadron_csrf cookie must be set by GET').not.toBeNull();
  const cookieMatch = setCookieRaw!.match(/_hadron_csrf=([^;]+)/);
  expect(cookieMatch, '_hadron_csrf cookie must be in Set-Cookie header').not.toBeNull();
  const csrfCookieValue = cookieMatch![1];

  return { csrfToken, csrfCookieValue, grantProof, html };
}

/**
 * Submit `POST /oauth/authorize` with the given form fields. Caller
 * must supply csrfToken + csrfCookieValue from `startConsentFlow`
 * (otherwise the request fails CSRF validation).
 */
async function postAuthorize(
  fields: Record<string, string>,
  opts: {
    csrfCookieValue?: string;
    cookie?: string | null;
  } = {},
): Promise<Response> {
  const body = new URLSearchParams(fields).toString();
  const authCookie =
    opts.cookie === undefined ? testCookieHeader : opts.cookie;
  const csrfCookie = opts.csrfCookieValue
    ? `_hadron_csrf=${opts.csrfCookieValue}`
    : '';
  const cookies = [authCookie, csrfCookie].filter(Boolean).join('; ');
  return fetch(`${baseUrl}/oauth/authorize`, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      ...(cookies ? { cookie: cookies } : {}),
    },
    body,
  });
}

// ── GET — pre-redirect 400s (open-redirect mitigation) ───────────────

describe('GET /oauth/authorize — pre-redirect 400s', () => {
  it('unknown client_id → 400 invalid_client (NO redirect)', async () => {
    const res = await getAuthorize(
      buildAuthorizeQuery({ client_id: 'dcr_does_not_exist' }),
    );
    expect(res.status).toBe(400);
    expect(res.headers.get('location')).toBeNull();
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('invalid_client');
  });

  it('missing client_id → 400 invalid_client', async () => {
    const res = await getAuthorize(buildAuthorizeQuery({ client_id: undefined }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('invalid_client');
  });

  it('mismatched redirect_uri → 400 invalid_redirect_uri (NO redirect)', async () => {
    const res = await getAuthorize(
      buildAuthorizeQuery({ redirect_uri: 'https://evil.example/steal' }),
    );
    expect(res.status).toBe(400);
    expect(res.headers.get('location')).toBeNull();
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('invalid_redirect_uri');
  });

  it('soft-deleted OAuthClient → 400 invalid_client', async () => {
    await db.oAuthClient.update({
      where: { clientId: testClientId },
      data: { deletedAt: new Date(), deletedBy: 'test' },
    });
    const res = await getAuthorize(buildAuthorizeQuery());
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('invalid_client');
  });
});

// ── GET — post-client-validation redirects ───────────────────────────

describe('GET /oauth/authorize — post-validation redirects with OAuth error', () => {
  function expectRedirectToRegisteredCb(res: Response, expectedError: string): URL {
    expect(res.status).toBe(302);
    const location = res.headers.get('location');
    expect(location, 'must redirect to the registered callback').not.toBeNull();
    const url = new URL(location!);
    expect(url.origin + url.pathname).toBe(REGISTERED_REDIRECT);
    expect(url.searchParams.get('error')).toBe(expectedError);
    return url;
  }

  it('missing code_challenge → redirect with ?error=invalid_request&state', async () => {
    const res = await getAuthorize(
      buildAuthorizeQuery({ code_challenge: undefined }),
    );
    const url = expectRedirectToRegisteredCb(res, 'invalid_request');
    expect(url.searchParams.get('state')).toBe('opaque-state-value');
  });

  it('code_challenge_method=plain → redirect with ?error=invalid_request', async () => {
    const res = await getAuthorize(
      buildAuthorizeQuery({ code_challenge_method: 'plain' }),
    );
    expectRedirectToRegisteredCb(res, 'invalid_request');
  });

  it('response_type != "code" → redirect with ?error=invalid_request', async () => {
    const res = await getAuthorize(buildAuthorizeQuery({ response_type: 'token' }));
    expectRedirectToRegisteredCb(res, 'invalid_request');
  });

  it('missing resource → redirect with ?error=invalid_request', async () => {
    const res = await getAuthorize(buildAuthorizeQuery({ resource: undefined }));
    expectRedirectToRegisteredCb(res, 'invalid_request');
  });

  it('unsupported scope → redirect with ?error=invalid_scope', async () => {
    const res = await getAuthorize(buildAuthorizeQuery({ scope: 'admin' }));
    expectRedirectToRegisteredCb(res, 'invalid_scope');
  });

  it('accepts the account scope and supported scope combinations', async () => {
    for (const scope of ['account', 'mcp account', 'account mcp']) {
      const res = await getAuthorize(buildAuthorizeQuery({ scope }));
      expect(res.status, scope).toBe(200);
    }
  });

  it('multi-value resource → 400 invalid_request (NOT a redirect — v1 contract)', async () => {
    // Two `resource` params land as an array on req.query.
    const params = new URLSearchParams(buildAuthorizeQuery({ resource: undefined }));
    params.append('resource', RESOURCE_URL);
    params.append('resource', `${RESOURCE_URL}/other`);
    const res = await getAuthorize(params.toString());
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('invalid_request');
  });

  it('multi-value scope → redirect with ?error=invalid_request (no silent default)', async () => {
    // `?scope=mcp&scope=admin` lands as an array on req.query. The
    // pre-fix code treated this as non-string and silently fell
    // back to 'mcp', letting the misbehaving client through.
    const params = new URLSearchParams(buildAuthorizeQuery());
    params.delete('scope');
    params.append('scope', 'mcp');
    params.append('scope', 'admin');
    const res = await getAuthorize(params.toString());
    expect(res.status).toBe(302);
    const url = new URL(res.headers.get('location')!);
    expect(url.origin + url.pathname).toBe(REGISTERED_REDIRECT);
    expect(url.searchParams.get('error')).toBe('invalid_request');
  });

  it.each([
    ['too short (42 chars)', 'a'.repeat(42)],
    ['too long (129 chars)', 'a'.repeat(129)],
    ['invalid base64url charset (contains "+")', 'a'.repeat(40) + '+++'],
    ['invalid base64url charset (contains "=")', 'a'.repeat(40) + '==='],
    ['invalid base64url charset (contains "/")', 'a'.repeat(40) + '///'],
    ['whitespace inside', 'a'.repeat(40) + ' \t '],
  ])(
    'code_challenge %s → redirect with ?error=invalid_request',
    async (_label, badChallenge) => {
      // RFC 7636 §4.2: S256 challenges are exactly 43 chars
      // (base64url-encoded SHA-256), permitted range 43-128, and
      // restricted to the [A-Za-z0-9_-.~] charset. Rejecting at
      // the gate is fail-fast — /token would also catch these
      // but consent shouldn't even render for a malformed
      // challenge.
      const res = await getAuthorize(
        buildAuthorizeQuery({ code_challenge: badChallenge }),
      );
      expect(res.status).toBe(302);
      const url = new URL(res.headers.get('location')!);
      expect(url.origin + url.pathname).toBe(REGISTERED_REDIRECT);
      expect(url.searchParams.get('error')).toBe('invalid_request');
    },
  );

  it('code_challenge at the 43-char min boundary is ACCEPTED', async () => {
    // Negative-test counterpart for the rejection cases above:
    // exactly 43 chars in the valid charset should still render
    // the consent screen (otherwise the predicate is too tight).
    const res = await getAuthorize(
      buildAuthorizeQuery({ code_challenge: 'a'.repeat(43) }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
  });
});

// ── GET — Option-C sign-in redirect ──────────────────────────────────

describe('GET /oauth/authorize — Option-C sign-in (FR-007)', () => {
  it('no hadron_token cookie → redirect to /auth/github with return_to', async () => {
    const q = buildAuthorizeQuery();
    const res = await getAuthorize(q, { cookie: null });
    expect(res.status).toBe(302);
    const location = res.headers.get('location');
    expect(location).not.toBeNull();
    const url = new URL(location!, baseUrl);
    expect(url.pathname).toBe('/auth/github');
    const returnTo = url.searchParams.get('return_to');
    expect(returnTo).not.toBeNull();
    // return_to must round-trip back to /oauth/authorize with the
    // original query intact.
    expect(returnTo).toMatch(/^\/oauth\/authorize\?/);
    expect(returnTo).toContain(`client_id=${testClientId}`);
  });

  it('login_provider=google → redirect to /auth/google with the full return_to', async () => {
    const q = buildAuthorizeQuery({ login_provider: 'google' });
    const res = await getAuthorize(q, { cookie: null });

    expect(res.status).toBe(302);
    const url = new URL(res.headers.get('location')!, baseUrl);
    expect(url.pathname).toBe('/auth/google');
    const returnTo = url.searchParams.get('return_to');
    expect(returnTo).not.toBeNull();
    expect(returnTo).toMatch(/^\/oauth\/authorize\?/);
    expect(returnTo).toContain('login_provider=google');
    expect(returnTo).toContain(`client_id=${testClientId}`);
  });

  it('login_provider=apple → redirect to /auth/apple with the full return_to', async () => {
    // #794: App Store guideline 4.8 — the iOS app must be able to route the
    // unauthenticated leg through Sign in with Apple.
    const q = buildAuthorizeQuery({ login_provider: 'apple' });
    const res = await getAuthorize(q, { cookie: null });

    expect(res.status).toBe(302);
    const url = new URL(res.headers.get('location')!, baseUrl);
    expect(url.pathname).toBe('/auth/apple');
    const returnTo = url.searchParams.get('return_to');
    expect(returnTo).not.toBeNull();
    expect(returnTo).toMatch(/^\/oauth\/authorize\?/);
    expect(returnTo).toContain('login_provider=apple');
    expect(returnTo).toContain(`client_id=${testClientId}`);
  });

  it('unknown login_provider → OAuth invalid_request, never an auth-route redirect', async () => {
    const res = await getAuthorize(
      buildAuthorizeQuery({ login_provider: 'not-a-provider' }),
      { cookie: null },
    );

    expect(res.status).toBe(302);
    const url = new URL(res.headers.get('location')!);
    expect(url.origin + url.pathname).toBe(REGISTERED_REDIRECT);
    expect(url.searchParams.get('error')).toBe('invalid_request');
    expect(url.searchParams.get('state')).toBe('opaque-state-value');
  });

  it('multi-value login_provider → OAuth invalid_request', async () => {
    const params = new URLSearchParams(buildAuthorizeQuery());
    params.append('login_provider', 'google');
    params.append('login_provider', 'github');
    const res = await getAuthorize(params.toString(), { cookie: null });

    expect(res.status).toBe(302);
    const url = new URL(res.headers.get('location')!);
    expect(url.origin + url.pathname).toBe(REGISTERED_REDIRECT);
    expect(url.searchParams.get('error')).toBe('invalid_request');
  });

  it('malformed hadron_token cookie → also bounces to /auth/github', async () => {
    const res = await getAuthorize(buildAuthorizeQuery(), {
      cookie: 'hadron_token=not.a.valid.jwt',
    });
    expect(res.status).toBe(302);
    const location = res.headers.get('location');
    expect(location).toMatch(/^\/auth\/github\?return_to=/);
  });
});

// ── GET — happy path: consent HTML render ────────────────────────────

describe('GET /oauth/authorize — happy path renders consent HTML', () => {
  it('returns 200 + HTML with all hidden inputs + CSRF token', async () => {
    const res = await getAuthorize(buildAuthorizeQuery());
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    const html = await res.text();

    // CSRF token present in hidden input + cookie set.
    expect(html).toMatch(/name="_csrf"\s+value="[^"]+"/);
    expect(res.headers.get('set-cookie')).toMatch(/_hadron_csrf=/);

    // All preserved-state hidden inputs present with correct values.
    expect(html).toContain(`value="${testClientId}"`);
    expect(html).toContain(`value="${REGISTERED_REDIRECT}"`);
    expect(html).toContain(`value="${'a'.repeat(43)}"`); // code_challenge
    expect(html).toContain('value="S256"');
    expect(html).toContain(`value="${RESOURCE_URL}"`);
    expect(html).toContain('value="mcp"');
    expect(html).toContain('value="opaque-state-value"');

    // Client name surfaces in body copy.
    expect(html).toContain('Test MCP Client');
  });

  it('attacker-controlled client_name is HTML-escaped (XSS guard)', async () => {
    await db.oAuthClient.update({
      where: { clientId: testClientId },
      data: { clientName: '<script>alert(1)</script>"\'>' },
    });
    const res = await getAuthorize(buildAuthorizeQuery());
    const html = await res.text();
    // The raw script tag MUST NOT appear.
    expect(html).not.toContain('<script>alert(1)</script>');
    // The escaped form MUST appear.
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });
});

// ── POST — CSRF protection ────────────────────────────────────────────

describe('POST /oauth/authorize — CSRF protection', () => {
  it('missing _csrf field → 403', async () => {
    const res = await postAuthorize({
      decision: 'approve',
      client_id: testClientId,
      redirect_uri: REGISTERED_REDIRECT,
      code_challenge: 'a'.repeat(43),
      resource: RESOURCE_URL,
      state: 'opaque-state-value',
    });
    expect(res.status).toBe(403);
  });

  it('invalid _csrf token → 403', async () => {
    const { csrfCookieValue } = await startConsentFlow();
    const res = await postAuthorize(
      {
        _csrf: 'totally-bogus-token',
        decision: 'approve',
        client_id: testClientId,
        redirect_uri: REGISTERED_REDIRECT,
        code_challenge: 'a'.repeat(43),
        resource: RESOURCE_URL,
        state: 'opaque-state-value',
      },
      { csrfCookieValue },
    );
    expect(res.status).toBe(403);
  });

  it('valid _csrf but missing _hadron_csrf cookie → 403', async () => {
    const { csrfToken } = await startConsentFlow();
    const res = await postAuthorize(
      {
        _csrf: csrfToken,
        decision: 'approve',
        client_id: testClientId,
        redirect_uri: REGISTERED_REDIRECT,
        code_challenge: 'a'.repeat(43),
        resource: RESOURCE_URL,
        state: 'opaque-state-value',
      },
      // No csrfCookieValue → the double-submit half is missing.
    );
    expect(res.status).toBe(403);
  });
});

// ── POST — happy path approve + AuthCode mint ────────────────────────

describe('POST /oauth/authorize — decision=approve mints AuthCode', () => {
  it('approve → 302 to redirect_uri with raw code + state', async () => {
    const codeChallenge = 'a'.repeat(43);
    const { csrfToken, csrfCookieValue, grantProof } = await startConsentFlow();
    const res = await postAuthorize(
      {
        _csrf: csrfToken,
        decision: 'approve',
        client_id: testClientId,
        redirect_uri: REGISTERED_REDIRECT,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
        resource: RESOURCE_URL,
        scope: 'mcp',
        state: 'opaque-state-value',
        grant_proof: grantProof,
      },
      { csrfCookieValue },
    );
    expect(res.status).toBe(302);

    const location = res.headers.get('location');
    expect(location).not.toBeNull();
    const url = new URL(location!);
    expect(url.origin + url.pathname).toBe(REGISTERED_REDIRECT);
    const rawCode = url.searchParams.get('code');
    expect(rawCode).toMatch(/^[0-9a-f]{64}$/); // randomBytes(32).toString('hex')
    expect(url.searchParams.get('state')).toBe('opaque-state-value');

    // REV-5: codeHash stored, raw code NEVER persisted.
    const rows = await db.authCode.findMany({});
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.codeHash).toBe(createHash('sha256').update(rawCode!).digest('hex'));
    expect(row.codeHash).not.toBe(rawCode);
    expect(row.clientId).toBe(testClientId);
    expect(row.userId).toBe(testUser.id);
    expect(row.redirectUri).toBe(REGISTERED_REDIRECT);
    expect(row.codeChallenge).toBe(codeChallenge);
    expect(row.resource).toEqual([RESOURCE_URL]); // REV-3: String[]
    expect(row.oauthScopes).toEqual(['mcp']);
    expect(row.createdBy).toBe(testUser.id);
    expect(row.expiresAt.getTime()).toBeGreaterThan(Date.now() + 9 * 60 * 1000); // ≥9min
    expect(row.expiresAt.getTime()).toBeLessThan(Date.now() + 11 * 60 * 1000); // ≤11min
  });

  it('persists the approved account grant in canonical order', async () => {
    const codeChallenge = 'a'.repeat(43);
    const { csrfToken, csrfCookieValue, grantProof } = await startConsentFlow(
      buildAuthorizeQuery({ scope: 'account mcp' }),
    );
    const res = await postAuthorize(
      {
        _csrf: csrfToken,
        decision: 'approve',
        client_id: testClientId,
        redirect_uri: REGISTERED_REDIRECT,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
        resource: RESOURCE_URL,
        scope: 'account mcp',
        state: 'opaque-state-value',
        grant_proof: grantProof,
      },
      { csrfCookieValue },
    );
    expect(res.status).toBe(302);
    const row = await db.authCode.findFirstOrThrow();
    expect(row.oauthScopes).toEqual(['mcp', 'account']);
  });

  it('approve with no state → 302 without state in query', async () => {
    const codeChallenge = 'a'.repeat(43);
    const { csrfToken, csrfCookieValue, grantProof } = await startConsentFlow(
      buildAuthorizeQuery({ state: '' }),
    );
    const res = await postAuthorize(
      {
        _csrf: csrfToken,
        decision: 'approve',
        client_id: testClientId,
        redirect_uri: REGISTERED_REDIRECT,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
        resource: RESOURCE_URL,
        scope: 'mcp',
        grant_proof: grantProof,
      },
      { csrfCookieValue },
    );
    expect(res.status).toBe(302);
    const url = new URL(res.headers.get('location')!);
    expect(url.searchParams.has('code')).toBe(true);
    expect(url.searchParams.has('state')).toBe(false);
  });
});

// ── #156: one operator log line per minted AuthCode ──────────────────

describe('POST /oauth/authorize — #156 authcode_minted log line', () => {
  afterEach(() => { vi.restoreAllMocks(); });
  // The grant proof binds the challenge startConsentFlow's default query carries.
  const CHALLENGE = 'a'.repeat(43);
  const mintLines = (spy: { mock: { calls: unknown[][] } }) =>
    spy.mock.calls.filter((call) => call[0] === '[oauth] authcode_minted');
  async function approve(decision = 'approve') {
    const { csrfToken, csrfCookieValue, grantProof } = await startConsentFlow();
    return postAuthorize(
      {
        _csrf: csrfToken, decision, client_id: testClientId, redirect_uri: REGISTERED_REDIRECT,
        code_challenge: CHALLENGE, code_challenge_method: 'S256', resource: RESOURCE_URL, scope: 'mcp',
        state: 'opaque-state-value', grant_proof: grantProof,
      },
      { csrfCookieValue },
    );
  }

  it('logs one line with client_id, an 8-char user prefix and ip; never code, hash, challenge, state or redirect', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const res = await approve();
    expect(res.status).toBe(302);
    const rawCode = new URL(res.headers.get('location')!).searchParams.get('code')!;
    const lines = mintLines(spy);
    expect(lines).toHaveLength(1);
    const [, payload] = lines[0] as [string, Record<string, unknown>];
    expect(payload).toEqual({ client_id: testClientId, user: testUser.id.slice(0, 8), ip: expect.any(String) });
    const logged = JSON.stringify(lines);
    const { codeHash } = await db.authCode.findFirstOrThrow();
    for (const secret of [rawCode, codeHash, CHALLENGE, 'opaque-state-value', REGISTERED_REDIRECT, testUser.id]) {
      expect(logged).not.toContain(secret);
    }
  });

  it('logs nothing when consent is denied (no code minted)', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect((await approve('deny')).status).toBe(302);
    expect(await db.authCode.count()).toBe(0);
    expect(mintLines(spy)).toHaveLength(0);
  });

  it('logs nothing when an ended sign-in is refused (401, no code minted)', async () => {
    const { createSignIn } = await import('../../auth/signIn.js');
    const si = await db.$transaction((tx) => createSignIn(tx, { userId: testUser.id, method: 'email', passkeyId: null }));
    const jwt = await signJwt({ sub: testUser.id, roles: ['CONTRIBUTOR'], sid: si.id });
    const { csrfToken, csrfCookieValue, grantProof } = await startConsentFlow();
    await db.signIn.update({ where: { id: si.id }, data: { endedAt: new Date(), endReason: 'passkey-cancelled' } });
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const res = await postAuthorize(
      {
        _csrf: csrfToken, decision: 'approve', client_id: testClientId, redirect_uri: REGISTERED_REDIRECT,
        code_challenge: CHALLENGE, code_challenge_method: 'S256', resource: RESOURCE_URL, scope: 'mcp',
        state: 'opaque-state-value', grant_proof: grantProof,
      },
      { csrfCookieValue, cookie: `hadron_token=${jwt}` },
    );
    expect(res.status).toBe(401);
    expect(await db.authCode.count()).toBe(0);
    expect(mintLines(spy)).toHaveLength(0);
  });
});

// ── POST — fail-closed decision branches ─────────────────────────────

describe('POST /oauth/authorize — fail-closed decision (FR-012)', () => {
  // For each non-approve decision shape, the POST MUST:
  //   1. NOT mint an AuthCode.
  //   2. Redirect to the registered redirect_uri with ?error=access_denied.
  it.each([
    ['decision=deny', { decision: 'deny' }],
    ['decision missing', {}],
    ['decision="yes" (non-literal)', { decision: 'yes' }],
    ['decision="APPROVE" (wrong case)', { decision: 'APPROVE' }],
    ['decision=" approve " (whitespace-padded)', { decision: ' approve ' }],
  ])('%s → no AuthCode + redirect with ?error=access_denied', async (_name, override) => {
    const codeChallenge = 'a'.repeat(43);
    const { csrfToken, csrfCookieValue } = await startConsentFlow();
    const fields: Record<string, string> = {
      _csrf: csrfToken,
      client_id: testClientId,
      redirect_uri: REGISTERED_REDIRECT,
      code_challenge: codeChallenge,
      resource: RESOURCE_URL,
      state: 'opaque-state-value',
      ...(override as Record<string, string>),
    };
    const res = await postAuthorize(fields, { csrfCookieValue });
    expect(res.status).toBe(302);
    const url = new URL(res.headers.get('location')!);
    expect(url.origin + url.pathname).toBe(REGISTERED_REDIRECT);
    expect(url.searchParams.get('error')).toBe('access_denied');
    expect(url.searchParams.get('state')).toBe('opaque-state-value');
    expect(url.searchParams.has('code')).toBe(false);
    expect(await db.authCode.count()).toBe(0);
  });
});

describe('POST /oauth/authorize — revalidates the immutable OAuth grant', () => {
  it('rejects a hidden scope tampered to an unsupported value', async () => {
    const { csrfToken, csrfCookieValue } = await startConsentFlow();
    const res = await postAuthorize(
      {
        _csrf: csrfToken,
        decision: 'approve',
        client_id: testClientId,
        redirect_uri: REGISTERED_REDIRECT,
        code_challenge: 'a'.repeat(43),
        resource: RESOURCE_URL,
        scope: 'admin',
        state: 'opaque-state-value',
      },
      { csrfCookieValue },
    );
    expect(res.status).toBe(302);
    const url = new URL(res.headers.get('location')!);
    expect(url.searchParams.get('error')).toBe('invalid_scope');
    expect(await db.authCode.count()).toBe(0);
  });

  it('rejects a supported scope substituted after the user saw the consent grant', async () => {
    const { csrfToken, csrfCookieValue, grantProof } = await startConsentFlow(
      buildAuthorizeQuery({ scope: 'mcp' }),
    );
    const res = await postAuthorize(
      {
        _csrf: csrfToken,
        decision: 'approve',
        client_id: testClientId,
        redirect_uri: REGISTERED_REDIRECT,
        code_challenge: 'a'.repeat(43),
        code_challenge_method: 'S256',
        resource: RESOURCE_URL,
        scope: 'account',
        state: 'opaque-state-value',
        grant_proof: grantProof,
      },
      { csrfCookieValue },
    );
    expect(res.status).toBe(302);
    const url = new URL(res.headers.get('location')!);
    expect(url.searchParams.get('error')).toBe('invalid_request');
    expect(await db.authCode.count()).toBe(0);
  });

  it('rejects an invalid grant proof', async () => {
    const { csrfToken, csrfCookieValue } = await startConsentFlow();
    const res = await postAuthorize(
      {
        _csrf: csrfToken,
        decision: 'approve',
        client_id: testClientId,
        redirect_uri: REGISTERED_REDIRECT,
        code_challenge: 'a'.repeat(43),
        code_challenge_method: 'S256',
        resource: RESOURCE_URL,
        scope: 'mcp',
        state: 'opaque-state-value',
        grant_proof: 'invalid',
      },
      { csrfCookieValue },
    );
    expect(res.status).toBe(302);
    const url = new URL(res.headers.get('location')!);
    expect(url.searchParams.get('error')).toBe('invalid_request');
    expect(await db.authCode.count()).toBe(0);
  });
});

// ── POST — open-redirect mitigation (re-validate redirect_uri) ───────

describe('POST /oauth/authorize — open-redirect mitigation', () => {
  it('tampered redirect_uri (not in client registration) → 400, no AuthCode', async () => {
    const codeChallenge = 'a'.repeat(43);
    const { csrfToken, csrfCookieValue } = await startConsentFlow();
    const res = await postAuthorize(
      {
        _csrf: csrfToken,
        decision: 'approve',
        client_id: testClientId,
        // The GET issued the CSRF token for the legitimate redirect_uri,
        // but the form has been tampered with to point at an attacker URL.
        redirect_uri: 'https://evil.example/steal',
        code_challenge: codeChallenge,
        resource: RESOURCE_URL,
        state: 'opaque-state-value',
      },
      { csrfCookieValue },
    );
    expect(res.status).toBe(400);
    expect(res.headers.get('location')).toBeNull();
    expect(await db.authCode.count()).toBe(0);
  });

  it('tampered client_id (unknown) → 400, no AuthCode', async () => {
    const codeChallenge = 'a'.repeat(43);
    const { csrfToken, csrfCookieValue } = await startConsentFlow();
    const res = await postAuthorize(
      {
        _csrf: csrfToken,
        decision: 'approve',
        client_id: 'dcr_unknown',
        redirect_uri: REGISTERED_REDIRECT,
        code_challenge: codeChallenge,
        resource: RESOURCE_URL,
        state: 'opaque-state-value',
      },
      { csrfCookieValue },
    );
    expect(res.status).toBe(400);
    expect(await db.authCode.count()).toBe(0);
  });

  it('redirect_uri with pre-existing ?code= → response overwrites, not duplicates (parameter pollution)', async () => {
    // RFC 6749 §3.1.2 doesn't prohibit registered redirect_uris
    // with query strings. If the client registers
    // `https://cb.example/?code=fixed`, the AS response must use
    // `searchParams.set` (NOT `append`) for OAuth-reserved keys
    // so the final Location header carries exactly one `code`
    // param — ours, the authoritative one. Two `code` values
    // is undefined-behavior territory for client parsers and a
    // fixation-attack vector if the fixed value is attacker-
    // controlled.
    const pollutionRedirect = 'https://client.example.com/cb?code=fixed&state=stale';
    const pollutionClientId = `dcr_${'b'.repeat(32)}`;
    await db.oAuthClient.create({
      data: {
        clientId: pollutionClientId,
        clientName: 'Pollution Test Client',
        redirectUris: [pollutionRedirect],
      },
    });
    const codeChallenge = 'a'.repeat(43);

    // GET to seed CSRF.
    const getRes = await getAuthorize(
      buildAuthorizeQuery({
        client_id: pollutionClientId,
        redirect_uri: pollutionRedirect,
        code_challenge: codeChallenge,
        state: 'fresh-state',
      }),
    );
    expect(getRes.status).toBe(200);
    const html = await getRes.text();
    const csrfToken = html.match(/name="_csrf"\s+value="([^"]+)"/)![1];
    const grantProof = html.match(/name="grant_proof"\s+value="([^"]+)"/)![1];
    const csrfCookieValue = getRes.headers
      .get('set-cookie')!
      .match(/_hadron_csrf=([^;]+)/)![1];

    // POST approve → expect exactly one `code` param (ours), and
    // the `state` param overwritten by our value.
    const res = await postAuthorize(
      {
        _csrf: csrfToken,
        decision: 'approve',
        client_id: pollutionClientId,
        redirect_uri: pollutionRedirect,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
        resource: RESOURCE_URL,
        scope: 'mcp',
        state: 'fresh-state',
        grant_proof: grantProof,
      },
      { csrfCookieValue },
    );
    expect(res.status).toBe(302);
    const location = res.headers.get('location')!;
    const url = new URL(location);
    // Exactly one `code` param, NOT 'fixed'.
    expect(url.searchParams.getAll('code')).toHaveLength(1);
    expect(url.searchParams.get('code')).not.toBe('fixed');
    expect(url.searchParams.get('code')).toMatch(/^[0-9a-f]{64}$/);
    // `state` overwritten by ours.
    expect(url.searchParams.getAll('state')).toHaveLength(1);
    expect(url.searchParams.get('state')).toBe('fresh-state');
  });

  it('POST without hadron_token cookie → CSRF 403 (session-bound token), no AuthCode', async () => {
    // The CSRF token issued by the GET was bound to the signed-in
    // user's session id (getSessionIdentifier returns the JWT sub).
    // Re-submitting without the JWT cookie shifts the session id
    // to 'anonymous', so the token no longer validates — CSRF
    // middleware emits 403 BEFORE the handler's auth check runs.
    // This is the right fail-closed posture: a CSRF token can't
    // be reused across different sessions / signed-out states.
    const codeChallenge = 'a'.repeat(43);
    const { csrfToken, csrfCookieValue } = await startConsentFlow();
    const res = await postAuthorize(
      {
        _csrf: csrfToken,
        decision: 'approve',
        client_id: testClientId,
        redirect_uri: REGISTERED_REDIRECT,
        code_challenge: codeChallenge,
        resource: RESOURCE_URL,
      },
      { csrfCookieValue, cookie: null },
    );
    expect(res.status).toBe(403);
    expect(await db.authCode.count()).toBe(0);
  });
});

// ── #1897 / R66: the code carries its sign-in root ───────────────────

describe('POST /oauth/authorize — sign-in lineage (#1897)', () => {
  async function approveWith(cookie: string) {
    const { csrfToken, csrfCookieValue, grantProof } = await startConsentFlow();
    return postAuthorize(
      {
        _csrf: csrfToken, decision: 'approve', client_id: testClientId, redirect_uri: REGISTERED_REDIRECT,
        code_challenge: 'a'.repeat(43), code_challenge_method: 'S256', resource: RESOURCE_URL, scope: 'mcp',
        state: 'opaque-state-value', grant_proof: grantProof,
      },
      { csrfCookieValue, cookie },
    );
  }
  async function liveSignIn() {
    const { createSignIn } = await import('../../auth/signIn.js');
    return db.$transaction((tx) => createSignIn(tx, { userId: testUser.id, method: 'email', passkeyId: null }));
  }

  it('a sid-bearing session mints a code rooted at that sign-in', async () => {
    const si = await liveSignIn();
    const jwt = await signJwt({ sub: testUser.id, roles: ['CONTRIBUTOR'], sid: si.id });
    expect((await approveWith(`hadron_token=${jwt}`)).status).toBe(302);
    expect((await db.authCode.findFirstOrThrow({})).signInId).toBe(si.id);
  });
  it('a session without sid mints an unrooted code (identity-provider and legacy sign-ins unchanged)', async () => {
    expect((await approveWith(testCookieHeader)).status).toBe(302);
    expect((await db.authCode.findFirstOrThrow({})).signInId).toBeNull();
  });
  it('an ended sign-in\'s cookie no longer authenticates the consent POST and mints nothing', async () => {
    const si = await liveSignIn();
    const jwt = await signJwt({ sub: testUser.id, roles: ['CONTRIBUTOR'], sid: si.id });
    await db.signIn.update({ where: { id: si.id }, data: { endedAt: new Date(), endReason: 'passkey-cancelled' } });
    expect((await approveWith(`hadron_token=${jwt}`)).status).toBe(401);
    expect(await db.authCode.count()).toBe(0);
  });
});
