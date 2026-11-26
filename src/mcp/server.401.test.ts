import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Request } from 'express';
import { db } from '../integrations/db/client.js';
import { cleanDb, makeMcpReq, makeMcpRes } from '../test/helpers.js';
import { handleMcpRequest } from './server.js';
import { hashUserApiKey, USER_API_KEY_PREFIX } from '../middleware/auth.js';

// Spec 025-oauth-for-mcp FR-005: /mcp emits 401 + RFC 9728 WWW-Authenticate
// header with resource_metadata URL on unauthenticated requests, so MCP-spec-
// compliant clients (Claude Desktop, MCP Inspector) can discover the OAuth
// authorization server.

beforeEach(async () => {
  await cleanDb(db);
});

describe('/mcp 401 + WWW-Authenticate (FR-005, RFC 9728)', () => {
  it('returns 401 with Bearer challenge + resource_metadata URL when no Authorization header', async () => {
    const req = makeMcpReq({});
    const res = makeMcpRes();

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
        oauthScopes: [],
      },
    });

    const req = makeMcpReq({ authorization: `Bearer ${rawKey}` });
    const res = makeMcpRes();

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
    const req = makeMcpReq({
      protocol: 'https',
      host: 'hadron.example.com',
    });
    const res = makeMcpRes();

    await handleMcpRequest(req, res);

    expect(res._status).toBe(401);
    expect(res._headers['WWW-Authenticate']).toBe(
      'Bearer realm="hadron", error="invalid_token", ' +
        'resource_metadata="https://hadron.example.com/.well-known/oauth-protected-resource"',
    );
  });

  it('returns 400 when Host header is missing (RFC 7230 §5.4)', async () => {
    // HTTP/1.1 requires a Host header on every request; without one we
    // can't synthesize a meaningful resource_metadata URL. Respond 400
    // honestly rather than emit a partial URL that downstream clients
    // would 404 against.
    const req = {
      method: 'POST',
      headers: {},
      protocol: 'http',
      body: { jsonrpc: '2.0', method: 'initialize', id: 1 },
      get: () => undefined,
    } as unknown as Request;
    const res = makeMcpRes();

    await handleMcpRequest(req, res);

    expect(res._status).toBe(400);
    expect(res._body).toEqual({ error: 'Missing Host header' });
    // No WWW-Authenticate emitted for a malformed request.
    expect(res._headers['WWW-Authenticate']).toBeUndefined();
  });
});
