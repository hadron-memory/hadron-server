/**
 * #3649 slice B (cor:acl:140:07; the node-signing mirror cor:dmo:130:03): grant signing requests on GraphQL. One grant per
 * request (gate selection 1). No signer is named (ruling 0255, item 12). No call here takes an assertion or makes a signature
 * (the cor:dmo:130:02 mirror): that is slice C's ceremony page, the only path that will.
 *
 * Who may do what, through the ONE grant read gate (`resolveGrantReader` + the shared row scope in src/lib/grants/read.ts):
 * - request: whoever may read the grant. As built, only a BOUND WORKER SESSION in its own App reads grants (#3789), so a
 *   worker asks for a signature on a grant it holds or a pending one it requested; the manager's and a person holder's read
 *   (#3711) widen this with no change here;
 * - withdraw: the requester ACCOUNT (the user, from any of its sessions or workers), among those who may read the grant;
 * - read: whoever may read the grant; unknown and unreadable look the same (null).
 * A support (impersonation) session never asks for or ends a signature (FORBIDDEN). Every miss is GRANT_NOT_FOUND /
 * SIGNING_REQUEST_NOT_FOUND, the same answer whatever the reason, so the calls disclose no grant.
 * Behind PASSKEY_SIGNING_ENABLED with the rest of signing (deploymentSchema's removal set).
 */
import { GraphQLError } from 'graphql';
import type { Context } from './resolvers.helpers.js';
import { withAuthorizedTx } from './authorizedTx.js';
import { resolveGrantReader } from './resolvers.grant.js';
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

/** The grant's App when the caller may read it, else null (the one read gate; `db` is the request's or the transaction's). */
async function readableGrantApp(ctx: Context, grantId: string): Promise<string | null> {
  const reader = await resolveGrantReader(ctx);
  if (!reader) return null;
  const grant = await getGrantForWorker(ctx.db, reader, grantId);
  return grant ? grant.appId : null;
}

async function readableRequest(ctx: Context, id: string): Promise<(GrantSigningRequestRow & { appId: string }) | null> {
  const row = await ctx.db.grantSigningRequest.findUnique({ where: { id } });
  if (!row) return null;
  const appId = await readableGrantApp(ctx, row.grantId);
  return appId ? { ...row, appId } : null;
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
    const appId = await readableGrantApp(ctx, grantRef);
    if (!appId) throw grantNotFound(grantRef);
    try {
      return await withAuthorizedTx(
        ctx, [{ kind: 'app', id: appId }],
        async (txCtx) => { if ((await readableGrantApp(txCtx, grantRef)) !== appId) throw grantNotFound(grantRef); },
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
    const row = await readableRequest(ctx, id);
    if (!row) throw requestNotFound(id);
    const caller = { userId: ctx.userId ?? null, appId: !ctx.userId && ctx.appKeyId ? ctx.appId ?? null : null };
    try {
      return await withAuthorizedTx(
        ctx, [{ kind: 'app', id: row.appId }],
        async (txCtx) => { if ((await readableGrantApp(txCtx, row.grantId)) !== row.appId) throw requestNotFound(id); },
        (tx) => withdrawGrantSigningRequestInTransaction(tx, id, { appId: row.appId, caller }),
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
