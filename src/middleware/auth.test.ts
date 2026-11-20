import { describe, it, expect, beforeEach } from 'vitest';
import { SignJWT } from 'jose';
import type { Request } from 'express';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { Prisma } from '../generated/prisma/index.js';
import { AUTH_STORE_BUSY_MESSAGE, AUTH_STORE_UNREACHABLE_MESSAGE, AuthStoreBusyError } from '../lib/authStoreBusy.js';
import {
  APP_KEY_PREFIX,
  resolveAuthContext,
  resolveAuthContextWithStatus,
  hashUserApiKey,
  USER_API_KEY_PREFIX,
} from './auth.js';

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

    // #4561: the App-key twin of the user-key pin ('updates lastUsedAt fire-and-forget on
    // successful resolution'). Until now nothing pinned this stamp: the #4471 busy-store
    // assertions only count ZERO writes on fault paths, which a mutant that deletes the
    // success-path stamp cannot redden.
    it('#4561: updates the App Key lastUsedAt fire-and-forget on successful resolution', async () => {
      const { rawKey } = await createAppWithKey();
      const before = await db.appKey.findUniqueOrThrow({ where: { id: 'key-1' } });
      expect(before.lastUsedAt).toBeNull();

      await resolveAuthContext(makeReq(`Bearer ${rawKey}`), db);

      // Fire-and-forget; poll for the deferred update rather than a fixed sleep (same
      // budget as the user-key pin: 1s, every 10ms).
      let after = before;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        after = await db.appKey.findUniqueOrThrow({ where: { id: 'key-1' } });
        if (after.lastUsedAt) break;
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(after.lastUsedAt).not.toBeNull();
    });

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
      expect(ctx.sessionBindingRefused).toBeUndefined();
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
      // #1705: the request still proceeds, but it is marked as having named a
      // session it cannot use, so agent-task writes refuse instead of acting
      // as the bare credential.
      expect(ctx.sessionBindingRefused).toBe(true);
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
      expect(ctx.sessionBindingRefused).toBe(true);
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

    // ── #4471: a busy store during the API-key check ──────────────────────
    //
    // The App-key and user-API-key paths resolve by one hash lookup. When the
    // store is too busy to answer it (P2024, or P2028's "Unable to start"
    // arm), the rejection must surface as the typed RETRYABLE
    // AUTH_STORE_BUSY — never as the raw driver error an untyped 500 wraps,
    // and never as a verdict on the key (cor:aut:010:05 S5).
    // The JWT path is out of scope by ruling: its own catch (#3532, rulings
    // 0192–0194) keeps these faults 'unavailable' and lets the request
    // proceed.
    describe('#4471 — a busy store during the API-key check is typed retryable, never a verdict', () => {
      // The fault is injected at the lookup, so no real pool exhaustion is needed. The stub also
      // COUNTS the fire-and-forget lastUsedAt stamps (BLIND P2-3): the wrap covers the whole
      // resolver, but the only write inside fires after a successful lookup — the busy path must
      // reach zero of them. Counting makes that claim a pin instead of an argument.
      const busyDb = (reject: () => unknown) => {
        const writes = { userApiKey: 0, appKey: 0 };
        const withStamp = (model: keyof typeof writes) => ({
          findUnique: () => Promise.reject(reject()),
          update: () => {
            writes[model] += 1;
            return Promise.resolve();
          },
        });
        return {
          db: {
            userApiKey: withStamp('userApiKey'),
            appKey: withStamp('appKey'),
          } as unknown as typeof db,
          writes,
        };
      };

      const p = (code: string, message: string) =>
        new Prisma.PrismaClientKnownRequestError(message, {
          code,
          clientVersion: '6.19.2',
        });

      // #4504: P1xxx faults arrive as PrismaClientInitializationError — and on the per-query
      // path the engine leaves `errorCode` UNDEFINED (observed on 6.19.2; the code exists
      // only in the fixed message prefix), so this helper mirrors the real shape: no
      // errorCode, the message carrying "Can't reach database server at `host:port`" —
      // driver text the conversion must never forward.
      const p1001 = () => new Prisma.PrismaClientInitializationError(
        "Can't reach database server at `127.0.0.1:5432`\n\nPlease make sure your database server is running at `127.0.0.1:5432`.",
        '6.19.2',
      );

      // #4504 (QA round, Celine's FAIL at 522fe537): the WARM-POOL shape — a LIVE server whose
      // database is stopped (`compose stop db` under a warm pool) answers the NEXT QUERY with a
      // PrismaClientKnownRequestError carrying code 'P1001' (set, on this class), meta.database_location,
      // and the same engine phrase mid-message. This helper reproduces the captured object
      // FIELD-FOR-FIELD from her stopped-DB run, per her QA receipts on this PR (FAIL at 522fe537,
      // PASS at c393e9ca; stack celine4514, engine 6.19.2) — not a tidied stand-in: the invocation
      // preamble, the source frame, the phrase and the "Please make sure" tail all ride the real
      // message, so an engine rewording or a reclassified code reddens HERE, not in production.
      const p1001Warm = () => new Prisma.PrismaClientKnownRequestError(
        [
          'Invalid `db.userApiKey.findUnique()` invocation in /app/src/middleware/auth.ts:485:42',
          '',
          "    482 // direct lookup by hash. bcrypt would prevent the lookup; the raw key's",
          '    483 // entropy makes dictionary attacks against the hash a non-issue.',
          '    484 const keyHash = hashUserApiKey(rawKey);',
          '  → 485 const userApiKey = await db.userApiKey.findUnique(',
          "Can't reach database server at `db:5432`",
          '',
          'Please make sure your database server is running at `db:5432`.',
        ].join('\n'),
        {
          code: 'P1001',
          meta: { modelName: 'UserApiKey', database_location: 'db:5432' },
          clientVersion: '6.19.2',
        },
      );

      const USER_KEY = USER_API_KEY_PREFIX + 'a'.repeat(64);
      const APP_KEY = APP_KEY_PREFIX + 'b'.repeat(64);

      async function refuse(doReject: () => Promise<unknown>): Promise<unknown> {
        try {
          await doReject();
        } catch (e) {
          return e;
        }
        throw new Error('expected a rejection');
      }

      it('a P2024 during the lookup throws the typed fault, not the raw driver error, on both key paths (BLIND P3)', async () => {
        for (const key of [USER_KEY, APP_KEY]) {
          const busy = busyDb(() => p('P2024', 'Timed out fetching a new connection from the pool.'));
          const err = await refuse(() => resolveAuthContextWithStatus(makeReq(`Bearer ${key}`), busy.db));
          expect(err, key).toBeInstanceOf(AuthStoreBusyError);
          const typed = err as AuthStoreBusyError;
          expect(typed.message).toBe(AUTH_STORE_BUSY_MESSAGE);
          expect(typed.extensions.code).toBe('AUTH_STORE_BUSY');
          expect(typed.extensions.retryable).toBe(true);
          expect(typed.extensions.reason).toBe('POOL_WAIT');
          // No driver text rides the message; the driver error stays on .cause, server-side only.
          expect(typed.message).not.toMatch(/P2024|Timed out fetching/i);
          expect(typed.cause).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
          // BLIND P2-3, pinned: nothing was written on the busy path.
          expect(busy.writes, key).toEqual({ userApiKey: 0, appKey: 0 });
        }
      });

      it('P2028 "Unable to start a transaction" is the same typed fault, on both key paths', async () => {
        for (const key of [USER_KEY, APP_KEY]) {
          const err = await refuse(() =>
            resolveAuthContextWithStatus(
              makeReq(`Bearer ${key}`),
              busyDb(() => p('P2028', 'Unable to start a transaction in the given time.')).db,
            ),
          );
          expect(err, key).toBeInstanceOf(AuthStoreBusyError);
          expect((err as AuthStoreBusyError).extensions.code).toBe('AUTH_STORE_BUSY');
          expect((err as AuthStoreBusyError).extensions.retryable).toBe(true);
        }
      });

      it('#4504: a P1001 (unreachable store, new connection) during the lookup throws the typed fault with the sibling reason, on both key paths', async () => {
        for (const key of [USER_KEY, APP_KEY]) {
          const busy = busyDb(() => p1001());
          const err = await refuse(() => resolveAuthContextWithStatus(makeReq(`Bearer ${key}`), busy.db));
          expect(err, key).toBeInstanceOf(AuthStoreBusyError);
          const typed = err as AuthStoreBusyError;
          // Same code, same retryability, sibling reason and prose.
          expect(typed.message).toBe(AUTH_STORE_UNREACHABLE_MESSAGE);
          expect(typed.extensions.code).toBe('AUTH_STORE_BUSY');
          expect(typed.extensions.retryable).toBe(true);
          expect(typed.extensions.reason).toBe('STORE_UNREACHABLE');
          // No driver text rides the message — the host:port stays server-side.
          expect(typed.message).not.toMatch(/Can't reach|P1001|127\.0\.0\.1/i);
          expect(typed.cause).toBeInstanceOf(Prisma.PrismaClientInitializationError);
          // The real per-query shape: no errorCode on the instance — the code lives in
          // the message (behind the client's invocation preamble).
          expect((typed.cause as Prisma.PrismaClientInitializationError).message).toMatch(/Can't reach database server/i);
          // The unreachable path wrote nothing either — counted, not argued.
          expect(busy.writes, key).toEqual({ userApiKey: 0, appKey: 0 });
        }
      });

      it('#4504 (QA round): the WARM-POOL P1001 — the live stopped-DB shape, captured not invented — throws the same typed fault on both key paths', async () => {
        for (const key of [USER_KEY, APP_KEY]) {
          const busy = busyDb(() => p1001Warm());
          const err = await refuse(() => resolveAuthContextWithStatus(makeReq(`Bearer ${key}`), busy.db));
          expect(err, key).toBeInstanceOf(AuthStoreBusyError);
          const typed = err as AuthStoreBusyError;
          // Same code, same retryability, sibling reason and prose — identical to the
          // never-connected shape: an unreachable store is unreachable either way.
          expect(typed.message).toBe(AUTH_STORE_UNREACHABLE_MESSAGE);
          expect(typed.extensions.code).toBe('AUTH_STORE_BUSY');
          expect(typed.extensions.retryable).toBe(true);
          expect(typed.extensions.reason).toBe('STORE_UNREACHABLE');
          // No driver text rides the message — db:5432 stays server-side, on .cause only.
          expect(typed.message).not.toMatch(/Can't reach|P1001|db:5432/i);
          expect(typed.cause).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
          expect((typed.cause as Prisma.PrismaClientKnownRequestError).code).toBe('P1001');
          expect((typed.cause as Prisma.PrismaClientKnownRequestError).meta).toMatchObject({ database_location: 'db:5432' });
          expect(busy.writes, key).toEqual({ userApiKey: 0, appKey: 0 });
        }
      });

      // #4519 (BLIND delta P3): the warm arm's discriminator is the CODE on the class, not one
      // captured object — the engine can emit the warm P1001 with a leaner payload (no meta at
      // all, or meta without database_location) and with any clientVersion. The captured leg
      // above stays field-for-field (it reddens on an engine REWORDING); this leg sweeps the
      // key-shape variants so the arm cannot over-fit the one capture.
      it('#4519: the warm arm tolerates the P1001 key-shape variants — no meta, leaner meta, a later clientVersion', async () => {
        const variants: { label: string; options: ConstructorParameters<typeof Prisma.PrismaClientKnownRequestError>[1] }[] = [
          { label: 'no meta at all', options: { code: 'P1001', clientVersion: '6.19.2' } },
          { label: 'meta without database_location', options: { code: 'P1001', clientVersion: '6.19.2', meta: { modelName: 'UserApiKey' } } },
          { label: 'a later clientVersion', options: { code: 'P1001', clientVersion: '6.20.0', meta: { modelName: 'UserApiKey', database_location: 'db:5432' } } },
        ];
        for (const { label, options } of variants) {
          const busy = busyDb(() => new Prisma.PrismaClientKnownRequestError(
            "Can't reach database server at `db:5432`",
            options,
          ));
          const err = await refuse(() => resolveAuthContextWithStatus(makeReq(`Bearer ${USER_KEY}`), busy.db));
          expect(err, label).toBeInstanceOf(AuthStoreBusyError);
          const typed = err as AuthStoreBusyError;
          expect(typed.extensions.reason, label).toBe('STORE_UNREACHABLE');
          expect(typed.message, label).toBe(AUTH_STORE_UNREACHABLE_MESSAGE);
          expect(typed.cause, label).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
          expect((typed.cause as Prisma.PrismaClientKnownRequestError).code, label).toBe('P1001');
        }
      });

      it('#4504 (QA round): the warm-pool typed refusal is DETERMINISTIC — the same injected fault serializes identically every call', async () => {
        // #4519 (BLIND P3-5), relabeled: this unit leg cannot assert "identical across key
        // shapes" on its own — a raw (unconverted) error is also identical across key shapes.
        // What it pins is DETERMINISM: nothing request-scoped rides the conversion, so the
        // same captured fault answers byte-identically. It composes with the instanceof leg
        // above (together: CONVERTED-and-deterministic, the property QA observed live); the
        // oracle-free cross-shape assertion is the e2e user-vs-App leg in
        // api/graphql/authStoreUnreachable4504.test.ts.
        const answers = await Promise.all(
          [USER_KEY, APP_KEY, USER_API_KEY_PREFIX + 'e'.repeat(64), APP_KEY_PREFIX + 'f'.repeat(64)].map((key) =>
            refuse(() => resolveAuthContextWithStatus(makeReq(`Bearer ${key}`), busyDb(() => p1001Warm()).db)).then(
              (err) => {
                const typed = err as AuthStoreBusyError;
                return JSON.stringify({ message: typed.message, extensions: typed.extensions });
              },
            ),
          ),
        );
        for (const a of answers.slice(1)) expect(a).toBe(answers[0]);
      });

      it('#4504 (QA round): a neighboring KNOWN-REQUEST fault (P1002 on the warm class) stays the raw error — the warm arm is P1001 only', async () => {
        const rejected = await refuse(() =>
          resolveAuthContextWithStatus(
            makeReq(`Bearer ${USER_KEY}`),
            busyDb(() => new Prisma.PrismaClientKnownRequestError(
              'Authentication failed against the database server',
              { code: 'P1002', clientVersion: '6.19.2' },
            )).db,
          ),
        );
        expect(rejected).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
        expect(rejected).not.toBeInstanceOf(AuthStoreBusyError);
      });

      it('#4504: the P1001 typed refusal is DETERMINISTIC — nothing request-scoped rides the conversion', async () => {
        // #4519 (BLIND P3-5), relabeled: the oracle-free "identical across key shapes"
        // assertion is the e2e user-vs-App leg (api/graphql/authStoreUnreachable4504.test.ts);
        // this unit leg pins that the conversion itself is deterministic — same fault, same
        // serialized answer — and composes with the instanceof legs above.
        const verdicts = [USER_KEY, APP_KEY, USER_API_KEY_PREFIX + 'c'.repeat(64), APP_KEY_PREFIX + 'd'.repeat(64)]
          .map((key) => {
            const busy = busyDb(() => p1001());
            return refuse(() => resolveAuthContextWithStatus(makeReq(`Bearer ${key}`), busy.db))
              .then((err) => {
                const typed = err as AuthStoreBusyError;
                return JSON.stringify({ message: typed.message, extensions: typed.extensions });
              });
          });
        const answers = await Promise.all(verdicts);
        for (const a of answers.slice(1)) expect(a).toBe(answers[0]);
      });

      it('#4504: a non-Prisma error wearing errorCode P1001 is NOT classified — the class is closed to Prisma', async () => {
        const impostor = Object.assign(new Error('not prisma'), { errorCode: 'P1001' });
        const err = await refuse(() =>
          resolveAuthContextWithStatus(makeReq(`Bearer ${USER_KEY}`), busyDb(() => impostor).db),
        );
        expect(err).toBe(impostor);
      });

      // #4519 (LOCAL P3-1): the defensive errorCode arm, pinned on its own. On the installed
      // engine (6.19.2) the per-query initialization error leaves `errorCode` undefined (see
      // p1001's comment), so every other leg reaches the classifier's phrase arm — nothing fed
      // the CODE arm until this leg. The message here cannot match the phrase, so only the
      // errorCode arm can classify: dropping it reddens HERE first (the gate's named mutant).
      it('#4519: an initialization error carrying errorCode P1001 but NOT the engine phrase still classifies STORE_UNREACHABLE — the defensive errorCode arm', async () => {
        const err = await refuse(() =>
          resolveAuthContextWithStatus(
            makeReq(`Bearer ${USER_KEY}`),
            busyDb(() => new Prisma.PrismaClientInitializationError(
              'Database handshake dropped by the network',
              '6.19.2',
              'P1001',
            )).db,
          ),
        );
        expect(err).toBeInstanceOf(AuthStoreBusyError);
        const typed = err as AuthStoreBusyError;
        expect(typed.extensions.reason).toBe('STORE_UNREACHABLE');
        expect(typed.message).toBe(AUTH_STORE_UNREACHABLE_MESSAGE);
        expect(typed.cause).toBeInstanceOf(Prisma.PrismaClientInitializationError);
        expect((typed.cause as Prisma.PrismaClientInitializationError).errorCode).toBe('P1001');
      });

      it('#4504: a neighboring initialization fault (P1002, authentication refused) stays the raw error — only P1001 is the unreachable arm', async () => {
        const rejected = await refuse(() =>
          resolveAuthContextWithStatus(
            makeReq(`Bearer ${USER_KEY}`),
            busyDb(() => new Prisma.PrismaClientInitializationError(
              'Authentication failed against the database server',
              '6.19.2',
              'P1002',
            )).db,
          ),
        );
        expect(rejected).toBeInstanceOf(Prisma.PrismaClientInitializationError);
        expect(rejected).not.toBeInstanceOf(AuthStoreBusyError);
      });

      it('#4504 (Bradley P3, the reachable half of "nothing was written"): the fire-and-forget lastUsedAt stamp FIRES and its rejection is swallowed — it cannot produce this fault (#4519, BLIND P2-2)', async () => {
        // A successful lookup followed by a REJECTED stamp: the resolver must still resolve,
        // because the stamp is never awaited (`.catch(() => {})` in the resolver). Together
        // with the lookup being the only awaited store operation, this is why the typed fault
        // can only originate from the lookup itself — where nothing has been written yet.
        // #4519 (BLIND P2-2): the stub now COUNTS the update calls and the assertions run
        // after a tick, so the leg pins the CALL fired (remove the stamp and it reddens),
        // not just the swallow.
        let stampCalls = 0;
        const stampingDb = {
          userApiKey: {
            findUnique: () => Promise.resolve({
              id: 'key-4504',
              revokedAt: null,
              originSignIn: null,
              originSignInId: null,
              oauthScopes: [],
              user: { id: 'user-4504', deletedAt: null, roles: ['READER'], githubUsername: 'yuri', email: null },
            }),
            update: () => {
              stampCalls += 1;
              return Promise.reject(p('P2024', 'Timed out fetching a new connection from the pool.'));
            },
          },
        } as unknown as typeof db;
        const ctx = await resolveAuthContextWithStatus(makeReq(`Bearer ${USER_KEY}`), stampingDb);
        // One microtask tick: let the rejected stamp's promise chain (and its swallow) settle
        // before asserting, so an unhandled rejection would surface here, not in a later test.
        await new Promise((resolve) => setImmediate(resolve));
        expect(ctx.auth.userId).toBe('user-4504');
        expect(ctx.credentialStatus).toBe('authenticated');
        expect(stampCalls).toBe(1);
      });

      it('#4561: the App Key lastUsedAt stamp FIRES and its rejection is swallowed — the App-key twin of the user-key swallow pin', async () => {
        // Same shape as the user-key leg above: a successful lookup, then a REJECTED stamp.
        // The call is COUNTED and asserted after a tick, so removing the stamp reddens here;
        // the rejection must neither surface as AUTH_STORE_BUSY nor fail the request.
        let stampCalls = 0;
        const stampingDb = {
          appKey: {
            findUnique: () => Promise.resolve({
              id: 'key-4561',
              revokedAt: null,
              app: { id: 'app-4561', deletedAt: null, organizationId: 'org-4561' },
            }),
            update: () => {
              stampCalls += 1;
              return Promise.reject(p('P2024', 'Timed out fetching a new connection from the pool.'));
            },
          },
        } as unknown as typeof db;
        // The swallow is asserted by THIS test, not by the runner: an unhandled rejection is
        // captured here, so dropping the resolver's `.catch` fails this test by name instead of
        // surfacing only as a run-level error attributed to whichever test is running (#4571, BLIND P2).
        const unhandled: unknown[] = [];
        const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
        process.on('unhandledRejection', onUnhandled);
        try {
          const ctx = await resolveAuthContextWithStatus(makeReq(`Bearer ${APP_KEY}`), stampingDb);
          // Let the rejected stamp's promise chain settle (a rejection is reported after the
          // microtask queue drains, so two macrotask ticks) before asserting.
          await new Promise((resolve) => setImmediate(resolve));
          await new Promise((resolve) => setImmediate(resolve));
          expect(ctx.auth.appId).toBe('app-4561');
          expect(ctx.auth.appKeyId).toBe('key-4561');
          expect(ctx.credentialStatus).toBe('authenticated');
          expect(stampCalls).toBe(1);
          expect(unhandled).toEqual([]);
        } finally {
          process.off('unhandledRejection', onUnhandled);
        }
      });

      it('a non-Prisma error wearing code P2024 is NOT classified — the class is closed to Prisma (LOCAL mutant)', async () => {
        // The classifier must prove instanceof, not read a field any Error can carry.
        const impostor = Object.assign(new Error('not prisma'), { code: 'P2024' });
        const err = await refuse(() =>
          resolveAuthContextWithStatus(makeReq(`Bearer ${USER_KEY}`), busyDb(() => impostor).db),
        );
        expect(err).toBe(impostor);
      });

      it('every other fault stays the raw error — the class is closed', async () => {
        // P2028's other arm ("Transaction already closed") has no meaning during a
        // lookup that holds no transaction.
        const closed = await refuse(() =>
          resolveAuthContextWithStatus(
            makeReq(`Bearer ${USER_KEY}`),
            busyDb(() => p('P2028', 'Transaction already closed')).db,
          ),
        );
        expect(closed).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
        expect(closed).not.toBeInstanceOf(AuthStoreBusyError);
        // #4476's model-statement cancel shape (an UnknownRequestError carrying the
        // rendered 57014) is a bounded-read concept, deliberately not classified here.
        const cancel = await refuse(() =>
          resolveAuthContextWithStatus(
            makeReq(`Bearer ${USER_KEY}`),
            busyDb(() =>
              new Prisma.PrismaClientUnknownRequestError(
                'PostgresError { code: "57014", message: "canceling statement due to statement timeout" }',
                { clientVersion: '6.19.2' },
              ),
            ).db,
          ),
        );
        expect(cancel).toBeInstanceOf(Prisma.PrismaClientUnknownRequestError);
        expect(cancel).not.toBeInstanceOf(AuthStoreBusyError);
      });

      it('the verdicts stay byte-identical: unknown, revoked, deleted-user and ended-sign-in keys refuse the same', async () => {
        const unknown = await resolveAuthContext(
          makeReq(`Bearer ${USER_API_KEY_PREFIX}${'0'.repeat(64)}`),
          db,
        );
        const revokedPair = await createUserWithKey({ githubUsername: 'vera' });
        await db.userApiKey.update({
          where: { id: revokedPair.keyId },
          data: { revokedAt: new Date() },
        });
        const revoked = await resolveAuthContext(makeReq(`Bearer ${revokedPair.rawKey}`), db);

        const deletedPair = await createUserWithKey({ githubUsername: 'walt' });
        await db.user.update({
          where: { id: deletedPair.userId },
          data: { deletedAt: new Date() },
        });
        const deleted = await resolveAuthContext(makeReq(`Bearer ${deletedPair.rawKey}`), db);

        // #1897: a key descending from an ended sign-in is dead even if its own row is clean.
        // originSignInId is immutable ("the sign-in root of a credential never changes"), so the
        // key is CREATED with it — the same shape signIn.test.ts mints.
        const { randomBytes } = await import('crypto');
        const endedUser = await db.user.create({
          data: { id: 'user-4471-xena', githubUsername: 'xena', email: null, roles: ['READER'] },
        });
        const signIn = await db.signIn.create({
          data: {
            userId: endedUser.id,
            method: 'email',
            expiresAt: new Date(Date.now() + 3_600_000),
            endedAt: new Date(),
            endReason: 'signout',
          },
        });
        const endedKey = USER_API_KEY_PREFIX + randomBytes(32).toString('hex');
        await db.userApiKey.create({
          data: {
            userId: endedUser.id,
            keyHash: hashUserApiKey(endedKey),
            keyPreview: endedKey.slice(-4),
            label: 'ended',
            createdBy: endedUser.id,
            issuedVia: 'portal',
            oauthScopes: [],
            originSignInId: signIn.id,
          },
        });
        const ended = await resolveAuthContext(makeReq(`Bearer ${endedKey}`), db);

        expect(JSON.stringify(unknown)).toBe('{}');
        for (const ctx of [revoked, deleted, ended]) {
          expect(JSON.stringify(ctx)).toBe(JSON.stringify(unknown));
        }
      });
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

it('passes only a signed callback login claim through JWT authentication', async () => {
  const user = await db.user.create({ data: { handle: 'fresh-login', roles: ['READER'] } });
  const login = { at: Date.now() - 10_000, method: 'google' };
  const token = await makeJwt({ sub: user.id, login });
  expect((await resolveAuthContext(makeReq(`Bearer ${token}`), db)).login).toEqual(login);
  const ordinary = await makeJwt({ sub: user.id });
  expect((await resolveAuthContext(makeReq(`Bearer ${ordinary}`), db)).login).toBeUndefined();
});
