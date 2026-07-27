/**
 * #804 — email magic-link sign-in through the OAuth authorize flow.
 *
 * Mirrors the 025-oauth-authorize integration style (real Express app
 * over HTTP, manual redirects). `sendMagicLink` is mocked (it calls
 * Resend); everything else — CSRF, rate limit, verify, cookie — runs
 * for real.
 *
 * Coverage:
 *   - GET /oauth/authorize?login_provider=email (unauthenticated) →
 *     renders the server-hosted email-entry page (NOT a provider
 *     redirect): form action, hidden return_to with the full original
 *     authorize URL, CSRF token + cookie. Signed-in callers skip
 *     straight to consent; unknown providers still fail.
 *   - POST /oauth/authorize/email → invokes the magic-link send path
 *     with the round-tripped return_to; renders "Check your email".
 *     CSRF-protected; malformed return_to / missing email → 400 with
 *     no send.
 *   - GET /auth/email/verify Option-C: an unbound token + valid
 *     return_to sets the hadron_token cookie and 302s to return_to;
 *     malformed return_to → 400 WITHOUT consuming the token; an
 *     unbound token without return_to still fails closed (#511 P2);
 *     a BOUND (portal) token ignores return_to and takes the handoff
 *     path (no #505 bypass).
 *   - Full dance: verify → cookie → GET return_to renders consent.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash } from 'node:crypto';
import { createServer } from '../../server.js';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../helpers.js';
import { signJwt } from '../../auth/jwt.js';
import { generateId } from '../../lib/id.js';

// Mock ONLY sendMagicLink (it calls Resend). verifyMagicLink and the
// rest of the module stay real — the verify tests below exercise the
// genuine single-use claim.
const sendMagicLinkMock = vi.hoisted(() => vi.fn());
vi.mock('../../auth/email.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../auth/email.js')>();
  return { ...mod, sendMagicLink: sendMagicLinkMock };
});

// ── Test fixtures ────────────────────────────────────────────────────

let server: Server;
let baseUrl: string;

const REGISTERED_REDIRECT = 'com.hadronmemory.ios://oauth/callback';
const RESOURCE_URL = 'https://hadron.example/mcp';

let testClientId: string;

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
  sendMagicLinkMock.mockReset();
  sendMagicLinkMock.mockResolvedValue(undefined);

  testClientId = `dcr_${'e'.repeat(32)}`;
  await db.oAuthClient.create({
    data: {
      clientId: testClientId,
      clientName: 'Hadron iOS',
      redirectUris: [REGISTERED_REDIRECT],
    },
  });
});

// ── Helpers ──────────────────────────────────────────────────────────

/** Canonical authorize query with login_provider=email by default. */
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
    login_provider: 'email',
  };
  const merged = { ...defaults, ...overrides };
  for (const [k, v] of Object.entries(merged)) {
    if (v !== undefined) params.set(k, v);
  }
  return params.toString();
}

/** GET /oauth/authorize (anonymous unless a cookie is passed). */
async function getAuthorize(query: string, cookie?: string): Promise<Response> {
  return fetch(`${baseUrl}/oauth/authorize?${query}`, {
    redirect: 'manual',
    headers: cookie ? { cookie } : undefined,
  });
}

/**
 * Walk the email-entry GET → extract the CSRF token, the CSRF cookie,
 * and the hidden return_to value, ready for the follow-up POST.
 */
async function startEmailEntryFlow(query?: string): Promise<{
  csrfToken: string;
  csrfCookieValue: string;
  returnTo: string;
  html: string;
}> {
  const res = await getAuthorize(query ?? buildAuthorizeQuery());
  expect(res.status).toBe(200);
  const html = await res.text();

  const tokenMatch = html.match(/name="_csrf"\s+value="([^"]+)"/);
  expect(tokenMatch, 'csrf token must be in the email-entry HTML').not.toBeNull();

  const returnToMatch = html.match(/name="return_to"\s+value="([^"]+)"/);
  expect(returnToMatch, 'hidden return_to must be in the email-entry HTML').not.toBeNull();

  const setCookieRaw = res.headers.get('set-cookie');
  expect(setCookieRaw, '_hadron_csrf cookie must be set by GET').not.toBeNull();
  const cookieMatch = setCookieRaw!.match(/_hadron_csrf=([^;]+)/);
  expect(cookieMatch).not.toBeNull();

  // The hidden value is HTML-escaped (&amp; for &) — undo for reuse.
  const returnTo = returnToMatch![1]
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');

  return { csrfToken: tokenMatch![1], csrfCookieValue: cookieMatch![1], returnTo, html };
}

