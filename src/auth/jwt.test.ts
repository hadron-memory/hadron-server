import { describe, it, expect } from 'vitest';
import { SignJWT } from 'jose';
import { signJwt, verifyJwt } from './jwt.js';

// JWT_SECRET is set in vitest.config.ts env

const PAYLOAD = {
  sub: 'user-id-123',
  login: 'alice',
  role: 'ADMIN' as const,
  githubId: 42,
};

describe('signJwt + verifyJwt', () => {
  it('round-trips the payload', async () => {
    const token = await signJwt(PAYLOAD);
    const result = await verifyJwt(token);
    expect(result.sub).toBe(PAYLOAD.sub);
    expect(result.login).toBe(PAYLOAD.login);
    expect(result.role).toBe(PAYLOAD.role);
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
      .setIssuer('hadron-controller')
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
      .setIssuer('hadron-controller')
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
      .setIssuer('hadron-controller')
      .setAudience('wrong-audience')
      .setExpirationTime('7d')
      .sign(secret);

    await expect(verifyJwt(token)).rejects.toThrow();
  });

  it('throws on a malformed token string', async () => {
    await expect(verifyJwt('not.a.jwt')).rejects.toThrow();
  });

  it('throws on an empty string', async () => {
    await expect(verifyJwt('')).rejects.toThrow();
  });
});
