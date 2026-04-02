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

  // First, check the new station_keys table (non-revoked keys for active stations)
  const stationKeys = await db.stationKey.findMany({
    where: { revokedAt: null },
    include: {
      station: {
        select: { id: true, role: true, organizationId: true, deletedAt: true, expiresAt: true },
      },
    },
  });

  for (const sk of stationKeys) {
    if (sk.station.deletedAt) continue;
    if (sk.station.expiresAt && sk.station.expiresAt < new Date()) continue;
    const match = await bcrypt.compare(rawKey, sk.keyHash);
    if (match) {
      // Update lastUsedAt on both the key and the station (fire-and-forget)
      const now = new Date();
      db.stationKey.update({ where: { id: sk.id }, data: { lastUsedAt: now } }).catch(() => {});
      db.station.update({ where: { id: sk.station.id }, data: { lastUsedAt: now } }).catch(() => {});
      return {
        clientId: sk.station.id,
        roles: [sk.station.role],
        organizationId: sk.station.organizationId ?? undefined,
      };
    }
  }

  // Fallback: check legacy Station.keyHash for keys not yet migrated
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
