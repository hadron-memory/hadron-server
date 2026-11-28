/**
 * #1329 — one answer to "may this run read this node", used by the run's read
 * tool and by an attestation refusal, so a refusal can never disagree with what
 * the run can load: not narrower (a `memory.read` grant, #3306's PUBLIC knowledge)
 * and not wider (the shared memory gate admits memories a run's own read refuses).
 * It asks about one node and grants nothing.
 */
import type { Context } from '../../api/graphql/schema/resolvers.js';
import type { AppRun, Prisma, PrismaClient } from '../../generated/prisma/index.js';
import { canReadMemory } from '../../mcp/access-control.js';
import type { AuthContext } from '../../middleware/auth.js';
import { publicKnowledgeAmong, readsPublicKnowledgeWithoutUser } from '../auth/publicKnowledgeRead.js';
import { attestedAuthoring, type AuthoredWith, type AuthoringContext } from '../authoringAttestation.js';
import { grantReadReachFor } from '../grants/readGrant.js';
import { isOwnedBy, requireOwnerRefOf } from '../owner.js';

type RunRef = Pick<AppRun, 'id' | 'organizationId' | 'ownerUserId'>;

/**
 * Runs are unavailable on encrypted memories. In the run's org: the shared gate, then its App's read grant. Elsewhere: PUBLIC knowledge
 * for a run with no user, or its App's read grant. The grant is a signed `memory.read` grant (#5404, cor:acl:140:02, the one judge
 * `grantReadReachFor`), which reaches a userless run only; the per-automation read grant of #2883 is gone, so a run carrying a user id
 * reads only what the shared gate gives it.
 */
export async function runReadsNode(
  db: PrismaClient | Prisma.TransactionClient,
  principal: Context,
  run: RunRef,
  memoryId: string,
  loc: string,
): Promise<boolean> {
  const client = db as PrismaClient;
  const memory = await client.memory.findFirst({ where: { id: memoryId, deletedAt: null }, select: { isEncrypted: true, organizationId: true, ownerUserId: true } });
  if (!memory || memory.isEncrypted) return false;
  const auth: AuthContext = {
    clientId: principal.clientId, userId: principal.userId, appId: principal.appId, organizationId: principal.organizationId,
  };
  // #5077: the run's own tenant by `isOwnedBy`; `===` would take this branch for another person's memory (two nulls).
  if (isOwnedBy(memory, requireOwnerRefOf(run))) {
    if (await canReadMemory(client, auth, memoryId)) return true;
  } else if (readsPublicKnowledgeWithoutUser(auth) && (await publicKnowledgeAmong(client, [memoryId])).has(memoryId)) {
    return true;
  }
  // #5404: the App's `memory.read` grant, after the gates above refused (a whole memory: the grant has no branch until #5412).
  return (await grantReadReachFor(client, auth, [memoryId])).has(memoryId);
}

/** The authoring context of a write a run makes. */
export function runAuthoring(principal: Context, run: RunRef, claim?: AuthoredWith | null): AuthoringContext {
  return attestedAuthoring(principal, claim, 'run', (tx, memoryId, loc) => runReadsNode(tx, principal, run, memoryId, loc));
}
