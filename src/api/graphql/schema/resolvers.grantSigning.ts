/**
 * #3649 slice B (cor:acl:140:07; the node-signing mirror cor:dmo:130:03): grant signing requests on GraphQL. One grant per
 * request (gate selection 1). No signer is named (ruling 0255, item 12). No call here takes an assertion or makes a signature
 * (the cor:dmo:130:02 mirror): that is slice C's ceremony page, the only path that will.
 *
 * Who may do what. Exactly two readers reach a grant here, ONE arm per session, the worker arm first and exclusive:
 * - a BOUND WORKER SESSION in its own App (`resolveGrantReader` + the shared row scope in src/lib/grants/read.ts, #3789): it
 *   asks for a signature on a grant it holds or a pending one it requested;
 * - #4012: a PERSON acting as themselves who manages the grant's own live, installed App (`resolveGrantPerson` +
 *   `managesApp`, the reach `appGrants` gives, #3711), judged under the transaction's membership locks. A session bound to a
 *   worker never falls to this arm: a retired or refused worker binding reads nothing, not even as the person driving it.
 * Then: request: either reader; withdraw: the requester ACCOUNT alone (the user, from any of its sessions or workers),
 * among those who may read the grant, so a manager who did not ask is refused SIGNING_REQUEST_NOT_REQUESTER; read: either
 * reader, by id; unknown and unreadable look the same (null). An uninstalled App is reached by neither arm.
 * A support (impersonation) session never asks for or ends a signature (FORBIDDEN). Every miss is GRANT_NOT_FOUND /
 * SIGNING_REQUEST_NOT_FOUND, the same answer whatever the reason, so the calls disclose no grant.
 * Behind PASSKEY_SIGNING_ENABLED with the rest of signing (deploymentSchema's removal set).
 */
import { GraphQLError } from 'graphql';
import type { Context } from './resolvers.helpers.js';
import { withAuthorizedTx } from './authorizedTx.js';
import { resolveGrantPerson, resolveGrantReader } from './resolvers.grant.js';
import { loadApp } from './resolvers.agentTask.js';
import { lockAppManagerMemberships, managesApp } from '../../../lib/auth/appManagement.js';
import type { Prisma } from '../../../generated/prisma/index.js';
import { getGrantForWorker } from '../../../lib/grants/read.js';
import { currentActor } from '../../../lib/requestActor.js';
import {
  createGrantSigningRequestInTransaction, GrantSigningRefusal, withdrawGrantSigningRequestInTransaction,
} from '../../../lib/signing/grantRequests.js';
import { effectiveRequestState, type SigningRequester } from '../../../lib/signing/requests.js';
import { grantSigningCeremonyUrl } from '../../../lib/signing/ceremonyUrl.js';

type GrantSigningRequestRow = {
  id: string; grantId: string; version: number; termsHash: string; payloadVersion: string; state: string;
  requesterUserId: string | null; requesterAppId: string | null; requesterWorkerId: string | null; requesterSessionId: string | null;
  createdAt: Date; expiresAt: Date; endedAt: Date | null;
};

function grantNotFound(grantRef: string): GraphQLError {
  return new GraphQLError('Grant not found', { extensions: { code: 'GRANT_NOT_FOUND', grantRef } });
}

function requestNotFound(id: string): GraphQLError {
  return new GraphQLError('Signing request not found', { extensions: { code: 'SIGNING_REQUEST_NOT_FOUND', id } });
}

function refusalToGraphQL(error: GrantSigningRefusal, ref: Record<string, string>): GraphQLError {
  return new GraphQLError(error.message, { extensions: { code: error.code, ...ref, ...error.details } });
}

/** A transaction-side denial (the App or the caller went while we waited) conceals like any other miss. */
function isDenial(error: unknown): boolean {
  return error instanceof GraphQLError && error.extensions?.code === 'FORBIDDEN';
}

function refuseImpersonation(ctx: Context): void {
  if (ctx.impersonation) {
    throw new GraphQLError('Grant signing requests cannot be made or withdrawn while impersonating.', { extensions: { code: 'FORBIDDEN' } });
  }
}

type Reach = { appId: string; audience: { kind: 'worker'; workerId: string } | { kind: 'manager'; userId: string } };

/**
 * The grant's App and the arm that reaches it, or null (the one gate; `ctx.db` is the request's or the transaction's). The
 * worker arm is tried first and alone; the person arm only for a session bound to no worker. With `locks` (the transaction),
 * the manager's memberships are held FOR SHARE before they are judged, on the transaction's own context.
 */
async function readableGrantReach(ctx: Context, grantId: string, locks?: Prisma.TransactionClient): Promise<Reach | null> {
  const reader = await resolveGrantReader(ctx);
  if (reader) {
    const grant = await getGrantForWorker(ctx.db, reader, grantId);
    return grant ? { appId: grant.appId, audience: { kind: 'worker', workerId: reader.workerId } } : null;
  }
  if (currentActor().workerId) return null;
  const userId = await resolveGrantPerson(ctx);
  if (!userId) return null;
  const grant = await ctx.db.grant.findUnique({ where: { id: grantId }, select: { appId: true } });
  if (!grant) return null;
  const app = await loadApp(ctx, grant.appId);
  if (!app || app.deletedAt || app.uninstalledAt) return null;
  if (locks) await lockAppManagerMemberships(locks, userId, app);
  if (!(await managesApp(ctx, app))) return null;
  return { appId: app.id, audience: { kind: 'manager', userId } };
}

