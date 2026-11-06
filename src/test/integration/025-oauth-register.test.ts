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

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
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
  // TEST-NET-3 (RFC 5737) — IPs reserved for documentation/test that
  // will never appear in the wild. The happy-path block now has >10
  // tests; the production burst limiter is 10/IP/min, so every test
  // must claim a distinct synthetic client IP via X-F-F or the late
  // tests in the block get 429'd by leftover counter state from the
  // earlier tests (the router is built once via createServer; the
  // limiter persists across tests in the block).
  let nextIpOctet = 0;
  const uniqueTestIp = () => `203.0.113.${(nextIpOctet = (nextIpOctet + 1) % 254)}`;

  async function postRegister(body: unknown): Promise<Response> {
    return fetch(`${baseUrl}/oauth/register`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': uniqueTestIp(),
      },
      body: JSON.stringify(body),
    });
  }

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
    const res = await postRegister({
      client_name: 'Some MCP Client',
      redirect_uris: ['https://example.com/callback'],
      token_endpoint_auth_method: 'none',
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

  it('#155: a registered client expires 30 days from registration unless it is used', async () => {
    const before = Date.now();
    const res = await postRegister({ client_name: 'Expiring Client', redirect_uris: ['https://example.com/cb'] });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { client_id: string };
    const row = await db.oAuthClient.findUniqueOrThrow({ where: { clientId: body.client_id } });
    const thirtyDays = 30 * 24 * 60 * 60 * 1000;
    expect(row.expiresAt).not.toBeNull();
    expect(row.expiresAt!.getTime()).toBeGreaterThanOrEqual(before + thirtyDays);
    expect(row.expiresAt!.getTime()).toBeLessThanOrEqual(Date.now() + thirtyDays);
  });

  it('falls back to "Unnamed MCP Client" when client_name is absent', async () => {
    const res = await postRegister({ redirect_uris: ['https://example.com/cb'] });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { client_name: string };
    expect(body.client_name).toBe('Unnamed MCP Client');
  });

  it('rejects missing redirect_uris → 400 invalid_redirect_uri', async () => {
    const res = await postRegister({ client_name: 'X' });
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe('invalid_redirect_uri');
    expect(body.error_description).toMatch(/non-empty array/);
  });

  it('rejects empty redirect_uris array → 400', async () => {
    const res = await postRegister({ redirect_uris: [] });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('invalid_redirect_uri');
  });

  it('rejects relative redirect_uri → 400 invalid_redirect_uri', async () => {
    const res = await postRegister({ redirect_uris: ['/callback'] });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; error_description: string };
    expect(body.error).toBe('invalid_redirect_uri');
    expect(body.error_description).toMatch(/not a valid absolute URL/);
  });

  it('rejects redirect_uri with fragment → 400 invalid_redirect_uri', async () => {
    const res = await postRegister({ redirect_uris: ['https://example.com/cb#tok'] });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; error_description: string };
    expect(body.error).toBe('invalid_redirect_uri');
    expect(body.error_description).toMatch(/must not contain a fragment/);
  });

  it('rejects redirect_uris that contains non-string entries → 400', async () => {
    const res = await postRegister({ redirect_uris: ['https://example.com/cb', 42] });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('invalid_redirect_uri');
  });

  it('does NOT persist a row on validation failure', async () => {
    const before = await db.oAuthClient.count();
    const res = await postRegister({ redirect_uris: ['not-a-url'] });
    expect(res.status).toBe(400);
    expect(await db.oAuthClient.count()).toBe(before);
  });

  it.each([
    ['javascript', 'javascript:alert(1)'],
    ['data', 'data:text/html,<script>alert(1)</script>'],
    ['file', 'file:///etc/passwd'],
  ])(
    'rejects protocol-injection scheme (%s) — empty host → 400',
    async (_name, uri) => {
      // These schemes parse successfully (URL accepts them) but
      // resolve to an empty host. The `!parsed.host` check in
      // validateRedirectUris is the load-bearing defense; this test
      // regression-guards that line.
      const res = await postRegister({ redirect_uris: [uri] });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string; error_description: string };
      expect(body.error).toBe('invalid_redirect_uri');
      expect(body.error_description).toMatch(/scheme \+ authority/);
    },
  );

  it('rejects redirect_uris array longer than the documented cap → 400', async () => {
    const tooMany = Array.from({ length: 21 }, (_, i) => `https://example.com/cb${i}`);
    const res = await postRegister({ redirect_uris: tooMany });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; error_description: string };
    expect(body.error).toBe('invalid_redirect_uri');
    expect(body.error_description).toMatch(/at most 20/);
  });

  it('rejects a single redirect_uri longer than 2048 chars → 400', async () => {
    const longPath = 'x'.repeat(2100);
    const res = await postRegister({
      redirect_uris: [`https://example.com/${longPath}`],
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; error_description: string };
    expect(body.error).toBe('invalid_redirect_uri');
    expect(body.error_description).toMatch(/at most 2048/);
  });
});

