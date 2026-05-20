/**
 * Spec 025-oauth-for-mcp FR-020 / research §R-6 — MCP-boundary
 * App-identification regime integration tests.
 *
 * Tests T027 per tasks.md: single-App default + HTTP 409
 * `multiple_apps_resolved` on multi-App + zero-App preserves
 * existing behavior + AppKey callers unchanged.
 *
 * Uses the same mock req/res pattern as src/mcp/server.401.test.ts.
 * Tests assert on the response shape; the full MCP transport setup
 * downstream is irrelevant to FR-020's contract (and may write
 * additional bytes after our handler returns — we check the
 * 409 case BEFORE the transport ever runs).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Request, Response } from 'express';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import { handleMcpRequest } from './server.js';
import {
  APP_KEY_PREFIX,
  USER_API_KEY_PREFIX,
  hashAppKey,
  hashUserApiKey,
} from '../middleware/auth.js';
import * as userAppResolution from '../auth/user-app-resolution.js';

let user: { id: string };
let org: { id: string; urn: string };

beforeEach(async () => {
  await cleanDb(db);
  user = await db.user.create({
    data: { id: generateId(), handle: 'alice', githubUsername: 'alice' },
  });
  org = await db.organization.create({
    data: { id: generateId(), name: 'Acme', urn: 'acme' },
  });
});

async function createAppForUser(slug: string, userId: string): Promise<string> {
  const app = await db.app.create({
    data: {
      id: generateId(),
      organizationId: org.id,
      name: slug,
      urn: `${org.urn}:${slug}`,
    },
  });
  await db.appMember.create({
    data: { appId: app.id, userId, role: 'owner' },
  });
  return app.id;
}

async function mintUserApiKey(userId: string): Promise<string> {
  const { randomBytes } = await import('crypto');
  const rawKey = USER_API_KEY_PREFIX + randomBytes(32).toString('hex');
  await db.userApiKey.create({
    data: {
      userId,
      keyHash: hashUserApiKey(rawKey),
      keyPreview: rawKey.slice(-4),
      createdBy: userId,
      issuedVia: 'portal',
    },
  });
  return rawKey;
}

function makeReq(opts: { authorization?: string }): Request {
  return {
    method: 'POST',
    headers: opts.authorization ? { authorization: opts.authorization } : {},
    protocol: 'http',
    body: { jsonrpc: '2.0', method: 'initialize', id: 1 },
    get: (name: string) => {
      if (name.toLowerCase() === 'host') return 'localhost:4000';
      return undefined;
    },
    // Express's `connect`-like adapter expects req.on / req.pipe for
    // body streaming; our handler doesn't need them for the
    // FR-020 code paths (which all return before transport setup
    // when they want to short-circuit, and the transport gracefully
    // handles a synthetic body for non-short-circuit cases).
    on: vi.fn(),
    pipe: vi.fn(),
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
    getHeader: vi.fn((name: string) => headers[name]),
    status: vi.fn((code: number) => {
      status = code;
      return res;
    }),
    json: vi.fn((payload: unknown) => {
      body = payload;
      return res;
    }),
    // The MCP StreamableHTTPServerTransport (via @hono/node-server's
    // shim) calls writeHead/write/end directly on the response after
    // our FR-020 block returns. We stub them as no-ops so the
    // transport doesn't crash; the App-resolution assertions all
    // care about state set BEFORE the transport runs.
    writeHead: vi.fn((code: number, h?: Record<string, string>) => {
      status = code;
      if (h) Object.assign(headers, h);
      return res;
    }),
    write: vi.fn(() => true),
    end: vi.fn(),
    on: vi.fn(),
    once: vi.fn(),
    off: vi.fn(),
    removeListener: vi.fn(),
    addListener: vi.fn(),
    emit: vi.fn(),
    headersSent: false,
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

describe('handleMcpRequest App-identification regime (FR-020 / R-6)', () => {
  it('returns 409 multiple_apps_resolved when a user-credential caller has 2+ Apps', async () => {
    await createAppForUser('alpha', user.id);
    await createAppForUser('beta', user.id);
    const rawKey = await mintUserApiKey(user.id);

    const req = makeReq({ authorization: `Bearer ${rawKey}` });
    const res = makeRes();

    await handleMcpRequest(req, res);

    expect(res._status).toBe(409);
    expect(res._body).toMatchObject({
      error: 'multiple_apps_resolved',
      error_description: expect.stringContaining('more than one Hadron App'),
    });
  });

  it('does not return 409 for a user-credential caller with exactly one App (resolved automatically)', async () => {
    await createAppForUser('alpha', user.id);
    const rawKey = await mintUserApiKey(user.id);

    const req = makeReq({ authorization: `Bearer ${rawKey}` });
    const res = makeRes();

    await handleMcpRequest(req, res);

    // FR-020 happy path: single-App default. The handler should NOT
    // emit the multi-App error. Downstream MCP transport setup may
    // write its own bytes; we only assert that App resolution didn't
    // reject. (status defaults to 200; only the 409 branch would set
    // a different status before transport runs.)
    expect(res._status).not.toBe(409);
    expect(res._body).not.toMatchObject({ error: 'multiple_apps_resolved' });
  });

  it('does not return 409 for a user-credential caller with zero Apps (existing behavior preserved)', async () => {
    // Zero-App: no AppMember rows for this user.
    const rawKey = await mintUserApiKey(user.id);

    const req = makeReq({ authorization: `Bearer ${rawKey}` });
    const res = makeRes();

    await handleMcpRequest(req, res);

    // FR-020 doesn't specify zero-App handling. The handler must NOT
    // emit the multi-App 409 (that's for 2+ Apps only). Downstream
    // tool calls will fail with App-specific errors when they need
    // an appId — existing JWT-without-App behavior is preserved.
    expect(res._status).not.toBe(409);
    expect(res._body).not.toMatchObject({ error: 'multiple_apps_resolved' });
  });

  it('populates auth.appId on the single-App path (positive contract check)', async () => {
    // The earlier negative-only test ("does not return 409") couldn't
    // distinguish "resolution worked" from "resolution silently
    // skipped". Spy on resolveAppForRequest to assert the dispatch
    // helper was called with the right userId and returned the
    // expected resolved shape — which the production handler then
    // uses to mutate auth.appId. This pins the positive contract.
    const appId = await createAppForUser('alpha', user.id);
    const rawKey = await mintUserApiKey(user.id);

    const spy = vi.spyOn(userAppResolution, 'resolveAppForRequest');

    const req = makeReq({ authorization: `Bearer ${rawKey}` });
    const res = makeRes();

    await handleMcpRequest(req, res);

    // The spy fired with the user's id and returned a 'resolved'
    // shape carrying the App's id + organizationId. The production
    // handler reads this and mutates auth.appId / auth.organizationId
    // (which downstream MCP tool calls consume).
    expect(spy).toHaveBeenCalledOnce();
    expect(spy).toHaveBeenCalledWith(user.id, expect.anything());
    const result = await spy.mock.results[0].value;
    expect(result).toEqual({
      kind: 'resolved',
      appId,
      organizationId: org.id,
    });
    expect(res._status).not.toBe(409);

    spy.mockRestore();
  });

  it('skips App resolution entirely for AppKey-resolved callers (no 409 even with multiple App memberships under the same user)', async () => {
    // Build an AppKey-keyed App + create AppMember rows so the user
    // ALSO appears to be a member of 2+ Apps. The AppKey path
    // populates ctx.appId directly in the middleware, so the
    // FR-020 block ("userId && !appId") must not run — otherwise
    // we'd 409 AppKey callers, which is the wrong behavior (their
    // App is already disambiguated by the key itself).
    const appA = await createAppForUser('alpha', user.id);
    await createAppForUser('beta', user.id);

    // Use the production hashing primitive instead of inlining the
    // SHA-256 call — keeps the test resilient to future hash-algorithm
    // refactors. Same `slice(-4)` keyPreview convention as
    // createUserApiKey (PR #150 review consistency).
    const { randomBytes } = await import('crypto');
    const rawKey = APP_KEY_PREFIX + randomBytes(32).toString('hex');
    const keyHash = hashAppKey(rawKey);
    await db.appKey.create({
      data: {
        appId: appA,
        keyHash,
        keyPreview: rawKey.slice(-4),
      },
    });

    // Spy to assert resolveAppForRequest is NEVER called on this path
    // (the gate `auth.userId && !auth.appId` is false for AppKey).
    const spy = vi.spyOn(userAppResolution, 'resolveAppForRequest');

    const req = makeReq({ authorization: `Bearer ${rawKey}` });
    const res = makeRes();

    await handleMcpRequest(req, res);

    expect(spy).not.toHaveBeenCalled();
    expect(res._status).not.toBe(409);
    expect(res._body).not.toMatchObject({ error: 'multiple_apps_resolved' });

    spy.mockRestore();
  });

  it('returns 401 + WWW-Authenticate for unauthenticated requests (App resolution does not interfere with the auth check)', async () => {
    // Sanity check: the FR-020 block is downstream of the auth gate.
    // No auth → 401, never reaches App resolution.
    const req = makeReq({}); // no authorization
    const res = makeRes();

    await handleMcpRequest(req, res);

    expect(res._status).toBe(401);
    expect(res._headers['WWW-Authenticate']).toMatch(/Bearer/);
    expect(res._body).toEqual({ error: 'Authentication required' });
  });
});
