import type { Prisma, PrismaClient } from '../generated/prisma/index.js';
import { COMMENT_NODE_TYPE } from './comments/index.js';
import { DECISION_LOG_ROLE, isDecisionFamilyRole } from './decisions/index.js';
import { computeApprovalHash, type ApprovalHashFields } from './approvalHash.js';
import type { EncryptionKey } from './crypto.js';
import { decryptNodeFieldsWithKey } from './nodeCrypto.js';
import { ensureCurrentNodeRevisionInTransaction, type SnapshotEditor } from './nodeRevisionSnapshot.js';

/**
 * #1591 — node approvals: approving a node's CURRENT revision, and the state
 * and integrity reads built on it.
 *
 * The approval of record lives on `Node` (`approvedRevNo` … `approvalHash`):
 * the live revision has no `NodeRevision` row, and revision rows can be pruned
 * or deleted. When an approved revision is edited away, the revision snapshot
 * copies the approval onto its row (`createNodeRevision`), so history keeps it.
 *
 * Who may approve is decided by the caller's policy function
 * (`mayApproveNodes`), not here.
 */

/** Whether the node's current revision is approved (contract on #1591). */
export type NodeApprovalState = 'NOT_APPROVED' | 'APPROVED' | 'SUPERSEDED';

/** Outcome of the tamper check. */
export type NodeIntegrityState = 'INTACT' | 'TAMPERED' | 'SUPERSEDED' | 'NOT_APPROVED';

/** The node columns an approval reads and writes. */
export interface NodeApprovalRow {
  id: string;
  memoryId: string;
  loc: string;
  name: string;
  abstract: string | null;
  content: string | null;
  isPlaceholder: boolean;
  revSeq: number;
  approvedRevNo: number | null;
  approvedBy: string | null;
  approvedByInfo: string | null;
  approvedAt: Date | null;
  approvalHash: string | null;
}

/** Prisma `select` for {@link NodeApprovalRow}. */
export const NODE_APPROVAL_ROW_SELECT = {
  id: true,
  memoryId: true,
  loc: true,
  name: true,
  abstract: true,
  content: true,
  isPlaceholder: true,
  revSeq: true,
  approvedRevNo: true,
  approvedBy: true,
  approvedByInfo: true,
  approvedAt: true,
  approvalHash: true,
} as const satisfies Prisma.NodeSelect;

/** A recorded approval, as the API presents it. */
export interface NodeApprovalRecord {
  revision: number;
  approvedBy: string | null;
  approvedByInfo: string | null;
  approvedAt: Date;
  hash: string;
}

/** The latest approval held on the node, or null when it was never approved. */
export function approvalRecordOf(node: Pick<NodeApprovalRow,
  'approvedRevNo' | 'approvedBy' | 'approvedByInfo' | 'approvedAt' | 'approvalHash'>): NodeApprovalRecord | null {
  if (node.approvedRevNo == null || node.approvedAt == null || node.approvalHash == null) return null;
  return {
    revision: node.approvedRevNo,
    approvedBy: node.approvedBy,
    approvedByInfo: node.approvedByInfo,
    approvedAt: node.approvedAt,
    hash: node.approvalHash,
  };
}

/** Approval state of `revision` given the node's latest approval. */
export function approvalStateOf(approvedRevNo: number | null, revision: number): NodeApprovalState {
  if (approvedRevNo == null) return 'NOT_APPROVED';
  return approvedRevNo === revision ? 'APPROVED' : 'SUPERSEDED';
}

/**
 * The hashed fields of a node, decrypted when its memory is encrypted. `key`
 * must be supplied for an encrypted memory; the caller refuses without one.
 */
export function approvalFieldsOf(
  node: { name: string; abstract: string | null; content: string | null },
  key: EncryptionKey | null,
): ApprovalHashFields {
  const plain = key
    ? decryptNodeFieldsWithKey({ abstract: node.abstract, content: node.content }, key)
    : { abstract: node.abstract, content: node.content };
  return { title: node.name, abstract: plain.abstract ?? null, content: plain.content ?? null };
}

