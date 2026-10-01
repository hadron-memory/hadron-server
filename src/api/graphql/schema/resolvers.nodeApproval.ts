import { GraphQLError } from 'graphql';
import type { Context } from './resolvers.helpers.js';
import {
  concealUnreadableDenial,
  isMemoryHiddenForWrite,
  isMemoryReadableCached,
  requireMemoryWriteAccess,
} from './resolvers.helpers.js';
import { resolveNodeRefForCaller } from './resolvers.nodeRefAccess.js';
import { resolveNodeUrnField, resolveRevisionEditor, typeResolvers } from './resolvers.types.js';
import { withAuthorizedMemoryTx } from './authorizedTx.js';
import { resolveMemoryRef } from '../../../lib/entityRef/memoryRef.js';
import { MemoryNotFoundError } from '../../../lib/asset/gate.js';
import { NodeNotFoundError } from '../../../lib/entityRef/errors.js';
import { sessionKeyCache } from '../../../lib/sessionKeyCache.js';
import type { EncryptionKey } from '../../../lib/crypto.js';
import { editorFromAuth } from '../../../lib/nodeRevisionSnapshot.js';
import {
  approvalFieldsOf,
  approvalRecordOf,
  approvalStateOf,
  approveNodeInTransaction,
  checkNodeIntegrity,
  loadApprovedSnapshots,
  NODE_APPROVAL_ROW_SELECT,
  NodeApprovalRefusal,
  type NodeApprovalRecord,
  type NodeApprovalRow,
  type NodeIntegrityResult,
} from '../../../lib/nodeApproval.js';

/**
 * #1591 — the approval policy: may this caller approve nodes of this memory?
 * Holger's ruling (#1447 round 3, question 1): any writer of the memory, the
 * author included. The ONE place that decides it, so a later MemoryConfig
 * setting changes it here and nowhere else.
 */
export async function mayApproveNodes(ctx: Context, memoryId: string): Promise<void> {
  await requireMemoryWriteAccess(ctx, memoryId);
}

/** The session key of an encrypted memory, or `SESSION_EXPIRED`; null for a plaintext memory. */
async function keyForMemory(ctx: Context, memoryId: string): Promise<EncryptionKey | null> {
  const memory = await ctx.db.memory.findUniqueOrThrow({ where: { id: memoryId }, select: { isEncrypted: true } });
  if (!memory.isEncrypted) return null;
  const key = sessionKeyCache.getByMemoryId(memoryId);
  if (!key) {
    throw new GraphQLError(
      `SESSION_EXPIRED: memory ${memoryId} is encrypted but no active session key is available.`,
      { extensions: { code: 'SESSION_EXPIRED', memoryId } },
    );
  }
  return key;
}

function nodeNotFound(nodeRef: string): GraphQLError {
  return new GraphQLError('Node not found', { extensions: { code: 'NODE_NOT_FOUND', nodeRef } });
}

function refusalToGraphQL(error: NodeApprovalRefusal, nodeRef: string): GraphQLError {
  return new GraphQLError(error.message, { extensions: { code: error.code, nodeRef, ...error.details } });
}

/** Resolve a node ref to its live id + memory, answering every miss as NODE_NOT_FOUND. */
async function resolveLiveNode(ctx: Context, nodeRef: string): Promise<{ id: string; memoryId: string }> {
  let id: string;
  try {
    ({ id } = await resolveNodeRefForCaller(ctx, nodeRef));
  } catch (error) {
    if (error instanceof NodeNotFoundError) throw nodeNotFound(nodeRef);
    throw error;
  }
  const node = await ctx.db.node.findUnique({ where: { id }, select: { memoryId: true, deletedAt: true } });
  if (!node || node.deletedAt) throw nodeNotFound(nodeRef);
  return { id, memoryId: node.memoryId };
}

/** A receipt row: the node's identity plus its approval. */
async function receiptOf(ctx: Context, node: NodeApprovalRow) {
  return {
    nodeId: node.id,
    loc: node.loc,
    urn: await resolveNodeUrnField(node, ctx),
    approval: approvalRecordOf(node)!,
  };
}

/**
 * Run the tamper check over loaded rows of ONE memory, decrypting live and
 * snapshot text. A snapshot captured in another memory (before a move) is
 * decrypted with that memory's key; when it is encrypted and its key isn't
 * available the snapshot is treated as not retained, never hashed as
 * ciphertext, which would read as a false TAMPERED.
 */
