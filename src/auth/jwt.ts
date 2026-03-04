import { SignJWT, jwtVerify, type JWTPayload } from 'jose';

export interface HadronJwtPayload extends JWTPayload {
  sub: string;        // User.id (cuid)
  login: string;      // GitHub username
  roles: ('ADMIN' | 'CONTRIBUTOR' | 'READER')[];
  githubId: number;
}

const JWT_ISSUER = 'hadron-controller';
const JWT_AUDIENCE = 'hadron';
const JWT_EXPIRY = '7d';

function getSecret(): Uint8Array {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET env var is required');
  return new TextEncoder().encode(secret);
}

export async function signJwt(
  payload: Omit<HadronJwtPayload, 'iss' | 'aud' | 'iat' | 'exp'>,
): Promise<string> {
  return new SignJWT(payload as unknown as Record<string, unknown>)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setIssuer(JWT_ISSUER)
    .setAudience(JWT_AUDIENCE)
    .setExpirationTime(JWT_EXPIRY)
    .sign(getSecret());
}

export async function verifyJwt(token: string): Promise<HadronJwtPayload> {
  const { payload } = await jwtVerify(token, getSecret(), {
    issuer: JWT_ISSUER,
    audience: JWT_AUDIENCE,
  });
  return payload as unknown as HadronJwtPayload;
}