/** Why an approval was refused. The resolver maps each to its GraphQL code. */
export class NodeApprovalRefusal extends Error {
  constructor(
    readonly code:
      | 'NODE_NOT_FOUND'
      | 'NODE_IS_PLACEHOLDER'
      | 'REVISION_MISMATCH'
      | 'COMMENT_NOT_APPROVABLE'
      | 'DECISION_NOT_APPROVABLE'
      | 'DECISION_LOG_NOT_APPROVABLE',
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

/**
 * Approve one node's current revision inside the caller's transaction.
 *
 * Locks the node and reconciles any out-of-band change first (#1323), so the
 * revision number and the hashed text are read together under the lock: an
 * edit that commits first is what gets approved (or refused, when
 * `expectedRevision` names the older one), and an edit that waits commits as a
 * new, unapproved revision. Approving an already approved revision returns the
 * existing approval unchanged.
 *
 * @returns the node row after approval and whether this call recorded it.
 * @throws NodeApprovalRefusal for a node that moved out of `memoryId`, a
 *   placeholder, or a revision mismatch.
 */
export async function approveNodeInTransaction(
  tx: Prisma.TransactionClient,
  nodeId: string,
  opts: {
    memoryId: string;
    approver: SnapshotEditor;
    key: EncryptionKey | null;
    expectedRevision?: number | null;
    now?: Date;
  },
): Promise<{ node: NodeApprovalRow; approvedNow: boolean }> {
  const revision = await ensureCurrentNodeRevisionInTransaction(tx, nodeId, { expectedMemoryId: opts.memoryId });
  if (revision == null) throw new NodeApprovalRefusal('NODE_NOT_FOUND', 'Node not found');
  // Re-read under the lock, pinned to the authorized memory and to a LIVE row:
  // a soft delete that committed while this waited must not get an approval
  // stamped on its tombstone (Atilla/Chip, PR #1592).
  const locked = await tx.node.findFirst({
    where: { id: nodeId, memoryId: opts.memoryId, deletedAt: null },
    select: { ...NODE_APPROVAL_ROW_SELECT, updatedAt: true, nodeType: true, role: true },
  });
  if (!locked) throw new NodeApprovalRefusal('NODE_NOT_FOUND', 'Node not found');
  const { updatedAt, nodeType, role, ...node } = locked;
  // #1641 §6.1a — a log holds settings, not a decision, and is never approved
  // (Baloo P3-4). A decision is approved only by one of its deciders, through
  // the per-node predicate that lands with answering (slice S2); until then no
  // path approves one, so a memory writer cannot pre-stamp a decision.
  if (role === DECISION_LOG_ROLE) {
    throw new NodeApprovalRefusal('DECISION_LOG_NOT_APPROVABLE', 'A decision log holds settings, not a decision; it is never approved.');
  }
  if (isDecisionFamilyRole(role)) {
    throw new NodeApprovalRefusal('DECISION_NOT_APPROVABLE', 'A decision is approved only by one of its deciders, which is not available yet.');
  }
  // #1607 (cor:dmo:110:06) — a comment is never approved. Refused before the
  // revision check, so the answer does not depend on which revision was named.
  if (nodeType === COMMENT_NODE_TYPE) {
    throw new NodeApprovalRefusal('COMMENT_NOT_APPROVABLE', 'A comment is feedback, never approved or minted.');
  }
  if (opts.expectedRevision != null && opts.expectedRevision !== node.revSeq) {
    throw new NodeApprovalRefusal(
      'REVISION_MISMATCH',
      `Revision ${opts.expectedRevision} is no longer current; the node is at revision ${node.revSeq}.`,
      { expected: opts.expectedRevision, current: node.revSeq },
    );
  }
  if (node.isPlaceholder) {
    throw new NodeApprovalRefusal('NODE_IS_PLACEHOLDER', 'A reserved placeholder has no spec to approve yet.');
  }
  if (node.approvedRevNo === node.revSeq) return { node, approvedNow: false };

  const approved = await tx.node.update({
    where: { id: nodeId },
    data: {
      approvedRevNo: node.revSeq,
      approvedBy: opts.approver.userId ?? null,
      approvedByInfo: opts.approver.userId ? null : opts.approver.info ?? 'unknown',
      approvedAt: opts.now ?? new Date(),
      approvalHash: computeApprovalHash(approvalFieldsOf(node, opts.key)),
      // An approval is not an authoring change: it must not move the
      // node's "last updated" time, which filters and sync read.
      updatedAt,
    },
    select: NODE_APPROVAL_ROW_SELECT,
  });
  return { node: approved, approvedNow: true };
}

/** One node's tamper-check result. */
export interface NodeIntegrityResult {
  nodeId: string;
  loc: string;
  state: NodeIntegrityState;
  revision: number;
  approvedRevision: number | null;
  expectedHash: string | null;
  actualHash: string;
}

/**
 * The tamper check for one node: recompute the approval hash and compare.
 *
 * - The current revision is approved: INTACT when the live text still hashes
 *   to the approval, TAMPERED when it does not (it changed without a revision).
 * - Approved earlier, edited since: SUPERSEDED, unless the retained snapshot of
 *   the APPROVED revision no longer hashes to its approval. That snapshot is
 *   the approved revision's last state, so a mismatch means the approved text
 *   was altered before the revision advanced. This is exactly what a #1323
 *   reconcile records after a direct database write, so the finding survives
 *   a read that reconciled it. A pruned snapshot leaves SUPERSEDED.
 *
 * Pure read. `snapshotFields` supplies the approved revision's decrypted
 * snapshot when one is retained.
 */
export function checkNodeIntegrity(
  node: NodeApprovalRow,
  liveFields: ApprovalHashFields,
  approvedSnapshotFields: ApprovalHashFields | null,
): NodeIntegrityResult {
  const actualHash = computeApprovalHash(liveFields);
  const base = {
    nodeId: node.id,
    loc: node.loc,
    revision: node.revSeq,
    approvedRevision: node.approvedRevNo,
    expectedHash: node.approvalHash,
    actualHash,
  };
  if (node.approvedRevNo == null || node.approvalHash == null) return { ...base, state: 'NOT_APPROVED' };
  if (node.approvedRevNo === node.revSeq) {
    return { ...base, state: actualHash === node.approvalHash ? 'INTACT' : 'TAMPERED' };
  }
  if (approvedSnapshotFields && computeApprovalHash(approvedSnapshotFields) !== node.approvalHash) {
    return { ...base, state: 'TAMPERED' };
  }
  return { ...base, state: 'SUPERSEDED' };
}

/**
 * Load the retained snapshots of each node's APPROVED revision, keyed by node
 * id, for {@link checkNodeIntegrity}. Only nodes edited since approval need
 * one. Rows are returned at rest; the caller decrypts.
 */
export async function loadApprovedSnapshots(
  db: Pick<PrismaClient, 'nodeRevision'> | Prisma.TransactionClient,
  nodes: Array<Pick<NodeApprovalRow, 'id' | 'approvedRevNo' | 'revSeq'>>,
): Promise<Map<string, { memoryId: string | null; name: string; abstract: string | null; content: string | null }>> {
  const wanted = nodes.filter((n) => n.approvedRevNo != null && n.approvedRevNo !== n.revSeq);
  if (wanted.length === 0) return new Map();
  const rows = await db.nodeRevision.findMany({
    where: { OR: wanted.map((n) => ({ nodeId: n.id, revNo: n.approvedRevNo! })) },
    select: { nodeId: true, memoryId: true, name: true, abstract: true, content: true },
  });
  return new Map(rows.map((r) => [r.nodeId, r]));
}

/**
 * #1591 — the `NodeFilter.approvalState` predicate as Prisma `where`. The
 * comparison is between two columns, so it needs the client's field
 * reference for `revSeq`.
 */
export function approvalStatePrismaWhere(
  state: NodeApprovalState | null | undefined,
  db: Pick<PrismaClient, 'node'>,
): Prisma.NodeWhereInput {
  if (state == null) return {};
  if (state === 'NOT_APPROVED') return { approvedRevNo: null };
  // A NULL approvedRevNo compares as unknown, so both column predicates
  // already exclude never-approved nodes.
  return state === 'APPROVED'
    ? { approvedRevNo: { equals: db.node.fields.revSeq } }
    : { approvedRevNo: { lt: db.node.fields.revSeq } };
}

/** #1591 — the `NodeFilter.approvalState` predicate as SQL over `nodes` (no parameters). */
export function approvalStateSql(state: NodeApprovalState | null | undefined): string | null {
  if (state == null) return null;
  if (state === 'NOT_APPROVED') return 'approved_rev_no IS NULL';
  return state === 'APPROVED' ? 'approved_rev_no = rev_seq' : 'approved_rev_no < rev_seq';
}
