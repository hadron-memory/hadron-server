import { GraphQLError } from 'graphql';
import type { PrismaClient } from '../../../generated/prisma/index.js';
import type { Context } from './resolvers.helpers.js';
import { isMemoryReadableCached, requireMemoryWriteAccess } from './resolvers.helpers.js';
import { resolveNodeRefForCaller } from './resolvers.nodeRefAccess.js';
import { resolveNodeUrnField, resolveRevisionEditor } from './resolvers.types.js';
import { withAuthorizedMemoryTx } from './authorizedTx.js';
import { NodeNotFoundError } from '../../../lib/entityRef/errors.js';
import { currentActor } from '../../../lib/requestActor.js';
import {
  createSigningRequestInTransaction, effectiveRequestState, SigningRefusal, withdrawSigningRequestInTransaction,
  type SigningRequester,
} from '../../../lib/signing/requests.js';
import { signingCeremonyUrl } from '../../../lib/signing/ceremonyUrl.js';
import { loadSignatureStatuses, type NodeSignatureStatusView, type SignatureView } from '../../../lib/signing/status.js';

/**
 * #1632 / cor:dmo:130 (S2b-1) — signing requests and the signatureStatus
 * projection on GraphQL. Contract: hadron-server#1632 issuecomment-6148958707.
 *
 * Who may do what (cor:dmo:130:02/:03):
 * - request a signature: any READER of the node, agents included;
 * - withdraw: the requester ACCOUNT, from any of its sessions (#10397);
 * - read requests and signatures: the node's readers (#10019, 130:06).
 * No call here takes an assertion or a record (130:02 S2): completion and
 * decline are reached only through S2b-2's ceremony page.
 * The refusal codes are ruled (Holger, #10430; cor:dmo:130:02/:03). Still
 * unruled and so provisional: which refusal wins when several apply (#10437).
 */

type SigningRequestRow = {
  id: string; nodeId: string; revision: number; approvalHash: string; payloadVersion: string; state: string;
  namedSignerId: string | null; requesterUserId: string | null; requesterAppId: string | null;
  requesterWorkerId: string | null; requesterSessionId: string | null;
  createdAt: Date; expiresAt: Date; endedAt: Date | null;
};

function nodeNotFound(nodeRef: string): GraphQLError {
  return new GraphQLError('Node not found', { extensions: { code: 'NODE_NOT_FOUND', nodeRef } });
}

function requestNotFound(id: string): GraphQLError {
  return new GraphQLError('Signing request not found', { extensions: { code: 'SIGNING_REQUEST_NOT_FOUND', id } });
}

function refusalToGraphQL(error: SigningRefusal, ref: Record<string, string>): GraphQLError {
  return new GraphQLError(error.message, { extensions: { code: error.code, ...ref, ...error.details } });
}

/** A support (impersonation) session reads; it never asks for or ends a signature on someone's behalf. */
function refuseImpersonation(ctx: Context): void {
  if (ctx.impersonation) {
    throw new GraphQLError('Signing requests cannot be made or withdrawn while impersonating.', { extensions: { code: 'FORBIDDEN' } });
  }
}

/** The requester as recorded: a person when there is one; the App only when the App key itself is the principal. */
function requesterOf(ctx: Context): SigningRequester {
  return {
    userId: ctx.userId ?? null,
    appId: !ctx.userId && ctx.appKeyId ? ctx.appId ?? null : null,
    workerId: currentActor().workerId,
    sessionId: ctx.sessionId ?? null,
  };
}

/** Resolve a node ref through the node read gate to its live id + memory; every miss is NODE_NOT_FOUND. */
async function resolveReadableNode(ctx: Context, nodeRef: string): Promise<{ id: string; memoryId: string }> {
  let id: string;
  try {
    ({ id } = await resolveNodeRefForCaller(ctx, nodeRef));
  } catch (error) {
    if (error instanceof NodeNotFoundError) throw nodeNotFound(nodeRef);
    throw error;
  }
  const node = await ctx.db.node.findUnique({ where: { id }, select: { memoryId: true, deletedAt: true } });
  if (!node || node.deletedAt || !(await isMemoryReadableCached(ctx, node.memoryId))) throw nodeNotFound(nodeRef);
  return { id, memoryId: node.memoryId };
}