/** Submit POST /oauth/authorize/email as an anonymous browser form. */
async function postAuthorizeEmail(
  fields: Record<string, string>,
  opts: { csrfCookieValue?: string } = {},
): Promise<Response> {
  const csrfCookie = opts.csrfCookieValue ? `_hadron_csrf=${opts.csrfCookieValue}` : '';
  return fetch(`${baseUrl}/oauth/authorize/email`, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      ...(csrfCookie ? { cookie: csrfCookie } : {}),
    },
    body: new URLSearchParams(fields).toString(),
  });
}

/** Insert a magic-link token row directly (the mint side is mocked). */
async function insertEmailToken(opts: {
  email: string;
  clientStateHash?: string | null;
}): Promise<string> {
  const token = `evtok-${generateId()}`;
  await db.emailVerificationToken.create({
    data: {
      id: generateId(),
      email: opts.email,
      token,
      expiresAt: new Date(Date.now() + 15 * 60 * 1000),
      clientStateHash: opts.clientStateHash ?? null,
    },
  });
  return token;
}

// ── GET /oauth/authorize — login_provider=email renders the entry page ──

describe('GET /oauth/authorize — login_provider=email (unauthenticated)', () => {
  it('renders the email-entry page, NOT a provider redirect', async () => {
    const res = await getAuthorize(buildAuthorizeQuery());
    expect(res.status).toBe(200);
    expect(res.headers.get('location')).toBeNull();
    expect(res.headers.get('content-type')).toMatch(/text\/html/);

    const html = await res.text();
    expect(html).toContain('action="/oauth/authorize/email"');
    expect(html).toMatch(/name="_csrf"\s+value="[^"]+"/);
    expect(html).toContain('name="email"');
    expect(res.headers.get('set-cookie')).toMatch(/_hadron_csrf=/);
    // Client name surfaces in body copy.
    expect(html).toContain('Hadron iOS');
  });

  it('hidden return_to carries the FULL original authorize URL', async () => {
    const { returnTo } = await startEmailEntryFlow();
    expect(returnTo).toMatch(/^\/oauth\/authorize\?/);
    const url = new URL(returnTo, baseUrl);
    expect(url.searchParams.get('client_id')).toBe(testClientId);
    expect(url.searchParams.get('login_provider')).toBe('email');
    expect(url.searchParams.get('code_challenge')).toBe('a'.repeat(43));
    expect(url.searchParams.get('state')).toBe('opaque-state-value');
  });

  it('attacker-controlled client_name is HTML-escaped on the entry page (XSS guard)', async () => {
    await db.oAuthClient.update({
      where: { clientId: testClientId },
      data: { clientName: '<script>alert(1)</script>' },
    });
    const res = await getAuthorize(buildAuthorizeQuery());
    const html = await res.text();
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('signed-in caller with login_provider=email skips to consent', async () => {
    const user = await db.user.create({
      data: { id: generateId(), handle: 'mailuser', roles: ['CONTRIBUTOR'] },
    });
    const jwt = await signJwt({ sub: user.id, roles: ['CONTRIBUTOR'] });
    const res = await getAuthorize(buildAuthorizeQuery(), `hadron_token=${jwt}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    // Consent, not the email form.
    expect(html).not.toContain('action="/oauth/authorize/email"');
    expect(html).toContain('name="decision"');
  });

  it('unknown login_provider still fails with OAuth invalid_request', async () => {
    const res = await getAuthorize(buildAuthorizeQuery({ login_provider: 'not-a-provider' }));
    expect(res.status).toBe(302);
    const url = new URL(res.headers.get('location')!);
    expect(url.searchParams.get('error')).toBe('invalid_request');
  });
});

// ── POST /oauth/authorize/email — send leg ───────────────────────────

describe('POST /oauth/authorize/email', () => {
  it('valid submit → magic-link send path invoked with the round-tripped return_to; renders "Check your email"', async () => {
    const { csrfToken, csrfCookieValue, returnTo } = await startEmailEntryFlow();
    const res = await postAuthorizeEmail(
      { _csrf: csrfToken, return_to: returnTo, email: '  new-user@example.test ' },
      { csrfCookieValue },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    const html = await res.text();
    expect(html).toContain('Check your email');
    expect(html).toContain('new-user@example.test'); // trimmed

    // The existing send path was invoked with return_to riding along —
    // and with NO portal redirect and NO clientStateHash (Option-C leg).
    expect(sendMagicLinkMock).toHaveBeenCalledTimes(1);
    const [email, , redirect, clientStateHash, sentReturnTo] =
      sendMagicLinkMock.mock.calls[0];
    expect(email).toBe('new-user@example.test');
    expect(redirect).toBeUndefined();
    expect(clientStateHash).toBeUndefined();
    expect(sentReturnTo).toBe(returnTo);
    expect(sentReturnTo).toMatch(/^\/oauth\/authorize\?/);
  });

  it('missing _csrf → 403, no send', async () => {
    const { returnTo } = await startEmailEntryFlow();
    const res = await postAuthorizeEmail({ return_to: returnTo, email: 'a@example.test' });
    expect(res.status).toBe(403);
    expect(sendMagicLinkMock).not.toHaveBeenCalled();
  });

  it('missing email → 400, no send', async () => {
    const { csrfToken, csrfCookieValue, returnTo } = await startEmailEntryFlow();
    const res = await postAuthorizeEmail(
      { _csrf: csrfToken, return_to: returnTo, email: '   ' },
      { csrfCookieValue },
    );
    expect(res.status).toBe(400);
    expect(sendMagicLinkMock).not.toHaveBeenCalled();
  });

  it.each([
    ['absolute URL', 'https://evil.example/grab'],
    ['protocol-relative', '//evil.example/grab'],
    ['backslash', '/foo\\bar'],
    ['missing', undefined],
  ])('return_to %s → 400, no send', async (_label, badReturnTo) => {
    const { csrfToken, csrfCookieValue } = await startEmailEntryFlow();
    const fields: Record<string, string> = { _csrf: csrfToken, email: 'a@example.test' };
    if (badReturnTo !== undefined) fields.return_to = badReturnTo;
    const res = await postAuthorizeEmail(fields, { csrfCookieValue });
    expect(res.status).toBe(400);
    expect(sendMagicLinkMock).not.toHaveBeenCalled();
  });
});

// ── GET /auth/email/verify — Option-C return_to ──────────────────────

describe('GET /auth/email/verify — Option-C return_to (#804)', () => {
  const RETURN_TO = '/oauth/authorize?client_id=x&login_provider=email';

  it('unbound token + valid return_to → hadron_token cookie + 302 to return_to', async () => {
    const token = await insertEmailToken({ email: 'optionc@example.test' });
    const res = await fetch(
      `${baseUrl}/auth/email/verify?token=${token}&return_to=${encodeURIComponent(RETURN_TO)}`,
      { redirect: 'manual' },
    );
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(RETURN_TO);

    const setCookie = res.headers.get('set-cookie');
    expect(setCookie).toMatch(/hadron_token=/);
    expect(setCookie).toMatch(/HttpOnly/i);

    // The user was upserted by email, same as the portal flow.
    const user = await db.user.findUnique({ where: { email: 'optionc@example.test' } });
    expect(user).not.toBeNull();
    expect(user!.identityProvider).toBe('EMAIL');
  });

  it.each([
    ['absolute URL', 'https%3A%2F%2Fevil.example%2Fgrab'],
    ['protocol-relative', '%2F%2Fevil.example'],
    ['backslash', '%2Ffoo%5Cbar'],
    ['control bytes', '%2Ffoo%0D%0Abar'],
  ])('malformed return_to (%s) → 400 WITHOUT consuming the token', async (_label, encoded) => {
    const token = await insertEmailToken({ email: 'keep@example.test' });
    const res = await fetch(
      `${baseUrl}/auth/email/verify?token=${token}&return_to=${encoded}`,
      { redirect: 'manual' },
    );
    expect(res.status).toBe(400);
    expect(res.headers.get('set-cookie')).toBeNull();

    // The single-use token must survive a malformed request — the user
    // can still tap the genuine link.
    const row = await db.emailVerificationToken.findUnique({ where: { token } });
    expect(row!.usedAt).toBeNull();
  });

  it('unbound token WITHOUT return_to still fails closed (#511 P2 regression)', async () => {
    const token = await insertEmailToken({ email: 'unbound@example.test' });
    const res = await fetch(`${baseUrl}/auth/email/verify?token=${token}`, {
      redirect: 'manual',
    });
    expect(res.status).toBe(400);
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('BOUND (portal) token ignores return_to — handoff path, no cookie (#505 not bypassable)', async () => {
    const token = await insertEmailToken({
      email: 'portal@example.test',
      clientStateHash: createHash('sha256').update('nonce').digest('hex'),
    });
    const res = await fetch(
      `${baseUrl}/auth/email/verify?token=${token}&return_to=${encodeURIComponent(RETURN_TO)}`,
      { redirect: 'manual' },
    );
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get('location')!);
    // Portal handoff (frontend /auth/callback?code=…), NOT the return_to.
    expect(loc.pathname).toBe('/auth/callback');
    expect(loc.searchParams.get('code')).toMatch(/^[0-9a-f]{64}$/);
    expect(res.headers.get('set-cookie') ?? '').not.toMatch(/hadron_token=/);
  });
});

// ── Full dance — verify lands back on consent ────────────────────────

describe('email leg end-to-end: entry page → verify → consent', () => {
  it('the tapped link signs in and the return_to URL renders consent', async () => {
    // 1. Entry page (captures the real return_to the form would submit).
    const { csrfToken, csrfCookieValue, returnTo } = await startEmailEntryFlow();

    // 2. Submit the address (send is mocked; grab the return_to it carried).
    const post = await postAuthorizeEmail(
      { _csrf: csrfToken, return_to: returnTo, email: 'dance@example.test' },
      { csrfCookieValue },
    );
    expect(post.status).toBe(200);
    const [, , , , sentReturnTo] = sendMagicLinkMock.mock.calls[0];

    // 3. Simulate the emailed link: mint the token row the real
    // sendMagicLink would have created (unbound — Option-C).
    const token = await insertEmailToken({ email: 'dance@example.test' });
    const verify = await fetch(
      `${baseUrl}/auth/email/verify?token=${token}&return_to=${encodeURIComponent(sentReturnTo)}`,
      { redirect: 'manual' },
    );
    expect(verify.status).toBe(302);
    expect(verify.headers.get('location')).toBe(sentReturnTo);
    const cookie = verify.headers.get('set-cookie')!.match(/(hadron_token=[^;]+)/)![1];

    // 4. Follow the redirect with the fresh cookie → consent renders.
    const consent = await fetch(`${baseUrl}${sentReturnTo}`, {
      redirect: 'manual',
      headers: { cookie },
    });
    expect(consent.status).toBe(200);
    const html = await consent.text();
    expect(html).toContain('name="decision"');
    expect(html).toContain(`value="${testClientId}"`);
  });
});

// ── App Review demo bypass (REVIEW_DEMO_EMAIL + REVIEW_DEMO_CODE) ────

describe('POST /oauth/authorize/email — App Review demo bypass', () => {
  const DEMO_EMAIL = 'review-demo@example.test';
  const DEMO_CODE = '424242';

  /** Enable the bypass for one test; afterEach restores. */
  function enableBypass() {
    process.env.REVIEW_DEMO_EMAIL = DEMO_EMAIL;
    process.env.REVIEW_DEMO_CODE = DEMO_CODE;
  }

  afterEach(() => {
    delete process.env.REVIEW_DEMO_EMAIL;
    delete process.env.REVIEW_DEMO_CODE;
  });

  async function createDemoUser() {
    return db.user.create({
      data: { id: generateId(), handle: 'review-demo', email: DEMO_EMAIL, roles: ['READER'] },
    });
  }

  /** Submit the entry form with the demo address; returns the response. */
  async function submitDemoEmail() {
    const { csrfToken, csrfCookieValue, returnTo } = await startEmailEntryFlow();
    const res = await postAuthorizeEmail(
      { _csrf: csrfToken, return_to: returnTo, email: DEMO_EMAIL },
      { csrfCookieValue },
    );
    return { res, returnTo };
  }

  /** Extract csrf token + cookie from the rendered code page. */
  function parseCodePage(html: string, setCookie: string | null) {
    const tokenMatch = html.match(/name="_csrf"\s+value="([^"]+)"/);
    expect(tokenMatch, 'csrf token must be in the code-entry HTML').not.toBeNull();
    const cookieMatch = (setCookie ?? '').match(/_hadron_csrf=([^;]+)/);
    expect(cookieMatch, 'fresh _hadron_csrf cookie must accompany the code page').not.toBeNull();
    return { csrfToken: tokenMatch![1], csrfCookieValue: cookieMatch![1] };
  }

  async function postCode(fields: Record<string, string>, csrfCookieValue: string) {
    return fetch(`${baseUrl}/oauth/authorize/email/code`, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: `_hadron_csrf=${csrfCookieValue}`,
      },
      body: new URLSearchParams(fields).toString(),
    });
  }

  it('inactive when the env vars are unset: demo address gets a normal send', async () => {
    const { res } = await submitDemoEmail();
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Check your email');
    expect(sendMagicLinkMock).toHaveBeenCalledTimes(1);
  });

  it('active: demo address renders the code page and sends NO email', async () => {
    enableBypass();
    await createDemoUser();
    const { res } = await submitDemoEmail();
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Enter access code');
    expect(html).toContain('/oauth/authorize/email/code');
    expect(sendMagicLinkMock).not.toHaveBeenCalled();
  });

  it('active: a non-demo address still gets the normal send', async () => {
    enableBypass();
    const { csrfToken, csrfCookieValue, returnTo } = await startEmailEntryFlow();
    const res = await postAuthorizeEmail(
      { _csrf: csrfToken, return_to: returnTo, email: 'someone-else@example.test' },
      { csrfCookieValue },
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Check your email');
    expect(sendMagicLinkMock).toHaveBeenCalledTimes(1);
  });

  it('wrong code → generic 400, no cookie', async () => {
    enableBypass();
    await createDemoUser();
    const { res, returnTo } = await submitDemoEmail();
    const { csrfToken, csrfCookieValue } = parseCodePage(await res.text(), res.headers.get('set-cookie'));
    const codeRes = await postCode(
      { _csrf: csrfToken, return_to: returnTo, email: DEMO_EMAIL, code: '999999' },
      csrfCookieValue,
    );
    expect(codeRes.status).toBe(400);
    expect(codeRes.headers.get('set-cookie') ?? '').not.toContain('hadron_token=');
  });

  it('correct code signs into the EXISTING demo user and 302s to return_to', async () => {
    enableBypass();
    const demoUser = await createDemoUser();
    const { res, returnTo } = await submitDemoEmail();
    const { csrfToken, csrfCookieValue } = parseCodePage(await res.text(), res.headers.get('set-cookie'));
    const codeRes = await postCode(
      { _csrf: csrfToken, return_to: returnTo, email: DEMO_EMAIL, code: DEMO_CODE },
      csrfCookieValue,
    );
    expect(codeRes.status).toBe(302);
    expect(codeRes.headers.get('location')).toBe(returnTo);
    const setCookie = codeRes.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('hadron_token=');
    // The minted session belongs to the pre-existing demo user.
    const jwt = setCookie.match(/hadron_token=([^;]+)/)![1];
    const payload = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString());
    expect(payload.sub).toBe(demoUser.id);
    // Bypass never creates users.
    expect(await db.user.count({ where: { email: DEMO_EMAIL } })).toBe(1);
  });

  it('correct code but NO existing user → generic 400 (never auto-creates)', async () => {
    enableBypass();
    const { res, returnTo } = await submitDemoEmail();
    const { csrfToken, csrfCookieValue } = parseCodePage(await res.text(), res.headers.get('set-cookie'));
    const codeRes = await postCode(
      { _csrf: csrfToken, return_to: returnTo, email: DEMO_EMAIL, code: DEMO_CODE },
      csrfCookieValue,
    );
    expect(codeRes.status).toBe(400);
    expect(await db.user.count({ where: { email: DEMO_EMAIL } })).toBe(0);
  });

  it('code POST without CSRF → 403', async () => {
    enableBypass();
    await createDemoUser();
    const { returnTo } = await submitDemoEmail();
    const res = await fetch(`${baseUrl}/oauth/authorize/email/code`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ return_to: returnTo, email: DEMO_EMAIL, code: DEMO_CODE }).toString(),
    });
    expect(res.status).toBe(403);
  });
});
