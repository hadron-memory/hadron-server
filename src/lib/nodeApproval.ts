import type { Prisma, PrismaClient } from '../generated/prisma/index.js';
import { COMMENT_NODE_TYPE } from './comments/index.js';
import { DECISION_LOG_ROLE, isDecisionFamilyRole } from './decisions/index.js';
import { computeApprovalHash, type ApprovalHashFields } from './approvalHash.js';
import type { EncryptionKey } from './crypto.js';
import { decryptNodeFieldsWithKey } from './nodeCrypto.js';
import { ensureCurrentNodeRevisionInTransaction, RECONCILE_EDITOR_INFO, type SnapshotEditor } from './nodeRevisionSnapshot.js';
import { COMPILED_BOOT_PROMPT_NODE_TYPE, boundWorkerId, isBootPromptRole } from './bootPrompt.js';
import { findBatchGrant } from './grants/bootPromptGrant.js';
import { BOOT_PROMPT_APPROVAL_MESSAGES, type BootPromptApprovalGate, type BootPromptApprovalRefusalCode } from './bootPromptApproval.js';

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
export type NodeApprovalState = 'NOT_APPROVED' | 'APPROVED' | 'SUPERSEDED' | 'NOT_APPLICABLE';

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
  /** #1611 — the revision at which the hashed fields last changed through a sanctioned writer. */
  contentRevSeq: number;
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
  contentRevSeq: true,
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

/**
 * Whether the node's latest approval still covers its current text (#1611,
 * cor:dmo:120:04): the hashed fields have not changed since the revision the
 * approval was recorded at. Metadata-only revisions advance `revSeq` but not
 * `contentRevSeq`, so they leave it valid.
 */
export function approvalHoldsFor(
  node: Pick<NodeApprovalRow, 'approvedRevNo' | 'contentRevSeq'> & { approvalHash?: string | null },
): boolean {
  // #1838: an approval ended on entering an encrypted memory keeps who/when/
  // revision but has no hash (explicit null), and covers nothing.
  if (node.approvalHash === null) return false;
  return node.approvedRevNo != null && node.contentRevSeq <= node.approvedRevNo;
}

