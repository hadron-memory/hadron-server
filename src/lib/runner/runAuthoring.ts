/**
 * #1329 — what a run can read beyond its principal's memory gate, and the
 * authoring context of a run's writes.
 *
 * `hadron_read_node` admits an unencrypted PUBLIC knowledge memory for a run
 * with no user, and a live automation read grant covering the node (#2883,
 * #3306). An attestation refusal has to agree with that read: a task the run can
 * load is readable, or a run is told to fix access it already has. This asks
 * about one node and grants nothing.
 */
import type { Context } from '../../api/graphql/schema/resolvers.js';
import type { Prisma, PrismaClient } from '../../generated/prisma/index.js';
import { publicKnowledgeAmong, readsPublicKnowledgeWithoutUser } from '../auth/publicKnowledgeRead.js';
import { attestedAuthoring, type AuthoredWith, type AuthoringContext } from '../authoringAttestation.js';
import { runHoldsReadGrant } from '../automationReadGrant.js';

/** The run-only read arms, for an unencrypted memory, after the shared gate refused. */
export async function runReadAdmits(
  db: PrismaClient | Prisma.TransactionClient,
  principal: Pick<Context, 'userId' | 'appId' | 'impersonation'>,
  runId: string,
  memoryId: string,
  loc: string,
): Promise<boolean> {
  const client = db as PrismaClient;
  const memory = await client.memory.findFirst({ where: { id: memoryId, deletedAt: null }, select: { isEncrypted: true } });
  if (!memory || memory.isEncrypted) return false;
  if (readsPublicKnowledgeWithoutUser(principal) && (await publicKnowledgeAmong(client, [memoryId])).has(memoryId)) return true;
  return runHoldsReadGrant(client, principal, runId, memoryId, loc);
}

/** The authoring context of a write a run makes. */
export function runAuthoring(principal: Context, runId: string, claim?: AuthoredWith | null): AuthoringContext {
  return attestedAuthoring(principal, claim, 'run', (tx, memoryId, loc) => runReadAdmits(tx, principal, runId, memoryId, loc));
}
