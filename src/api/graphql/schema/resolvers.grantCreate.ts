/**
 * #3690 PR 2 (Grants S2a create): `createGrant`, the one grant writer on GraphQL. Only a BOUND WORKER SESSION in its own App may
 * call it, for itself or its role agent (src/lib/grants/create.ts holds the rule); the row is born pending. The caller gate is
 * the one grant read gate (`resolveGrantReader`: a worker session driven by a person, not an App key, a run or an impersonated
 * session), re-run inside the transaction under the App, person and (for an agent holder) agent anchors. No MCP tool: Holger's
 * rule (2026-10-31), "Agents: yes, Workers: no". Behind PASSKEY_SIGNING_ENABLED with the rest of signing: no grant can be
 * created where it could not be signed (deploymentSchema's removal set).
 */
import { GraphQLError } from 'graphql';
import type { Context } from './resolvers.helpers.js';
import { withAuthorizedTx } from './authorizedTx.js';
import { resolveGrantReader } from './resolvers.grant.js';
import { createPendingGrant, GrantCreateRefusal } from '../../../lib/grants/create.js';
import { getGrantForWorker } from '../../../lib/grants/read.js';
import { currentActor } from '../../../lib/requestActor.js';
import type { AuthorityAnchor } from '../../../lib/auth/authorityAnchors.js';

interface CreateGrantInput {
  action: string;
  values: unknown;
  holderKind: 'USER' | 'AGENT' | 'WORKER' | 'APP';
  holderRef: string;
  startsAt?: Date | string | null;
  expiresAt?: Date | string | null;
  maxUses?: number | null;
  reason: string;
}

function refusal(error: GrantCreateRefusal): GraphQLError {
  return new GraphQLError(error.message, { extensions: { code: error.code } });
}

const notWorker = () => refusal(new GrantCreateRefusal('GRANT_REQUESTER_NOT_WORKER'));

function asDate(value: Date | string | null | undefined): Date | null {
  if (value === null || value === undefined) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) throw refusal(new GrantCreateRefusal('GRANT_TERMS_INVALID', 'time'));
  return d;
}

export const grantCreateMutations = {
  createGrant: async (_: unknown, { input }: { input: CreateGrantInput }, ctx: Context) => {
    const reader = await resolveGrantReader(ctx);
    if (!reader || !ctx.userId) throw notWorker();
    const userId = ctx.userId;
    const kind = input.holderKind.toLowerCase() as 'user' | 'agent' | 'worker' | 'app';
    const startsAt = asDate(input.startsAt);
    const expiresAt = asDate(input.expiresAt);
    // An agent holder takes the agent's own anchor, before the worker row (agent before worker, as every departure door does).
    // Only the caller's OWN role agent is anchored: any other id falls through to the one GRANT_HOLDER_NOT_ALLOWED answer, so the
    // refusal cannot tell an agent that exists from one that does not.
    const self = await ctx.db.worker.findUnique({ where: { id: reader.workerId }, select: { agentId: true } });
    const anchors: AuthorityAnchor[] = [{ kind: 'app', id: reader.appId }, ...(kind === 'agent' && self?.agentId === input.holderRef ? [{ kind: 'agent' as const, id: input.holderRef }] : [])];
    try {
      return await withAuthorizedTx(
        ctx, anchors,
        async (txCtx) => {
          const again = await resolveGrantReader(txCtx);
          if (!again || again.appId !== reader.appId || again.workerId !== reader.workerId) throw notWorker();
        },
        async (tx) => {
          const id = await createPendingGrant(tx, {
            appId: reader.appId,
            requester: { userId, workerId: reader.workerId, sessionId: ctx.sessionId ?? null },
            holder: { kind, id: input.holderRef },
            heldAgentAnchor: anchors.find((a) => a.kind === 'agent')?.id ?? null,
            action: input.action, values: input.values, startsAt, expiresAt, maxUses: input.maxUses ?? null, reason: input.reason,
          });
          const view = await getGrantForWorker(tx, reader, id);
          if (!view) throw notWorker();
          return view;
        },
      );
    } catch (error) {
      if (error instanceof GrantCreateRefusal) throw refusal(error);
      if (error instanceof GraphQLError && error.extensions?.code === 'FORBIDDEN') throw notWorker();
      if (error instanceof Error && error.message === 'Forbidden') throw notWorker();
      throw error;
    }
  },
};
