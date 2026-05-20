import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Request, Response } from 'express';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { handleMcpRequest } from './server.js';
import { hashUserApiKey, USER_API_KEY_PREFIX } from '../middleware/auth.js';

// Spec 025-oauth-for-mcp FR-005: /mcp emits 401 + RFC 9728 WWW-Authenticate
// header with resource_metadata URL on unauthenticated requests, so MCP-spec-
// compliant clients (Claude Desktop, MCP Inspector) can discover the OAuth
// authorization server.

beforeEach(async () => {
  await cleanDb(db);
});

function makeReq(opts: {
  authorization?: string;
  protocol?: 'http' | 'https';
  host?: string;
}): Request {
  return {
    method: 'POST',
    headers: opts.authorization
      ? { authorization: opts.authorization }
      : {},
    protocol: opts.protocol ?? 'http',
    body: { jsonrpc: '2.0', method: 'initialize', id: 1 },
    get: (name: string) => {
      if (name.toLowerCase() === 'host') return opts.host ?? 'localhost:4000';
      return undefined;
    },
  } as unknown as Request;
}

function makeRes(): Response & {
  _status: number;
  _headers: Record<string, string>;
  _body: unknown;
} {
  const headers: Record<string, string> = {};
  let status = 200;
  let body: unknown;
  const res = {
    setHeader: vi.fn((name: string, value: string) => {
      headers[name] = value;
      return res;
    }),
    status: vi.fn((code: number) => {
      status = code;
      return res;
    }),
    json: vi.fn((payload: unknown) => {
      body = payload;
      return res;
    }),
    get _status() {
      return status;
    },
    get _headers() {
      return headers;
    },
    get _body() {
      return body;
    },
  };
  return res as unknown as Response & {
    _status: number;
    _headers: Record<string, string>;
    _body: unknown;
  };
}

describe('/mcp 401 + WWW-Authenticate (FR-005, RFC 9728)', () => {
  it('returns 401 with Bearer challenge + resource_metadata URL when no Authorization header', async () => {
    const req = makeReq({});
    const res = makeRes();

    await handleMcpRequest(req, res);

    expect(res._status).toBe(401);
    expect(res._headers['WWW-Authenticate']).toBe(
      'Bearer realm="hadron", error="invalid_token", ' +
        'resource_metadata="http://localhost:4000/.well-known/oauth-protected-resource"',
    );
    expect(res._body).toEqual({ error: 'Authentication required' });
  });

  it('returns 401 + same WWW-Authenticate shape for a revoked UserApiKey (no info leak)', async () => {
    const { randomBytes } = await import('crypto');
    const user = await db.user.create({
      data: {
        id: 'user-mcp-401-revoked',
        githubUsername: 'alice-revoked',
        roles: ['READER'],
      },
    });
    const rawKey = USER_API_KEY_PREFIX + randomBytes(32).toString('hex');
    await db.userApiKey.create({
      data: {
        userId: user.id,
        keyHash: hashUserApiKey(rawKey),
        keyPreview: rawKey.slice(-4),
        revokedAt: new Date(), // revoked before first use
        createdBy: user.id,
        issuedVia: 'portal',
      },
    });

    const req = makeReq({ authorization: `Bearer ${rawKey}` });
    const res = makeRes();

    await handleMcpRequest(req, res);

    // Identical shape to the unknown-key case — spec Edge Cases prohibit
    // any difference that would distinguish "revoked" from "unknown".
    expect(res._status).toBe(401);
    expect(res._headers['WWW-Authenticate']).toBe(
      'Bearer realm="hadron", error="invalid_token", ' +
        'resource_metadata="http://localhost:4000/.well-known/oauth-protected-resource"',
    );
    expect(res._body).toEqual({ error: 'Authentication required' });
  });

  it('advertises HTTPS resource_metadata URL when behind a TLS-terminating proxy (req.protocol = "https")', async () => {
    // Simulates the production case: Express's `trust proxy` resolves
    // req.protocol to "https" from X-Forwarded-Proto when the request
    // arrives over a Cloudflare tunnel / load balancer. Claude Desktop
    // refuses non-HTTPS metadata URLs (EF-003).
    const req = makeReq({
      protocol: 'https',
      host: 'hadron.example.com',
    });
    const res = makeRes();

    await handleMcpRequest(req, res);

    expect(res._status).toBe(401);
    expect(res._headers['WWW-Authenticate']).toBe(
      'Bearer realm="hadron", error="invalid_token", ' +
        'resource_metadata="https://hadron.example.com/.well-known/oauth-protected-resource"',
    );
  });

  it('falls back to "localhost" host when req.get("host") returns undefined', async () => {
    const req = {
      method: 'POST',
      headers: {},
      protocol: 'http',
      body: { jsonrpc: '2.0', method: 'initialize', id: 1 },
      get: () => undefined,
    } as unknown as Request;
    const res = makeRes();

    await handleMcpRequest(req, res);

    expect(res._status).toBe(401);
    expect(res._headers['WWW-Authenticate']).toContain(
      'resource_metadata="http://localhost/.well-known/oauth-protected-resource"',
    );
  });
});
