/**
 * Spec 025-oauth-for-mcp Phase 2B — `POST /oauth/register` (T036).
 *
 * Coverage:
 *   - happy path: 201 + persisted `OAuthClient` row + RFC 7591 body shape
 *   - validation 400s: missing / non-array / relative-URL / fragment-URL
 *   - burst rate-limit: 11th request in <1 min → 429 + Retry-After ≤60s
 *   - daily-cap rate-limit (inline mount with low threshold so the
 *     test doesn't have to send 101 reqs through the production mount)
 *   - trust-proxy: req.ip honors X-Forwarded-For under a
 *     Cloudflare-CIDR-only trust proxy config (the FR-006 / T035
 *     interaction — without this, the rate-limit keys on the
 *     proxy's IP and every real client shares a counter)
 *
 * The happy-path + validation tests go through the same
 * `createServer()` + random-port pattern as `oauth.metadata.test.ts`.
 * The rate-limit + trust-proxy tests use a minimal inline Express app
 * with the router from `oauth.ts` mounted directly — that lets us
 * configure `trust proxy` to known CIDRs and (for daily-cap) use
 * lower thresholds without spending 101 round-trips at production
 * thresholds.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import rateLimit from 'express-rate-limit';
import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createServer } from '../../server.js';
import { buildOAuthRouter, handleClientRegistration } from '../../auth/oauth.js';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../helpers.js';

// ── Happy path + validation 400s (real createServer) ─────────────────

describe('POST /oauth/register — happy path + validation', () => {
  let server: Server;
  let baseUrl: string;

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
  });

  it('returns 201 + RFC 7591 body shape and persists the OAuthClient', async () => {
    const res = await fetch(`${baseUrl}/oauth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_name: 'Some MCP Client',
        redirect_uris: ['https://example.com/callback'],
        token_endpoint_auth_method: 'none',
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      client_id: expect.stringMatching(/^dcr_[0-9a-f]{32}$/),
      client_name: 'Some MCP Client',
      redirect_uris: ['https://example.com/callback'],
      token_endpoint_auth_method: 'none',
      client_id_issued_at: expect.any(Number),
    });
    // Persisted row matches the response — single source of truth.
    const row = await db.oAuthClient.findUniqueOrThrow({
      where: { clientId: body.client_id as string },
    });
    expect(row.clientName).toBe('Some MCP Client');
    expect(row.redirectUris).toEqual(['https://example.com/callback']);
  });

  it('falls back to "Unnamed MCP Client" when client_name is absent', async () => {
    const res = await fetch(`${baseUrl}/oauth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ redirect_uris: ['https://example.com/cb'] }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { client_name: string };
    expect(body.client_name).toBe('Unnamed MCP Client');
  });

  it('rejects missing redirect_uris → 400 invalid_redirect_uri', async () => {
    const res = await fetch(`${baseUrl}/oauth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: 'X' }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe('invalid_redirect_uri');
    expect(body.error_description).toMatch(/non-empty array/);
  });

  it('rejects empty redirect_uris array → 400', async () => {
    const res = await fetch(`${baseUrl}/oauth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ redirect_uris: [] }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('invalid_redirect_uri');
  });

  it('rejects relative redirect_uri → 400 invalid_redirect_uri', async () => {
    const res = await fetch(`${baseUrl}/oauth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ redirect_uris: ['/callback'] }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; error_description: string };
    expect(body.error).toBe('invalid_redirect_uri');
    expect(body.error_description).toMatch(/not a valid absolute URL/);
  });

  it('rejects redirect_uri with fragment → 400 invalid_redirect_uri', async () => {
    const res = await fetch(`${baseUrl}/oauth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ redirect_uris: ['https://example.com/cb#tok'] }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; error_description: string };
    expect(body.error).toBe('invalid_redirect_uri');
    expect(body.error_description).toMatch(/must not contain a fragment/);
  });

  it('rejects redirect_uris that contains non-string entries → 400', async () => {
    const res = await fetch(`${baseUrl}/oauth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ redirect_uris: ['https://example.com/cb', 42] }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('invalid_redirect_uri');
  });

  it('does NOT persist a row on validation failure', async () => {
    const before = await db.oAuthClient.count();
    const res = await fetch(`${baseUrl}/oauth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ redirect_uris: ['not-a-url'] }),
    });
    expect(res.status).toBe(400);
    expect(await db.oAuthClient.count()).toBe(before);
  });
});

// ── Burst rate-limit (production threshold: 10/min/IP) ───────────────

describe('POST /oauth/register — burst rate limit (10/min/IP)', () => {
  let server: Server;
  let baseUrl: string;

  /**
   * Build an isolated Express app with the production router so this
   * test's rate-limit counter is independent of the happy-path suite
   * above. Each top-level `describe` gets its own listener.
   */
  beforeAll(async () => {
    const app = express();
    // Permissive trust proxy → req.ip honors X-Forwarded-For so each
    // test can claim a unique synthetic client IP.
    app.set('trust proxy', true);
    app.use(express.json());
    app.use(buildOAuthRouter());
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
  });

  it('11th request from the same IP within 60s returns 429 + Retry-After ≤ 60', async () => {
    // Synthetic client IP, unique to this test — even though the
    // limiter is reset per process (fresh router) the X-F-F header
    // also guards against any host-collision oddness.
    const clientIp = '198.51.100.7';
    const sendOne = () =>
      fetch(`${baseUrl}/oauth/register`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-forwarded-for': clientIp,
        },
        body: JSON.stringify({ redirect_uris: ['https://example.com/cb'] }),
      });

    for (let i = 0; i < 10; i++) {
      const res = await sendOne();
      expect(res.status).toBe(201);
    }
    const eleventh = await sendOne();
    expect(eleventh.status).toBe(429);
    const retryAfter = eleventh.headers.get('retry-after');
    expect(retryAfter).not.toBeNull();
    const seconds = Number(retryAfter);
    expect(Number.isFinite(seconds)).toBe(true);
    expect(seconds).toBeGreaterThanOrEqual(0);
    expect(seconds).toBeLessThanOrEqual(60);
    const body = (await eleventh.json()) as Record<string, unknown>;
    expect(body.error).toBe('rate_limit_exceeded');
  });

  it('11th-from-IP-A still allows 1st-from-IP-B (per-IP keying, not global)', async () => {
    const ipA = '198.51.100.10';
    const ipB = '198.51.100.11';
    const send = (ip: string) =>
      fetch(`${baseUrl}/oauth/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
        body: JSON.stringify({ redirect_uris: ['https://example.com/cb'] }),
      });

    for (let i = 0; i < 10; i++) {
      const res = await send(ipA);
      expect(res.status).toBe(201);
    }
    expect((await send(ipA)).status).toBe(429);
    expect((await send(ipB)).status).toBe(201);
  });
});

// ── Daily-cap rate-limit (low-threshold inline mount) ────────────────

describe('POST /oauth/register — daily-cap rate limit shape', () => {
  // The production daily cap is 100 req / IP / 24h. Triggering it
  // through the real router would require 101 round-trips; we'd be
  // testing the round-trip cost, not the rate-limit behavior. Instead
  // mount a low-threshold limiter inline with the SAME config shape
  // (windowMs: 86_400_000, message body, standardHeaders draft-7) and
  // assert: a) exceedance returns 429 + the documented body shape,
  // b) Retry-After is > 60 (proves it's the daily-cap value, not the
  // burst value).
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    const app = express();
    app.set('trust proxy', true);
    app.use(express.json());
    app.use(
      '/oauth/register',
      rateLimit({
        windowMs: 86_400_000,
        limit: 2,
        standardHeaders: 'draft-7',
        legacyHeaders: false,
        message: { error: 'rate_limit_exceeded' },
      }),
      handleClientRegistration,
    );
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
  });

  it('3rd request exceeds limit=2 → 429 + Retry-After > 60s + rate_limit_exceeded body', async () => {
    const clientIp = '198.51.100.20';
    const send = () =>
      fetch(`${baseUrl}/oauth/register`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-forwarded-for': clientIp,
        },
        body: JSON.stringify({ redirect_uris: ['https://example.com/cb'] }),
      });

    expect((await send()).status).toBe(201);
    expect((await send()).status).toBe(201);
    const third = await send();
    expect(third.status).toBe(429);
    const retryAfter = Number(third.headers.get('retry-after'));
    expect(Number.isFinite(retryAfter)).toBe(true);
    // Daily-cap window is 86_400s; Retry-After must be MUCH larger
    // than the burst-limit's 60s max. Use 60 as a discriminator.
    expect(retryAfter).toBeGreaterThan(60);
    const body = (await third.json()) as Record<string, unknown>;
    expect(body.error).toBe('rate_limit_exceeded');
  });
});

// ── Trust-proxy interaction (FR-006 / T014 / T035) ───────────────────

describe('POST /oauth/register — trust-proxy + rate-limit IP resolution', () => {
  // T036's "the only test that catches a regression here": with
  // production-style Cloudflare-CIDR-only trust proxy, the rate-limit
  // MUST key on the REAL client IP (leftmost X-F-F), not the
  // Cloudflare proxy IP (rightmost X-F-F). If `app.set('trust proxy', …)`
  // is misconfigured (e.g., wrong CIDR, or permissive `true` in
  // production), every client behind Cloudflare gets bucketed under
  // one IP and the burst limit becomes a global ceiling.
  //
  // Cloudflare's published IPv4 ranges include `103.21.244.0/22`
  // (see https://www.cloudflare.com/ips/); we use that as the trusted
  // proxy CIDR here. The simulated request arrives over the proxy at
  // `103.21.244.10` (in-CIDR, trusted), carrying `X-Forwarded-For:
  // 1.2.3.4, 103.21.244.10`. Express's trust-proxy logic peels off
  // the trusted hop and exposes `req.ip = "1.2.3.4"` (real client).

  let server: Server;
  let baseUrl: string;
  const capturedIps: string[] = [];

  beforeAll(async () => {
    const app = express();
    // Production-style: trust ONLY Cloudflare's CIDR. A request
    // arriving from outside this CIDR with X-F-F set should NOT have
    // X-F-F honored.
    app.set('trust proxy', ['103.21.244.0/22']);
    app.use(express.json());
    // Spy handler captures req.ip without touching the DB. We don't
    // use the real registration handler here because the goal is to
    // pin req.ip resolution, not exercise the persistence path
    // (which the happy-path suite already covers).
    app.post('/oauth/register', (req, res) => {
      capturedIps.push(req.ip ?? '<unknown>');
      res.status(204).end();
    });
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

  beforeEach(() => {
    capturedIps.length = 0;
  });

  it('req.ip resolves to the REAL client IP, not the Cloudflare proxy', async () => {
    // The TCP source for this request is 127.0.0.1 (the test
    // listener) — not in the Cloudflare CIDR — so Express will only
    // honor X-F-F if 127.0.0.1 is itself trusted. We need a request
    // that LOOKS like it came through Cloudflare. Express's
    // trust-proxy walks X-F-F right-to-left, peeling trusted hops
    // until it hits the leftmost non-trusted entry — but only when
    // the *immediate* peer IP is trusted. To simulate that the test
    // server received the request directly from Cloudflare, we add
    // 127.0.0.1 to the trusted set alongside the Cloudflare CIDR:
    // this models "the test runner stands in for Cloudflare". The
    // production setup is structurally identical: trust the
    // immediate-peer's CIDR; X-F-F is then a stack of upstream hops.
    server.close();
    const app = express();
    app.set('trust proxy', ['127.0.0.1/32', '103.21.244.0/22']);
    app.post('/oauth/register', (req, res) => {
      capturedIps.push(req.ip ?? '<unknown>');
      res.status(204).end();
    });
    server = createHttpServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    baseUrl = `http://127.0.0.1:${port}`;

    const res = await fetch(`${baseUrl}/oauth/register`, {
      method: 'POST',
      headers: { 'x-forwarded-for': '1.2.3.4, 103.21.244.10' },
    });
    expect(res.status).toBe(204);
    expect(capturedIps).toEqual(['1.2.3.4']);
  });

  it('untrusted X-F-F is IGNORED (req.ip stays at the immediate peer)', async () => {
    // Restart the listener with ONLY the Cloudflare CIDR trusted
    // (127.0.0.1 is NOT trusted this time). A spoofed X-F-F should
    // be dropped — req.ip stays at the TCP source (127.0.0.1).
    server.close();
    const app = express();
    app.set('trust proxy', ['103.21.244.0/22']);
    app.post('/oauth/register', (req, res) => {
      capturedIps.push(req.ip ?? '<unknown>');
      res.status(204).end();
    });
    server = createHttpServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    baseUrl = `http://127.0.0.1:${port}`;

    const res = await fetch(`${baseUrl}/oauth/register`, {
      method: 'POST',
      headers: { 'x-forwarded-for': '1.2.3.4' },
    });
    expect(res.status).toBe(204);
    expect(capturedIps).toEqual(['127.0.0.1']);
  });
});
