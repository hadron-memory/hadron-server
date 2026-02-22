import bcrypt from 'bcrypt';
import type { Request } from 'express';
import type { PrismaClient } from '../generated/prisma/index.js';

export interface AuthContext {
  clientId?: string;
  role?: 'ADMIN' | 'CONTRIBUTOR' | 'READER';
  namespace?: string;
}

// Resolve auth context from an incoming request.
// Checks Bearer token first (API key), then falls back to session cookie
// (GitHub OAuth — to be implemented).
export async function resolveAuthContext(req: Request, db: PrismaClient): Promise<AuthContext> {
  const authHeader = req.headers.authorization;

  if (authHeader?.startsWith('Bearer ')) {
    const rawKey = authHeader.slice(7);
    return resolveApiKey(rawKey, db);
  }

  // GitHub OAuth session cookie — placeholder until OAuth flow is implemented
  // TODO: validate session cookie, fetch GitHub org membership, map to role
  return {};
}

async function resolveApiKey(rawKey: string, db: PrismaClient): Promise<AuthContext> {
  // Fetch all keys and compare — in production, prefix the key with the label
  // (e.g., "label:rawSecret") so we can look up by label without full scan.
  const keys = await db.apiKey.findMany({
    where: {
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
    },
  });

  for (const key of keys) {
    const match = await bcrypt.compare(rawKey, key.keyHash);
    if (match) {
      await db.apiKey.update({
        where: { id: key.id },
        data: { lastUsedAt: new Date() },
      });
      return {
        clientId: key.label,
        role: key.role as 'ADMIN' | 'CONTRIBUTOR' | 'READER',
        namespace: key.namespace ?? undefined,
      };
    }
  }

  return {};
}
