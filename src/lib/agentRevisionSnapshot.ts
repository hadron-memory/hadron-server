/**
 * #4634 F2 — see readAgentRevisionList. Its own module so the list function it calls stays the unit the list tests cover.
 */
import type { Prisma, PrismaClient } from '../generated/prisma/index.js';
import { listAgentRevisions, type AgentRevisionList } from './agentRevisions.js';

/**
 * #4634 F2 — the published pin and the revision rows are read in ONE RepeatableRead snapshot. Two statements at two moments let a
 * publish of B plus a delete of A commit between them: the pin read says A, the rows no longer hold A, and the list shows no
 * published revision, a state that never existed. A client opens its own snapshot transaction; a caller already inside a
 * transaction hands its client and its own isolation governs (no resolver passes one). The Agent's system memory never changes, so
 * it is read here with the pin rather than trusted from an earlier read.
 */
export async function readAgentRevisionList(db: PrismaClient | Prisma.TransactionClient, agentId: string): Promise<AgentRevisionList | null> {
  const read = async (tx: Prisma.TransactionClient): Promise<AgentRevisionList | null> => {
    const agent = await tx.agent.findUnique({ where: { id: agentId }, select: { systemMemoryId: true, publishedRevisionLoc: true } });
    if (!agent?.systemMemoryId) return null;
    return listAgentRevisions(tx, agent.systemMemoryId, agent.publishedRevisionLoc ?? null);
  };
  if ('$transaction' in db) return db.$transaction(read, { isolationLevel: 'RepeatableRead' });
  return read(db);
}
