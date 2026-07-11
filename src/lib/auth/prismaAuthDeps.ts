/**
 * Prisma-backed `AuthDeps` factory for `resolveMemoryAuthorization`.
 *
 * Wires the predicate's five lookups to the Prisma client. Production
 * call sites should use this; tests stub `AuthDeps` directly.
 *
 * All lookups are PK or unique-index hits via `findUnique` — no
 * `deletedAt` filter (the new join tables have no soft-delete; remove
 * is a hard row delete per spec 023).
 *
 * Per-request lookup caching (spec 023 plan T010) is intentionally NOT
 * embedded here — the cache lives on the request context object so its
 * lifecycle is bounded by one request. Add a `RequestCache` wrapper at
 * the boundary if needed.
 */

import type { PrismaClient } from '../../generated/prisma/index.js';
import type { AuthDeps } from '@hadron-memory/access-control';

export function prismaAuthDeps(db: PrismaClient): AuthDeps {
  return {
    getAgentSubscription: async (userId, agentId) =>
      db.agentSubscription.findUnique({
        where: { userId_agentId: { userId, agentId } },
        select: { activatedAt: true, revokedAt: true, expiresAt: true },
      }),

    getAppMember: async (appId, userId) =>
      db.appMember.findUnique({
        where: { appId_userId: { appId, userId } },
        select: { role: true },
      }),

    getAppAgent: async (appId, agentId) => {
      const row = await db.appAgent.findUnique({
        where: { appId_agentId: { appId, agentId } },
        select: { appId: true },
      });
      return row ? { exists: true } : null;
    },

    getMemoryShare: async (memoryId, granteeId) =>
      db.memoryShare.findUnique({
        where: { memoryId_granteeId: { memoryId, granteeId } },
        select: { role: true },
      }),

    getMemoryMember: async (memoryId, userId) =>
      db.memoryMember.findUnique({
        where: { memoryId_userId: { memoryId, userId } },
        select: { role: true },
      }),

    // `evaluateKnowledgeAccess` is left undefined here. Phase 2b will
    // wire it to the existing visibility logic from
    // `src/mcp/access-control.ts`. Until then, the predicate's
    // conservative default (`allowed: true`) applies — callers that
    // need stricter knowledge-class gating should pass their own hook.
  };
}
