/**
 * #3649 slice B (cor:acl:140:07; the node-signing mirror cor:dmo:130:03): grant signing requests on GraphQL. One grant per
 * request (gate selection 1). No signer is named (ruling 0255, item 12). No call here takes an assertion or makes a signature
 * (the cor:dmo:130:02 mirror): that is slice C's ceremony page, the only path that will.
 *
 * Who may do what. Exactly three readers reach a grant here, ONE arm per session, the worker arm first and exclusive:
 * - a BOUND WORKER SESSION in its own App (`resolveGrantReader` + the shared row scope in src/lib/grants/read.ts, #3789): it
 *   asks for a signature on a grant it holds or a pending one it requested;
 * - #4012: a PERSON acting as themselves who manages the grant's own live, installed App (`resolveGrantPerson` +
 *   `managesApp`, the reach `appGrants` gives, #3711), judged under the transaction's membership locks. A session bound to a
 *   worker never falls to this arm: a retired or refused worker binding reads nothing, not even as the person driving it.
 * - #4544: that same PERSON, while an App participant, on a grant that backs a secret read client they ISSUED (cor:sec:060:01
 *   lets the current version's writer issue; this lets them finish the hand-off). Keyed on the client's stored issuer.
 * Then: request: any reader; withdraw: the requester ACCOUNT alone (the user, from any of its sessions or workers),
 * among those who may read the grant, so a manager who did not ask is refused SIGNING_REQUEST_NOT_REQUESTER; read: any
 * reader, by id; unknown and unreadable look the same (null). An uninstalled App is reached by no arm.
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
import { isAppParticipant } from '../../../lib/auth/appParticipantRead.js';
import type { Prisma } from '../../../generated/prisma/index.js';
import { getGrantForWorker } from '../../../lib/grants/read.js';
import { currentActor } from '../../../lib/requestActor.js';
import {
  createGrantSigningRequestInTransaction, GrantSigningRefusal, withdrawGrantSigningRequestInTransaction,
} from '../../../lib/signing/grantRequests.js';
import { effectiveRequestState, type SigningRequester } from '../../../lib/signing/requests.js';
import { grantSigningCeremonyUrl, grantSelectionSigningCeremonyUrl } from '../../../lib/signing/ceremonyUrl.js';
import {
  createGrantSelectionInTransaction, normalizeSelectionRefs, withdrawGrantSelectionInTransaction,
} from '../../../lib/signing/grantSelectionRequests.js';

type GrantSigningRequestRow = {
  id: string; grantId: string; version: number; termsHash: string; payloadVersion: string; state: string;
  requesterUserId: string | null; requesterAppId: string | null; requesterWorkerId: string | null; requesterSessionId: string | null;
  createdAt: Date; expiresAt: Date; endedAt: Date | null; selectionId?: string | null;
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

type Reach = {
  appId: string;
  audience: { kind: 'worker'; workerId: string } | { kind: 'manager'; userId: string } | { kind: 'issuer'; userId: string };
};

/**
 * The grant's App and the arm that reaches it, or null (the one gate; `ctx.db` is the request's or the transaction's). The
 * worker arm is tried first and alone; the person arms only for a session bound to no worker. With `locks` (the transaction),
 * the person's memberships are held FOR SHARE before they are judged, on the transaction's own context.
 *
 * #4544 (cor:sec:060:01, Vera's FIT issuecomment-7034402954): besides a manager, the person who ISSUED the secret read client
 * this grant backs reaches it, while still an App participant, so a writer who does not manage the App can finish the
 * hand-off. Keyed on the client's stored issuer (`secret_read_clients.issuer_user_id`), a person: never a worker bound to
 * them (the worker arm above answers for every worker session), an App key, a run or an impersonated session
 * (`resolveGrantPerson`). A grant with no read client row gains no reader, so no other grant kind is widened.
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
  if (await managesApp(ctx, app)) return { appId: app.id, audience: { kind: 'manager', userId } };
  const client = await ctx.db.secretReadClient.findUnique({ where: { grantId }, select: { appId: true, issuerUserId: true } });
  if (!client || client.appId !== app.id || client.issuerUserId !== userId) return null;
  if (!(await isAppParticipant(ctx, app))) return null;
  return { appId: app.id, audience: { kind: 'issuer', userId } };
}

const reachKey = (r: Reach): string => `${r.appId}:${r.audience.kind}:${r.audience.kind === 'worker' ? r.audience.workerId : r.audience.userId}`;
const sameReach = (a: Reach | null, b: Reach): boolean => a !== null && reachKey(a) === reachKey(b);

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

type GrantSigningSelectionRow = {
  id: string; appId: string; payloadVersion: string; state: string;
  requesterUserId: string | null; requesterAppId: string | null; requesterWorkerId: string | null; requesterSessionId: string | null;
  createdAt: Date; expiresAt: Date; endedAt: Date | null; lastRefusedAt: Date | null;
};

/**
 * The App and the one reach a caller has over EVERY grant of a selection, or null: one unreadable item, or two Apps, is null (one
 * shape for unknown and unreadable, so a selection is never partly visible). `locks` is the transaction, as for one grant.
 */
