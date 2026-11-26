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
import { db } from '../integrations/db/client.js';
import { cleanDb, makeMcpReq, makeMcpRes } from '../test/helpers.js';
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
      oauthScopes: [],
    },
  });
  return rawKey;
}

describe('handleMcpRequest App-identification regime (FR-020 / R-6)', () => {
  it('allows a multi-App user-credential session to OPEN (spec 026 refinement of spec 025\'s 409)', async () => {
    // Spec 025 originally returned HTTP 409 `multiple_apps_resolved` here.
    // Spec 026 §FR-016 refinement: the 409 is moved from session-init to
    // per-tool-call layer (as an MCP tool-error envelope), so multi-App
    // users can OPEN a session and call `hadron_list_apps` / `hadron_set_active_app`
    // to pick an App. This unblocks Claude Desktop OAuth users —
    // see specs/026-app-identification-regimes/spec.md §Background.
    await createAppForUser('alpha', user.id);
    await createAppForUser('beta', user.id);
    const rawKey = await mintUserApiKey(user.id);

    const spy = vi.spyOn(userAppResolution, 'resolveAppForRequest');

    const req = makeMcpReq({ authorization: `Bearer ${rawKey}` });
    const res = makeMcpRes();

    await handleMcpRequest(req, res);

    // No 409 — the multi-App dispatch no longer short-circuits.
    expect(res._status).not.toBe(409);
    expect(res._body).not.toMatchObject({ error: 'multiple_apps_resolved' });

    // The dispatch DID call resolveAppForRequest (so the resolution is
    // cached for the per-tool-call requireAppScope helper). The cached
    // resolution is 'multi-app' for this user.
    expect(spy).toHaveBeenCalled();
    const result = await spy.mock.results[0].value;
    expect(result).toEqual({ kind: 'multi-app' });

    spy.mockRestore();
  });

  it('does not return 409 for a user-credential caller with exactly one App (resolved automatically)', async () => {
    await createAppForUser('alpha', user.id);
    const rawKey = await mintUserApiKey(user.id);

    const req = makeMcpReq({ authorization: `Bearer ${rawKey}` });
    const res = makeMcpRes();

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

    const req = makeMcpReq({ authorization: `Bearer ${rawKey}` });
    const res = makeMcpRes();

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

    const req = makeMcpReq({ authorization: `Bearer ${rawKey}` });
    const res = makeMcpRes();

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

    const req = makeMcpReq({ authorization: `Bearer ${rawKey}` });
    const res = makeMcpRes();

    await handleMcpRequest(req, res);

    expect(spy).not.toHaveBeenCalled();
    expect(res._status).not.toBe(409);
    expect(res._body).not.toMatchObject({ error: 'multiple_apps_resolved' });

    spy.mockRestore();
  });

  it('returns 401 + WWW-Authenticate for unauthenticated requests (App resolution does not interfere with the auth check)', async () => {
    // Sanity check: the FR-020 block is downstream of the auth gate.
    // No auth → 401, never reaches App resolution.
    const req = makeMcpReq({}); // no authorization
    const res = makeMcpRes();

    await handleMcpRequest(req, res);

    expect(res._status).toBe(401);
    expect(res._headers['WWW-Authenticate']).toMatch(/Bearer/);
    expect(res._body).toEqual({ error: 'Authentication required' });
  });
});
