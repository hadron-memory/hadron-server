import { SignJWT, jwtVerify, type JWTPayload } from 'jose';

export interface HadronJwtPayload extends JWTPayload {
  /// Only verified first-party login callbacks set this; token issuance alone is not re-authentication.
  login?: { at: number; method: 'github' | 'google' | 'apple' | 'email' };
  sub: string;            // User.id (cuid)
  roles: ('OWNER' | 'ADMIN' | 'CONTRIBUTOR' | 'READER')[];
  githubUsername?: string; // GitHub username (GitHub users)
  githubId?: number;       // GitHub numeric ID (GitHub users)
  email?: string;          // email address (email users)
  /// #1897: SignIn.id of a factor-protected sign-in. Present => the row must be live (verifyAuthenticatedJwt).
  sid?: string;
  /// Admin-impersonation claim (read-only support sessions). When present,
  /// `sub` is the TARGET user and `roles` MUST be `[]` (no platform-role
  /// inheritance). The claim only names the session — the ImpersonationSession
  /// row is the source of truth, re-validated on every request by
  /// `resolveJwt` (src/middleware/auth.ts), so an ended/expired session or a
  /// demoted admin kills the token immediately, mid-TTL.
  imp?: {
    sid: string; // ImpersonationSession.id
    act: string; // actor (admin) User.id
    org: string; // the single org scoping the session's reads
  };
}

const JWT_ISSUER = 'hadron-server';
const JWT_AUDIENCE = 'hadron';
const JWT_EXPIRY = process.env.JWT_EXPIRY || '7d';
/// #421: signJwt only emits HS256; jose would accept any HS* on this key
/// unless the verifier pins one.
const JWT_ALGORITHMS = ['HS256'];

function getSecret(): Uint8Array {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET env var is required');
  return new TextEncoder().encode(secret);
}

/**
 * Sign a Hadron JWT. `opts.expiresIn` (jose duration string or epoch seconds)
 * overrides the default `JWT_EXPIRY` — used by impersonation tokens, whose
 * lifetime is the (much shorter) session TTL rather than the login expiry.
 */
export async function signJwt(
  payload: Omit<HadronJwtPayload, 'iss' | 'aud' | 'iat' | 'exp'>,
  opts?: { expiresIn?: string | number },
): Promise<string> {
  return new SignJWT(payload as unknown as Record<string, unknown>)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setIssuer(JWT_ISSUER)
    .setAudience(JWT_AUDIENCE)
    .setExpirationTime(opts?.expiresIn ?? JWT_EXPIRY)
    .sign(getSecret());
}

export async function verifyJwt(token: string): Promise<HadronJwtPayload> {
  const { payload } = await jwtVerify(token, getSecret(), {
    issuer: JWT_ISSUER,
    audience: JWT_AUDIENCE,
    algorithms: JWT_ALGORITHMS,
  });
  return payload as unknown as HadronJwtPayload;
}