async function integrityOf(ctx: Context, memoryId: string, nodes: NodeApprovalRow[], key: EncryptionKey | null) {
  const snapshots = await loadApprovedSnapshots(ctx.db, nodes);
  const foreign = [...new Set([...snapshots.values()]
    .map((s) => s.memoryId)
    .filter((id): id is string => id != null && id !== memoryId))];
  const encryptedForeign = new Set((await ctx.db.memory.findMany({
    where: { id: { in: foreign }, isEncrypted: true },
    select: { id: true },
  })).map((m) => m.id));
  const snapshotFields = (snapshot: { memoryId: string | null; name: string; abstract: string | null; content: string | null }) => {
    const sourceId = snapshot.memoryId ?? memoryId;
    if (sourceId === memoryId) return approvalFieldsOf(snapshot, key);
    if (!encryptedForeign.has(sourceId)) return approvalFieldsOf(snapshot, null);
    const foreignKey = sessionKeyCache.getByMemoryId(sourceId);
    return foreignKey ? approvalFieldsOf(snapshot, foreignKey) : null;
  };
  return nodes.map((node) => {
    const snapshot = snapshots.get(node.id);
    return checkNodeIntegrity(node, approvalFieldsOf(node, key), snapshot ? snapshotFields(snapshot) : null);
  });
}

async function integrityCheckView(ctx: Context, result: NodeIntegrityResult, memoryId: string) {
  return { ...result, urn: await resolveNodeUrnField({ loc: result.loc, memoryId }, ctx) };
}

export const nodeApprovalQueries = {
  /**
   * #1591 — the tamper check for one node: recompute its approval hash and
   * compare it with the approval on record. Read-gated like a node read; a
   * pure read (no reconcile, no writes).
   */
  verifyNode: async (_: unknown, { nodeRef }: { nodeRef: string }, ctx: Context) => {
    const { id, memoryId } = await resolveLiveNode(ctx, nodeRef);
    if (!(await isMemoryReadableCached(ctx, memoryId))) throw nodeNotFound(nodeRef);
    const key = await keyForMemory(ctx, memoryId);
    const node = await ctx.db.node.findUniqueOrThrow({ where: { id }, select: NODE_APPROVAL_ROW_SELECT });
    const [result] = await integrityOf(ctx, memoryId, [node], key);
    return integrityCheckView(ctx, result!, memoryId);
  },

  /** #1591 — the tamper check over every live node of a memory. */
  verifyMemoryNodes: async (_: unknown, { memoryRef }: { memoryRef: string }, ctx: Context) => {
    const { id: memoryId } = await resolveMemoryRef(ctx.db, memoryRef);
    if (!(await isMemoryReadableCached(ctx, memoryId))) throw new MemoryNotFoundError(memoryRef);
    const key = await keyForMemory(ctx, memoryId);
    const nodes = await ctx.db.node.findMany({
      where: { memoryId, deletedAt: null },
      orderBy: { loc: 'asc' },
      select: NODE_APPROVAL_ROW_SELECT,
    });
    const results = await integrityOf(ctx, memoryId, nodes, key);
    const count = (state: NodeIntegrityResult['state']) => results.filter((r) => r.state === state).length;
    return {
      checked: results.length,
      intact: count('INTACT'),
      tampered: count('TAMPERED'),
      superseded: count('SUPERSEDED'),
      notApproved: count('NOT_APPROVED'),
      problems: await Promise.all(
        results.filter((r) => r.state !== 'INTACT').map((r) => integrityCheckView(ctx, r, memoryId)),
      ),
    };
  },
};

