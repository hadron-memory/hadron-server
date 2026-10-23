/**
 * Durable pending login state — the DB-backed replacement for the three
 * in-process `pendingStates` Maps (GitHub / Google / Apple).
 *
 * Context: Apple App Review failed with "the app failed to login with
 * Apple" — any deploy/restart wiped the in-flight Maps and the provider
 * callback then answered a raw-JSON 400 dead end; a user slower than the
 * TTL at the IdP hit the same wall. Covered here:
 *
 *   - a state minted before a "restart" is claimable afterwards (with DB
 *     backing, the restart survival IS the DB row: the claim goes through
 *     a fresh call path with no shared process state);
 *   - single use — the second claim of the same state fails;
 *   - expired / unknown / missing state → 400 with the human-readable
 *     HTML page (not raw JSON), friendly copy present;
 *   - a KNOWN state gets past the 400 guards (the positive discriminator
 *     for the Apple callback's urlencoded body parsing);
 *   - provider binding — a state minted for one provider is not claimable
 *     by another's callback;
 *   - the start-route lazy sweep removes expired rows;
 *   - the shared TTL gives slow IdP flows 15 minutes of headroom.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { AddressInfo } from 'node:net';
import { createServer as createHttpServer, type Server } from 'node:http';
import { createServer } from '../../server.js';
import { db } from '../../integrations/db/client.js';
import {
  claimPendingLoginState,
  LOGIN_STATE_TTL_MS,
} from '../../auth/pendingLoginState.js';

let server: Server;
let baseUrl: string;

const APPLE_ENV_VARS = [
  'APPLE_CLIENT_ID',
  'APPLE_TEAM_ID',
  'APPLE_KEY_ID',
  'APPLE_PRIVATE_KEY',
] as const;
const savedEnv: Partial<Record<(typeof APPLE_ENV_VARS)[number], string | undefined>> = {};

beforeAll(async () => {
  // Apple flow needs the four env vars to answer at all. The private key is a
  // deliberate non-PEM placeholder: the callback's code exchange then fails
  // INSIDE mintAppleClientSecret (importPKCS8), before any network I/O — so a
  // valid-state POST deterministically exercises the exchange_failed path.
  for (const v of APPLE_ENV_VARS) savedEnv[v] = process.env[v];
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
  for (const v of APPLE_ENV_VARS) {
    if (savedEnv[v] === undefined) delete process.env[v];
    else process.env[v] = savedEnv[v];
  }
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
});

beforeEach(async () => {
  // The login flows only touch pending_login_states before the exchange; no
  // other tables are involved in these tests.
  await db.pendingLoginState.deleteMany();
});

/** Start a GitHub login and return the minted state (from the 302 to GitHub). */
async function startGithubLogin(): Promise<string> {
  const res = await fetch(`${baseUrl}/auth/github?client_state=${'a'.repeat(64)}`, {
    redirect: 'manual',
  });
  expect(res.status).toBe(302);
  return new URL(res.headers.get('location')!).searchParams.get('state')!;
}

