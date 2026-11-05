/**
 * #1329 — one answer to "may this run read this node", used by the run's read
 * tool and by an attestation refusal, so a refusal can never disagree with what
 * the run can load: not narrower (#2883's prefix grant, #3306's PUBLIC knowledge)
 * and not wider (the shared memory gate admits memories a run's own read refuses).
 * It asks about one node and grants nothing.
 */
import type { Context } from '../../api/graphql/schema/resolvers.js';
import type { AppRun, Prisma, PrismaClient } from '../../generated/prisma/index.js';
import { canReadMemory } from '../../mcp/access-control.js';
import type { AuthContext } from '../../middleware/auth.js';
import { publicKnowledgeAmong, readsPublicKnowledgeWithoutUser } from '../auth/publicKnowledgeRead.js';
import { attestedAuthoring, type AuthoredWith, type AuthoringContext } from '../authoringAttestation.js';
import { runHoldsReadGrant } from '../automationReadGrant.js';

type RunRef = Pick<AppRun, 'id' | 'organizationId'>;

/** Runs are unavailable on encrypted memories. In the run's org: the shared gate, then its grant. Elsewhere: PUBLIC knowledge for a run with no user, or its grant. */
export async function runReadsNode(
  db: PrismaClient | Prisma.TransactionClient,
  principal: Context,
  run: RunRef,
  memoryId: string,
  loc: string,
): Promise<boolean> {
  const client = db as PrismaClient;
  const memory = await client.memory.findFirst({ where: { id: memoryId, deletedAt: null }, select: { isEncrypted: true, organizationId: true } });
  if (!memory || memory.isEncrypted) return false;
  const auth: AuthContext = {
    clientId: principal.clientId, userId: principal.userId, appId: principal.appId, organizationId: principal.organizationId,
  };
  if (memory.organizationId === run.organizationId) {
    if (await canReadMemory(client, auth, memoryId)) return true;
  } else if (readsPublicKnowledgeWithoutUser(auth) && (await publicKnowledgeAmong(client, [memoryId])).has(memoryId)) {
    return true;
  }
  // #2883: the automation's read grant, consulted here only, after the gate above refused.
  return runHoldsReadGrant(client, auth, run.id, memoryId, loc);
}

/** The authoring context of a write a run makes. */
export function runAuthoring(principal: Context, run: RunRef, claim?: AuthoredWith | null): AuthoringContext {
  return attestedAuthoring(principal, claim, 'run', (tx, memoryId, loc) => runReadsNode(tx, principal, run, memoryId, loc));
}