// ── DB failure path (Issue #1 regression guard) ──────────────────────

describe('POST /oauth/register — DB failure returns 500 (not a crash)', () => {
  // Express 4 does not auto-forward rejected async-handler promises
  // to error middleware. Before the try/catch landed, a thrown
  // Prisma error crashed the process. This test pins the 500
  // behavior so a future refactor that drops the try/catch fails
  // here before it lands in production.
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

  it('returns 500 + server_error when oAuthClient.create throws', async () => {
    const spy = vi
      .spyOn(db.oAuthClient, 'create')
      .mockRejectedValueOnce(new Error('simulated DB outage'));
    try {
      const res = await fetch(`${baseUrl}/oauth/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          client_name: 'X',
          redirect_uris: ['https://example.com/cb'],
        }),
      });
      expect(res.status).toBe(500);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.error).toBe('server_error');
      // The 500 body MUST NOT echo the raw DB error message (could
      // leak internal identifiers / constraints).
      expect(JSON.stringify(body)).not.toMatch(/simulated DB outage/);
      // The next request must succeed — confirms the failure was
      // contained to one request, not a process-level crash.
      const followUp = await fetch(`${baseUrl}/oauth/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ redirect_uris: ['https://example.com/cb'] }),
      });
      expect(followUp.status).toBe(201);
    } finally {
      spy.mockRestore();
    }
  });
});

// ── #156: one operator log line per successful registration ──────────