/** Drive the Apple callback the way Apple does: a cross-site form POST. */
async function postAppleCallback(fields: Record<string, string>): Promise<Response> {
  return fetch(`${baseUrl}/auth/apple/callback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields),
    redirect: 'manual',
  });
}

const FRIENDLY_TITLE = 'Sign-in didn&#39;t complete';

describe('durable pending login state', () => {
  it('survives a restart: the state minted at the start route is a DB row a fresh process can claim', async () => {
    const state = await startGithubLogin();

    // The pending state is durable — nothing about it lives in the Express
    // app's process memory.
    const row = await db.pendingLoginState.findUnique({ where: { state } });
    expect(row).not.toBeNull();
    expect(row!.provider).toBe('github');
    expect(row!.clientState).toBe('a'.repeat(64));

    // Claim through a fresh call path (module import, not the server that
    // minted it) — exactly what a post-deploy worker does.
    const claim = await claimPendingLoginState(state, 'github');
    expect(claim.ok).toBe(true);
    if (claim.ok) {
      expect(claim.pending.redirect).toBe('/');
      expect(claim.pending.clientState).toBe('a'.repeat(64));
    }
  });

  it('gives slow IdP flows 15 minutes (shared TTL constant)', async () => {
    expect(LOGIN_STATE_TTL_MS).toBe(15 * 60 * 1000);
    const state = await startGithubLogin();
    const row = await db.pendingLoginState.findUnique({ where: { state } });
    const ttl = row!.expiresAt.getTime() - row!.createdAt.getTime();
    expect(ttl).toBeGreaterThan(14 * 60 * 1000);
    expect(ttl).toBeLessThanOrEqual(16 * 60 * 1000);
  });

  it('is single-use: the second claim of the same state fails', async () => {
    const state = await startGithubLogin();
    const first = await claimPendingLoginState(state, 'github');
    expect(first.ok).toBe(true);
    const second = await claimPendingLoginState(state, 'github');
    expect(second).toEqual({ ok: false, reason: 'state_unknown' });
  });

  it('is provider-bound: a GitHub state is not claimable as Apple', async () => {
    const state = await startGithubLogin();
    const claim = await claimPendingLoginState(state, 'apple');
    // Indistinguishable from a never-issued state — no cross-provider oracle.
    expect(claim).toEqual({ ok: false, reason: 'state_unknown' });
  });

  it('a wrong-provider attempt does NOT burn the rightful login (PR-894 Codex P2)', async () => {
    const state = await startGithubLogin();
    // The provider-scoped conditional delete affects zero rows here...
    expect(await claimPendingLoginState(state, 'apple')).toEqual({
      ok: false,
      reason: 'state_unknown',
    });
    // ...so the in-flight GitHub login still completes.
    const claim = await claimPendingLoginState(state, 'github');
    expect(claim.ok).toBe(true);
  });

  it('answers an EXPIRED state with the friendly 400 HTML page and burns the row', async () => {
    const state = 'e'.repeat(32);
    await db.pendingLoginState.create({
      data: {
        state,
        provider: 'apple',
        redirect: '/',
        clientState: 'c'.repeat(64),
        providerNonceHash: 'a'.repeat(64),
        expiresAt: new Date(Date.now() - 1000),
      },
    });

    const res = await postAppleCallback({ code: 'x', state });
    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    const body = await res.text();
    expect(body).toContain(FRIENDLY_TITLE);
    expect(body).toContain('Your sign-in session expired or was interrupted.');
    // No technical detail leaks to the page (the old raw-JSON body).
    expect(body).not.toContain('Invalid or expired state');
    expect(body).not.toContain('state_expired');

    // The expired claim consumed the row (single use even on failure).
    expect(await db.pendingLoginState.findUnique({ where: { state } })).toBeNull();
  });

  it('answers an UNKNOWN state with the friendly 400 HTML page (github callback)', async () => {
    const res = await fetch(
      `${baseUrl}/auth/github/callback?code=x&state=${'f'.repeat(32)}`,
      { redirect: 'manual' },
    );
    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    expect(await res.text()).toContain(FRIENDLY_TITLE);
  });

  it('lets a KNOWN state past the 400 guards, and only once (apple, exchange fails → friendly 500)', async () => {
    // Start a real Apple login to mint a valid state.
    const start = await fetch(`${baseUrl}/auth/apple?client_state=${'b'.repeat(64)}`, {
      redirect: 'manual',
    });
    expect(start.status).toBe(302);
    const state = new URL(start.headers.get('location')!).searchParams.get('state')!;

    // First POST: the state IS recognized (this is the positive discriminator
    // proving the urlencoded body reached the handler and the claim worked),
    // so the flow proceeds to the code exchange — which fails on the
    // placeholder key, landing on the friendly page with a 500.
    const first = await postAppleCallback({ code: 'x', state });
    expect(first.status).toBe(500);
    expect(first.headers.get('content-type')).toMatch(/text\/html/);
    expect(await first.text()).toContain(FRIENDLY_TITLE);

    // Second POST with the same state: already claimed → 400.
    const second = await postAppleCallback({ code: 'x', state });
    expect(second.status).toBe(400);
    expect(second.headers.get('content-type')).toMatch(/text\/html/);
  });

  it('sweeps expired rows lazily on a start-route hit', async () => {
    await db.pendingLoginState.create({
      data: {
        state: 'd'.repeat(32),
        provider: 'google',
        redirect: '/',
        providerNonceHash: 'a'.repeat(64),
        expiresAt: new Date(Date.now() - 1000),
      },
    });
    await startGithubLogin();
    expect(
      await db.pendingLoginState.findUnique({ where: { state: 'd'.repeat(32) } }),
    ).toBeNull();
  });
});
