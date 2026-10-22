import { GraphQLError } from 'graphql';
import type { ApprovalHashFields } from '../../../lib/approvalHash.js';
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
import { memoryAuthorityAnchors } from './installMemory.js';
import { resolveMemoryRef } from '../../../lib/entityRef/memoryRef.js';
import { MemoryNotFoundError } from '../../../lib/asset/gate.js';
import { NodeNotFoundError } from '../../../lib/entityRef/errors.js';
import { sessionKeyCache } from '../../../lib/sessionKeyCache.js';
import type { EncryptionKey } from '../../../lib/crypto.js';
import { editorFromAuth } from '../../../lib/nodeRevisionSnapshot.js';
import { COMMENT_NODE_TYPE } from '../../../lib/comments/index.js';
import { DECISION_FAMILY_WHERE, DECISION_ROLE } from '../../../lib/decisions/index.js';
import { unresolvedFeedbackOf } from '../../../lib/comments/summary.js';
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
import { bootPromptApprovalGate } from '../../../lib/bootPromptApproval.js';

/**
 * #1591 — the approval policy: may this caller approve nodes of this memory?
 * Holger's ruling (#1447 round 3, question 1): any writer of the memory, the
 * author included. The ONE place that decides it, so a later MemoryConfig
 * setting changes it here and nowhere else.
 */
export async function mayApproveNodes(ctx: Context, memoryId: string): Promise<void> {
  await requireMemoryWriteAccess(ctx, memoryId);
}

/**
 * #2043 — the pooled pre-check before an approval's fenced transaction. An
 * install memory's write decision on the pooled client is honoured only as a
 * pre-flight for a door that rechecks inside its own fenced transaction (#2064);
 * both approval doors recheck {@link mayApproveNodes} under
 * `withAuthorizedMemoryTx`, so they may opt in. Without it no App manager could
 * approve anything in an install memory.
 */
function mayApproveNodesPreflight(ctx: Context, memoryId: string): Promise<void> {
  return mayApproveNodes({ ...ctx, installWritePreflight: true }, memoryId);
}

function bootPromptRefusalToGraphQL(error: NodeApprovalRefusal): GraphQLError {
  return new GraphQLError(error.message, { extensions: { code: error.code, op: 'approve' } });
}

const BOOT_PROMPT_REFUSALS = new Set<string>(['BOOT_PROMPT_WORKER_SESSION_REFUSED', 'BOOT_PROMPT_APPROVAL_FORBIDDEN']);

/**
 * #1591 — the mint policy: may this caller mint the nodes of this memory?
 * Holger's ruling (#1447 round 3, question 2a): any writer of the memory. The
 * ONE place that decides it, for a later MemoryConfig setting.
 */
export async function mayMintNodes(ctx: Context, memoryId: string): Promise<void> {
  await requireMemoryWriteAccess(ctx, memoryId);
}

