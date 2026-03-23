import bcrypt from 'bcrypt';
import type { Request } from 'express';
import type { PrismaClient } from '../generated/prisma/index.js';
import { verifyJwt } from '../auth/jwt.js';

export interface AuthContext {
  clientId?: string;       // Station.id (API keys) or "github:<username>" (OAuth)
  userId?: string;         // User.id — only set for OAuth/JWT users
  roles?: ('OWNER' | 'ADMIN' | 'CONTRIBUTOR' | 'READER')[];
  namespace?: string;
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

  // JWTs have the form header.payload.signature (two dots); hex API keys do not
  if (token.includes('.')) {
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
  rawKey: string,
  db: PrismaClient,
): Promise<AuthContext> {
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
        namespace: station.namespace ?? undefined,
        organizationId: station.organizationId ?? undefined,
      };
    }
  }

  return {};
}
