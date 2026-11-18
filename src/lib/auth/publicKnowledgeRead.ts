/**
 * #3306 / ruling 0104 (cor:acl:010:01, cor:dmo:050:09): the ONE definition of the PUBLIC knowledge a principal with no
 * user reads read-only, with no item. Shared by the MCP point gate, the runner's read tool and the GraphQL read gate,
 * so the surfaces cannot drift apart.
 *
 * What it admits: a live knowledge memory, visibility PUBLIC, with no App (`app_id` null: an App-scoped memory is
 * App-internal, cor:acl:010:01), no per-user holding and no owner (spec 047: a user-owned memory is owner-only
 * whatever its visibility). Reach is the memory's own rule, so it holds in any org. It never writes (ruling 0083).
 *
 * Who: a credential with an App and no user, including a session-bound App key (ruling 0114 B). Only this
 * PUBLIC read is outside session confinement; all other reads and every write keep their gates. Every user principal, including an
 * impersonation, is unchanged: their PUBLIC reach is already `getOrgReadableMemoryIds`.
 */
import type { PrismaClient } from '../../generated/prisma/index.js';

/** The shape of principal the arm applies to. Structural so GraphQL contexts and MCP auth contexts both fit. */
export interface PublicKnowledgeReader {
  appId?: string | null;
  userId?: string | null;
  sessionId?: string | null;
  impersonation?: unknown;
}

/** A principal with an App and no user; a session binding does not remove its PUBLIC read (0114 B). */
export function readsPublicKnowledgeWithoutUser(auth: PublicKnowledgeReader): boolean {
  return Boolean(auth.appId) && !auth.userId && !auth.impersonation;
}

/** The memory-row predicate: shared so no caller restates it. */
export const PUBLIC_KNOWLEDGE_WHERE = {
  deletedAt: null,
  class: 'knowledge',
  visibility: 'PUBLIC',
  appId: null,
  userMemoryOfAgentId: null,
  ownerUserId: null,
  isInstallMemory: false,
} as const;

/** Of `ids`, the memories that are such PUBLIC knowledge (one indexed lookup). */
export async function publicKnowledgeAmong(db: PrismaClient, ids: readonly string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await db.memory.findMany({
    where: { ...PUBLIC_KNOWLEDGE_WHERE, id: { in: [...ids] } } as never,
    select: { id: true },
  });
  return new Set(rows.map((r: { id: string }) => r.id));
}
