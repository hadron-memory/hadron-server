import bcrypt from 'bcrypt';
import type { Request } from 'express';
import type { PrismaClient } from '../generated/prisma/index.js';
import { verifyJwt } from '../auth/jwt.js';

export interface AuthContext {
  clientId?: string;       // Station.id (API keys) or "github:<username>" (OAuth)
  userId?: string;         // User.id — only set for OAuth/JWT users
  roles?: ('OWNER' | 'ADMIN' | 'CONTRIBUTOR' | 'READER')[];
  organizationId?: string; // set when the Client is scoped to an organization
}

// Resolve auth context from an incoming request.
// JWTs (contain dots) → OAuth user; hex API keys (no dots) → machine Client.
export async function resolveAuthContext(
  req: Request,
  db: PrismaClient,
): Promise<AuthContext> {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) return {};

  const token = authHeader.slice(7);

  // JWTs have the form header.payload.signature (exactly two dots separating
  // three base64url segments).  Station keys may contain dots in their URN
  // prefix (e.g. "baragaun.com:ws/date/hex"), so a simple includes('.') check
  // is not sufficient.
  const isJwt = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token);
  if (isJwt) {
    return resolveJwt(token);
  }
  return resolveStationKey(token, db);
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

async function resolveStationKey(
  rawKeyOrPrefixed: string,
  db: PrismaClient,
): Promise<AuthContext> {
  // Accept both prefixed format (urn/date/key) and raw key
  // Prefixed: "micromentor.org:engineering/202603281412/3ee91ad69c..."
  // Raw: "3ee91ad69c..."
  const parts = rawKeyOrPrefixed.split('/');
  const rawKey = parts.length >= 3 ? parts[parts.length - 1] : rawKeyOrPrefixed;

  const stations = await db.station.findMany({
    where: {
      deletedAt: null,
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
    },
  });

  for (const station of stations) {
    const match = await bcrypt.compare(rawKey, station.keyHash);
    if (match) {
      await db.station.update({
        where: { id: station.id },
        data: { lastUsedAt: new Date() },
      });
      return {
        clientId: station.id,
        roles: [station.role],
        organizationId: station.organizationId ?? undefined,
      };
    }
  }

  return {};
}
