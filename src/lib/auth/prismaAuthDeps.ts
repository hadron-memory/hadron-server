/**
 * Prisma-backed `AuthDeps` factory for `resolveMemoryAuthorization`.
 *
 * Wires the predicate's five lookups to the Prisma client. Production
 * call sites should use this; tests stub `AuthDeps` directly.
 *
 * Per-request lookup caching (spec 023 plan T010) is intentionally NOT
 * embedded here — the cache lives on the request context object so its
 * lifecycle is bounded by one request. Add a `RequestCache` wrapper at
 * the boundary if needed.
 */

import type { PrismaClient } from '@prisma/client';
import type { AuthDeps } from './resolveMemoryAuthorization.js';

export function prismaAuthDeps(db: PrismaClient): AuthDeps {
  return {
    getAgentSubscription: async (userId, agentId) =>
      db.agentSubscription.findUnique({
        where: { userId_agentId: { userId, agentId } },
        select: { activatedAt: true, revokedAt: true, expiresAt: true },
      }),

    getAppMember: async (appId, userId) =>
      db.appMember.findFirst({
        where: { appId, userId },
        select: { role: true },
      }),

    getAppAgent: async (appId, agentId) => {
      const row = await db.appAgent.findFirst({
        where: { appId, agentId, deletedAt: null },
        select: { appId: true },
      });
      return row ? { exists: true } : null;
    },

    getMemoryShare: async (memoryId, granteeId) => {
      const row = await db.memoryShare.findFirst({
        where: { memoryId, granteeId, deletedAt: null },
        select: { role: true },
      });
      return row;
    },

    getMemoryMember: async (memoryId, userId) => {
      const row = await db.memoryMember.findFirst({
        where: { memoryId, userId, deletedAt: null },
        select: { role: true },
      });
      return row;
    },

    // `evaluateKnowledgeAccess` is left undefined here. Phase 2b will
    // wire it to the existing visibility logic from
    // `src/mcp/access-control.ts`. Until then, the predicate's
    // conservative default (`allowed: true`) applies — callers that
    // need stricter knowledge-class gating should pass their own hook.
  };
}
