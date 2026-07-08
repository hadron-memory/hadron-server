/**
 * Issue #562: Query.authContext — expose the request's resolved principal
 * read-only, so any surface (CLI, portal) can validate a token and name the
 * exact credential without per-client hacks.
 *
 * Covers the security posture the issue asks us to hold:
 *   - current-request only (no token argument exists to test — structural);
 *   - null for a non-resolving credential, identically regardless of reason
 *     (no oracle);
 *   - once resolved, active-vs-revoked (apiKey.revokedAt) is surfaced.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';

type AuthContextSource = {
  principalType: 'USER' | 'APP' | 'AGENT';
  userId: string | null;
  appId: string | null;
  agentId: string | null;
  apiKeyId: string | null;
};

const authContext = resolvers.Query.authContext as (
  p: unknown,
  a: unknown,
  c: Context,
) => Promise<AuthContextSource | null>;

const acUser = resolvers.AuthContext.user as (
  s: { userId: string | null },
  a: unknown,
  c: Context,
) => Promise<unknown>;

const acApiKey = resolvers.AuthContext.apiKey as (
  s: { apiKeyId: string | null },
  a: unknown,
  c: Context,
) => Promise<{ id: string; revokedAt: Date | null } | null>;

let user: { id: string };

beforeEach(async () => {
  await cleanDb(db);
  user = await db.user.create({
    data: {
      id: generateId(),
      handle: 'alice',
      githubId: 3001,
      githubUsername: 'alice',
      name: 'Alice',
    },
  });
});

async function mintKey(userId: string, overrides: Record<string, unknown> = {}) {
  return db.userApiKey.create({
    data: {
      id: generateId(),
      userId,
      keyHash: generateId(),
      keyPreview: 'ab12',
      label: 'ci-deploy',
      createdBy: userId,
      issuedVia: 'portal',
      ...overrides,
    },
  });
}

describe('Query.authContext', () => {
  it('returns null for an unauthenticated request (no credential resolved)', async () => {
    const result = await authContext(undefined, undefined, { db, roles: [] } as Context);
    expect(result).toBeNull();
  });

  it('reports a USER principal for a JWT/user token, with no apiKey', async () => {
    // JWT path: userId set, but no apiKeyId (JWTs have no UserApiKey row).
    const src = await authContext(undefined, undefined, {
      db,
      userId: user.id,
      roles: ['READER'],
    } as Context);
    expect(src).toMatchObject({
      principalType: 'USER',
      userId: user.id,
      appId: null,
      agentId: null,
      apiKeyId: null,
    });
    // apiKey field resolves to null; user field resolves to the User.
    expect(await acApiKey(src!, undefined, { db } as Context)).toBeNull();
    expect(await acUser(src!, undefined, { db } as Context)).toMatchObject({ id: user.id });
  });

  it('names the exact UserApiKey for an hdr_user_-authenticated request', async () => {
    const key = await mintKey(user.id);
    const src = await authContext(undefined, undefined, {
      db,
      userId: user.id,
      apiKeyId: key.id,
      roles: ['READER'],
    } as Context);
    expect(src!.principalType).toBe('USER');

    const resolvedKey = await acApiKey(src!, undefined, { db } as Context);
    expect(resolvedKey).toMatchObject({ id: key.id, revokedAt: null });
  });

  it('surfaces revokedAt once the credential has resolved (active-vs-revoked is fine post-auth)', async () => {
    // A request only reaches here with ctx.apiKeyId set because the key was
    // ACTIVE at auth time — resolveUserApiKey returns {} (unauthenticated)
    // for an already-revoked key. So model revocation happening *after* the
    // context is established: authenticate with the active key, then revoke
    // it in the DB, then resolve apiKey — revokedAt is now observable, which
    // is fine (you already authenticated as this credential).
    const key = await mintKey(user.id);
    const src = await authContext(undefined, undefined, {
      db,
      userId: user.id,
      apiKeyId: key.id,
      roles: ['READER'],
    } as Context);
    await db.userApiKey.update({ where: { id: key.id }, data: { revokedAt: new Date() } });
    const resolvedKey = await acApiKey(src!, undefined, { db } as Context);
    expect(resolvedKey!.revokedAt).not.toBeNull();
  });

  it('reports an APP principal for an App key, with user null', async () => {
    // App-keyed caller: appId set, no userId (mirrors resolveAppKey).
    const src = await authContext(undefined, undefined, {
      db,
      appId: 'app-123',
      roles: [],
    } as Context);
    expect(src).toMatchObject({
      principalType: 'APP',
      appId: 'app-123',
      userId: null,
      agentId: null,
      apiKeyId: null,
    });
    // A valid App credential is NOT reported as invalid (the false-negative
    // `me` produces) — but `user`/`apiKey` are null (App keys aren't users).
    expect(await acUser(src!, undefined, { db } as Context)).toBeNull();
    expect(await acApiKey(src!, undefined, { db } as Context)).toBeNull();
  });
});
