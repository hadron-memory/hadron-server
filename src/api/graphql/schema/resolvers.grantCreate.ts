/**
 * #3690 PR 2 (Grants S2a create): `createGrant`, the one grant writer on GraphQL. A BOUND WORKER SESSION in its own App may
 * call it, for itself or its role agent (src/lib/grants/create.ts holds the rule); and (#3711, S2b) a PERSON who manages the App
 * may, naming it by `appRef`, for any worker of it or an agent installed in it, recorded as that person; the row is born pending. The caller gate is
 * the one grant read gate (`resolveGrantReader`: a worker session driven by a person, not an App key, a run or an impersonated
 * session), re-run inside the transaction under the App, person and (for an agent holder) agent anchors. MCP: the person-manager arm
 * only (`hadron_create_grant`, ruling 0255 item 21); a worker never creates over MCP. Behind PASSKEY_SIGNING_ENABLED with the rest of signing: no grant can be
 * created where it could not be signed (deploymentSchema's removal set).
 */
import { GraphQLError } from 'graphql';
import type { Context } from './resolvers.helpers.js';
import { withAuthorizedTx } from './authorizedTx.js';
import { resolveGrantPerson, resolveGrantReader } from './resolvers.grant.js';
import { manageRefusal, resolveGrantManager } from './resolvers.grantManage.js';
import { GrantManageRefusal } from '../../../lib/grants/manage.js';
import { getGrantForManager } from '../../../lib/grants/read.js';
import { lockAppManagerMemberships, managesApp } from '../../../lib/auth/appManagement.js';
import { createPendingGrant, GrantCreateRefusal } from '../../../lib/grants/create.js';
import { getGrantForWorker } from '../../../lib/grants/read.js';
import { currentActor } from '../../../lib/requestActor.js';
import type { AuthorityAnchor } from '../../../lib/auth/authorityAnchors.js';

interface CreateGrantInput {
  appRef?: string | null;
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
    if (!reader) return createAsManager(ctx, input);
    if (!ctx.userId) throw notWorker();
    // A worker session creates in its OWN App: an appRef naming another is refused as the worker gate refuses everything else.
    if (input.appRef) {
      const named = await ctx.db.app.findFirst({ where: { OR: [{ id: input.appRef }, { urn: input.appRef }], deletedAt: null }, select: { id: true } });
      if (!named || named.id !== reader.appId) throw notWorker();
    }
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

/**
 * #3711: a PERSON who manages the App creates a PENDING grant in it, recorded as that person (no worker, no session). Anything else
 * (not a person, no App named, an App they do not manage, an unknown App) is the one GRANT_NOT_MANAGER answer. The agent holder is
 * anchored under its own authority anchor (agent after the App, as every door orders them); an unknown agent id falls through to the
 * one GRANT_HOLDER_NOT_ALLOWED refusal inside the transaction. The manager predicate is re-judged under the locks.
 */
async function createAsManager(ctx: Context, input: CreateGrantInput) {
  // No App named: this is the worker door's caller (a person with no bound worker session, a retired worker, a bad session) and it keeps
  // its #3690 answer; only a call that names an App is judged as a manager's.
  if (!input.appRef) throw notWorker();
  const manager = await resolveGrantManager(ctx, input.appRef);
  if (!manager) throw notManager();
  const { userId, app } = manager;
  const kind = input.holderKind.toLowerCase() as 'user' | 'agent' | 'worker' | 'app';
  const startsAt = asDate(input.startsAt);
  const expiresAt = asDate(input.expiresAt);
  const anchors: AuthorityAnchor[] = [
    { kind: 'app', id: app.id },
    ...(app.organizationId ? [{ kind: 'org' as const, id: app.organizationId }] : []),
    ...(app.ownerUserId ? [{ kind: 'user' as const, id: app.ownerUserId }] : []),
    ...(kind === 'agent' ? [{ kind: 'agent' as const, id: input.holderRef }] : []),
  ];
  try {
    return await withAuthorizedTx(
      ctx, anchors,
      async (txCtx) => {
        if ((await resolveGrantPerson(txCtx)) !== userId) throw notManager();
        const fresh = await txCtx.db.app.findUnique({ where: { id: app.id }, select: { id: true, organizationId: true, ownerUserId: true, deletedAt: true } });
        if (!fresh || fresh.deletedAt || !(await managesApp(txCtx, fresh))) throw notManager();
      },
      async (tx) => {
        const id = await createPendingGrant(tx, {
          appId: app.id,
          requester: { userId, workerId: null, sessionId: null },
          holder: { kind, id: input.holderRef },
          heldAgentAnchor: kind === 'agent' ? input.holderRef : null,
          action: input.action, values: input.values, startsAt, expiresAt, maxUses: input.maxUses ?? null, reason: input.reason,
        });
        const view = await getGrantForManager(tx, app.id, id, true);
        if (!view) throw notManager();
        return view;
      },
      { afterLock: (tx) => lockAppManagerMemberships(tx, userId, app) },
    );
  } catch (error) {
    if (error instanceof GrantCreateRefusal) throw refusal(error);
    if (error instanceof GraphQLError && error.extensions?.code === 'FORBIDDEN') throw notManager();
    if (error instanceof GrantManageRefusal) throw manageRefusal(error);
    if (error instanceof Error && error.message === 'Forbidden') throw notManager();
    throw error;
  }
}

const notManager = () => manageRefusal(new GrantManageRefusal('GRANT_NOT_MANAGER'));
