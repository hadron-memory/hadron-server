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
    // The liveness check (#662) resolves the subject against the users
    // table, so the row must exist and be undeleted.
    await db.user.create({
      data: { id: 'user-1', handle: 'alice', githubUsername: 'alice', githubId: 1, roles: ['ADMIN'] },
    });
    const token = await makeJwt({ sub: 'user-1', githubUsername: 'alice', roles: ['ADMIN'], githubId: 1 });
    const ctx = await resolveAuthContext(makeReq(`Bearer ${token}`), db);

    expect(ctx.clientId).toBe('github:alice');
    expect(ctx.userId).toBe('user-1');
    expect(ctx.roles).toEqual(['ADMIN']);
  });

  it('#1251 — resolves JWT roles from the current user row, not the signed claim', async () => {
    await db.user.create({
      data: {
        id: 'user-stale-admin',
        githubUsername: 'stale-admin',
        githubId: 1251,
        roles: ['READER'],
      },
    });
    const token = await makeJwt({
      sub: 'user-stale-admin',
      githubUsername: 'stale-admin',
      roles: ['ADMIN'],
      githubId: 1251,
    });

    const ctx = await resolveAuthContext(makeReq(`Bearer ${token}`), db);

    expect(ctx.userId).toBe('user-stale-admin');
    expect(ctx.roles).toEqual(['READER']);
  });

  it('returns empty context for a JWT whose subject does not exist or is deleted', async () => {
    const token = await makeJwt({ sub: 'ghost', githubUsername: 'ghost', roles: ['READER'], githubId: 3 });
    expect(await resolveAuthContext(makeReq(`Bearer ${token}`), db)).toEqual({});
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

    it('#1661 review (Rook P2-1, DY-5): a NO-expiry session binds while recent and stops binding once dormant', async () => {
      const { appId, rawKey } = await createAppWithKey();
      await db.app.update({ where: { id: appId }, data: { sessionDormancyDays: 30 } });
      const at = (days: number) => new Date(Date.now() - days * 24 * 60 * 60 * 1000);
      await db.session.create({ data: { id: 'sess-recent', appId, type: 'CHATBOT', startedAt: at(10), updatedAt: at(10) } });
      await db.session.create({ data: { id: 'sess-forgotten', appId, type: 'CHATBOT', startedAt: at(400), updatedAt: at(400) } });
      // A hard expiry, not dormancy, bounds a session that has one.
      await db.session.create({ data: { id: 'sess-bounded', appId, type: 'CHATBOT', startedAt: at(400), updatedAt: at(400), expiresAt: new Date(Date.now() + 60000) } });
      const bind = async (id: string) => (await resolveAuthContext(
        { headers: { authorization: `Bearer ${rawKey}`, 'x-hadron-session': id } } as unknown as Request, db,
      )).sessionId;
      expect(await bind('sess-recent')).toBe('sess-recent');
      expect(await bind('sess-forgotten')).toBeUndefined();
      expect(await bind('sess-bounded')).toBe('sess-bounded');
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

    /**
     * #943 regression. `Session.appId` used to be writable ONLY by an App key,
     * so "this session names my App" and "my App created this session" were
     * the same statement. `SessionInput.appRef` (PR #944) lets a MEMBER stamp
     * it, and the session id is caller-generated — so this binding check is
     * now the only thing standing between a caller-suppliable column and
     * `getAccessibleMemoryIds`'s App-key-with-session branch
     * (`resolvers.helpers.ts:926`), which returns the session's memory + the
     * bound agent's system memory AS the accessible set.
     *
     * Both directions are pinned: a foreign App's key must not bind a session
     * merely because a user stamped that session with some App, and the named
     * App's key must still bind (the feature would be inert otherwise).
     */
    it('binds by the session App, not by who created it (#943 caller-suppliable appId)', async () => {
      const { appId, rawKey } = await createAppWithKey();
      await db.organization.create({
        data: { id: 'org-bystander', name: 'bystander', urn: 'bystander' },
      });
      const bystander = await db.app.create({
        data: { id: 'app-bystander', organizationId: 'org-bystander', name: 'Bystander', urn: 'bystander:app' },
      });
      const { createHash, randomBytes } = await import('crypto');
      const bystanderKey = 'hdr_app_' + randomBytes(32).toString('hex');
      await db.appKey.create({
        data: {
          id: 'key-bystander',
          appId: bystander.id,
          keyHash: createHash('sha256').update(bystanderKey).digest('hex'),
          keyPreview: bystanderKey.slice(0, 12) + '...',
        },
      });
      // A member-started session that NAMES app-1 — the state `appRef` makes
      // reachable without app-1's key ever being involved.
      await db.user.create({
        data: { id: 'user-member', githubId: 9431, githubUsername: 'member', roles: ['READER'] },
      });
      await db.session.create({
        data: { id: 'sess-member', appId, userId: 'user-member', type: 'DEVELOPER' },
      });
      const withKey = (key: string) =>
        resolveAuthContext(
          {
            headers: { authorization: `Bearer ${key}`, 'x-hadron-session': 'sess-member' },
          } as unknown as Request,
          db,
        );

      expect((await withKey(bystanderKey)).sessionId).toBeUndefined();
      expect((await withKey(rawKey)).sessionId).toBe('sess-member');
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
          oauthScopes: [],
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

      // Fire-and-forget; poll for the deferred update rather than a
      // fixed sleep to avoid CI flake under load. Total budget: 1s,
      // polled every 10ms.
      let after = before;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        after = await db.userApiKey.findUniqueOrThrow({ where: { id: keyId } });
        if (after.lastUsedAt) break;
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(after.lastUsedAt).not.toBeNull();
    });

    it('does not surface appId for user-credential callers', async () => {
      const { rawKey } = await createUserWithKey({ githubUsername: 'gina' });
      const ctx = await resolveAuthContext(makeReq(`Bearer ${rawKey}`), db);
      expect(ctx.appId).toBeUndefined();
      expect(ctx.organizationId).toBeUndefined();
    });
  });

  // ── User-principal session binding (#934, amending cor:aut:020:02) ──────
  //
  // Binding is ATTRIBUTION only (the usage-event heartbeat the #930 reaper
  // counts), never a credential: strict `session.userId === userId`, no
  // platform-admin bypass, never under impersonation. The scope-side
  // narrow-never-grant mirror (#967 class) is pinned in
  // resolvers.sessionIsolationScope.test.ts.
  describe('User-principal session binding (#934)', () => {
    async function createUserWithKey(
      id: string,
      roles: ('OWNER' | 'ADMIN' | 'CONTRIBUTOR' | 'READER')[] = ['READER'],
    ): Promise<{ userId: string; rawKey: string }> {
      const { randomBytes } = await import('crypto');
      const user = await db.user.create({
        data: { id, githubUsername: id, githubId: Math.floor(Math.random() * 1e9), roles },
      });
      const rawKey = USER_API_KEY_PREFIX + randomBytes(32).toString('hex');
      await db.userApiKey.create({
        data: {
          userId: user.id,
          keyHash: hashUserApiKey(rawKey),
          keyPreview: rawKey.slice(-4),
          label: 'test',
          createdBy: user.id,
          issuedVia: 'portal',
          oauthScopes: [],
        },
      });
      return { userId: user.id, rawKey };
    }

    const withSession = (token: string, sessionId: string) =>
      resolveAuthContext(
        {
          headers: { authorization: `Bearer ${token}`, 'x-hadron-session': sessionId },
        } as unknown as Request,
        db,
      );

    it('binds a session the user is attributed to (hdr_user_ key)', async () => {
      const { userId, rawKey } = await createUserWithKey('user-owner');
      // The self-attributed CLI shape: appId null — ownership, not
      // App-membership, is the predicate.
      await db.session.create({
        data: { id: 'sess-own', userId, type: 'DEVELOPER' },
      });
      const ctx = await withSession(rawKey, 'sess-own');
      expect(ctx.userId).toBe(userId);
      expect(ctx.sessionId).toBe('sess-own');
    });

    it('binds via a JWT user credential too (one binding path)', async () => {
      await db.user.create({
        data: { id: 'user-jwt', handle: 'jwtu', githubUsername: 'jwtu', githubId: 77, roles: ['READER'] },
      });
      await db.session.create({
        data: { id: 'sess-jwt', userId: 'user-jwt', type: 'DEVELOPER' },
      });
      const token = await makeJwt({ sub: 'user-jwt', githubUsername: 'jwtu', roles: ['READER'], githubId: 77 });
      const ctx = await withSession(token, 'sess-jwt');
      expect(ctx.sessionId).toBe('sess-jwt');
    });

    it("refuses another user's session — strict ownership", async () => {
      const { rawKey } = await createUserWithKey('user-a');
      const { userId: otherId } = await createUserWithKey('user-b');
      await db.session.create({
        data: { id: 'sess-other-user', userId: otherId, type: 'DEVELOPER' },
      });
      const ctx = await withSession(rawKey, 'sess-other-user');
      expect(ctx.userId).toBe('user-a');
      expect(ctx.sessionId).toBeUndefined();
    });

    it('platform ADMIN gets no bypass on the ownership check', async () => {
      const { rawKey } = await createUserWithKey('user-admin', ['ADMIN']);
      const { userId: otherId } = await createUserWithKey('user-c');
      await db.session.create({
        data: { id: 'sess-of-c', userId: otherId, type: 'DEVELOPER' },
      });
      const ctx = await withSession(rawKey, 'sess-of-c');
      expect(ctx.roles).toEqual(['ADMIN']);
      expect(ctx.sessionId).toBeUndefined();
    });

    it('refuses an ended session (same honor conditions as App-key)', async () => {
      const { userId, rawKey } = await createUserWithKey('user-ended');
      await db.session.create({
        data: { id: 'sess-ended', userId, type: 'DEVELOPER', endedAt: new Date() },
      });
      expect((await withSession(rawKey, 'sess-ended')).sessionId).toBeUndefined();
    });

    it('refuses a hard-expired session (same honor conditions as App-key)', async () => {
      const { userId, rawKey } = await createUserWithKey('user-expired');
      await db.session.create({
        data: {
          id: 'sess-expired',
          userId,
          type: 'DEVELOPER',
          expiresAt: new Date(Date.now() - 60_000),
        },
      });
      expect((await withSession(rawKey, 'sess-expired')).sessionId).toBeUndefined();
    });

    it('never binds under impersonation, even for the TARGET-owned session', async () => {
      // A live, fully-authorized impersonation context: platform-admin actor,
      // target a READER in the shared org. The target OWNS the session — the
      // ownership predicate would match — but a support session heartbeating
      // the target's coding session is attribution theater, and the binding
      // must stay identity-scoped (the #876 class).
      const org = await db.organization.create({
        data: { id: 'org-imp', name: 'imp', urn: 'imp-org.com' },
      });
      const actor = await db.user.create({
        data: { id: 'imp-actor', githubUsername: 'imp-actor', githubId: 501, roles: ['ADMIN'] },
      });
      const target = await db.user.create({
        data: { id: 'imp-target', githubUsername: 'imp-target', githubId: 502, roles: ['READER'] },
      });
      await db.orgMember.createMany({
        data: [
          { id: 'om-imp-a', organizationId: org.id, userId: actor.id, role: 'ADMIN' },
          { id: 'om-imp-t', organizationId: org.id, userId: target.id, role: 'READER' },
        ],
      });
      await db.impersonationSession.create({
        data: {
          id: 'imp-sess-1',
          adminUserId: actor.id,
          targetUserId: target.id,
          organizationId: org.id,
          expiresAt: new Date(Date.now() + 60_000),
        },
      });
      await db.session.create({
        data: { id: 'sess-of-target', userId: target.id, type: 'DEVELOPER' },
      });
      const token = await makeJwt({
        sub: target.id,
        imp: { sid: 'imp-sess-1', act: actor.id, org: org.id },
      });
      const ctx = await withSession(token, 'sess-of-target');
      // Sanity: the impersonation context itself resolved…
      expect(ctx.userId).toBe(target.id);
      expect(ctx.impersonation?.actorUserId).toBe(actor.id);
      // …and the binding did not.
      expect(ctx.sessionId).toBeUndefined();
    });
  });

});
