/**
 * #4634 F2 — see readAgentRevisionList. Its own module so the list function it calls stays the unit the list tests cover.
 */
import type { Prisma, PrismaClient } from '../generated/prisma/index.js';
import { listAgentRevisions, type AgentRevisionList } from './agentRevisions.js';

/**
 * #5039 item 2 — what the snapshot read found. `absent`: no Agent row, or a soft-deleted one (the caller answers it as the
 * read gate answers an unreadable Agent, #1944). `no-system-memory`: a live Agent without one. One bare null for both is
 * what let the deleted case hide behind the wrong message.
 */
export type AgentRevisionListRead =
  | { kind: 'list'; list: AgentRevisionList }
  | { kind: 'absent' }
  | { kind: 'no-system-memory' };

/**
 * #4634 F2 — the published pin and the revision rows are read in ONE RepeatableRead snapshot. Two statements at two moments let a
 * publish of B plus a delete of A commit between them: the pin read says A, the rows no longer hold A, and the list shows no
 * published revision, a state that never existed. A client opens its own snapshot transaction; a caller already inside a
 * transaction hands its client and its own isolation governs (no resolver passes one). The Agent's system memory never changes, so
 * it is read here with the pin rather than trusted from an earlier read.
 *
 * #5039 item 1 — this re-read is the row actually served, so it is gated like one (the `requireReadableAgent` convention): a
 * soft-deleted Agent is absent here even though its system memory is still set (cor:dmo:050:23 S6).
 */
export async function readAgentRevisionList(db: PrismaClient | Prisma.TransactionClient, agentId: string): Promise<AgentRevisionListRead> {
  const read = async (tx: Prisma.TransactionClient): Promise<AgentRevisionListRead> => {
    const agent = await tx.agent.findUnique({ where: { id: agentId }, select: { systemMemoryId: true, publishedRevisionLoc: true, deletedAt: true } });
    if (!agent || agent.deletedAt) return { kind: 'absent' };
    if (!agent.systemMemoryId) return { kind: 'no-system-memory' };
    return { kind: 'list', list: await listAgentRevisions(tx, agent.systemMemoryId, agent.publishedRevisionLoc ?? null) };
  };
  if ('$transaction' in db) return db.$transaction(read, { isolationLevel: 'RepeatableRead' });
  return read(db);
}
