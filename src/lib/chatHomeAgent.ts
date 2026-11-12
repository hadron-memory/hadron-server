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