/** A request the caller may read (a reader of its node's memory), else null: unknown and unreadable look the same. */
async function readableRequest(ctx: Context, id: string): Promise<(SigningRequestRow & { memoryId: string }) | null> {
  const row = await ctx.db.signingRequest.findUnique({ where: { id }, include: { node: { select: { memoryId: true } } } });
  if (!row || !(await isMemoryReadableCached(ctx, row.node.memoryId))) return null;
  const { node, ...rest } = row;
  return { ...rest, memoryId: node.memoryId };
}

/**
 * The signer policy S2b-2's ceremony page will pass to completion and decline:
 * a person who may write the node's memory (#9839, #9902). One place, so a
 * later MemoryConfig setting changes it here.
 */
export function maySignInMemory(db: PrismaClient) {
  return async (userId: string, memoryId: string): Promise<boolean> => {
    try {
      await requireMemoryWriteAccess({ db, userId, roles: [] } as Context, memoryId);
      return true;
    } catch {
      return false;
    }
  };
}

export const signingMutations = {
  /**
   * #1632 — open a signing request on a node's current content (cor:dmo:130:03).
   * `expectedRevision`, when given, must still be current, so a requester asks
   * for a signature on the text they read. `signerRef` names one signer (a
   * user id); omitted, any writer of the memory may sign. A named signer who
   * may not write the memory is refused with SIGNER_NOT_A_WRITER (#1904).
   */
  requestNodeSignature: async (
    _: unknown,
    { nodeRef, expectedRevision, signerRef }: { nodeRef: string; expectedRevision?: number | null; signerRef?: string | null },
    ctx: Context,
  ) => {
    refuseImpersonation(ctx);
    const { id, memoryId } = await resolveReadableNode(ctx, nodeRef);
    try {
      return await withAuthorizedMemoryTx(
        ctx, memoryId, [],
        async (txCtx) => { if (!(await isMemoryReadableCached(txCtx, memoryId))) throw nodeNotFound(nodeRef); },
        (tx) => createSigningRequestInTransaction(tx, id, {
          memoryId, requester: requesterOf(ctx), namedSignerId: signerRef ?? null, expectedRevision,
          mayWrite: maySignInMemory(ctx.db),
        }),
      );
    } catch (error) {
      if (error instanceof SigningRefusal) {
        throw error.code === 'NODE_NOT_FOUND' ? nodeNotFound(nodeRef) : refusalToGraphQL(error, { nodeRef });
      }
      throw error;
    }
  },

  /** #1632 — withdraw an open request: only the account that asked (#10024, #10397). */
  withdrawSigningRequest: async (_: unknown, { id }: { id: string }, ctx: Context) => {
    refuseImpersonation(ctx);
    const row = await readableRequest(ctx, id);
    if (!row) throw requestNotFound(id);
    const caller = { userId: ctx.userId ?? null, appId: !ctx.userId && ctx.appKeyId ? ctx.appId ?? null : null };
    try {
      return await withAuthorizedMemoryTx(
        ctx, row.memoryId, [],
        async (txCtx) => { if (!(await isMemoryReadableCached(txCtx, row.memoryId))) throw requestNotFound(id); },
        (tx) => withdrawSigningRequestInTransaction(tx, id, { memoryId: row.memoryId, caller }),
      );
    } catch (error) {
      if (error instanceof SigningRefusal) {
        throw error.code === 'SIGNING_REQUEST_NOT_FOUND' ? requestNotFound(id) : refusalToGraphQL(error, { id });
      }
      throw error;
    }
  },
};

export const signingQueries = {
  /** #1632 — one request by id; null when unknown or not readable (one shape). */
  signingRequest: (_: unknown, { id }: { id: string }, ctx: Context) => readableRequest(ctx, id),
};

