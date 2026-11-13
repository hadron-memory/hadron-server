import type { PrismaClient, Prisma } from '../generated/prisma/index.js';
import { isAgentInstalledAndLicensed } from './appAgent.js';

/** A retained chat pointer is not authority to read an App's Agent definition.
 * Gate the already-resolved Agent before any system-memory reads, independently
 * of the home's class or the caller's Agent-management rights. Standalone homes
 * retain their existing behavior.
 */
export async function chatHomeAgentIfLicensed<T extends { id: string }>(
  db: PrismaClient | Prisma.TransactionClient,
  home: { appId: string | null },
  agent: T | null,
): Promise<T | null> {
  if (agent && home.appId && !await isAgentInstalledAndLicensed(db, home.appId, agent.id)) return null;
  return agent;
}

/**
 * #4076: the ONE Agent lookup for a chat turn (sendChatMessage and processChatResponse).
 * Order is binding: resolve (a soft-deleted Agent is none, cor:dmo:010:04), then licence
 * ({@link chatHomeAgentIfLicensed}), then the caller reads the Agent's definition.
 * A shared/user home pointer names its Agent; otherwise (legacy) the first non-deleted Agent
 * linked by a memory item that has a system memory, in the documented order (createdAt, id).
 * `deletedAgentId` names a pointer's soft-deleted Agent so a caller can keep its own refusal.
 */
export async function resolveChatHomeAgent(
  db: PrismaClient | Prisma.TransactionClient,
  memory: { id: string; appId: string | null; sharedMemoryOfAgentId: string | null; userMemoryOfAgentId: string | null },
): Promise<{ agent: any | null; deletedAgentId: string | null }> {
  const pointer = memory.sharedMemoryOfAgentId ?? memory.userMemoryOfAgentId;
  let agent: any | null = null;
  let deletedAgentId: string | null = null;
  if (pointer) {
    const found = await db.agent.findUnique({ where: { id: pointer } });
    if (found?.deletedAt) deletedAgentId = found.id;
    else agent = found;
  } else {
    const legacy = await db.agent.findMany({
      where: { deletedAt: null, memoryItems: { some: { memoryId: memory.id } } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    agent = legacy.find((a) => (a as any).systemMemoryId) ?? null;
  }
  return { agent: await chatHomeAgentIfLicensed(db, memory, agent), deletedAgentId };
}
