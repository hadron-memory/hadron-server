import { createHash } from 'crypto';
import type { Request } from 'express';
import type { PrismaClient } from '../generated/prisma/index.js';
import { verifyJwt } from '../auth/jwt.js';

export interface AuthContext {
  clientId?: string;       // "github:<username>" / "email:<addr>" — only set for OAuth/JWT users
  userId?: string;         // User.id — only set for OAuth/JWT users
  appId?: string;          // App.id — set when caller authenticated via an App Key
  sessionId?: string;      // Session.id — set when operating inside an active session
  roles?: ('OWNER' | 'ADMIN' | 'CONTRIBUTOR' | 'READER')[];
  organizationId?: string; // set when the Client is scoped to an organization
}

// App Keys use a distinct prefix so the middleware can route them without
// ambiguity. The raw key is `hdr_app_<64 hex chars>`.
export const APP_KEY_PREFIX = 'hdr_app_';

export function hashAppKey(rawKey: string): string {
  return createHash('sha256').update(rawKey).digest('hex');
}

// Resolve auth context from an incoming request.
// JWTs (contain dots) → OAuth user; App Keys (hdr_app_ prefix) → App.
export async function resolveAuthContext(
  req: Request,
  db: PrismaClient,
): Promise<AuthContext> {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) return {};

  const token = authHeader.slice(7);

  if (token.startsWith(APP_KEY_PREFIX)) {
    const sessionIdHeader = req.headers['x-hadron-session'];
    const sessionId = Array.isArray(sessionIdHeader) ? sessionIdHeader[0] : sessionIdHeader;
    return resolveAppKey(token, db, sessionId);
  }

  // JWTs have the form header.payload.signature — three base64url segments.
  const isJwt = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token);
  if (isJwt) {
    return resolveJwt(token);
  }
  return {};
}

async function resolveAppKey(
  rawKey: string,
  db: PrismaClient,
  sessionId?: string,
): Promise<AuthContext> {
  // App keys are hashed via SHA-256 (not bcrypt) because we look them up by
  // hash — bcrypt's per-hash salt makes that impossible at any useful scale.
  // SHA-256 is fine here because the raw key is a 256-bit random value, so
  // dictionary/rainbow attacks against the hash are not a concern.
  const keyHash = hashAppKey(rawKey);
  const appKey = await db.appKey.findUnique({
    where: { keyHash },
    include: { app: true },
  });
  if (!appKey || appKey.revokedAt || appKey.app.deletedAt) return {};

  // Fire-and-forget lastUsedAt update
  db.appKey
    .update({ where: { id: appKey.id }, data: { lastUsedAt: new Date() } })
    .catch(() => {});

  const ctx: AuthContext = {
    appId: appKey.app.id,
    organizationId: appKey.app.organizationId,
    // App Keys carry no explicit roles; org-level checks are enforced per-call
    // by the resolvers against the app's organization.
    roles: [],
  };

  if (sessionId) {
    // Validate the session belongs to this app and is still active.
    const session = await db.session.findUnique({
      where: { id: sessionId },
      select: { id: true, appId: true, expiresAt: true, endedAt: true },
    });
    if (
      session &&
      session.appId === appKey.app.id &&
      !session.endedAt &&
      (!session.expiresAt || session.expiresAt > new Date())
    ) {
      ctx.sessionId = session.id;
    }
  }

  return ctx;
}

async function resolveJwt(token: string): Promise<AuthContext> {
  try {
    const payload = await verifyJwt(token);
    const clientId = payload.githubUsername
      ? `github:${payload.githubUsername}`
      : `email:${payload.email}`;
    return {
      clientId,
      userId: payload.sub,
      roles: payload.roles,
    };
  } catch {
    return {}; // invalid or expired JWT
  }
}
