/**
 * "The server answering" (cor:urn:010:01, R3: the reserved root `server` names
 * something that belongs to THIS server). A database may hold more than one
 * `hadron_server` row (cor:dmo:080:01: a row records a running instance), so the
 * answer is a rule, not a lookup by chance: the OLDEST LIVE row. Server-owned
 * templates (`resolvers.memoryConfigTemplate.ts`) and the aiconf URN (#3857)
 * share it, so a server-owned thing has one identity in every address.
 */
import type { PrismaClient } from '../generated/prisma/index.js';

/** The current server's id, or null when no live `hadron_server` row exists. */
export async function currentHadronServerId(db: Pick<PrismaClient, 'hadronServer'>): Promise<string | null> {
  const row = await db.hadronServer.findFirst({
    where: { deletedAt: null },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { id: true },
  });
  return row?.id ?? null;
}
