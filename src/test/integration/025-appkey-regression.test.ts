/**
 * Spec 025-oauth-for-mcp US6 regression suite (T030 per tasks.md).
 *
 * US6 ("AppKey continues to work unchanged") has zero new code —
 * the spec is strictly additive at the credential-validation layer.
 * What's at risk is **silent regression**: a future refactor that
 * accidentally promotes AppKey callers through user-credential
 * code paths, leaks the `clientId` synthesis into AppKey auth, or
 * 409s App-key-keyed requests that should never reach the FR-020
 * dispatch.
 *
 * The deeper coverage already lives in:
 *   - src/middleware/auth.test.ts (App Key auth describe block, 6 tests)
 *   - src/api/graphql/schema/resolvers.userApiKey.test.ts
 *     (createUserApiKey / revokeUserApiKey / myUserApiKeys all
 *     reject AppKey callers with UNAUTHENTICATED)
 *   - src/mcp/server.app-resolution.test.ts (AppKey caller skips
 *     FR-020 even with 2+ AppMember rows under the user)
 *
 * This file is the **aggregated cross-surface invariant check**: a
 * single AppKey caller exercises every spec 025 surface and we
 * assert the AppKey-specific behavior is preserved at every point.
 * Each test cross-references where the deeper coverage lives, so a
 * failure here points at the right place.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Request, Response } from 'express';
import { randomBytes } from 'crypto';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../helpers.js';
import { generateId } from '../../lib/id.js';
import {
  APP_KEY_PREFIX,
  hashAppKey,
  resolveAuthContext,
} from '../../middleware/auth.js';
import { handleMcpRequest } from '../../mcp/server.js';
import { resolvers, type Context } from '../../api/graphql/schema/resolvers.js';

let user: { id: string };
let org: { id: string; urn: string };
let app: { id: string; urn: string };
let rawKey: string;

beforeEach(async () => {
  await cleanDb(db);
  user = await db.user.create({
    data: { id: generateId(), handle: 'alice', githubUsername: 'alice' },
  });
  org = await db.organization.create({
    data: { id: generateId(), name: 'Acme', urn: 'acme' },
  });
  app = await db.app.create({
    data: {
      id: generateId(),
      organizationId: org.id,
      name: 'Juno-onboarding',
      urn: `${org.urn}:juno`,
    },
  });
  // AppMember row so /mcp App-resolution would see this user under
  // this App. The point of US6 is that AppKey callers don't go
  // through that resolution path at all — the test still creates
  // the membership so the negative is meaningful.
  await db.appMember.create({
    data: { appId: app.id, userId: user.id, role: 'owner' },
  });
  rawKey = APP_KEY_PREFIX + randomBytes(32).toString('hex');
  await db.appKey.create({
    data: {
      appId: app.id,
      keyHash: hashAppKey(rawKey),
      keyPreview: rawKey.slice(-4),
    },
  });
});

function makeReq(authorization: string, host = 'localhost:4000'): Request {
  return {
    method: 'POST',
    headers: { authorization },
    protocol: 'http',
    body: { jsonrpc: '2.0', method: 'initialize', id: 1 },
    get: (name: string) => (name.toLowerCase() === 'host' ? host : undefined),
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
    setHeader: vi.fn((n: string, v: string) => { headers[n] = v; return res; }),
    getHeader: vi.fn((n: string) => headers[n]),
    status: vi.fn((c: number) => { status = c; return res; }),
    json: vi.fn((p: unknown) => { body = p; return res; }),
    writeHead: vi.fn((c: number, h?: Record<string, string>) => {
      status = c;
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
    get _status() { return status; },
    get _headers() { return headers; },
    get _body() { return body; },
  };
  return res as unknown as Response & {
    _status: number;
    _headers: Record<string, string>;
    _body: unknown;
  };
}

function appKeyCtx(): Context {
  // What the middleware produces for AppKey: appId + organizationId
  // set, userId / clientId deliberately absent. Matches the shape
  // observed in middleware/auth.ts:resolveAppKey.
  return { db, appId: app.id, organizationId: org.id, roles: [] };
}

// ── Cross-surface invariants ──────────────────────────────────────────

describe('spec 025 US6 — AppKey regression suite', () => {
  // ── Middleware: AppKey resolves to appId, no clientId leakage ──────

  it('resolveAuthContext for AppKey Bearer sets appId + organizationId, NOT userId/clientId', async () => {
    // The user-credential path synthesizes a `clientId` (`github:…`
    // / `email:…` / `user:<id>`). An accidental refactor that
    // promoted AppKey callers through that synthesis would
    // cross-pollute the auth context and break downstream code
    // that uses `clientId` to detect "is this a user-credential
    // caller". Pin the AppKey shape explicitly.
    //
    // Deeper coverage: src/middleware/auth.test.ts §"App Key auth".
    const req = {
      headers: { authorization: `Bearer ${rawKey}` },
    } as unknown as Request;
    const ctx = await resolveAuthContext(req, db);

    expect(ctx.appId).toBe(app.id);
    expect(ctx.organizationId).toBe(org.id);
    expect(ctx.userId).toBeUndefined();
    expect(ctx.clientId).toBeUndefined();
  });

  // ── /mcp: AppKey bypasses the FR-020 App-resolution block ──────────

  it('AppKey caller on /mcp does NOT trip the FR-020 multi-App 409 (App resolution is gated on userId && !appId)', async () => {
    // The FR-020 dispatch block has a precise gate: `userId set
    // AND appId unset`. AppKey callers have appId set by the
    // middleware, so the block must never run for them. A future
    // refactor that drops the gate (e.g., to centralize App
    // resolution for all callers) would 409 every AppKey request
    // — catastrophic and silent without this test.
    //
    // Deeper coverage: src/mcp/server.app-resolution.test.ts
    // §"skips App resolution entirely for AppKey-resolved callers".
    const req = makeReq(`Bearer ${rawKey}`);
    const res = makeRes();

    await handleMcpRequest(req, res);

    expect(res._status).not.toBe(409);
    expect(res._body).not.toMatchObject({ error: 'multiple_apps_resolved' });
    // Also not the 401 (AppKey is valid auth).
    expect(res._status).not.toBe(401);
  });

  // ── GraphQL: AppKey callers rejected from user-scoped mutations ────

  it('AppKey caller rejected from createUserApiKey with UNAUTHENTICATED (user-scoped only)', async () => {
    // FR-004: only resolved-userId callers can mint user keys.
    // AppKey caller (no userId in context) must be rejected, even
    // though they have full auth in another sense (they hold a
    // valid credential for an App). This is the "AppKey is App-
    // scoped, hdr_user_<…> is user-scoped" boundary that US6
    // protects.
    //
    // Deeper coverage: src/api/graphql/schema/resolvers.userApiKey.test.ts
    // §"rejects AppKey-resolved callers with UNAUTHENTICATED".
    await expect(
      resolvers.Mutation.createUserApiKey(undefined, { label: 'attempt' }, appKeyCtx()),
    ).rejects.toMatchObject({ extensions: { code: 'UNAUTHENTICATED' } });
  });

  it('AppKey caller rejected from revokeUserApiKey with UNAUTHENTICATED', async () => {
    await expect(
      resolvers.Mutation.revokeUserApiKey(undefined, { id: 'any' }, appKeyCtx()),
    ).rejects.toMatchObject({ extensions: { code: 'UNAUTHENTICATED' } });
  });

  it('AppKey caller rejected from myUserApiKeys Query with UNAUTHENTICATED', async () => {
    await expect(
      resolvers.Query.myUserApiKeys(undefined, undefined, appKeyCtx()),
    ).rejects.toMatchObject({ extensions: { code: 'UNAUTHENTICATED' } });
  });

  // ── Boundary: AppKey caller cannot impersonate user-key flows ──────

  it('AppKey caller does NOT pick up the userId of an underlying AppMember (no implicit user-credential elevation)', async () => {
    // Setup: an AppKey caller might tempt a future refactor to
    // "resolve the user from the AppMember" — but that would
    // collapse the boundary between App-acting-for-itself
    // (AppKey) and User-acting-personally (hdr_user_<…>). The
    // middleware MUST leave userId undefined for AppKey, even when
    // the underlying App has exactly one AppMember.
    const req = {
      headers: { authorization: `Bearer ${rawKey}` },
    } as unknown as Request;
    const ctx = await resolveAuthContext(req, db);
    expect(ctx.userId).toBeUndefined();
    // The (single) AppMember row exists in beforeEach — but the
    // resolution path mustn't synthesize a userId from it.
    const memberships = await db.appMember.findMany({ where: { appId: app.id } });
    expect(memberships).toHaveLength(1);
    expect(memberships[0].userId).toBe(user.id);
    // Cross-check: middleware ignored the membership.
    expect(ctx.userId).toBeUndefined();
  });
});
