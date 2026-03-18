import { describe, it, expect, beforeEach } from 'vitest';
import { SignJWT } from 'jose';
import type { Request } from 'express';
import { db } from '../integrations/db/client.js';
import { cleanDb, createDbClient, TEST_RAW_KEY } from '../test/helpers.js';
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

  it('resolves a valid API key to client context', async () => {
    const client = await createDbClient(db, 'my-service', 'CONTRIBUTOR');

    const ctx = await resolveAuthContext(makeReq(`Bearer ${TEST_RAW_KEY}`), db);
    expect(ctx.clientId).toBe(client.id);
    expect(ctx.roles).toEqual(['CONTRIBUTOR']);
    expect(ctx.userId).toBeUndefined();
  });

  it('returns empty context for an invalid API key', async () => {
    await createDbClient(db, 'my-service', 'READER');

    const ctx = await resolveAuthContext(makeReq(`Bearer ${'z'.repeat(64)}`), db);
    expect(ctx).toEqual({});
  });

  it('returns empty context for an expired Client', async () => {
    const past = new Date(Date.now() - 1000);
    await createDbClient(db, 'expired-client', 'READER', { expiresAt: past });

    const ctx = await resolveAuthContext(makeReq(`Bearer ${TEST_RAW_KEY}`), db);
    expect(ctx).toEqual({});
  });

  it('updates lastUsedAt in DB when API key is valid', async () => {
    await createDbClient(db, 'tracking-client', 'ADMIN');

    await resolveAuthContext(makeReq(`Bearer ${TEST_RAW_KEY}`), db);

    const client = await db.client.findFirst({ where: { label: 'tracking-client' } });
    expect(client!.lastUsedAt).not.toBeNull();
  });

  it('propagates namespace from client to context', async () => {
    await createDbClient(db, 'ns-client', 'READER', { namespace: 'org.graph' });

    const ctx = await resolveAuthContext(makeReq(`Bearer ${TEST_RAW_KEY}`), db);
    expect(ctx.namespace).toBe('org.graph');
  });
});