export const nodeApprovalMutations = {
  /**
   * #1591 — approve a node's CURRENT revision. `revision`, when given, must
   * still be current (`REVISION_MISMATCH` otherwise), so an approver approves
   * the text they read. Idempotent: an approved revision keeps its approval.
   * Gated by {@link mayApproveNodes} under the memory's authority anchors.
   */
  approveNode: async (
    _: unknown,
    { nodeRef, revision }: { nodeRef: string; revision?: number | null },
    ctx: Context,
  ) => {
    const { id, memoryId } = await resolveLiveNode(ctx, nodeRef);
    if (await isMemoryHiddenForWrite(ctx, memoryId, 'node')) throw nodeNotFound(nodeRef);
    const key = await keyForMemory(ctx, memoryId);
    try {
      const { node } = await withAuthorizedMemoryTx(
        ctx, memoryId, [],
        (txCtx) => mayApproveNodes(txCtx, memoryId),
        (tx) => approveNodeInTransaction(tx, id, {
          memoryId, approver: editorFromAuth(ctx), key, expectedRevision: revision,
        }),
      );
      return receiptOf(ctx, node);
    } catch (error) {
      if (error instanceof NodeApprovalRefusal) {
        throw error.code === 'NODE_NOT_FOUND' ? nodeNotFound(nodeRef) : refusalToGraphQL(error, nodeRef);
      }
      throw error;
    }
  },

  /**
   * #1591 — approve the current revision of every live node of a memory that
   * isn't approved yet, in one transaction. Placeholders are skipped and
   * reported. PR 2 narrows the scope to unminted nodes.
   */
  approveMemoryNodes: async (_: unknown, { memoryRef }: { memoryRef: string }, ctx: Context) => {
    const { id: memoryId } = await resolveMemoryRef(ctx.db, memoryRef);
    await concealUnreadableDenial(ctx, memoryId, memoryRef, () => mayApproveNodes(ctx, memoryId));
    const key = await keyForMemory(ctx, memoryId);
    const outcome = await withAuthorizedMemoryTx(
      ctx, memoryId, [],
      (txCtx) => mayApproveNodes(txCtx, memoryId),
      async (tx) => {
        // Lock in id order, so two bulk approvals cannot deadlock each other.
        const ids = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT id FROM nodes WHERE memory_id = ${memoryId} AND deleted_at IS NULL ORDER BY id FOR UPDATE`;
        const approved: NodeApprovalRow[] = [];
        const skippedPlaceholders: string[] = [];
        let alreadyApprovedCount = 0;
        const now = new Date();
        for (const { id } of ids) {
          try {
            const result = await approveNodeInTransaction(tx, id, {
              memoryId, approver: editorFromAuth(ctx), key, now,
            });
            if (result.approvedNow) approved.push(result.node);
            else alreadyApprovedCount += 1;
          } catch (error) {
            if (!(error instanceof NodeApprovalRefusal)) throw error;
            if (error.code === 'NODE_IS_PLACEHOLDER') {
              const { loc } = await tx.node.findUniqueOrThrow({ where: { id }, select: { loc: true } });
              skippedPlaceholders.push(loc);
            } else {
              throw error;
            }
          }
        }
        return { approved, skippedPlaceholders, alreadyApprovedCount };
      },
      { timeout: 120_000 },
    );
    const byLoc = (a: { loc: string }, b: { loc: string }) => (a.loc < b.loc ? -1 : a.loc > b.loc ? 1 : 0);
    return {
      approvedCount: outcome.approved.length,
      approved: await Promise.all([...outcome.approved].sort(byLoc).map((n) => receiptOf(ctx, n))),
      alreadyApprovedCount: outcome.alreadyApprovedCount,
      skippedPlaceholders: outcome.skippedPlaceholders.sort(),
    };
  },
};

type ApprovalParent = { id: string; revSeq: number } & Partial<Pick<NodeApprovalRow,
  'approvedRevNo' | 'approvedBy' | 'approvedByInfo' | 'approvedAt' | 'approvalHash'>>;

export const nodeApprovalFieldResolvers = {
  Node: {
    /**
     * #1591 — whether the node's current revision is approved. Compared with
     * the RECONCILED revision (`Node.revision`), so a node changed outside a
     * revisioned writer never reads as approved.
     */
    approvalStatus: async (n: ApprovalParent, args: unknown, ctx: Context) => {
      const revision = await (typeResolvers.Node.revision as (p: unknown, a: unknown, c: Context) => Promise<number>)(n, args, ctx);
      const row = 'approvedRevNo' in n && n.approvedRevNo !== undefined
        ? n
        : await ctx.db.node.findUnique({
          where: { id: n.id },
          select: { approvedRevNo: true, approvedBy: true, approvedByInfo: true, approvedAt: true, approvalHash: true },
        });
      const approval = row ? approvalRecordOf(row as Parameters<typeof approvalRecordOf>[0]) : null;
      return { state: approvalStateOf(approval?.revision ?? null, revision), approval };
    },
  },
  NodeApproval: {
    approvedBy: (a: NodeApprovalRecord, _: unknown, ctx: Context) =>
      a.approvedBy ? resolveRevisionEditor(ctx, [a.approvedBy]) : null,
  },
};
