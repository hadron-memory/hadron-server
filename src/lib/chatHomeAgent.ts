import type { PrismaClient, Prisma } from '../generated/prisma/index.js';
import type { Context } from '../api/graphql/schema/resolvers.helpers.js';
import { canChatWithAgent } from '../api/graphql/schema/agentChatAccess.js';
import { isAgentInstalledAndLicensed } from './appAgent.js';

/** A retained chat pointer is not authority to read an Agent's definition. Gate the already-resolved Agent before any
 * system-memory reads, independently of the home's class.
 *
 * - App-bearing home (#4043): the home's App must still install and license the Agent. No manager exemption.
 * - App-less home (#4070), when the caller is passed (the response): the CURRENT request principal must still reach the Agent through the shared
 *   `canChatWithAgent`, the predicate `sendChatMessage` applies, so send and respond never disagree (cor:acl:010:01,
 *   the `system` row). The chat's creator, the stored home pointer and a historical App are not substitutes.
 *
 * Returning null means "no Agent definition for this turn": the caller records the turn and routes nothing, with no
 * error and no new oracle (cor:cht:020:01).
 */
export async function chatHomeAgentIfLicensed<T extends { id: string; organizationId?: string | null; ownerUserId?: string | null; visibility?: string; deletedAt?: Date | null }>(
  db: PrismaClient | Prisma.TransactionClient,
  home: { appId: string | null },
  agent: T | null,
  caller?: Context,
): Promise<T | null> {
  if (!agent) return agent;
  if (home.appId) return await isAgentInstalledAndLicensed(db, home.appId, agent.id) ? agent : null;
  // `sendChatMessage` omits the caller: its serve gate already runs canChatWithAgent before any write and refuses
  // with AGENT_NOT_FOUND, which must stay a refusal (#4070 CHECKED: send's refusal is unchanged).
  if (!caller) return agent;
  const current = await caller.db.agent.findUnique({
    where: { id: agent.id },
    select: { id: true, organizationId: true, ownerUserId: true, visibility: true, deletedAt: true },
  });
  return current && await canChatWithAgent(caller, current) ? agent : null;
}

/**
 * #4076: the ONE Agent lookup for a chat turn (sendChatMessage and processChatResponse).
 * Order is binding: resolve (a soft-deleted Agent is none, cor:dmo:010:04), then licence
 * ({@link chatHomeAgentIfLicensed}), then the caller reads the Agent's definition.
 * A shared/user home pointer names its Agent; otherwise (legacy) the first non-deleted Agent
 * linked by a LIVE (not soft-deleted) memory item that has a system memory, in the documented order (createdAt, id).
 * `deletedAgentId` names a pointer's soft-deleted Agent so a caller can keep its own refusal.
 */
export async function resolveChatHomeAgent(
  db: PrismaClient | Prisma.TransactionClient,
  memory: { id: string; appId: string | null; sharedMemoryOfAgentId: string | null; userMemoryOfAgentId: string | null },
  caller?: Context,
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
      where: { deletedAt: null, memoryItems: { some: { memoryId: memory.id, deletedAt: null } } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    agent = legacy.find((a) => (a as any).systemMemoryId) ?? null;
  }
  return { agent: await chatHomeAgentIfLicensed(db, memory, agent, caller), deletedAgentId };
}
