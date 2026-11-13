import type { PrismaClient, Prisma } from '../generated/prisma/index.js';
import type { Context } from '../api/graphql/schema/resolvers.helpers.js';
import { canChatWithAgent } from '../api/graphql/schema/agentChatAccess.js';
import { isAgentInstalledAndLicensed } from './appAgent.js';

/** A retained chat pointer is not authority to read an Agent's definition. Gate the already-resolved Agent before any
 * system-memory reads, independently of the home's class.
 *
 * - App-bearing home (#4043): the home's App must still install and license the Agent. No manager exemption.
 * - App-less home (#4070): the CURRENT request principal must still reach the Agent through the shared
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
  caller: Context,
): Promise<T | null> {
  if (!agent) return agent;
  if (home.appId) return await isAgentInstalledAndLicensed(db, home.appId, agent.id) ? agent : null;
  const current = await caller.db.agent.findUnique({
    where: { id: agent.id },
    select: { id: true, organizationId: true, ownerUserId: true, visibility: true, deletedAt: true },
  });
  return current && await canChatWithAgent(caller, current) ? agent : null;
}
