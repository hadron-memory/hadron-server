import { describe, it, expect, beforeEach } from 'vitest';
import { SignJWT } from 'jose';
import type { Request } from 'express';
import { db } from '../integrations/db/client.js';
import { cleanDb, createDbStation, TEST_RAW_KEY } from '../test/helpers.js';
import { resolveAuthContext } from './auth.js';

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

  it('resolves a valid API key to station context', async () => {
    const station = await createDbStation(db, 'my-service', 'CONTRIBUTOR');

    const ctx = await resolveAuthContext(makeReq(`Bearer ${TEST_RAW_KEY}`), db);
    expect(ctx.clientId).toBe(station.id);
    expect(ctx.roles).toEqual(['CONTRIBUTOR']);
    expect(ctx.userId).toBeUndefined();
  });

  it('returns empty context for an invalid API key', async () => {
    await createDbStation(db, 'my-service', 'READER');

    const ctx = await resolveAuthContext(makeReq(`Bearer ${'z'.repeat(64)}`), db);
    expect(ctx).toEqual({});
  });

  it('returns empty context for an expired Station', async () => {
    const past = new Date(Date.now() - 1000);
    await createDbStation(db, 'expired-station', 'READER', { expiresAt: past });

    const ctx = await resolveAuthContext(makeReq(`Bearer ${TEST_RAW_KEY}`), db);
    expect(ctx).toEqual({});
  });

  it('updates lastUsedAt in DB when API key is valid', async () => {
    await createDbStation(db, 'tracking-station', 'ADMIN');

    await resolveAuthContext(makeReq(`Bearer ${TEST_RAW_KEY}`), db);

    const station = await db.station.findFirst({ where: { name: 'tracking-station' } });
    expect(station!.lastUsedAt).not.toBeNull();
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
        data: { id: 'mem-1', organizationId: 'org-app-test', urn: 'org-app-test:m', name: 'm' },
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
        data: { id: 'mem-2', organizationId: 'org-app-test', urn: 'org-app-test:m2', name: 'm2' },
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
        data: { id: 'app-other', organizationId: 'org-other', name: 'Other' },
      });
      await db.agent.create({
        data: { id: 'agent-other', organizationId: 'org-other', urn: 'other:a', name: 'a' },
      });
      await db.memory.create({
        data: { id: 'mem-other', organizationId: 'org-other', urn: 'other:m', name: 'm' },
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

});
