import bcrypt from 'bcrypt';
import type { Request } from 'express';
import type { PrismaClient } from '../generated/prisma/index.js';
import { verifyJwt } from '../auth/jwt.js';
import { deserializeRoles } from '../integrations/db/provider.js';

export interface AuthContext {
  clientId?: string;   // Client.label (API keys) or "github:<login>" (OAuth)
  userId?: string;     // User.id — only set for OAuth/JWT users
  roles?: ('ADMIN' | 'CONTRIBUTOR' | 'READER')[];
  namespace?: string;
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
    return {
      clientId: `github:${payload.login}`,
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
        clientId: client.label,
        roles: deserializeRoles(client.roles as string | string[]) as ('ADMIN' | 'CONTRIBUTOR' | 'READER')[],
        namespace: client.namespace ?? undefined,
      };
    }
  }

  return {};
}