async function readableSelectionReach(ctx: Context, grantIds: readonly string[], locks?: Prisma.TransactionClient): Promise<Reach | null> {
  let first: Reach | null = null;
  for (const id of grantIds) {
    const reach = await readableGrantReach(ctx, id, locks);
    if (!reach) return null;
    if (first && !sameReach(first, reach)) return null;
    first ??= reach;
  }
  return first;
}

async function readableSelection(ctx: Context, id: string): Promise<(GrantSigningSelectionRow & { appId: string; grantIds: string[] }) | null> {
  const row = await ctx.db.grantSigningSelection.findUnique({ where: { id }, include: { items: { select: { grantId: true } } } });
  if (!row) return null;
  const grantIds = row.items.map((i) => i.grantId).sort();
  const reach = await readableSelectionReach(ctx, grantIds);
  return reach && reach.appId === row.appId ? { ...row, grantIds } : null;
}

export const grantSigningMutations = {
  /**
   * #5001 (cor:acl:140:07): open ONE signing request over a selection of pending grants of one App, one passkey touch. Every ref
   * must be readable by the caller through the same gate as `requestGrantSignature`; the first one that is not (in ascending id
   * order) is GRANT_NOT_FOUND, the same answer as an unknown id. GraphQL only (the one-grant request has no MCP tool).
   */
  requestGrantSelectionSignature: async (_: unknown, { grantRefs }: { grantRefs: string[] }, ctx: Context) => {
    refuseImpersonation(ctx);
    let ids: string[];
    try { ids = normalizeSelectionRefs(grantRefs); } catch (error) {
      if (error instanceof GrantSigningRefusal) throw refusalToGraphQL(error, {});
      throw error;
    }
    const reaches = new Map<string, Reach>();
    for (const id of ids) {
      const reach = await readableGrantReach(ctx, id);
      if (!reach) throw grantNotFound(id);
      reaches.set(id, reach);
    }
    const first = reaches.get(ids[0]!)!;
    if (ids.some((id) => reaches.get(id)!.appId !== first.appId)) {
      throw refusalToGraphQL(new GrantSigningRefusal('SELECTION_MIXED_APPS', 'A selection holds grants of one App.'), {});
    }
    const appId = first.appId;
    try {
      return await withAuthorizedTx(
        ctx, [{ kind: 'app', id: appId }],
        async (txCtx, tx) => {
          for (const id of ids) if (!sameReach(await readableGrantReach(txCtx, id, tx), reaches.get(id)!)) throw grantNotFound(id);
        },
        (tx) => createGrantSelectionInTransaction(tx, ids, { appId, requester: requesterOf(ctx) }),
      );
    } catch (error) {
      if (error instanceof GrantSigningRefusal) {
        const ref = typeof error.details.grantRef === 'string' ? error.details.grantRef : null;
        throw error.code === 'GRANT_NOT_FOUND' && ref ? grantNotFound(ref) : refusalToGraphQL(error, {});
      }
      if (isDenial(error)) throw grantNotFound(ids[0]!);
      throw error;
    }
  },

  /** #5001: withdraw an open grant signing selection; only the account that asked. Its open items end with it. */
  withdrawGrantSigningSelection: async (_: unknown, { id }: { id: string }, ctx: Context) => {
    refuseImpersonation(ctx);
    const row = await readableSelection(ctx, id);
    if (!row) throw requestNotFound(id);
    const caller = { userId: ctx.userId ?? null, appId: !ctx.userId && ctx.appKeyId ? ctx.appId ?? null : null };
    try {
      return await withAuthorizedTx(
        ctx, [{ kind: 'app', id: row.appId }],
        async (txCtx, tx) => {
          const reach = await readableSelectionReach(txCtx, row.grantIds, tx);
          if (!reach || reach.appId !== row.appId) throw requestNotFound(id);
        },
        (tx) => withdrawGrantSelectionInTransaction(tx, id, { appId: row.appId, caller }),
      );
    } catch (error) {
      if (error instanceof GrantSigningRefusal) {
        throw error.code === 'SIGNING_REQUEST_NOT_FOUND' ? requestNotFound(id) : refusalToGraphQL(error, { id });
      }
      if (isDenial(error)) throw requestNotFound(id);
      throw error;
    }
  },

  /** #3649 slice B: open a signing request on one pending grant the caller may read (cor:acl:140:07). */
  requestGrantSignature: async (_: unknown, { grantRef }: { grantRef: string }, ctx: Context) => {
    refuseImpersonation(ctx);
    const reach = await readableGrantReach(ctx, grantRef);
    if (!reach) throw grantNotFound(grantRef);
    const appId = reach.appId;
    try {
      return await withAuthorizedTx(
        ctx, [{ kind: 'app', id: appId }],
        async (txCtx, tx) => { if (!sameReach(await readableGrantReach(txCtx, grantRef, tx), reach)) throw grantNotFound(grantRef); },
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
    const reach = row && !row.selectionId ? await readableGrantReach(ctx, row.grantId) : null;
    if (!row || !reach) throw requestNotFound(id);
    const caller = { userId: ctx.userId ?? null, appId: !ctx.userId && ctx.appKeyId ? ctx.appId ?? null : null };
    try {
      return await withAuthorizedTx(
        ctx, [{ kind: 'app', id: reach.appId }],
        async (txCtx, tx) => { if (!sameReach(await readableGrantReach(txCtx, row.grantId, tx), reach)) throw requestNotFound(id); },
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
  grantSigningRequest: async (_: unknown, { id }: { id: string }, ctx: Context) => {
    const row = await readableRequest(ctx, id);
    // #5001: an item of a selection is read through its selection only; the one-grant read answers as for an unknown id.
    return row && !row.selectionId ? row : null;
  },
  /** #5001: one grant signing selection by id; null when unknown or any of its grants is not readable (one shape). */
  grantSigningSelection: (_: unknown, { id }: { id: string }, ctx: Context) => readableSelection(ctx, id),
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

const selectionObservedAt = new WeakMap<GrantSigningSelectionRow, Date>();
function selectionEffectiveState(r: GrantSigningSelectionRow) {
  let at = selectionObservedAt.get(r);
  if (!at) { at = new Date(); selectionObservedAt.set(r, at); }
  return effectiveRequestState(r, at);
}

export const grantSigningFieldResolvers = {
  GrantSigningRequest: {
    state: (r: GrantSigningRequestRow) => effectiveState(r).toUpperCase(),
    endedAt: (r: GrantSigningRequestRow) => (effectiveState(r) === 'expired' && r.state === 'open' ? r.expiresAt : r.endedAt),
    requestedBy: (r: GrantSigningRequestRow) => ({
      userId: r.requesterUserId, appId: r.requesterAppId, workerId: r.requesterWorkerId, sessionId: r.requesterSessionId,
    }),
    // An item of a selection signs on its selection's page, never on a one-grant page of its own.
    ceremonyUrl: (r: GrantSigningRequestRow) => (r.selectionId ? grantSelectionSigningCeremonyUrl(r.selectionId) : grantSigningCeremonyUrl(r.id)),
  },
  GrantSigningSelection: {
    state: (r: GrantSigningSelectionRow) => selectionEffectiveState(r).toUpperCase(),
    endedAt: (r: GrantSigningSelectionRow) => (selectionEffectiveState(r) === 'expired' && r.state === 'open' ? r.expiresAt : r.endedAt),
    requestedBy: (r: GrantSigningSelectionRow) => ({
      userId: r.requesterUserId, appId: r.requesterAppId, workerId: r.requesterWorkerId, sessionId: r.requesterSessionId,
    }),
    ceremonyUrl: (r: GrantSigningSelectionRow) => grantSelectionSigningCeremonyUrl(r.id),
    items: (r: GrantSigningSelectionRow & { items?: GrantSigningRequestRow[] }, _a: unknown, ctx: Context) =>
      r.items ?? ctx.db.grantSigningRequest.findMany({ where: { selectionId: r.id }, orderBy: { positionInSelection: 'asc' } }),
  },
};