/** E1: no approval-derived hashes for encrypted memories, even with a cached key. */
async function requirePlainApprovalMemory(ctx: Context, memoryId: string): Promise<null> {
  const memory = await ctx.db.memory.findUniqueOrThrow({ where: { id: memoryId }, select: { isEncrypted: true } });
  if (!memory.isEncrypted) return null;
  throw new GraphQLError('Approval and integrity verification are not applicable to encrypted memories.', { extensions: { code: 'ENCRYPTED_MEMORY_NOT_APPLICABLE', memoryId } });
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
  const foreign = [...new Set([...snapshots.values()].flat()
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
    const evidence = (snapshots.get(node.id) ?? []).map(snapshotFields);
    // A snapshot whose key is unavailable is treated as not retained, never hashed as ciphertext.
    return checkNodeIntegrity(node, approvalFieldsOf(node, key), evidence.filter((f): f is ApprovalHashFields => f != null));
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
    const key = await requirePlainApprovalMemory(ctx, memoryId);
    // Pinned to the memory the read gate admitted, and live: a node moved into
    // another memory since the gate must not disclose that memory's loc or a
    // hash of its text (Atilla/Chip, PR #1592).
    const node = await ctx.db.node.findFirst({
      where: { id, memoryId, deletedAt: null },
      select: NODE_APPROVAL_ROW_SELECT,
    });
    if (!node) throw nodeNotFound(nodeRef);
    const [result] = await integrityOf(ctx, memoryId, [node], key);
    return integrityCheckView(ctx, result!, memoryId);
  },

  /** #1591 — the tamper check over every live node of a memory. */
  verifyMemoryNodes: async (_: unknown, { memoryRef }: { memoryRef: string }, ctx: Context) => {
    const { id: memoryId } = await resolveMemoryRef(ctx.db, memoryRef);
    if (!(await isMemoryReadableCached(ctx, memoryId))) throw new MemoryNotFoundError(memoryRef);
    const key = await requirePlainApprovalMemory(ctx, memoryId);
    // #1607 — comments are never approved, so they are outside the tamper
    // check entirely (cor:dmo:110:06), not reported as NOT_APPROVED.
    const nodes = await ctx.db.node.findMany({
      where: { memoryId, deletedAt: null, nodeType: { not: COMMENT_NODE_TYPE } },
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
    // Authorize before looking at key availability, so a reader of an
    // encrypted memory meets FORBIDDEN whether or not a key is cached
    // (@copilot, PR #1592). Re-checked inside the fenced transaction below.
    await mayApproveNodesPreflight(ctx, memoryId);
    await requirePlainApprovalMemory(ctx, memoryId);
    // E1 intentionally never supplies a decryption key to the approval writer.
    const key = null;
    // #2043 (Dara P2-1): an install memory's App/Agent authority in the opening ordered anchor set.
    const authorityAnchors = await memoryAuthorityAnchors(ctx.db, ctx, memoryId);
    try {
      const { node } = await withAuthorizedMemoryTx(
        ctx, memoryId, authorityAnchors,
        async (txCtx) => { await mayApproveNodes(txCtx, memoryId); await requirePlainApprovalMemory(txCtx, memoryId); },
        async (tx, txCtx) => approveNodeInTransaction(tx, id, {
          memoryId, approver: editorFromAuth(ctx), key, expectedRevision: revision,
          bootPromptGate: await bootPromptApprovalGate(txCtx, memoryId),
        }),
      );
      return receiptOf(ctx, node);
    } catch (error) {
      if (error instanceof NodeApprovalRefusal) {
        if (BOOT_PROMPT_REFUSALS.has(error.code)) throw bootPromptRefusalToGraphQL(error);
        throw error.code === 'NODE_NOT_FOUND' ? nodeNotFound(nodeRef) : refusalToGraphQL(error, nodeRef);
      }
      throw error;
    }
  },

  /**
   * #1591 — approve the current revision of every live, UNMINTED node of a
   * memory that isn't approved yet, in one transaction. Placeholders are
   * skipped and reported.
   */
  approveMemoryNodes: async (_: unknown, { memoryRef }: { memoryRef: string }, ctx: Context) => {
    const { id: memoryId } = await resolveMemoryRef(ctx.db, memoryRef);
    await concealUnreadableDenial(ctx, memoryId, memoryRef, () => mayApproveNodesPreflight(ctx, memoryId));
    await requirePlainApprovalMemory(ctx, memoryId);
    // E1 intentionally never supplies a decryption key to the approval writer.
    const key = null;
    // #2043 (Dara P2-1): an install memory's App/Agent authority in the opening ordered anchor set.
    const authorityAnchors = await memoryAuthorityAnchors(ctx.db, ctx, memoryId);
    const outcome = await withAuthorizedMemoryTx(
      ctx, memoryId, authorityAnchors,
      async (txCtx) => { await mayApproveNodes(txCtx, memoryId); await requirePlainApprovalMemory(txCtx, memoryId); },
      async (tx, txCtx) => {
        // #2043 — decided once for the memory, inside this transaction, and applied to each locked row.
        const bootPromptGate = await bootPromptApprovalGate(txCtx, memoryId);
        // Lock in id order, so two bulk approvals cannot deadlock each other.
        // #1591: only unminted nodes are approved in bulk; a minted node's
        // later edits are approved one at a time.
        const ids = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT id FROM nodes WHERE memory_id = ${memoryId} AND deleted_at IS NULL AND minted_at IS NULL
            AND node_type <> ${COMMENT_NODE_TYPE}
            AND NOT (role IS NOT NULL AND (role = ${DECISION_ROLE} OR role LIKE ${`${DECISION_ROLE}.%`}))
          ORDER BY id FOR UPDATE`;
        // #1641 §6.1a — bulk approval never approves a decision or a log: each
        // decision approval is an individual act by one of its deciders. They
        // are skipped and reported (bounded), and never locked here.
        const skippedDecisionCount = await tx.node.count({ where: { memoryId, deletedAt: null, ...DECISION_FAMILY_WHERE } });
        const skippedDecisions = skippedDecisionCount === 0 ? [] : (await tx.node.findMany({
          where: { memoryId, deletedAt: null, ...DECISION_FAMILY_WHERE },
          select: { loc: true },
          orderBy: { loc: 'asc' },
          take: 50,
        })).map((n) => n.loc);
        const approved: NodeApprovalRow[] = [];
        const skippedPlaceholders: string[] = [];
        // #2043 (R30) — placed boot prompts this caller may not approve are skipped and reported.
        const skippedBootPrompts: string[] = [];
        let alreadyApprovedCount = 0;
        const now = new Date();
        for (const { id } of ids) {
          try {
            const result = await approveNodeInTransaction(tx, id, {
              memoryId, approver: editorFromAuth(ctx), key, now, bootPromptGate,
            });
            if (result.approvedNow) approved.push(result.node);
            else alreadyApprovedCount += 1;
          } catch (error) {
            if (!(error instanceof NodeApprovalRefusal)) throw error;
            if (error.code === 'NODE_IS_PLACEHOLDER') {
              const { loc } = await tx.node.findUniqueOrThrow({ where: { id }, select: { loc: true } });
              skippedPlaceholders.push(loc);
            } else if (BOOT_PROMPT_REFUSALS.has(error.code)) {
              const { loc } = await tx.node.findUniqueOrThrow({ where: { id }, select: { loc: true } });
              skippedBootPrompts.push(loc);
            } else {
              throw error;
            }
          }
        }
        // #1607 (cor:dmo:110:07) — open discussion on the nodes in bulk scope,
        // as a warning. Read under the same lock as the approvals it annotates.
        const scoped = await tx.node.findMany({ where: { id: { in: ids.map((r) => r.id) } }, select: { id: true, loc: true } });
        const unresolvedFeedback = (await unresolvedFeedbackOf(tx, scoped)).map((f) => ({ ...f, memoryId }));
        return { approved, skippedPlaceholders, skippedBootPrompts, alreadyApprovedCount, unresolvedFeedback, skippedDecisionCount, skippedDecisions };
      },
      { timeout: 120_000 },
    );
    const byLoc = (a: { loc: string }, b: { loc: string }) => (a.loc < b.loc ? -1 : a.loc > b.loc ? 1 : 0);
    return {
      approvedCount: outcome.approved.length,
      approved: await Promise.all([...outcome.approved].sort(byLoc).map((n) => receiptOf(ctx, n))),
      alreadyApprovedCount: outcome.alreadyApprovedCount,
      skippedPlaceholders: outcome.skippedPlaceholders.sort(),
      skippedDecisionCount: outcome.skippedDecisionCount,
      skippedDecisions: outcome.skippedDecisions,
      skippedBootPromptCount: outcome.skippedBootPrompts.length,
      skippedBootPrompts: outcome.skippedBootPrompts.sort().slice(0, 50),
      unresolvedFeedback: outcome.unresolvedFeedback,
    };
  },
};

const MINT_SELECT = {
  mintedAt: true, mintedBy: true, mintedByInfo: true, mintedRevNo: true, mintedHash: true,
} as const;

type MintParent = { id: string } & Partial<{
  mintedAt: Date | null;
  mintedBy: string | null;
  mintedByInfo: string | null;
  mintedRevNo: number | null;
  mintedHash: string | null;
}>;

/** The NodeMintStatus projection of a node's mint columns. */
function mintStatusOf(row: Required<Omit<MintParent, 'id'>> | null) {
  if (!row?.mintedAt) {
    return { minted: false, mintedAt: null, mintedBy: null, mintedByInfo: null, revision: null, hash: null };
  }
  return {
    minted: true,
    mintedAt: row.mintedAt,
    mintedBy: row.mintedBy,
    mintedByInfo: row.mintedByInfo,
    revision: row.mintedRevNo,
    hash: row.mintedHash,
  };
}

type ApprovalParent = { id: string; revSeq: number; memoryId?: string } & Partial<Pick<NodeApprovalRow,
  'approvedRevNo' | 'contentRevSeq' | 'approvedBy' | 'approvedByInfo' | 'approvedAt' | 'approvalHash'>>;

const APPROVAL_SELECT = {
  approvedRevNo: true, contentRevSeq: true, approvedBy: true, approvedByInfo: true, approvedAt: true, approvalHash: true,
} as const;

type StatusColumns = 'approval' | 'mint';
type ColumnRow = Record<string, unknown> & { id: string; memoryId: string };
type ColumnBatch = { pending: Map<string, Array<(row: ColumnRow | null) => void>>; failures: Array<(e: unknown) => void> };
const columnBatches = new WeakMap<Context, Map<StatusColumns, ColumnBatch>>();

/**
 * #1596 — the approval/mint columns of a node whose GraphQL parent was
 * selected without them. Every miss of one KIND (approval or mint) in one
 * tick of a request shares ONE `findMany`: a page asking for both statuses
 * costs one fallback query per kind, not one per node. A later tick opens a
 * new batch, never joining a flushed one. This bounds only the column
 * fallback: an approved node's `approvalStatus` still runs the per-node
 * `Node.revision` reconcile.
 *
 * Pinned to the parent's memory when the parent carries it: a node moved to
 * another memory after the page was gated reads as having no record rather
 * than disclosing the new home's columns (the post-gate re-read rule,
 * `findings:post-gate-reread-pinned-to-gated-memory-and-live-row`). Soft-deleted
 * rows are deliberately NOT excluded: a trash read still shows its status,
 * exactly as the per-node `findUnique` this replaces did.
 */
function loadStatusColumns(ctx: Context, kind: StatusColumns, id: string, memoryId: string | undefined): Promise<ColumnRow | null> {
  let byKind = columnBatches.get(ctx);
  if (!byKind) {
    byKind = new Map();
    columnBatches.set(ctx, byKind);
  }
  let batch = byKind.get(kind);
  if (!batch) {
    const fresh: ColumnBatch = { pending: new Map(), failures: [] };
    batch = fresh;
    byKind.set(kind, fresh);
    setImmediate(() => {
      byKind!.delete(kind);
      void flushStatusColumns(ctx, kind, fresh);
    });
  }
  const target = batch;
  return new Promise<ColumnRow | null>((resolve, reject) => {
    const waiters = target.pending.get(id) ?? [];
    waiters.push(resolve);
    target.pending.set(id, waiters);
    target.failures.push(reject);
  }).then((row) => (row && memoryId !== undefined && row.memoryId !== memoryId ? null : row));
}

async function flushStatusColumns(ctx: Context, kind: StatusColumns, batch: ColumnBatch): Promise<void> {
  try {
    const rows = await ctx.db.node.findMany({
      where: { id: { in: [...batch.pending.keys()] } },
      select: { id: true, memoryId: true, ...(kind === 'approval' ? APPROVAL_SELECT : MINT_SELECT) },
    });
    const byId = new Map(rows.map((r) => [r.id, r as ColumnRow]));
    for (const [id, waiters] of batch.pending) for (const resolve of waiters) resolve(byId.get(id) ?? null);
  } catch (error) {
    for (const reject of batch.failures) reject(error);
  }
}

/**
 * #1856 — one tick of keyed lookups for a request, flushed in ONE query. The same shape as
 * {@link loadStatusColumns}: keyed on the request's Context, opened on the first key, flushed on the next
 * macrotask, and DELETED at flush. Nothing survives the tick: a later call opens a fresh batch and reads
 * the database again, so no answer is reused across ticks, let alone across requests (the issue's
 * guard). A failed flush rejects every waiter; nothing falls back to a default.
 */
type TickBatch<V> = { pending: Map<string, Array<(v: V) => void>>; failures: Array<(e: unknown) => void> };

function tickLoad<V>(
  registry: WeakMap<Context, TickBatch<V>>,
  ctx: Context,
  key: string,
  flush: (keys: string[]) => Promise<Map<string, V>>,
  absent: V,
): Promise<V> {
  let batch = registry.get(ctx);
  if (!batch) {
    const fresh: TickBatch<V> = { pending: new Map(), failures: [] };
    batch = fresh;
    registry.set(ctx, fresh);
    setImmediate(() => {
      registry.delete(ctx);
      flush([...fresh.pending.keys()]).then(
        (found) => {
          for (const [k, waiters] of fresh.pending) for (const resolve of waiters) resolve(found.has(k) ? found.get(k)! : absent);
        },
        (error) => {
          for (const reject of fresh.failures) reject(error);
        },
      );
    });
  }
  const target = batch;
  return new Promise<V>((resolve, reject) => {
    const waiters = target.pending.get(key) ?? [];
    waiters.push(resolve);
    target.pending.set(key, waiters);
    target.failures.push(reject);
  });
}

const encryptedBatches = new WeakMap<Context, TickBatch<boolean>>();

/**
 * Read the memory state rather than trusting decrypted parent projections. #1856: batched per request,
 * so a page asking both status fields pays one memory query, plus one node query for the parents
 * selected without their memoryId, instead of about two per node. Both steps run in the SAME flush, so a
 * page that mixes the two parent shapes still pays one memory query. The flag is always the STORED
 * `memory.isEncrypted`, never a field on the parent; a missing node or memory reads as not encrypted,
 * exactly as the per-node lookups this replaces did.
 */
function encryptedStatusParent(ctx: Context, n: { id: string; memoryId?: string }): Promise<boolean> {
  const key = n.memoryId ? `m:${n.memoryId}` : `n:${n.id}`;
  return tickLoad(encryptedBatches, ctx, key, async (keys) => {
    const nodeIds = keys.filter((k) => k.startsWith('n:')).map((k) => k.slice(2));
    const memoryOfNode = new Map<string, string>();
    if (nodeIds.length > 0) {
      const rows = await ctx.db.node.findMany({ where: { id: { in: nodeIds } }, select: { id: true, memoryId: true } });
      for (const r of rows) memoryOfNode.set(r.id, r.memoryId);
    }
    const memoryIds = new Set([
      ...keys.filter((k) => k.startsWith('m:')).map((k) => k.slice(2)),
      ...memoryOfNode.values(),
    ]);
    const encrypted = new Set<string>();
    if (memoryIds.size > 0) {
      const rows = await ctx.db.memory.findMany({ where: { id: { in: [...memoryIds] } }, select: { id: true, isEncrypted: true } });
      for (const r of rows) if (r.isEncrypted === true) encrypted.add(r.id);
    }
    const out = new Map<string, boolean>();
    for (const k of keys) {
      const memoryId = k.startsWith('m:') ? k.slice(2) : memoryOfNode.get(k.slice(2));
      out.set(k, memoryId !== undefined && encrypted.has(memoryId));
    }
    return out;
  }, false);
}

export const nodeApprovalFieldResolvers = {
  Node: {
    /**
     * #1591 — whether the node's current revision is approved. Compared with
     * the RECONCILED revision (`Node.revision`), so a node changed outside a
     * revisioned writer never reads as approved.
     *
     * #1596: a node with no approval is NOT_APPROVED at every revision, so the
     * reconcile (a locking transaction per node) runs only when there is an
     * approval to compare. That keeps a list page of mostly unapproved nodes
     * from paying one transaction per row.
     */
    approvalStatus: async (n: ApprovalParent, args: unknown, ctx: Context) => {
      if (await encryptedStatusParent(ctx, n)) return { state: 'NOT_APPLICABLE', approval: null };
      const row = 'approvedRevNo' in n && n.approvedRevNo !== undefined && n.contentRevSeq !== undefined
        ? n
        : await loadStatusColumns(ctx, 'approval', n.id, n.memoryId);
      const approval = row ? approvalRecordOf(row as Parameters<typeof approvalRecordOf>[0]) : null;
      if (approval?.revision == null) return { state: 'NOT_APPROVED' as const, approval };
      // Reconcile first: an out-of-band change moves the content boundary
      // (#1611), so a reconcile that ran here makes the columns read above stale.
      const revision = await (typeResolvers.Node.revision as (p: unknown, a: unknown, c: Context) => Promise<number>)(n, args, ctx);
      const current = revision === n.revSeq
        ? row
        : await loadStatusColumns(ctx, 'approval', n.id, n.memoryId);
      const currentApproval = current ? approvalRecordOf(current as Parameters<typeof approvalRecordOf>[0]) : approval;
      return {
        state: approvalStateOf({
          approvedRevNo: currentApproval?.revision ?? null,
          contentRevSeq: (current?.contentRevSeq as number | undefined) ?? Number.MAX_SAFE_INTEGER,
        }),
        approval: currentApproval,
      };
    },
    /** #1591 — whether the node is minted, and the record of it. */
    mintStatus: async (n: MintParent & { memoryId?: string }, _: unknown, ctx: Context) => {
      if (await encryptedStatusParent(ctx, n)) return mintStatusOf(null);
      const row = n.mintedAt !== undefined
        ? n
        : await loadStatusColumns(ctx, 'mint', n.id, n.memoryId);
      return mintStatusOf(row as Required<Omit<MintParent, 'id'>> | null);
    },
  },
  NodeApproval: {
    approvedBy: (a: NodeApprovalRecord, _: unknown, ctx: Context) =>
      a.approvedBy ? resolveRevisionEditor(ctx, [a.approvedBy]) : null,
  },
  NodeMintStatus: {
    mintedBy: (m: { mintedBy: string | null }, _: unknown, ctx: Context) =>
      m.mintedBy ? resolveRevisionEditor(ctx, [m.mintedBy]) : null,
  },
};
