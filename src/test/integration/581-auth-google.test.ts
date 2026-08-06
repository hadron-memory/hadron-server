/**
 * #581 — /auth/google + /auth/google/callback integration tests.
 *
 * Mirrors 025-auth-github-return-to.test.ts: spins up the real Express app on
 * a random port and asserts on the redirect / 400 / 503 behavior. The
 * callback's happy path (code exchange + ID-token verification) exchanges with
 * Google's API, so it isn't driven end-to-end here — its pieces are unit
 * tested in src/auth/google.test.ts; what IS covered is everything before the
 * exchange: missing params and unknown/expired state.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { AddressInfo } from 'node:net';
import { createServer as createHttpServer, type Server } from 'node:http';
import { createServer } from '../../server.js';

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  // The route reads the env at request time; set it before driving requests.
  process.env.GOOGLE_CLIENT_ID = 'test-client-id.apps.googleusercontent.com';
  process.env.GOOGLE_CLIENT_SECRET = 'test-client-secret';
  const app = await createServer();
  server = createHttpServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  delete process.env.GOOGLE_CLIENT_ID;
  delete process.env.GOOGLE_CLIENT_SECRET;
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
});

/** Drive /auth/google with redirects disabled so the 302 to Google's auth URL
 *  can be inspected without following it. */
async function getAuthGoogle(qs: string): Promise<Response> {
  return fetch(`${baseUrl}/auth/google${qs}`, { redirect: 'manual' });
}

describe('/auth/google GET', () => {
  it('302s to accounts.google.com with login-only scopes on the portal-handoff path', async () => {
    const res = await getAuthGoogle('?client_state=' + 'a'.repeat(64));
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get('location')!);
    expect(location.origin + location.pathname).toBe(
      'https://accounts.google.com/o/oauth2/v2/auth',
    );
    expect(location.searchParams.get('scope')).toBe('openid email profile');
    expect(location.searchParams.get('state')).toMatch(/^[0-9a-f]{32}$/);
  });

  it('accepts return_to=/oauth/authorize?state=abc (Option-C, server-local)', async () => {
    const res = await getAuthGoogle(
      '?return_to=' + encodeURIComponent('/oauth/authorize?state=abc'),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toMatch(/accounts\.google\.com/);
  });

  it('rejects a bare start with no return_to and no client_state (#477 fixation binding)', async () => {
    const res = await getAuthGoogle('');
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/client_state is required/);
  });

  it('rejects return_to=https://evil.example (open redirect) with 400', async () => {
    const res = await getAuthGoogle(
      '?return_to=' + encodeURIComponent('https://evil.example/grab-cookie'),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/Invalid return_to/);
  });

  it('rejects return_to=//evil.example (protocol-relative) with 400', async () => {
    const res = await getAuthGoogle(
      '?return_to=' + encodeURIComponent('//evil.example/grab-cookie'),
    );
    expect(res.status).toBe(400);
  });

  it('rejects return_to with an embedded newline (CRLF-injection class) with 400', async () => {
    const res = await getAuthGoogle(
      '?return_to=' + encodeURIComponent('/foo\r\nLocation: //evil.example'),
    );
    expect(res.status).toBe(400);
  });

  it('does NOT set the hadron_token cookie on the GET response', async () => {
    const res = await getAuthGoogle('?return_to=' + encodeURIComponent('/oauth/authorize'));
    expect(res.status).toBe(302);
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) {
      expect(setCookie).not.toMatch(/\bhadron_token\b/);
    }
  });

  it('answers 503 when the Google OAuth client is not configured', async () => {
    // Unset at request time — the route must fail loud instead of 302ing to a
    // Google error page with an undefined client_id.
    const saved = process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_ID;
    try {
      const res = await getAuthGoogle('?client_state=' + 'a'.repeat(64));
      expect(res.status).toBe(503);
      const body = (await res.json()) as { error: string };
      expect(body.error).toMatch(/not configured/);
    } finally {
      process.env.GOOGLE_CLIENT_ID = saved;
    }
  });
});

describe('/auth/google/callback GET — pre-exchange guards', () => {
  // Callback failures render the friendly HTML page (these endpoints are only
  // ever hit by browsers); the diagnostic reason code goes to the server log.
  it('rejects a callback with missing code or state (400, human-readable HTML)', async () => {
    const res = await fetch(`${baseUrl}/auth/google/callback`, { redirect: 'manual' });
    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    const body = await res.text();
    expect(body).toContain('Sign-in didn&#39;t complete');
    expect(body).toContain('expired or was interrupted');
  });

  it('rejects an unknown state (covers the expired-and-swept case too)', async () => {
    const res = await fetch(
      `${baseUrl}/auth/google/callback?code=x&state=${'f'.repeat(32)}`,
      { redirect: 'manual' },
    );
    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    expect(await res.text()).toContain('Sign-in didn&#39;t complete');
  });

  it('does not accept a GitHub-flow state at the Google callback (provider binding)', async () => {
    // Mint a pending state via /auth/github, then try to redeem it at the
    // Google callback — cross-provider replay must fail.
    const gh = await fetch(`${baseUrl}/auth/github?client_state=${'b'.repeat(64)}`, {
      redirect: 'manual',
    });
    expect(gh.status).toBe(302);
    const ghState = new URL(gh.headers.get('location')!).searchParams.get('state')!;
    const res = await fetch(`${baseUrl}/auth/google/callback?code=x&state=${ghState}`, {
      redirect: 'manual',
    });
    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
  });
});
