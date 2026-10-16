import { describe, it, expect } from 'vitest';
import { SignJWT } from 'jose';
import { signJwt, verifyJwt } from './jwt.js';

// JWT_SECRET is set in vitest.config.ts env

const PAYLOAD = {
  sub: 'user-id-123',
  githubUsername: 'alice',
  roles: ['ADMIN'] as ('OWNER' | 'ADMIN' | 'CONTRIBUTOR' | 'READER')[],
  githubId: 42,
};

describe('signJwt + verifyJwt', () => {
  it('round-trips the payload', async () => {
    const token = await signJwt(PAYLOAD);
    const result = await verifyJwt(token);
    expect(result.sub).toBe(PAYLOAD.sub);
    expect(result.githubUsername).toBe(PAYLOAD.githubUsername);
    expect(result.roles).toEqual(PAYLOAD.roles);
    expect(result.githubId).toBe(PAYLOAD.githubId);
  });

  it('returned token is a valid JWT string (3 parts)', async () => {
    const token = await signJwt(PAYLOAD);
    expect(token.split('.')).toHaveLength(3);
  });
});

describe('verifyJwt error cases', () => {
  it('throws on a tampered token (wrong secret)', async () => {
    // Sign with a different secret manually
    const secret = new TextEncoder().encode('completely-different-secret-!!!');
    const token = await new SignJWT(PAYLOAD)
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setIssuer('hadron-server')
      .setAudience('hadron')
      .setExpirationTime('7d')
      .sign(secret);

    await expect(verifyJwt(token)).rejects.toThrow();
  });

  it('throws on an expired token', async () => {
    const secret = new TextEncoder().encode(process.env.JWT_SECRET!);
    const token = await new SignJWT(PAYLOAD)
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setIssuer('hadron-server')
      .setAudience('hadron')
      .setExpirationTime('-1s') // already expired
      .sign(secret);

    await expect(verifyJwt(token)).rejects.toThrow();
  });

  it('throws on wrong issuer', async () => {
    const secret = new TextEncoder().encode(process.env.JWT_SECRET!);
    const token = await new SignJWT(PAYLOAD)
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setIssuer('wrong-issuer')
      .setAudience('hadron')
      .setExpirationTime('7d')
      .sign(secret);

    await expect(verifyJwt(token)).rejects.toThrow();
  });

  it('throws on wrong audience', async () => {
    const secret = new TextEncoder().encode(process.env.JWT_SECRET!);
    const token = await new SignJWT(PAYLOAD)
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setIssuer('hadron-server')
      .setAudience('wrong-audience')
      .setExpirationTime('7d')
      .sign(secret);

    await expect(verifyJwt(token)).rejects.toThrow();
  });

  it('#421 rejects a token signed with another HMAC algorithm on the same secret', async () => {
    // jose accepts any HS* algorithm for a Uint8Array key unless the verifier
    // pins one; signJwt only ever emits HS256.
    const secret = new TextEncoder().encode(process.env.JWT_SECRET!);
    for (const alg of ['HS384', 'HS512']) {
      const token = await new SignJWT(PAYLOAD)
        .setProtectedHeader({ alg })
        .setIssuedAt()
        .setIssuer('hadron-server')
        .setAudience('hadron')
        .setExpirationTime('7d')
        .sign(secret);

      await expect(verifyJwt(token)).rejects.toThrow();
    }
  });

  it('throws on a malformed token string', async () => {
    await expect(verifyJwt('not.a.jwt')).rejects.toThrow();
  });

  it('throws on an empty string', async () => {
    await expect(verifyJwt('')).rejects.toThrow();
  });
});
