import { describe, it, expect, beforeEach } from 'vitest';
import { SignJWT } from 'jose';
import type { Request } from 'express';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { resolveAuthContext, hashUserApiKey, USER_API_KEY_PREFIX } from './auth.js';

// JWT_SECRET is set in vitest.config.ts env

beforeEach(async () => {
  await cleanDb(db);
});

function makeReq(authorization?: string): Request {
  return {
    headers: authorization ? { authorization } : {},
  } as unknown as Request;
}

async function makeJwt(
  payload: Record<string, unknown>,
  opts: { issuer?: string; audience?: string; expiry?: string } = {},
): Promise<string> {
  const secret = new TextEncoder().encode(process.env.JWT_SECRET!);
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setIssuer(opts.issuer ?? 'hadron-server')
    .setAudience(opts.audience ?? 'hadron')
    .setExpirationTime(opts.expiry ?? '7d')
    .sign(secret);
}

describe('resolveAuthContext', () => {
  it('returns empty context when no Authorization header', async () => {
    const ctx = await resolveAuthContext(makeReq(), db);
    expect(ctx).toEqual({});
  });

  it('returns empty context for Authorization without Bearer prefix', async () => {
    const ctx = await resolveAuthContext(makeReq('Basic sometoken'), db);
    expect(ctx).toEqual({});
  });

  it('resolves a valid JWT to user context', async () => {
    const token = await makeJwt({ sub: 'user-1', githubUsername: 'alice', roles: ['ADMIN'], githubId: 1 });
    const ctx = await resolveAuthContext(makeReq(`Bearer ${token}`), db);

    expect(ctx.clientId).toBe('github:alice');
    expect(ctx.userId).toBe('user-1');
    expect(ctx.roles).toEqual(['ADMIN']);
  });

  it('returns empty context for an expired JWT', async () => {
    const token = await makeJwt(
      { sub: 'u', githubUsername: 'bob', roles: ['READER'], githubId: 2 },
      { expiry: '-1s' },
    );
    const ctx = await resolveAuthContext(makeReq(`Bearer ${token}`), db);
    expect(ctx).toEqual({});
  });

  it('returns empty context for a JWT with wrong issuer', async () => {
    const token = await makeJwt(
      { sub: 'u', githubUsername: 'bob', roles: ['READER'], githubId: 2 },
      { issuer: 'bad-issuer' },
    );
    const ctx = await resolveAuthContext(makeReq(`Bearer ${token}`), db);
    expect(ctx).toEqual({});
  });

  it('returns empty context for a JWT with wrong audience', async () => {
    const token = await makeJwt(
      { sub: 'u', githubUsername: 'bob', roles: ['READER'], githubId: 2 },
      { audience: 'bad-audience' },
    );
    const ctx = await resolveAuthContext(makeReq(`Bearer ${token}`), db);
    expect(ctx).toEqual({});
  });

  it('returns empty context for a non-prefixed bearer token', async () => {
    // After 003-station-to-app Phase 4, the only accepted bearer-token
    // shapes are JWTs (three dot-separated base64url segments) and
    // App Keys (`hdr_app_…` prefix). A 64-char hex token that fits
    // neither matches no auth path.
    const ctx = await resolveAuthContext(makeReq(`Bearer ${'z'.repeat(64)}`), db);
    expect(ctx).toEqual({});
  });

  // ── App Key auth ────────────────────────────────────────────────

  describe('App Key auth', () => {
    async function createAppWithKey(): Promise<{ appId: string; rawKey: string }> {
      const org = await db.organization.create({
        data: { id: 'org-app-test', name: 'org-app-test', urn: 'org-app-test' },
      });
      const app = await db.app.create({
        data: {
          id: 'app-1',
          organizationId: org.id,
          name: 'Test App',
          urn: 'org-app-test:test-app',
        },
      });
      // Generate a raw key and its SHA-256 hash — mirrors the createAppKey resolver
      const { createHash, randomBytes } = await import('crypto');
      const rawKey = 'hdr_app_' + randomBytes(32).toString('hex');
      const keyHash = createHash('sha256').update(rawKey).digest('hex');
      await db.appKey.create({
        data: {
          id: 'key-1',
          appId: app.id,
          keyHash,
          keyPreview: rawKey.slice(0, 12) + '...',
        },
      });
      return { appId: app.id, rawKey };
    }

    it('resolves a valid App Key to appId context', async () => {
      const { appId, rawKey } = await createAppWithKey();
      const ctx = await resolveAuthContext(makeReq(`Bearer ${rawKey}`), db);
      expect(ctx.appId).toBe(appId);
      expect(ctx.sessionId).toBeUndefined();
    });

    it('returns empty context for a revoked App Key', async () => {
      const { rawKey } = await createAppWithKey();
      await db.appKey.update({ where: { id: 'key-1' }, data: { revokedAt: new Date() } });
      const ctx = await resolveAuthContext(makeReq(`Bearer ${rawKey}`), db);
      expect(ctx).toEqual({});
    });

    it('returns empty context for an unknown App Key', async () => {
      const ctx = await resolveAuthContext(
        makeReq(`Bearer hdr_app_${'0'.repeat(64)}`),
        db,
      );
      expect(ctx).toEqual({});
    });

    it('binds sessionId from X-Hadron-Session header when session is active', async () => {
      const { appId, rawKey } = await createAppWithKey();
      await db.agent.create({
        data: { id: 'agent-1', organizationId: 'org-app-test', urn: 'org-app-test:a', name: 'a' },
      });
      await db.memory.create({
        data: {
      class: 'knowledge', id: 'mem-1', organizationId: 'org-app-test', urn: 'org-app-test:m', name: 'm' },
      });
      await db.session.create({
        data: {
          id: 'sess-1',
          appId,
          agentId: 'agent-1',
          memoryId: 'mem-1',
          type: 'CHATBOT',
          expiresAt: new Date(Date.now() + 60000),
        },
      });
      const req = {
        headers: {
          authorization: `Bearer ${rawKey}`,
          'x-hadron-session': 'sess-1',
        },
      } as unknown as Request;
      const ctx = await resolveAuthContext(req, db);
      expect(ctx.appId).toBe(appId);
      expect(ctx.sessionId).toBe('sess-1');
    });

    it('ignores expired sessions', async () => {
      const { appId, rawKey } = await createAppWithKey();
      await db.agent.create({
        data: { id: 'agent-2', organizationId: 'org-app-test', urn: 'org-app-test:b', name: 'b' },
      });
      await db.memory.create({
        data: {
      class: 'knowledge', id: 'mem-2', organizationId: 'org-app-test', urn: 'org-app-test:m2', name: 'm2' },
      });
      await db.session.create({
        data: {
          id: 'sess-2',
          appId,
          agentId: 'agent-2',
          memoryId: 'mem-2',
          type: 'CHATBOT',
          expiresAt: new Date(Date.now() - 60000),
        },
      });
      const req = {
        headers: {
          authorization: `Bearer ${rawKey}`,
          'x-hadron-session': 'sess-2',
        },
      } as unknown as Request;
      const ctx = await resolveAuthContext(req, db);
      expect(ctx.appId).toBe(appId);
      expect(ctx.sessionId).toBeUndefined();
    });

    it('refuses to bind a session belonging to another app', async () => {
      const { rawKey } = await createAppWithKey();
      // Create a second app and its session
      await db.organization.create({
        data: { id: 'org-other', name: 'other', urn: 'other' },
      });
      await db.app.create({
        data: { id: 'app-other', organizationId: 'org-other', name: 'Other', urn: 'other:other' },
      });
      await db.agent.create({
        data: { id: 'agent-other', organizationId: 'org-other', urn: 'other:a', name: 'a' },
      });
      await db.memory.create({
        data: {
      class: 'knowledge', id: 'mem-other', organizationId: 'org-other', urn: 'other:m', name: 'm' },
      });
      await db.session.create({
        data: {
          id: 'sess-other',
          appId: 'app-other',
          agentId: 'agent-other',
          memoryId: 'mem-other',
          type: 'CHATBOT',
          expiresAt: new Date(Date.now() + 60000),
        },
      });
      const req = {
        headers: {
          authorization: `Bearer ${rawKey}`,
          'x-hadron-session': 'sess-other',
        },
      } as unknown as Request;
      const ctx = await resolveAuthContext(req, db);
      expect(ctx.sessionId).toBeUndefined();
    });
  });

  // ── User API Key auth (spec 025-oauth-for-mcp) ──────────────────

  describe('User API Key auth', () => {
    async function createUserWithKey(
      user: Partial<{ id: string; githubUsername: string | null; email: string | null }> = {},
    ): Promise<{ userId: string; rawKey: string; keyId: string }> {
      const { randomBytes } = await import('crypto');
      const userId = user.id ?? `user-${randomBytes(4).toString('hex')}`;
      const createdUser = await db.user.create({
        data: {
          id: userId,
          githubUsername: user.githubUsername === undefined ? null : user.githubUsername,
          email: user.email === undefined ? null : user.email,
          roles: ['READER'],
        },
      });
      const rawKey = USER_API_KEY_PREFIX + randomBytes(32).toString('hex');
      const keyHash = hashUserApiKey(rawKey);
      const apiKey = await db.userApiKey.create({
        data: {
          userId: createdUser.id,
          keyHash,
          keyPreview: rawKey.slice(-4),
          label: 'test',
          createdBy: createdUser.id,
          issuedVia: 'portal',
        },
      });
      return { userId: createdUser.id, rawKey, keyId: apiKey.id };
    }

    it('resolves a valid User API Key to user context', async () => {
      const { userId, rawKey } = await createUserWithKey({
        githubUsername: 'alice',
      });
      const ctx = await resolveAuthContext(makeReq(`Bearer ${rawKey}`), db);
      expect(ctx.userId).toBe(userId);
      expect(ctx.clientId).toBe('github:alice');
      expect(ctx.appId).toBeUndefined(); // App resolution lives downstream (FR-020)
      expect(ctx.sessionId).toBeUndefined();
    });

    it('synthesizes clientId from githubUsername when present', async () => {
      const { rawKey } = await createUserWithKey({ githubUsername: 'bob' });
      const ctx = await resolveAuthContext(makeReq(`Bearer ${rawKey}`), db);
      expect(ctx.clientId).toBe('github:bob');
    });

    it('falls back to email-based clientId when githubUsername absent', async () => {
      const { rawKey } = await createUserWithKey({
        githubUsername: null,
        email: 'carol@example.com',
      });
      const ctx = await resolveAuthContext(makeReq(`Bearer ${rawKey}`), db);
      expect(ctx.clientId).toBe('email:carol@example.com');
    });

    it('falls back to user:<id> when neither githubUsername nor email is set', async () => {
      const { userId, rawKey } = await createUserWithKey({
        id: 'user-fallback-1',
        githubUsername: null,
        email: null,
      });
      const ctx = await resolveAuthContext(makeReq(`Bearer ${rawKey}`), db);
      expect(ctx.clientId).toBe(`user:${userId}`);
    });

    it('returns empty context for a revoked User API Key (no info leak)', async () => {
      const { rawKey, keyId } = await createUserWithKey({ githubUsername: 'dave' });
      await db.userApiKey.update({
        where: { id: keyId },
        data: { revokedAt: new Date() },
      });
      const ctx = await resolveAuthContext(makeReq(`Bearer ${rawKey}`), db);
      expect(ctx).toEqual({});
    });

    it('returns empty context for a soft-deleted user', async () => {
      const { rawKey, userId } = await createUserWithKey({ githubUsername: 'erin' });
      await db.user.update({
        where: { id: userId },
        data: { deletedAt: new Date() },
      });
      const ctx = await resolveAuthContext(makeReq(`Bearer ${rawKey}`), db);
      expect(ctx).toEqual({});
    });

    it('returns empty context for an unknown User API Key', async () => {
      const ctx = await resolveAuthContext(
        makeReq(`Bearer ${USER_API_KEY_PREFIX}${'0'.repeat(64)}`),
        db,
      );
      expect(ctx).toEqual({});
    });

    it('hashUserApiKey is deterministic over identical inputs', () => {
      const raw = USER_API_KEY_PREFIX + 'a'.repeat(64);
      expect(hashUserApiKey(raw)).toBe(hashUserApiKey(raw));
    });

    it('hashUserApiKey produces different hashes for different inputs', () => {
      const a = USER_API_KEY_PREFIX + 'a'.repeat(64);
      const b = USER_API_KEY_PREFIX + 'b'.repeat(64);
      expect(hashUserApiKey(a)).not.toBe(hashUserApiKey(b));
    });

    it('updates lastUsedAt fire-and-forget on successful resolution', async () => {
      const { rawKey, keyId } = await createUserWithKey({ githubUsername: 'frank' });
      const before = await db.userApiKey.findUniqueOrThrow({ where: { id: keyId } });
      expect(before.lastUsedAt).toBeNull();

      await resolveAuthContext(makeReq(`Bearer ${rawKey}`), db);

      // Fire-and-forget — wait briefly for the deferred update to land.
      await new Promise((r) => setTimeout(r, 50));

      const after = await db.userApiKey.findUniqueOrThrow({ where: { id: keyId } });
      expect(after.lastUsedAt).not.toBeNull();
    });

    it('does not surface appId for user-credential callers', async () => {
      const { rawKey } = await createUserWithKey({ githubUsername: 'gina' });
      const ctx = await resolveAuthContext(makeReq(`Bearer ${rawKey}`), db);
      expect(ctx.appId).toBeUndefined();
      expect(ctx.organizationId).toBeUndefined();
    });
  });

});
