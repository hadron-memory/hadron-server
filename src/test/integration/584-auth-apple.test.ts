/**
 * #584 — /auth/apple + POST /auth/apple/callback integration tests.
 *
 * Mirrors 581-auth-google.test.ts: real Express app on a random port,
 * asserting on redirect / 400 / 503 behavior. The callback's happy path
 * exchanges with Apple's API (unit-tested pieces in src/auth/apple.test.ts);
 * covered here is everything before the exchange — including that the POST
 * callback actually parses urlencoded form bodies, which is Apple-specific
 * (the app only mounts JSON parsers globally).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { AddressInfo } from 'node:net';
import { createServer as createHttpServer, type Server } from 'node:http';
import { createServer } from '../../server.js';

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  process.env.APPLE_CLIENT_ID = 'com.hadronmemory.signin';
  process.env.APPLE_TEAM_ID = 'TEAMID9999';
  process.env.APPLE_KEY_ID = 'KEYID88888';
  process.env.APPLE_PRIVATE_KEY = 'test-only-placeholder-pem';
  const app = await createServer();
  server = createHttpServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  delete process.env.APPLE_CLIENT_ID;
  delete process.env.APPLE_TEAM_ID;
  delete process.env.APPLE_KEY_ID;
  delete process.env.APPLE_PRIVATE_KEY;
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
});

async function getAuthApple(qs: string): Promise<Response> {
  return fetch(`${baseUrl}/auth/apple${qs}`, { redirect: 'manual' });
}

/** Drive the callback the way Apple does: a cross-site form POST. */
async function postCallback(fields: Record<string, string>): Promise<Response> {
  return fetch(`${baseUrl}/auth/apple/callback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields),
    redirect: 'manual',
  });
}

describe('/auth/apple GET', () => {
  it('302s to appleid.apple.com with form_post + login scopes on the portal-handoff path', async () => {
    const res = await getAuthApple('?client_state=' + 'a'.repeat(64));
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get('location')!);
    expect(location.origin + location.pathname).toBe('https://appleid.apple.com/auth/authorize');
    expect(location.searchParams.get('response_mode')).toBe('form_post');
    expect(location.searchParams.get('scope')).toBe('name email');
    expect(location.searchParams.get('state')).toMatch(/^[0-9a-f]{32}$/);
  });

  it('accepts return_to=/oauth/authorize?state=abc (Option-C, server-local)', async () => {
    const res = await getAuthApple(
      '?return_to=' + encodeURIComponent('/oauth/authorize?state=abc'),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toMatch(/appleid\.apple\.com/);
  });

  it('rejects a bare start with no return_to and no client_state (#477 fixation binding)', async () => {
    const res = await getAuthApple('');
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/client_state is required/);
  });

  it('rejects return_to=https://evil.example (open redirect) with 400', async () => {
    const res = await getAuthApple(
      '?return_to=' + encodeURIComponent('https://evil.example/grab-cookie'),
    );
    expect(res.status).toBe(400);
  });

  it('rejects return_to with an embedded newline (CRLF-injection class) with 400', async () => {
    const res = await getAuthApple(
      '?return_to=' + encodeURIComponent('/foo\r\nLocation: //evil.example'),
    );
    expect(res.status).toBe(400);
  });

  it('does NOT set the hadron_token cookie on the GET response', async () => {
    const res = await getAuthApple('?return_to=' + encodeURIComponent('/oauth/authorize'));
    expect(res.status).toBe(302);
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) {
      expect(setCookie).not.toMatch(/\bhadron_token\b/);
    }
  });

  it('answers 503 when ANY of the four Apple env vars is missing (half-configured)', async () => {
    for (const v of ['APPLE_CLIENT_ID', 'APPLE_TEAM_ID', 'APPLE_KEY_ID', 'APPLE_PRIVATE_KEY']) {
      const saved = process.env[v];
      delete process.env[v];
      try {
        const res = await getAuthApple('?client_state=' + 'a'.repeat(64));
        expect(res.status, `missing ${v}`).toBe(503);
      } finally {
        process.env[v] = saved;
      }
    }
  });
});

describe('POST /auth/apple/callback — pre-exchange guards', () => {
  it('parses the urlencoded form body and rejects an unknown state', async () => {
    // Proves the route-scoped urlencoded parser works (the app is JSON-only
    // globally): the body fields must reach the handler for it to answer the
    // state-specific error rather than "Missing code or state".
    const res = await postCallback({ code: 'x', state: 'f'.repeat(32) });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/Invalid or expired state/);
  });

  it('rejects a callback with missing code or state', async () => {
    const res = await postCallback({});
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/Missing code or state/);
  });

  it('does not answer on GET (Apple form_posts; there is no GET callback)', async () => {
    const res = await fetch(`${baseUrl}/auth/apple/callback?code=x&state=y`, {
      redirect: 'manual',
    });
    expect(res.status).toBe(404);
  });

  it('does not accept a GitHub-flow state at the Apple callback (separate maps)', async () => {
    const gh = await fetch(`${baseUrl}/auth/github?client_state=${'b'.repeat(64)}`, {
      redirect: 'manual',
    });
    expect(gh.status).toBe(302);
    const ghState = new URL(gh.headers.get('location')!).searchParams.get('state')!;
    const res = await postCallback({ code: 'x', state: ghState });
    expect(res.status).toBe(400);
  });
});