/** Approval state of the current text given the node's latest approval. */
export function approvalStateOf(
  node: Pick<NodeApprovalRow, 'approvedRevNo' | 'contentRevSeq'> & { approvalHash?: string | null },
): NodeApprovalState {
  if (node.approvedRevNo == null || node.approvalHash === null) return 'NOT_APPROVED';
  return approvalHoldsFor(node) ? 'APPROVED' : 'SUPERSEDED';
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
      | 'DECISION_LOG_NOT_APPROVABLE'
      | BootPromptApprovalRefusalCode,
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
    /** #2043 — the caller's boot-prompt approval decision for this memory (bootPromptApprovalGate). Required: no caller skips it. */
    bootPromptGate: BootPromptApprovalGate;
    /**
     * #3823 (Andi P2): whether the session behind this call has the standing a batch grant presupposes: a person's user behind it
     * and no App key, the same shape the batch COMPILE requires. Absent means false, so a caller that does not say never lifts.
     */
    workerSessionMayUseBatch?: boolean;
  },
): Promise<{ node: NodeApprovalRow; approvedNow: boolean }> {
  // #2043 (R30, cor:agt:040:18) — judged on the LOCKED row, before the revision
  // reconcile below can write anything: a refusal changes nothing.
  const gate = opts.bootPromptGate;
  let approver = opts.approver;
  if (gate.placed && gate.refusal) {
    const [row] = await tx.$queryRaw<Array<{ id: string; memory_id: string; loc: string; role: string | null; node_type: string | null }>>`
      SELECT id, memory_id, loc, role, node_type FROM nodes WHERE id = ${nodeId} AND memory_id = ${opts.memoryId} AND deleted_at IS NULL FOR UPDATE`;
    if (row && isBootPromptRole(row.role)) {
      // #3823 (ruling 0267, cor:agt:040:18 r9, R30's one exception): a worker session approves a COMPILED prompt only under a live
      // batch grant that names it. The approval is recorded as the worker's, never as its holder's, and it never signs.
      const workerId = boundWorkerId();
      const batchGrantId = gate.refusal === 'BOOT_PROMPT_WORKER_SESSION_REFUSED' && workerId && opts.workerSessionMayUseBatch === true && row.node_type === COMPILED_BOOT_PROMPT_NODE_TYPE
        ? await findBatchGrant(tx, workerId, { id: row.id, memoryId: row.memory_id, loc: row.loc }, true)
        : null;
      if (!batchGrantId) throw new NodeApprovalRefusal(gate.refusal, BOOT_PROMPT_APPROVAL_MESSAGES[gate.refusal], { op: 'approve' });
      // The record names the grant that admitted it (no USE event: a batch grant has no use count).
      approver = { userId: null, info: `worker:${workerId} (batch grant ${batchGrantId})` } as typeof opts.approver;
    }
  }
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
  // Still valid (#1611): the text is unchanged since the approval, so the
  // approval of record stays as it was recorded, at its own revision.
  if (approvalHoldsFor(node)) return { node, approvedNow: false };

  const approved = await tx.node.update({
    where: { id: nodeId },
    data: {
      approvedRevNo: node.revSeq,
      approvedBy: approver.userId ?? null,
      approvedByInfo: approver.userId ? null : approver.info ?? 'unknown',
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
 * - The approval still covers the text (no content change since it was
 *   recorded; metadata-only revisions do not count): INTACT when the live text
 *   still hashes to the approval, TAMPERED when it does not (it changed
 *   without a revision).
 * - Approved earlier, content edited since: SUPERSEDED, unless the retained snapshot of
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
  node: Pick<NodeApprovalRow, 'id' | 'loc' | 'revSeq' | 'contentRevSeq' | 'approvedRevNo' | 'approvalHash'>,
  liveFields: ApprovalHashFields,
  approvedSnapshotFields: ApprovalHashFields | ApprovalHashFields[] | null,
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
  // The text is unchanged since the approval (#1611): a recomputed hash that no
  // longer matches means it changed outside the revision system, whatever
  // metadata revisions have happened since. Never relabeled as merely superseded.
  if (approvalHoldsFor(node)) {
    return { ...base, state: actualHash === node.approvalHash ? 'INTACT' : 'TAMPERED' };
  }
  const evidence = approvedSnapshotFields == null ? [] : Array.isArray(approvedSnapshotFields) ? approvedSnapshotFields : [approvedSnapshotFields];
  if (evidence.some((fields) => computeApprovalHash(fields) !== node.approvalHash)) {
    return { ...base, state: 'TAMPERED' };
  }
  return { ...base, state: 'SUPERSEDED' };
}

/**
 * Load the retained evidence {@link checkNodeIntegrity} compares to each
 * approval, keyed by node id: the snapshot of the APPROVED revision, plus every
 * reconcile-authored snapshot (#1323) from that revision up to the revision the
 * content last changed at (#1611). A reconcile snapshot is the state found
 * after a write outside the revision system, so one that no longer hashes to
 * the approval keeps the finding TAMPERED after later metadata revisions and
 * after a content edit that superseded it. Only nodes whose approval no longer
 * covers the text need any. Rows are returned at rest; the caller decrypts.
 */
export async function loadApprovedSnapshots(
  db: Pick<PrismaClient, 'nodeRevision'> | Prisma.TransactionClient,
  nodes: Array<Pick<NodeApprovalRow, 'id' | 'approvedRevNo' | 'contentRevSeq'>>,
): Promise<Map<string, Array<{ memoryId: string | null; name: string; abstract: string | null; content: string | null }>>> {
  const wanted = nodes.filter((n) => n.approvedRevNo != null && !approvalHoldsFor(n));
  if (wanted.length === 0) return new Map();
  const rows = await db.nodeRevision.findMany({
    where: {
      OR: wanted.flatMap((n) => [
        { nodeId: n.id, revNo: n.approvedRevNo! },
        { nodeId: n.id, editedByInfo: RECONCILE_EDITOR_INFO, revNo: { gte: n.approvedRevNo!, lt: n.contentRevSeq } },
      ]),
    },
    select: { nodeId: true, memoryId: true, name: true, abstract: true, content: true },
  });
  const byNode = new Map<string, Array<(typeof rows)[number]>>();
  for (const r of rows) byNode.set(r.nodeId, [...(byNode.get(r.nodeId) ?? []), r]);
  return byNode;
}

/**
 * #1591 — the `NodeFilter.approvalState` predicate as Prisma `where`. The
 * comparison is between two columns, so it needs the client's field
 * reference for `contentRevSeq` (#1611).
 */
export function approvalStatePrismaWhere(
  state: NodeApprovalState | null | undefined,
  db: Pick<PrismaClient, 'node'>,
): Prisma.NodeWhereInput {
  if (state == null) return {};
  if (state === 'NOT_APPLICABLE') return { memory: { isEncrypted: true } };
  const memory = { isEncrypted: false };
  if (state === 'NOT_APPROVED') return { memory, OR: [{ approvedRevNo: null }, { approvalHash: null }] };
  if (state === 'APPROVED') return { memory, approvalHash: { not: null }, approvedRevNo: { gte: db.node.fields.contentRevSeq } };
  if (state === 'SUPERSEDED') return { memory, approvalHash: { not: null }, approvedRevNo: { lt: db.node.fields.contentRevSeq } };
  return { id: { in: [] } }; // Unknown wire values grant no approved matches.
}

/** Approval filters consult the current memory state, including retained records. */
export function approvalStateSql(state: NodeApprovalState | null | undefined): string | null {
  if (state == null) return null;
  const encrypted = 'EXISTS (SELECT 1 FROM memories approval_memory WHERE approval_memory.id = nodes.memory_id AND approval_memory.is_encrypted)';
  if (state === 'NOT_APPLICABLE') return encrypted;
  // #1838: a hashless record (approval ended on encrypted entry) is no approval.
  const predicate = state === 'NOT_APPROVED' ? '(approved_rev_no IS NULL OR approval_hash IS NULL)'
    : state === 'APPROVED' ? '(approval_hash IS NOT NULL AND approved_rev_no >= content_rev_seq)'
    : state === 'SUPERSEDED' ? '(approval_hash IS NOT NULL AND approved_rev_no < content_rev_seq)' : 'FALSE';
  return `(NOT ${encrypted} AND ${predicate})`;
}

/** Mint status is inapplicable in encrypted memories, regardless of retained columns. */
export function mintedPrismaWhere(minted: boolean | null | undefined): Prisma.NodeWhereInput {
  if (minted == null) return {};
  return minted
    ? { memory: { isEncrypted: false }, mintedAt: { not: null } }
    : { OR: [{ memory: { isEncrypted: true } }, { mintedAt: null }] };
}

export function mintedSql(minted: boolean | null | undefined): string | null {
  if (minted == null) return null;
  const encrypted = 'EXISTS (SELECT 1 FROM memories mint_memory WHERE mint_memory.id = nodes.memory_id AND mint_memory.is_encrypted)';
  return minted ? `(NOT ${encrypted} AND minted_at IS NOT NULL)` : `(${encrypted} OR minted_at IS NULL)`;
}

/** Whether a revision was approved, and by which recorded approval (#1838). */
export interface RevisionApproval {
  /** NOT_APPLICABLE inside an encrypted memory (cor:dmo:120:00): nothing is read. */
  state: 'APPROVED' | 'NOT_APPROVED' | 'NOT_APPLICABLE';
  /** The covering record, with the revision it was recorded at. Null unless APPROVED. */
  record: NodeApprovalRecord | null;
  /**
   * Only when APPROVED: the exact content this verdict hashed, and the memory that captured it. An include serves
   * THIS text, so what is served is what qualified; it never re-reads the revision after the verdict (#2041).
   */
  served?: { content: string | null; memoryId: string };
}

const NOT_APPROVED_REVISION: RevisionApproval = { state: 'NOT_APPROVED', record: null };

/**
 * #1838 (cor:dmo:060:04, Holger's R7) — was revision `revNo` of the node
 * approved? Yes when some recorded approval covers exactly its hashed content,
 * whichever revision the approval was recorded on. The records are the
 * `NodeRevision` rows' copied approvals plus the node's current one, and no
 * table was added for them.
 *
 * A record counts only while the text it hashed still hashes to it (an altered
 * snapshot or live row is not an approval, and stays the integrity check's to
 * report), only from the same capture memory as the revision asked about (a
 * node moved across memories discloses nothing across them), and only with a
 * hash (an approval ended on encrypted entry has none). A legacy row with no
 * `revNo` can be neither pinned nor a record. This is a per-revision read: it
 * deliberately does not change what `Node.approvalStatus` says about the live
 * revision (#1611).
 *
 * Pure read; `db` may be a transaction client.
 */
export async function revisionApprovalOf(
  db: Pick<PrismaClient, 'node' | 'nodeRevision' | 'memory'> | Prisma.TransactionClient,
  nodeId: string,
  revNo: number,
  /** #40: a resolved read's budget. Every query is charged before it runs and every loaded text after. */
  meter?: ApprovalReadMeter,
  /**
   * #40: the one memory the caller may serve a revision from. A revision captured anywhere else
   * answers NOT_APPROVED before any of its text is charged, so whether such a row exists, and how large it is,
   * never changes what the reader sees. Unset keeps the full verdict for callers that judge any capture.
   */
  servableFrom?: string,
): Promise<RevisionApproval> {
  meter?.chargeLookup();
  const live = await db.node.findUnique({
    where: { id: nodeId },
    select: {
      memoryId: true, name: true, abstract: true, content: true, revSeq: true, contentRevSeq: true,
      approvedRevNo: true, approvedBy: true, approvedByInfo: true, approvedAt: true, approvalHash: true,
    },
  });
  if (!live) return NOT_APPROVED_REVISION;
  chargeTexts(meter, live);
  meter?.chargeLookup();
  const target = await db.nodeRevision.findFirst({
    where: { nodeId, revNo },
    select: {
      memoryId: true, name: true, abstract: true, content: true,
      revNo: true, approvedBy: true, approvedByInfo: true, approvedAt: true, approvalHash: true,
    },
  });
  const isLive = !target && revNo === live.revSeq;
  if (!target && !isLive) return NOT_APPROVED_REVISION;
  const captureMemoryId = target ? (target.memoryId ?? live.memoryId) : live.memoryId;
  if (servableFrom !== undefined && captureMemoryId !== servableFrom) return NOT_APPROVED_REVISION;
  if (target) chargeTexts(meter, target);
  meter?.chargeLookup();
  const memories = await db.memory.findMany({
    where: { id: { in: [...new Set([captureMemoryId, live.memoryId])] } },
    select: { isEncrypted: true },
  });
  if (memories.some((m) => m.isEncrypted)) return { state: 'NOT_APPLICABLE', record: null };

  const hashOf = (f: { name: string; abstract: string | null; content: string | null }) =>
    computeApprovalHash({ title: f.name, abstract: f.abstract, content: f.content });
  const wanted = hashOf(target ?? live);
  const served = { content: (target ?? live).content, memoryId: captureMemoryId };
  type Row = {
    revNo: number | null; approvedBy: string | null; approvedByInfo: string | null; approvedAt: Date | null;
    approvalHash: string | null; name: string; abstract: string | null; content: string | null;
  };
  // A snapshot's copied approval is a record only while the text it hashed still hashes to it (an altered
  // snapshot is not an approval), and only one covering this revision's text counts here.
  const recordOf = (r: Row): NodeApprovalRecord | null => (
    r.revNo != null && r.approvedAt != null && r.approvalHash === wanted && hashOf(r) === r.approvalHash
      ? { revision: r.revNo, approvedBy: r.approvedBy, approvedByInfo: r.approvedByInfo, approvedAt: r.approvedAt, hash: r.approvalHash }
      : null
  );
  const currentRecord = captureMemoryId === live.memoryId ? approvalRecordOf(live) : null;
  const current = currentRecord && approvalHoldsFor(live) && hashOf(live) === currentRecord.hash && currentRecord.hash === wanted
    ? currentRecord : null;

  // Prefer the record made AT this revision: its own snapshot (already loaded, and always from the capture
  // memory), else the node's current approval when it was made at this revision.
  const atRevision = (target ? recordOf(target as Row) : null) ?? (current?.revision === revNo ? current : null);
  if (atRevision) return { state: 'APPROVED', record: atRevision, served };

  // Else the earliest record that covers it. Only rows carrying this text's hash can cover it, and they are read
  // oldest first in bounded pages, each charged before it runs and its texts after, so a long approval history
  // is never materialized past the budget (#40). A snapshot sorts before the current approval on a tie.
  const where: Prisma.NodeRevisionWhereInput = {
    nodeId, approvalHash: wanted, revNo: { not: null }, approvedAt: { not: null },
    OR: [{ memoryId: captureMemoryId }, ...(captureMemoryId === live.memoryId ? [{ memoryId: null }] : [])],
  };
  let earliest: NodeApprovalRecord | null = null;
  let after: number | null = null;
  for (;;) {
    meter?.chargeLookup();
    const page: Row[] = await db.nodeRevision.findMany({
      where: after == null ? where : { AND: [where, { revNo: { gt: after } }] },
      select: {
        revNo: true, approvedBy: true, approvedByInfo: true, approvedAt: true, approvalHash: true,
        name: true, abstract: true, content: true,
      },
      orderBy: { revNo: 'asc' },
      take: APPROVAL_RECORD_PAGE,
    });
    // Every row the page returned was loaded, so every row is charged before one is chosen (#40).
    for (const r of page) chargeTexts(meter, r);
    earliest = page.map(recordOf).find((r): r is NodeApprovalRecord => r != null) ?? null;
    if (earliest || page.length < APPROVAL_RECORD_PAGE) break;
    // Past the current approval's revision no snapshot can be the earliest.
    after = page[page.length - 1].revNo;
    if (current && after != null && after >= current.revision) break;
  }
  const record = earliest && (!current || earliest.revision <= current.revision) ? earliest : current;
  if (!record) return NOT_APPROVED_REVISION;
  return { state: 'APPROVED', record, served };
}

/** #40: what an approval read charges against a resolved read's budget (a `ResolutionBudget` is one). */
export interface ApprovalReadMeter {
  chargeLookup(count?: number): void;
  chargeLoaded(text: string | null | undefined): void;
}

/** Rows of approval history read per query when looking for the earliest covering record. */
export const APPROVAL_RECORD_PAGE = 8;

function chargeTexts(meter: ApprovalReadMeter | undefined, f: { name: string; abstract: string | null; content: string | null }): void {
  if (!meter) return;
  meter.chargeLoaded(f.name);
  meter.chargeLoaded(f.abstract);
  meter.chargeLoaded(f.content);
}

/** How many revisions `newestApprovedRevisionOf` examines before it gives up (newest first). */
export const NEWEST_APPROVED_REVISION_SCAN_CAP = 100;

/** #3801: how many `cap`-sized batches a SERVE walk examines before it stops (a hard ceiling on the work one serve read may do; with the set-wise pre-filter a ceiling-deep miss of 1,000 revisions with 12 KB texts measured ~0.1 s locally, against ~2.7 s per-verdict). */
export const NEWEST_APPROVED_REVISION_SCAN_BATCHES = 10;

export interface NewestApprovedRevision {
  /** Null when no examined revision is approved (or the node/memory yields nothing to read). */
  found: { revNo: number; record: NodeApprovalRecord; source: 'live' | 'snapshot' } | null;
  /** True when the scan stopped at the cap with older revisions unexamined: `found: null` is then not "never approved". */
  truncated: boolean;
  /** #3801: set only with `truncated`: the oldest revision number examined, so a caller can continue below it. */
  resumeBelow?: number;
}

/**
 * #2041 (cor:dmo:150:05, "a newer unapproved edit of an `approved` target is
 * not broken: serve the newest approved revision") — the newest revision of
 * the node that `revisionApprovalOf` reads APPROVED. It is a walk over that one
 * predicate (live revision first, then the retained snapshots newest-first), so
 * no second definition of "approved" exists. It reads no `approvedRevNo`
 * pointer: that is the node's CURRENT approval, which a later edit supersedes
 * and an encrypted entry can end.
 *
 * Only revisions that can be served from the node's CURRENT memory count: a
 * snapshot captured in another memory (a node moved across memories) is never
 * selected, and an encrypted memory yields nothing (NOT_APPLICABLE, nothing is
 * read). A legacy snapshot with no `revNo` cannot be pinned and is skipped.
 *
 * Pure read; `db` may be a transaction client.
 */
export async function newestApprovedRevisionOf(
  db: Pick<PrismaClient, 'node' | 'nodeRevision' | 'memory'> | Prisma.TransactionClient,
  nodeId: string,
  cap: number = NEWEST_APPROVED_REVISION_SCAN_CAP,
  /** #40: a resolved read's budget, charged for this walk's own queries and every verdict it asks for. */
  meter?: ApprovalReadMeter,
  /** #3801: examine only revisions numbered below this (a continuation past a truncated batch). */
  below?: number,
): Promise<NewestApprovedRevision> {
  const none: NewestApprovedRevision = { found: null, truncated: false };
  const { live, snapshotNos, candidates } = await servableRevisionNumbers(db, nodeId, cap, meter, below);
  if (!live) return none;
  const examined = candidates.slice(0, cap);
  // A metered walk (an include's resolved read) keeps its per-verdict charges, which #40 pins; only an unmetered one pre-filters.
  const skippable = meter ? new Set<number>() : await revisionsWithNoApprovalHash(db, nodeId, live, examined);
  for (const revNo of examined) {
    if (skippable.has(revNo)) continue;
    const verdict = await revisionApprovalOf(db, nodeId, revNo, meter);
    if (verdict.state === 'NOT_APPLICABLE') return none;
    if (verdict.state === 'APPROVED') {
      return { found: { revNo, record: verdict.record!, source: snapshotNos.has(revNo) ? 'snapshot' : 'live' }, truncated: false };
    }
  }
  const truncated = candidates.length > cap;
  return truncated ? { found: null, truncated, resumeBelow: examined[examined.length - 1] } : { found: null, truncated };
}

/**
 * The candidate revision numbers every newest-approved walk offers, newest first (#2041's enumeration, unchanged;
 * #2973 extracted it so the approved-and-signed walk cannot drift from it): the live revision while NO snapshot at all
 * holds its number, plus every snapshot servable from the node's CURRENT memory (a foreign-memory capture is never
 * selected). `snapshotNos` marks which numbers a current-memory snapshot holds — the `source` an approval found there
 * reports. Null `live` is a node that no longer exists: nothing to offer. `below` (#3801) continues a past-batch walk
 * under that revision number only. `live` carries `memoryId` too: the unmetered pre-filter (`revisionsWithNoApprovalHash`)
 * needs it.
 */
export async function servableRevisionNumbers(
  db: Pick<PrismaClient, 'node' | 'nodeRevision' | 'memory'> | Prisma.TransactionClient,
  nodeId: string,
  cap: number,
  meter?: ApprovalReadMeter,
  below?: number,
): Promise<{ live: { memoryId: string; revSeq: number } | null; snapshotNos: Set<number>; candidates: number[] }> {
  meter?.chargeLookup();
  const live = await db.node.findUnique({ where: { id: nodeId }, select: { memoryId: true, revSeq: true } });
  if (!live) return { live: null, snapshotNos: new Set(), candidates: [] };
  // Snapshots servable from the node's CURRENT memory only (a foreign-memory capture is never selected).
  meter?.chargeLookup();
  const snapshots = await db.nodeRevision.findMany({
    where: { nodeId, revNo: below == null ? { not: null } : { not: null, lt: below }, OR: [{ memoryId: null }, { memoryId: live.memoryId }] },
    select: { revNo: true },
    orderBy: { revNo: 'desc' },
    take: cap + 1,
  });
  const snapshotNos = new Set(snapshots.map((r) => r.revNo!));
  // `revisionApprovalOf` resolves a number to its snapshot row first, whichever memory captured it, so the live
  // revision is offered only while NO snapshot at all holds its number: a foreign-memory snapshot at `revSeq` would
  // otherwise be read through, and reported as live.
  meter?.chargeLookup();
  const liveNumberHeld = (await db.nodeRevision.findFirst({ where: { nodeId, revNo: live.revSeq }, select: { id: true } })) != null;
  const candidates = [...(liveNumberHeld || (below != null && live.revSeq >= below) ? [] : [live.revSeq]), ...snapshotNos].sort((a, b) => b - a);
  return { live, snapshotNos, candidates };
}

/** #2973 (cor:agt:040:10 R35) — the outcome of the approved-and-signed walk. */
export interface NewestApprovedAndSignedRevision {
  /** The newest revision that is both approved and signed; null when none was found. */
  found: { revNo: number } | null;
  /**
   * True when some examined revision was APPROVED but did not carry a counting signature (R36's fork): the serve then
   * refuses BOOT_PROMPT_NOT_SIGNED, never BOOT_PROMPT_NOT_APPROVED. A pending-only signature on an approved revision
   * leaves it true — pending does not count.
   */
  approvedUnsigned: boolean;
  /** True when the scan stopped at the cap with older revisions unexamined. */
  truncated: boolean;
  /** #3801: set only with `truncated`: the oldest revision number examined, so a caller can continue below it. */
  resumeBelow?: number;
}

/**
 * #2973 (cor:agt:040:10 R35) — the newest revision of the node that is BOTH approved (`revisionApprovalOf`, the same
 * single definition of approved as every other walk) and signed: `signed(revNo)` decides the signature leg, injected so
 * this module never imports the signing domain. An approved revision without a counting signature does not stop the
 * walk — the serve falls back to the newest older revision that is both (R35) — it only marks `approvedUnsigned` so the
 * caller can refuse NOT_SIGNED rather than NOT_APPROVED when nothing qualifies (R36).
 *
 * Same enumeration as `newestApprovedRevisionOf` (the extracted candidates walk): only revisions servable from the
 * node's CURRENT memory, an encrypted memory yields nothing, a legacy unpinned snapshot is skipped. It carries the same
 * `cap`/`meter`/`below` shape (#3801) and the same unmetered set-wise pre-filter, so the two walks cannot drift. Pure
 * read; `db` may be a transaction client.
 */
export async function newestApprovedAndSignedRevisionOf(
  db: Pick<PrismaClient, 'node' | 'nodeRevision' | 'memory'> | Prisma.TransactionClient,
  nodeId: string,
  /** The signature predicate (#2973 `revisionSignatureCounts`), judged per candidate revision. */
  signed: (revNo: number) => Promise<boolean>,
  cap: number = NEWEST_APPROVED_REVISION_SCAN_CAP,
  /** #40: a resolved read's budget, charged for this walk's own queries and every verdict it asks for. */
  meter?: ApprovalReadMeter,
  /** #3801: examine only revisions numbered below this (a continuation past a truncated batch). */
  below?: number,
): Promise<NewestApprovedAndSignedRevision> {
  const { live, candidates } = await servableRevisionNumbers(db, nodeId, cap, meter, below);
  if (!live) return { found: null, approvedUnsigned: false, truncated: false };
  let approvedUnsigned = false;
  const examined = candidates.slice(0, cap);
  // A metered walk (an include's resolved read) keeps its per-verdict charges, which #40 pins; only an unmetered one pre-filters.
  const skippable = meter ? new Set<number>() : await revisionsWithNoApprovalHash(db, nodeId, live, examined);
  for (const revNo of examined) {
    if (skippable.has(revNo)) continue;
    const verdict = await revisionApprovalOf(db, nodeId, revNo, meter);
    if (verdict.state === 'NOT_APPLICABLE') return { found: null, approvedUnsigned, truncated: false };
    if (verdict.state !== 'APPROVED') continue;
    if (await signed(revNo)) return { found: { revNo }, approvedUnsigned, truncated: false };
    approvedUnsigned = true;
  }
  const truncated = candidates.length > cap;
  return truncated
    ? { found: null, approvedUnsigned, truncated, resumeBelow: examined[examined.length - 1] }
    : { found: null, approvedUnsigned, truncated };
}

const CEILING_WARN_INTERVAL_MS = 60_000;
const ceilingWarned = new Map<string, number>();
/** At most one ceiling warning per node per minute: a hot serve path must not flood the very state it reports. */
function ceilingWarnDue(nodeId: string): boolean {
  const now = Date.now();
  const last = ceilingWarned.get(nodeId);
  if (last != null && now - last < CEILING_WARN_INTERVAL_MS) return false;
  if (ceilingWarned.size > 1000) ceilingWarned.clear();
  ceilingWarned.set(nodeId, now);
  return true;
}

/**
 * #3801 (cor:dmo:150:05, cor:agt:040:12) — the walk a SERVE uses: `newestApprovedRevisionOf` continued past its scan cap in
 * further `cap`-sized batches, so an approved revision buried under more than `cap` newer unapproved ones still serves
 * (the cap is an implementation bound, not a rule that ends a revision's qualification). The work is bounded: at most
 * `NEWEST_APPROVED_REVISION_SCAN_BATCHES` batches; past that it answers like the single walk, `found: null` with
 * `truncated: true`, which the serve refuses as not approved (fail closed, never wrong text).
 */
export async function newestApprovedRevisionForServe(
  db: Pick<PrismaClient, 'node' | 'nodeRevision' | 'memory'> | Prisma.TransactionClient,
  nodeId: string,
  cap: number = NEWEST_APPROVED_REVISION_SCAN_CAP,
): Promise<NewestApprovedRevision> {
  let result = await newestApprovedRevisionOf(db, nodeId, cap);
  for (let batch = 1; batch < NEWEST_APPROVED_REVISION_SCAN_BATCHES && !result.found && result.truncated && result.resumeBelow != null; batch++) {
    result = await newestApprovedRevisionOf(db, nodeId, cap, undefined, result.resumeBelow);
  }
  // The ceiling stopped the walk with older revisions unexamined: the serve will refuse as not approved, so leave the one
  // signal an operator needs to tell this from genuine absence.
  if (!result.found && result.truncated && ceilingWarnDue(nodeId)) {
    console.warn(`[boot-prompt-serve] scan ceiling reached for node ${nodeId}: ${cap * NEWEST_APPROVED_REVISION_SCAN_BATCHES} revisions examined, older ones unexamined (refusing as not approved)`);
  }
  return result;
}

/**
 * #3801 — the revisions of `revNos` that `revisionApprovalOf` cannot read APPROVED, found set-wise instead of one verdict
 * each. Every route to APPROVED there needs a record whose hash equals the hash of THAT revision's text (its own snapshot's
 * copied approval, the node's current approval, or an earlier covering snapshot), so a revision whose text hashes to none of
 * the node's recorded approval hashes is not approved, whatever else is true. Three reads and one bounded carrier lookup per batch instead of ~3 per
 * revision. It only ever ADDS skips for revisions it positively hashed: a number held by more than one row, or one it
 * cannot read, is left to the verdict, and an encrypted memory skips nothing (the verdict answers NOT_APPLICABLE).
 */
async function revisionsWithNoApprovalHash(
  db: Pick<PrismaClient, 'node' | 'nodeRevision' | 'memory'> | Prisma.TransactionClient,
  nodeId: string,
  live: { memoryId: string; revSeq: number },
  revNos: number[],
): Promise<Set<number>> {
  const skip = new Set<number>();
  if (revNos.length === 0) return skip;
  const [memory, liveText, rows] = await Promise.all([
    db.memory.findUnique({ where: { id: live.memoryId }, select: { isEncrypted: true } }),
    db.node.findUnique({ where: { id: nodeId }, select: { revSeq: true, name: true, abstract: true, content: true, approvalHash: true } }),
    db.nodeRevision.findMany({ where: { nodeId, revNo: { in: revNos } }, select: { revNo: true, name: true, abstract: true, content: true } }),
  ]);
  if (!memory || memory.isEncrypted || !liveText) return skip;
  const hashOf = (f: { name: string; abstract: string | null; content: string | null }) =>
    computeApprovalHash({ title: f.name, abstract: f.abstract, content: f.content });
  const byNo = new Map<number, typeof rows>();
  for (const r of rows) byNo.set(r.revNo!, [...(byNo.get(r.revNo!) ?? []), r]);
  const hashes = new Map<number, string>();
  for (const revNo of revNos) {
    const held = byNo.get(revNo) ?? [];
    const text = held.length === 1 ? held[0] : held.length === 0 && revNo === live.revSeq && liveText.revSeq === live.revSeq ? liveText : null;
    if (text) hashes.set(revNo, hashOf(text));
  }
  // Only the batch's own hashes can matter, so ask which of THOSE are recorded: the read is bounded by the batch, never by
  // the length of the node's approval history.
  const wanted = [...new Set(hashes.values())];
  const recorded = new Set<string>(wanted.filter((h) => h === liveText.approvalHash));
  const unresolved = wanted.filter((h) => !recorded.has(h));
  if (unresolved.length > 0) {
    // GROUP BY runs in the database (Prisma applies `distinct` client-side, which would fetch every duplicate row), so the
    // rows returned never exceed the batch's own hashes however many revisions repeat one.
    const carriers = await db.nodeRevision.groupBy({ by: ['approvalHash'], where: { nodeId, approvalHash: { in: unresolved } } });
    for (const c of carriers) recorded.add(c.approvalHash!);
  }
  for (const [revNo, h] of hashes) if (!recorded.has(h)) skip.add(revNo);
  return skip;
}

/**
 * #2973 (cor:agt:040:10 R35) + #3801 adoption (Bob P2-1, delta review of deef730133) — the approved-and-signed walk a
 * SERVE uses: `newestApprovedAndSignedRevisionOf` continued past its scan cap in further `cap`-sized batches, exactly as
 * `newestApprovedRevisionForServe` continues the approval walk, so an older SIGNED revision buried under more than `cap`
 * newer approved-but-unsigned ones still serves (R35's fallback must not die at an implementation bound). The work is
 * bounded by the same `NEWEST_APPROVED_REVISION_SCAN_BATCHES` ceiling; past it the serve fails closed — `found: null`
 * with the `approvedUnsigned` the examined batches saw, so the refusal is NOT_SIGNED, never NOT_APPROVED, when an
 * approved-but-unsigned revision was passed (R36).
 */
export async function newestApprovedAndSignedRevisionForServe(
  db: Pick<PrismaClient, 'node' | 'nodeRevision' | 'memory'> | Prisma.TransactionClient,
  nodeId: string,
  /** The signature predicate (#2973 `revisionSignatureCounts`), judged per candidate revision. */
  signed: (revNo: number) => Promise<boolean>,
  cap: number = NEWEST_APPROVED_REVISION_SCAN_CAP,
): Promise<NewestApprovedAndSignedRevision> {
  let result = await newestApprovedAndSignedRevisionOf(db, nodeId, signed, cap);
  let approvedUnsigned = result.approvedUnsigned;
  for (let batch = 1; batch < NEWEST_APPROVED_REVISION_SCAN_BATCHES && !result.found && result.truncated && result.resumeBelow != null; batch++) {
    result = await newestApprovedAndSignedRevisionOf(db, nodeId, signed, cap, undefined, result.resumeBelow);
    approvedUnsigned = approvedUnsigned || result.approvedUnsigned;
  }
  // The ceiling stopped the walk with older revisions unexamined: the serve will refuse, so leave the one signal an
  // operator needs to tell a signature gap from genuine absence.
  if (!result.found && result.truncated && ceilingWarnDue(nodeId)) {
    console.warn(`[boot-prompt-serve] scan ceiling reached for node ${nodeId}: ${cap * NEWEST_APPROVED_REVISION_SCAN_BATCHES} revisions examined, older ones unexamined (refusing as ${approvedUnsigned ? 'not signed' : 'not approved'})`);
  }
  return { ...result, approvedUnsigned };
}

/**
 * #1838 (cor:dmo:120:04) — entering an encrypted memory ENDS the approvals of
 * the nodes that enter: the hash is cleared and who/when/revision are kept.
 * Applied to the node's current approval and to every copied record on its
 * revisions, in the caller's transaction, so no byte-identical revision can be
 * revived should the node ever leave. The one function every entry path calls
 * (`encryptMemory`; a future move-in, #1921, must too). Idempotent.
 */
export async function endApprovalsOnEncryptedEntry(
  tx: Prisma.TransactionClient,
  scope: { nodeIds: string[] } | { memoryId: string },
): Promise<void> {
  if ('nodeIds' in scope && scope.nodeIds.length === 0) return;
  // By memory: every node the memory holds (tombstones included) and every
  // snapshot of those nodes, whichever memory captured it (a node moved in
  // keeps modern snapshots from where it lived), plus snapshots captured here.
  const nodeWhere: Prisma.NodeWhereInput = 'nodeIds' in scope
    ? { id: { in: scope.nodeIds } } : { memoryId: scope.memoryId };
  const revisionWhere: Prisma.NodeRevisionWhereInput = 'nodeIds' in scope
    ? { nodeId: { in: scope.nodeIds } }
    : { OR: [{ memoryId: scope.memoryId }, { node: { memoryId: scope.memoryId } }] };
  await tx.node.updateMany({ where: { ...nodeWhere, approvalHash: { not: null } }, data: { approvalHash: null } });
  await tx.nodeRevision.updateMany({ where: { ...revisionWhere, approvalHash: { not: null } }, data: { approvalHash: null } });
}