const sameReach = (a: Reach | null, b: Reach): boolean => a !== null && a.appId === b.appId
  && a.audience.kind === b.audience.kind
  && (a.audience.kind === 'worker' ? a.audience.workerId === (b.audience as { workerId: string }).workerId : a.audience.userId === (b.audience as { userId: string }).userId);

async function readableRequest(ctx: Context, id: string): Promise<(GrantSigningRequestRow & { appId: string }) | null> {
  const row = await ctx.db.grantSigningRequest.findUnique({ where: { id } });
  if (!row) return null;
  const reach = await readableGrantReach(ctx, row.grantId);
  return reach ? { ...row, appId: reach.appId } : null;
}

function requesterOf(ctx: Context): SigningRequester {
  return {
    userId: ctx.userId ?? null,
    appId: !ctx.userId && ctx.appKeyId ? ctx.appId ?? null : null,
    workerId: currentActor().workerId,
    sessionId: ctx.sessionId ?? null,
  };
}

export const grantSigningMutations = {
  /** #3649 slice B: open a signing request on one pending grant the caller may read (cor:acl:140:07). */
  requestGrantSignature: async (_: unknown, { grantRef }: { grantRef: string }, ctx: Context) => {
    refuseImpersonation(ctx);
    const reach = await readableGrantReach(ctx, grantRef);
    if (!reach) throw grantNotFound(grantRef);
    const appId = reach.appId;
    try {
      return await withAuthorizedTx(
        ctx, [{ kind: 'app', id: appId }],
        async (txCtx) => { if (!sameReach(await readableGrantReach(txCtx, grantRef, txCtx.db as Prisma.TransactionClient), reach)) throw grantNotFound(grantRef); },
        (tx) => createGrantSigningRequestInTransaction(tx, grantRef, { appId, requester: requesterOf(ctx) }),
      );
    } catch (error) {
      if (error instanceof GrantSigningRefusal) {
        throw error.code === 'GRANT_NOT_FOUND' ? grantNotFound(grantRef) : refusalToGraphQL(error, { grantRef });
      }
      if (isDenial(error)) throw grantNotFound(grantRef);
      throw error;
    }
  },

  /** #3649 slice B: withdraw an open grant signing request; only the account that asked. */
  withdrawGrantSigningRequest: async (_: unknown, { id }: { id: string }, ctx: Context) => {
    refuseImpersonation(ctx);
    const row = await ctx.db.grantSigningRequest.findUnique({ where: { id } });
    const reach = row ? await readableGrantReach(ctx, row.grantId) : null;
    if (!row || !reach) throw requestNotFound(id);
    const caller = { userId: ctx.userId ?? null, appId: !ctx.userId && ctx.appKeyId ? ctx.appId ?? null : null };
    try {
      return await withAuthorizedTx(
        ctx, [{ kind: 'app', id: reach.appId }],
        async (txCtx) => { if (!sameReach(await readableGrantReach(txCtx, row.grantId, txCtx.db as Prisma.TransactionClient), reach)) throw requestNotFound(id); },
        (tx) => withdrawGrantSigningRequestInTransaction(tx, id, { appId: reach.appId, caller }),
      );
    } catch (error) {
      if (error instanceof GrantSigningRefusal) {
        throw error.code === 'SIGNING_REQUEST_NOT_FOUND' ? requestNotFound(id) : refusalToGraphQL(error, { id });
      }
      if (isDenial(error)) throw requestNotFound(id);
      throw error;
    }
  },
};

export const grantSigningQueries = {
  /** #3649 slice B: one grant signing request by id; null when unknown or its grant is not readable (one shape). */
  grantSigningRequest: (_: unknown, { id }: { id: string }, ctx: Context) => readableRequest(ctx, id),
};

/**
 * One instant per row: `state` and `endedAt` are separate field resolvers, and two clock reads could fall either side of the
 * deadline (OPEN with an end time, or EXPIRED without one). The first field read fixes the instant for the row object.
 */
const observedAt = new WeakMap<GrantSigningRequestRow, Date>();
function effectiveState(r: GrantSigningRequestRow) {
  let at = observedAt.get(r);
  if (!at) { at = new Date(); observedAt.set(r, at); }
  return effectiveRequestState(r, at);
}

export const grantSigningFieldResolvers = {
  GrantSigningRequest: {
    state: (r: GrantSigningRequestRow) => effectiveState(r).toUpperCase(),
    endedAt: (r: GrantSigningRequestRow) => (effectiveState(r) === 'expired' && r.state === 'open' ? r.expiresAt : r.endedAt),
    requestedBy: (r: GrantSigningRequestRow) => ({
      userId: r.requesterUserId, appId: r.requesterAppId, workerId: r.requesterWorkerId, sessionId: r.requesterSessionId,
    }),
    ceremonyUrl: (r: GrantSigningRequestRow) => grantSigningCeremonyUrl(r.id),
  },
};
