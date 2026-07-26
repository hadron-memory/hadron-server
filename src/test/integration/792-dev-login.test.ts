/**
 * #792 — dev-only login endpoint contract.
 *
 * Drives the real Express app over HTTP (the 477-auth-handoff pattern):
 *   - Every gate failure (flag unset, NODE_ENV=production, non-localhost
 *     Host) answers a plain 404 indistinguishable from a nonexistent route,
 *     even with valid params.
 *   - Unknown email → 404; never auto-creates a user.
 *   - Gates open: 302 into the portal handoff, and the minted code redeems
 *     at POST /auth/session for a JWT that resolves the right user.
 *   - `redirect` is restricted to a server-local path.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import type { AddressInfo } from 'node:net';
import { createServer as createHttpServer, request as httpRequest, type Server } from 'node:http';
import { createServer } from '../../server.js';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../helpers.js';

let server: Server;
let baseUrl: string;

const EMAIL = 'dev-login@example.com';

beforeAll(async () => {
  const app = await createServer();
  server = createHttpServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});

const savedEnv: Record<string, string | undefined> = {};

beforeEach(async () => {
  await cleanDb(db);
  savedEnv.DEV_LOGIN_ENABLED = process.env.DEV_LOGIN_ENABLED;
  savedEnv.NODE_ENV = process.env.NODE_ENV;
  // Default to gates-open; individual tests close specific gates.
  process.env.DEV_LOGIN_ENABLED = 'true';
  await db.user.create({
    data: { email: EMAIL, identityProvider: 'EMAIL', roles: ['READER'] },
  });
});

afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const devLogin = (params: Record<string, string>) => {
  const qs = new URLSearchParams(params).toString();
  return fetch(`${baseUrl}/auth/dev/login?${qs}`, { redirect: 'manual' });
};

describe('GET /auth/dev/login — gates', () => {
  it('404s when DEV_LOGIN_ENABLED is unset, even with valid params', async () => {
    delete process.env.DEV_LOGIN_ENABLED;
    const res = await devLogin({ email: EMAIL });
    expect(res.status).toBe(404);
    // Indistinguishable from a nonexistent route: Express's default HTML
    // "Cannot GET" body, not a JSON error that would reveal the endpoint.
    expect(await res.text()).toContain('Cannot GET /auth/dev/login');
  });

  it('404s when DEV_LOGIN_ENABLED is any value other than "true"', async () => {
    process.env.DEV_LOGIN_ENABLED = '1';
    const res = await devLogin({ email: EMAIL });
    expect(res.status).toBe(404);
  });

  it('404s when NODE_ENV=production, even with the flag set', async () => {
    process.env.NODE_ENV = 'production';
    const res = await devLogin({ email: EMAIL });
    expect(res.status).toBe(404);
    expect(await res.text()).toContain('Cannot GET /auth/dev/login');
  });

  it('404s for a non-localhost Host header, even with the flag set', async () => {
    // fetch() strips the forbidden `host` header, so drive node:http raw.
    const { status, body } = await new Promise<{ status: number; body: string }>(
      (resolve, reject) => {
        const req = httpRequest(
          `${baseUrl}/auth/dev/login?email=${encodeURIComponent(EMAIL)}`,
          { headers: { host: 'hadronmemory.com' } },
          (res) => {
            let data = '';
            res.on('data', (c: Buffer) => (data += c.toString()));
            res.on('end', () => resolve({ status: res.statusCode!, body: data }));
          },
        );
        req.on('error', reject);
        req.end();
      },
    );
    expect(status).toBe(404);
    expect(body).toContain('Cannot GET /auth/dev/login');
  });
});

describe('GET /auth/dev/login — behavior with gates open', () => {
  it('400s without an email param', async () => {
    const res = await devLogin({});
    expect(res.status).toBe(400);
  });

  it('404s on an unknown email and never creates a user', async () => {
    const before = await db.user.count();
    const res = await devLogin({ email: 'nobody@example.com' });
    expect(res.status).toBe(404);
    expect(await db.user.count()).toBe(before);
  });

  it('redirects into the portal handoff; the code redeems to the right user', async () => {
    const res = await devLogin({ email: EMAIL });
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get('location')!);
    expect(location.pathname).toBe('/auth/callback');
    const code = location.searchParams.get('code');
    expect(code).toBeTruthy();

    // Redeem exactly as the portal's server load does (no clientState — the
    // dev code is unbound by design).
    const session = await fetch(`${baseUrl}/auth/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    expect(session.status).toBe(200);
    const { token, redirect, isNew } = (await session.json()) as {
      token: string;
      redirect: string;
      isNew: boolean;
    };
    expect(redirect).toBe('/app/dashboard');
    expect(isNew).toBe(false);

    const me = await fetch(`${baseUrl}/auth/me`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(me.status).toBe(200);
    const meBody = (await me.json()) as { email?: string };
    expect(meBody.email).toBe(EMAIL);
  });

  it('matches the email case-insensitively with surrounding whitespace', async () => {
    const res = await devLogin({ email: '  Dev-Login@Example.COM ' });
    expect(res.status).toBe(302);
  });

  it('honors a server-local redirect param', async () => {
    const res = await devLogin({ email: EMAIL, redirect: '/app/memories' });
    const code = new URL(res.headers.get('location')!).searchParams.get('code');
    const session = await fetch(`${baseUrl}/auth/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    const { redirect } = (await session.json()) as { redirect: string };
    expect(redirect).toBe('/app/memories');
  });

  it('falls back to the default for a non-local redirect param', async () => {
    const res = await devLogin({ email: EMAIL, redirect: 'https://evil.example/x' });
    const code = new URL(res.headers.get('location')!).searchParams.get('code');
    const session = await fetch(`${baseUrl}/auth/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    const { redirect } = (await session.json()) as { redirect: string };
    expect(redirect).toBe('/app/dashboard');
  });
});
