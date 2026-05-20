/**
 * Spec 025-oauth-for-mcp Phase 2A — discovery endpoint tests (T033).
 *
 * Two layers:
 *   - Unit tests against the JSON shape builders (fast, pure).
 *   - HTTP integration tests against the mounted endpoints via the
 *     real Express app (catches Host-header derivation + production
 *     HTTPS behavior end-to-end).
 *
 * The integration suite uses the same createServer() + random-port
 * pattern as src/test/integration/025-auth-github-return-to.test.ts.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { Request, Response } from 'express';
import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createServer } from '../server.js';
import {
  buildProtectedResourceMetadata,
  buildAuthorizationServerMetadata,
  handleProtectedResourceMetadata,
  handleAuthorizationServerMetadata,
} from './oauth.js';

// ── Unit tests: JSON shape builders ──────────────────────────────────

describe('buildProtectedResourceMetadata (RFC 9728)', () => {
  it('returns the documented shape for an http://localhost origin', () => {
    const meta = buildProtectedResourceMetadata('http://localhost:4000');
    expect(meta).toEqual({
      resource: 'http://localhost:4000/mcp',
      authorization_servers: ['http://localhost:4000'],
      scopes_supported: ['mcp'],
      bearer_methods_supported: ['header'],
    });
  });

  it('returns the documented shape for an https production origin', () => {
    const meta = buildProtectedResourceMetadata('https://hadron.example.com');
    expect(meta).toMatchObject({
      resource: 'https://hadron.example.com/mcp',
      authorization_servers: ['https://hadron.example.com'],
    });
  });

  it('advertises only the `mcp` scope (single coarse scope per Clarifications Q-025-004)', () => {
    const meta = buildProtectedResourceMetadata('http://localhost:4000') as {
      scopes_supported: string[];
    };
    expect(meta.scopes_supported).toEqual(['mcp']);
  });

  it('advertises only the `header` Bearer method (no query / form-body Bearer tokens)', () => {
    const meta = buildProtectedResourceMetadata('http://localhost:4000') as {
      bearer_methods_supported: string[];
    };
    expect(meta.bearer_methods_supported).toEqual(['header']);
  });
});

describe('buildAuthorizationServerMetadata (RFC 8414)', () => {
  it('advertises registration_endpoint (EF-001 — required for Claude Desktop)', () => {
    // Without this, Anthropic's backend probes AS metadata and
    // silently bails. The actual /oauth/register handler ships in
    // Phase 2B; the URL is advertised now so the discovery phase
    // succeeds.
    const meta = buildAuthorizationServerMetadata('https://hadron.example.com') as {
      registration_endpoint: string;
    };
    expect(meta.registration_endpoint).toBe('https://hadron.example.com/oauth/register');
  });

  it('declares token_endpoint_auth_methods_supported: ["none"] (EF-002)', () => {
    // RFC 8414's default is ["client_secret_basic"], which leads
    // PKCE-only clients to expect a client secret. Public-client
    // / PKCE-only auth requires the explicit "none" declaration.
    const meta = buildAuthorizationServerMetadata('https://hadron.example.com') as {
      token_endpoint_auth_methods_supported: string[];
    };
    expect(meta.token_endpoint_auth_methods_supported).toEqual(['none']);
  });

  it('declares PKCE S256 only (no plain) per spec', () => {
    const meta = buildAuthorizationServerMetadata('https://hadron.example.com') as {
      code_challenge_methods_supported: string[];
    };
    expect(meta.code_challenge_methods_supported).toEqual(['S256']);
  });

  it('advertises only the authorization_code grant (refresh stubbed)', () => {
    const meta = buildAuthorizationServerMetadata('https://hadron.example.com') as {
      grant_types_supported: string[];
    };
    expect(meta.grant_types_supported).toEqual(['authorization_code']);
  });

  it('returns the full documented shape', () => {
    const meta = buildAuthorizationServerMetadata('https://hadron.example.com');
    expect(meta).toEqual({
      issuer: 'https://hadron.example.com',
      authorization_endpoint: 'https://hadron.example.com/oauth/authorize',
      token_endpoint: 'https://hadron.example.com/oauth/token',
      registration_endpoint: 'https://hadron.example.com/oauth/register',
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code'],
      code_challenge_methods_supported: ['S256'],
      scopes_supported: ['mcp'],
      token_endpoint_auth_methods_supported: ['none'],
    });
  });
});

// ── Integration tests: mounted endpoints ─────────────────────────────

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

describe('GET /.well-known/oauth-protected-resource (PRM endpoint)', () => {
  it('returns 200 + RFC 9728 JSON shape', async () => {
    const res = await fetch(`${baseUrl}/.well-known/oauth-protected-resource`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    const body = await res.json();
    expect(body).toMatchObject({
      resource: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/),
      authorization_servers: expect.arrayContaining([
        expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/),
      ]),
      scopes_supported: ['mcp'],
      bearer_methods_supported: ['header'],
    });
  });

  it('sets Cache-Control: public, max-age=86400 for CDN + client caches', async () => {
    // Discovery metadata changes rarely; Claude Desktop refreshes on
    // every reconnect. A 1-day TTL lets Cloudflare's edge serve the
    // bulk of probes without hitting Express.
    const res = await fetch(`${baseUrl}/.well-known/oauth-protected-resource`);
    expect(res.headers.get('cache-control')).toBe('public, max-age=86400');
  });

  // Missing-Host case is unit-tested against the exported handler
  // below (Node's built-in HTTP client always emits a Host header,
  // so a real-HTTP integration test can't reach this branch — the
  // closest we can get is a direct handler call with a mocked req
  // whose `get('host')` returns undefined).
});

describe('handleProtectedResourceMetadata + handleAuthorizationServerMetadata — Host header missing', () => {
  function makeReq(opts: { host?: string; protocol?: string } = {}): Request {
    return {
      protocol: opts.protocol ?? 'http',
      get: (name: string) =>
        name.toLowerCase() === 'host' ? opts.host : undefined,
    } as unknown as Request;
  }

  function makeRes(): Response & {
    _status: number;
    _body: unknown;
    _headers: Record<string, string>;
  } {
    let status = 200;
    let body: unknown;
    const headers: Record<string, string> = {};
    const res = {
      status: vi.fn((c: number) => {
        status = c;
        return res;
      }),
      json: vi.fn((p: unknown) => {
        body = p;
        return res;
      }),
      setHeader: vi.fn((name: string, value: string) => {
        headers[name] = value;
        return res;
      }),
      get _status() {
        return status;
      },
      get _body() {
        return body;
      },
      get _headers() {
        return headers;
      },
    };
    return res as unknown as Response & {
      _status: number;
      _body: unknown;
      _headers: Record<string, string>;
    };
  }

  it('PRM handler returns 400 + diagnostic when Host header is missing', () => {
    const req = makeReq({}); // no host
    const res = makeRes();
    handleProtectedResourceMetadata(req, res);
    expect(res._status).toBe(400);
    expect(res._body).toEqual({ error: 'Missing Host header' });
  });

  it('AS metadata handler returns 400 + diagnostic when Host header is missing', () => {
    const req = makeReq({});
    const res = makeRes();
    handleAuthorizationServerMetadata(req, res);
    expect(res._status).toBe(400);
    expect(res._body).toEqual({ error: 'Missing Host header' });
  });

  it('PRM handler emits HTTPS URLs when req.protocol = "https" (trust-proxy behind TLS proxy)', () => {
    // Pin the production behavior: under Cloudflare / load balancer
    // the request arrives over HTTPS even though the Express
    // listener is plain HTTP; trust-proxy + X-Forwarded-Proto set
    // req.protocol = 'https'. Claude Desktop refuses non-HTTPS
    // metadata URLs (EF-003), so this is load-bearing for prod.
    const req = makeReq({ host: 'hadron.example.com', protocol: 'https' });
    const res = makeRes();
    handleProtectedResourceMetadata(req, res);
    const body = res._body as { resource: string };
    expect(body.resource).toBe('https://hadron.example.com/mcp');
  });

  it('AS metadata handler emits HTTPS URLs when req.protocol = "https"', () => {
    const req = makeReq({ host: 'hadron.example.com', protocol: 'https' });
    const res = makeRes();
    handleAuthorizationServerMetadata(req, res);
    const body = res._body as { registration_endpoint: string; issuer: string };
    expect(body.issuer).toBe('https://hadron.example.com');
    expect(body.registration_endpoint).toBe('https://hadron.example.com/oauth/register');
  });
});

describe('GET /.well-known/oauth-authorization-server (AS metadata endpoint)', () => {
  it('returns 200 + RFC 8414 JSON shape with all critical fields', async () => {
    const res = await fetch(`${baseUrl}/.well-known/oauth-authorization-server`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    const body = (await res.json()) as Record<string, unknown>;
    // Critical fields present per EF-001 / EF-002 / spec FR-009.
    expect(body.registration_endpoint).toMatch(/\/oauth\/register$/);
    expect(body.token_endpoint_auth_methods_supported).toEqual(['none']);
    expect(body.code_challenge_methods_supported).toEqual(['S256']);
    expect(body.scopes_supported).toEqual(['mcp']);
    expect(body.grant_types_supported).toEqual(['authorization_code']);
  });

  it('host-derived URLs reflect the actual request origin', async () => {
    // The integration test runs on 127.0.0.1:<port>; all URLs in
    // the metadata should reflect that origin (not a hardcoded
    // hostname).
    const res = await fetch(`${baseUrl}/.well-known/oauth-authorization-server`);
    const body = (await res.json()) as Record<string, string>;
    expect(body.issuer).toBe(baseUrl);
    expect(body.authorization_endpoint).toBe(`${baseUrl}/oauth/authorize`);
    expect(body.token_endpoint).toBe(`${baseUrl}/oauth/token`);
    expect(body.registration_endpoint).toBe(`${baseUrl}/oauth/register`);
  });

  it('responds without requiring authentication (discovery is unauthenticated per RFC 8414)', async () => {
    // Sanity check: discovery endpoints must be reachable without
    // a Bearer token (clients call them before having a token).
    const res = await fetch(`${baseUrl}/.well-known/oauth-authorization-server`);
    expect(res.status).toBe(200);
    expect(res.status).not.toBe(401);
  });

  it('sets Cache-Control: public, max-age=86400 for CDN + client caches', async () => {
    const res = await fetch(`${baseUrl}/.well-known/oauth-authorization-server`);
    expect(res.headers.get('cache-control')).toBe('public, max-age=86400');
  });
});

describe('advertised /oauth/* endpoints (Phase 2A advertises; 2B/2C/2D handle)', () => {
  it('GET /oauth/register 404s today (handler lands in Phase 2B)', async () => {
    // Discovery currently advertises /oauth/register so Claude Desktop's
    // pre-OAuth probe finds it (EF-001), but the actual DCR handler
    // ships in Phase 2B. This test pins the "advertised but not yet
    // implemented" state so when 2B lands the maintainer is forced to
    // update it — a regression-strong way to track the gap.
    const res = await fetch(`${baseUrl}/oauth/register`, { method: 'GET' });
    expect(res.status).toBe(404);
  });
});