describe('POST /oauth/register — #156 dcr_registered log line', () => {
  let server: Server;
  let baseUrl: string;
  let ipOctet = 100;
  const post = (body: unknown) => fetch(`${baseUrl}/oauth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': `198.51.100.${ipOctet++}` },
    body: JSON.stringify(body),
  });
  /** The `[oauth] dcr_registered` calls only; other boot/request logs are ignored. */
  const dcrLines = (spy: { mock: { calls: unknown[][] } }) =>
    spy.mock.calls.filter((call) => call[0] === '[oauth] dcr_registered');

  beforeAll(async () => {
    const app = await createServer();
    server = createHttpServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  });
  beforeEach(async () => { await cleanDb(db); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('logs exactly one line with client_id, client_name and ip, and never a redirect URI', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const res = await post({ client_name: 'Some MCP Client', redirect_uris: ['https://example.com/cb?state=secret'] });
    expect(res.status).toBe(201);
    const { client_id } = (await res.json()) as { client_id: string };
    const lines = dcrLines(spy);
    expect(lines).toHaveLength(1);
    const [, payload] = lines[0] as [string, Record<string, unknown>];
    expect(payload).toEqual({ client_id, client_name: 'Some MCP Client', ip: expect.any(String) });
    expect((payload.ip as string).length).toBeGreaterThan(0);
    expect(JSON.stringify(lines)).not.toMatch(/example\.com|state=secret/);
  });

  it('strips control characters and truncates client_name to 80 before logging', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const forged = 'Evil\n[oauth] dcr_registered { client_id: "dcr_fake" }\r\u0007\u2028' + 'x'.repeat(200);
    expect((await post({ client_name: forged, redirect_uris: ['https://example.com/cb'] })).status).toBe(201);
    const [, payload] = dcrLines(spy)[0] as [string, { client_name: string }];
    expect(payload.client_name).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/);
    expect(payload.client_name.length).toBe(80);
    expect(payload.client_name.startsWith('Evil[oauth] dcr_registered')).toBe(true);
  });

  it('logs nothing for a refused (400) registration', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect((await post({ client_name: 'X', redirect_uris: ['relative/cb'] })).status).toBe(400);
    expect(dcrLines(spy)).toHaveLength(0);
  });

  it('logs nothing when persisting the registration fails (500)', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(db.oAuthClient, 'create').mockRejectedValueOnce(new Error('simulated DB outage'));
    expect((await post({ client_name: 'X', redirect_uris: ['https://example.com/cb'] })).status).toBe(500);
    expect(dcrLines(spy)).toHaveLength(0);
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

  it('429 from burst limiter has Retry-After ≤ 60 (not 86400 — daily limiter has not run)', async () => {
    // Pins middleware ordering: burst → daily → handler. If the
    // ordering were reversed, the 11th request would be rejected by
    // the daily limiter (Retry-After ~86400). The burst-window
    // Retry-After (≤60) is the only value distinguishing the two
    // limiters in the 429 response shape.
    const clientIp = '198.51.100.12';
    const send = () =>
      fetch(`${baseUrl}/oauth/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': clientIp },
        body: JSON.stringify({ redirect_uris: ['https://example.com/cb'] }),
      });

    for (let i = 0; i < 10; i++) {
      expect((await send()).status).toBe(201);
    }
    const eleventh = await send();
    expect(eleventh.status).toBe(429);
    const retryAfter = Number(eleventh.headers.get('retry-after'));
    expect(retryAfter).toBeLessThanOrEqual(60);
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

  let server: Server | null = null;
  let baseUrl = '';
  const capturedIps: string[] = [];
  const capturedProtocols: string[] = [];

  /**
   * Spin up a fresh listener with the given trust-proxy config. Spy
   * handler captures req.ip + req.protocol without touching the DB —
   * the goal here is to pin both attributions, not exercise
   * persistence (covered by the happy-path suite). Returns nothing;
   * mutates `server` + `baseUrl` so the test body uses them directly.
   */
  async function makeTestApp(trustProxy: string[]): Promise<void> {
    const app = express();
    app.set('trust proxy', trustProxy);
    app.post('/oauth/register', (req, res) => {
      capturedIps.push(req.ip ?? '<unknown>');
      capturedProtocols.push(req.protocol);
      res.status(204).end();
    });
    server = createHttpServer(app);
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    baseUrl = `http://127.0.0.1:${port}`;
  }

  beforeEach(() => {
    capturedIps.length = 0;
    capturedProtocols.length = 0;
  });

  afterEach(async () => {
    // Fully await the listener teardown so the next test starts
    // clean. server.close() is async; not awaiting can cause leaked
    // open handles + flake on CI resource-leak detectors.
    if (server) {
      const s = server;
      server = null;
      await new Promise<void>((resolve, reject) => {
        s.close((err) => (err ? reject(err) : resolve()));
      });
    }
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
    await makeTestApp(['127.0.0.1/32', '103.21.244.0/22']);

    const res = await fetch(`${baseUrl}/oauth/register`, {
      method: 'POST',
      headers: { 'x-forwarded-for': '1.2.3.4, 103.21.244.10' },
    });
    expect(res.status).toBe(204);
    expect(capturedIps).toEqual(['1.2.3.4']);
  });

  it('untrusted X-F-F is IGNORED (req.ip stays at the immediate peer)', async () => {
    // With ONLY the Cloudflare CIDR trusted (127.0.0.1 is NOT trusted
    // this time), a spoofed X-F-F should be dropped — req.ip stays
    // at the TCP source (127.0.0.1).
    await makeTestApp(['103.21.244.0/22']);

    const res = await fetch(`${baseUrl}/oauth/register`, {
      method: 'POST',
      headers: { 'x-forwarded-for': '1.2.3.4' },
    });
    expect(res.status).toBe(204);
    expect(capturedIps).toEqual(['127.0.0.1']);
  });

  // The companion of the IP test: same trust-proxy config, but asserts
  // `req.protocol === 'https'` when the request arrives with
  // `X-Forwarded-Proto: https` through a trusted hop. Closes the test
  // gap surfaced by user-reported production behavior where every URL
  // in OAuth metadata came back as `http://` even though the actual
  // request was reaching the server over Cloudflare-terminated HTTPS.
  // `getServerOrigin` consumes `req.protocol`, so a correct trust-proxy
  // config is load-bearing for the metadata being HTTPS — EXCEPT when
  // `BASE_URL` is set (which is the defense-in-depth
  // path; see oauth.base-url.test.ts).
  it('req.protocol resolves to "https" via X-Forwarded-Proto under a trusted CIDR', async () => {
    await makeTestApp(['127.0.0.1/32', '103.21.244.0/22']);

    const res = await fetch(`${baseUrl}/oauth/register`, {
      method: 'POST',
      headers: {
        'x-forwarded-for': '1.2.3.4, 103.21.244.10',
        'x-forwarded-proto': 'https',
      },
    });
    expect(res.status).toBe(204);
    expect(capturedProtocols).toEqual(['https']);
  });

  it('untrusted X-Forwarded-Proto is IGNORED (req.protocol stays at the TCP scheme)', async () => {
    // The IP-mitigation counterpart for protocol: a spoofed
    // X-Forwarded-Proto from a non-trusted peer must not flip
    // req.protocol. Otherwise an attacker could trivially convince
    // the server that an http:// request is https://, breaking any
    // protocol-conditioned logic downstream.
    await makeTestApp(['103.21.244.0/22']);

    const res = await fetch(`${baseUrl}/oauth/register`, {
      method: 'POST',
      headers: { 'x-forwarded-proto': 'https' },
    });
    expect(res.status).toBe(204);
    // The test listener is plain HTTP (`server.listen` → http server),
    // so the unspoofed TCP scheme is 'http'.
    expect(capturedProtocols).toEqual(['http']);
  });
});
