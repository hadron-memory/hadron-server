import { GraphQLError } from 'graphql';
import type { Prisma } from '../../generated/prisma/index.js';
import { requireOrgRole, type Context } from '../../api/graphql/schema/resolvers.helpers.js';
import { ensureAgentOrgGrant } from './ensureAgentOrgGrant.js';

/**
 * The subscribe rule of `createAgentOrgGrant`, re-run on the transaction's own context: the org's
 * ADMIN subscribing to a PUBLIC Agent owned by ANOTHER organisation. Throws `AGENT_NOT_PUBLIC`
 * otherwise. Must run on `txCtx` after the authority anchors are held (see `withAuthorizedTx`).
 */
export async function assertMaySubscribeOrgToPublicAgent(txCtx: Context, orgId: string, agentId: string): Promise<void> {
  await requireOrgRole(txCtx, orgId, 'ADMIN');
  const current = await txCtx.db.agent.findUniqueOrThrow({ where: { id: agentId } });
  if (current.organizationId === orgId || current.visibility !== 'PUBLIC') {
    throw new GraphQLError('Only PUBLIC agents from another organization can be subscribed to.', {
      extensions: { code: 'AGENT_NOT_PUBLIC', agentId },
    });
  }
}

/**
 * `createAgentOrgGrant`'s whole transactional body (#2245): the rule, then the idempotent grant.
 * Takes no locks of its own; the caller's `withAuthorizedTx` holds the org and Agent anchors and the
 * Agent row `FOR SHARE`. The caller re-reads the grant and requires it active.
 */
export async function subscribeOrgToPublicAgentInTx(
  txCtx: Context,
  tx: Prisma.TransactionClient,
  orgId: string,
  agentId: string,
  createdBy: string | null,
): Promise<void> {
  await assertMaySubscribeOrgToPublicAgent(txCtx, orgId, agentId);
  await ensureAgentOrgGrant(tx, orgId, agentId, { createdBy });
}
