import type { Prisma } from '../generated/prisma/index.js';
import { GraphQLError } from 'graphql';

/**
 * The shared retirement predicate (D-2026-05-15-001; cor:dmo:050:14).
 * Caller holds the Agent row FOR UPDATE; reference writers hold it FOR SHARE
 * and recheck liveness before inserting. AgentMemoryItem is not a dependency.
 * Retained installs/imports whose App/parent is no longer live do not block.
 */
export async function hasLiveAgentReferences(tx: Prisma.TransactionClient, agentId: string): Promise<boolean> {
  const [install, imported] = await Promise.all([
    tx.appAgent.findFirst({
      where: { agentId, app: { deletedAt: null, uninstalledAt: null } },
      select: { agentId: true },
    }),
    tx.agentImport.findFirst({
      where: { importedAgentId: agentId, parentAgent: { deletedAt: null } },
      select: { importedAgentId: true },
    }),
  ]);
  return install !== null || imported !== null;
}

/** Refuse retirement after authorization, without disclosing foreign reference identities. */
export async function assertNoLiveAgentReferences(tx: Prisma.TransactionClient, agentId: string): Promise<void> {
  if (await hasLiveAgentReferences(tx, agentId)) {
    throw new GraphQLError('The Agent is still in use; remove its live references before deleting it.', {
      extensions: { code: 'AGENT_IN_USE' },
    });
  }
}
