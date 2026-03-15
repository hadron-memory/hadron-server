import bcrypt from 'bcrypt';
import type { Request } from 'express';
import type { PrismaClient } from '../generated/prisma/index.js';
import { verifyJwt } from '../auth/jwt.js';

export interface AuthContext {
  clientId?: string;       // Client.id (API keys) or "github:<username>" (OAuth)
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
  return resolveClientKey(token, db);
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

async function resolveClientKey(
  rawKey: string,
  db: PrismaClient,
): Promise<AuthContext> {
  const clients = await db.client.findMany({
    where: {
      deletedAt: null,
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
    },
  });

  for (const client of clients) {
    const match = await bcrypt.compare(rawKey, client.keyHash);
    if (match) {
      await db.client.update({
        where: { id: client.id },
        data: { lastUsedAt: new Date() },
      });
      return {
        clientId: client.id,
        roles: [client.role],
        namespace: client.namespace ?? undefined,
        organizationId: client.organizationId ?? undefined,
      };
    }
  }

  return {};
}