type StatusBatch = { pending: Map<string, Array<(v: NodeSignatureStatusView) => void>>; failures: Array<(e: unknown) => void> };
const statusBatches = new WeakMap<Context, StatusBatch>();

/**
 * #1632 — the signatureStatus of every node resolved in one tick of a request
 * shares ONE load (two queries plus cached re-verification): the approvalStatus
 * same-tick batch (#1596/#1627), so a list or search page pays per page, not
 * per row. The parent node was already authorized by the read that produced it.
 */
function loadSignatureStatus(ctx: Context, nodeId: string): Promise<NodeSignatureStatusView> {
  let batch = statusBatches.get(ctx);
  if (!batch) {
    const fresh: StatusBatch = { pending: new Map(), failures: [] };
    batch = fresh;
    statusBatches.set(ctx, fresh);
    setImmediate(() => {
      statusBatches.delete(ctx);
      void (async () => {
        try {
          const statuses = await loadSignatureStatuses(ctx.db, [...fresh.pending.keys()]);
          for (const [id, waiters] of fresh.pending) for (const resolve of waiters) resolve(statuses.get(id)!);
        } catch (error) {
          for (const reject of fresh.failures) reject(error);
        }
      })();
    });
  }
  const target = batch;
  return new Promise((resolve, reject) => {
    const waiters = target.pending.get(nodeId) ?? [];
    waiters.push(resolve);
    target.pending.set(nodeId, waiters);
    target.failures.push(reject);
  });
}

export const signingFieldResolvers = {
  Node: {
    /** #1632 / cor:dmo:130:06 — the node's signatures and their derived states. */
    signatureStatus: (n: { id: string }, _: unknown, ctx: Context) => loadSignatureStatus(ctx, n.id),
    /** #1632 — the node's signing requests, newest first; the same readers as its signatures (#10019). */
    signingRequests: async (n: { id: string }, { state, first }: { state?: string | null; first?: number | null }, ctx: Context) => {
      const take = Math.min(Math.max(first ?? 20, 1), 100);
      const rows = await ctx.db.signingRequest.findMany({
        where: { nodeId: n.id },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        // A state filter is applied to the EFFECTIVE state, so it reads past the stored page.
        ...(state ? {} : { take }),
      });
      if (!state) return rows;
      const now = new Date();
      return rows.filter((r) => effectiveRequestState(r, now).toUpperCase() === state).slice(0, take);
    },
  },
  SigningRequest: {
    nodeUrn: async (r: SigningRequestRow, _: unknown, ctx: Context) => {
      const node = await ctx.db.node.findUnique({ where: { id: r.nodeId }, select: { id: true, loc: true, memoryId: true } });
      return node ? resolveNodeUrnField(node, ctx) : null;
    },
    state: (r: SigningRequestRow) => effectiveRequestState(r, new Date()).toUpperCase(),
    /** cor:dmo:130:08: the server-hosted page's link; the id is its only parameter. */
    ceremonyUrl: (r: SigningRequestRow) => signingCeremonyUrl(r.id),
    endedAt: (r: SigningRequestRow) =>
      effectiveRequestState(r, new Date()) === 'expired' && r.state === 'open' ? r.expiresAt : r.endedAt,
    namedSigner: (r: SigningRequestRow, _: unknown, ctx: Context) =>
      r.namedSignerId ? resolveRevisionEditor(ctx, [r.namedSignerId]) : null,
    requestedBy: (r: SigningRequestRow) => ({
      userId: r.requesterUserId, appId: r.requesterAppId, workerId: r.requesterWorkerId, sessionId: r.requesterSessionId,
    }),
    signature: async (r: SigningRequestRow, _: unknown, ctx: Context) => {
      if (r.state !== 'completed') return null;
      const status = await loadSignatureStatus(ctx, r.nodeId);
      return status.signatures.find((s) => s.signingRequestId === r.id) ?? null;
    },
  },
  NodeSignature: {
    signer: (s: SignatureView, _: unknown, ctx: Context) => resolveRevisionEditor(ctx, [s.signerId]),
  },
};
