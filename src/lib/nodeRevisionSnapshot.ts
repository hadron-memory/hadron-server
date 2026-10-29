/**
 * Shared NodeRevision snapshot builder (#620).
 *
 * A NodeRevision is a hand-curated subset of Node columns captured at every
 * write site (spec cor:dmo:060:04) — upsertNode, searchReplaceInNodes,
 * moveNode, mergeNodes, restoreNodeRevision, hadron_update_node,
 * hadron_move_node, and mergeMemories. Before #620 each site assembled the
 * row literal by hand, which is exactly how new Node columns kept getting
 * silently dropped from history (the spec-031 lesson). Every site now goes
 * through `buildNodeRevisionSnapshot`, so adding a versioned field is a
 * one-place change (plus the restoreNodeRevision write-back).
 *
 * Editor capture (#620): `editedBy` holds ONLY a User.id. When no user is
 * known, whatever we do know about the principal goes to `editedByInfo`
 * ("github:<login>" / "email:<addr>" / "user:<id>" from AuthContext.clientId,
 * or "app:<App.id>" for App-key principals). The #88 `reason` rationale is
 * captured as `revLabel` — it previously squatted in `editedBy`.
 */

import { currentActor } from './requestActor.js';
import { Prisma, type NodeAuthorshipKind } from '../generated/prisma/index.js';
import type { PrismaClient } from '../generated/prisma/index.js';
import { generateId } from './id.js';
import { clearNodeAuthorship } from './nodeAuthorship.js';
import { normalizeRole } from './enforceNodeSchema.js';
import { isDecisionFamilyRole } from './decisions/index.js';
import { computeApprovalHash } from './approvalHash.js';
import { newestApprovedRevisionOf } from './nodeApproval.js';
import { includeHistoryClient, type IncludeHistoryTransaction } from './includes/includeHistoryFence.js';

/**
 * The curated subset of Node fields every snapshot captures. On encrypted
 * memories `content` / `abstract` / `data` are the AT-REST ciphertext,
 * deliberately (revisions store the at-rest form; spec 041).
 */
export interface SnapshotSourceNode {
  id: string;
  memoryId: string;
  loc: string;
  name: string;
  alias: string | null;
  description: string | null;
  abstract: string | null;
  abstractOriginHash: string | null;
  content: string | null;
  tags: unknown;
  nodeType: string;
  objectType: string | null;
  isLink: boolean;
  properties: Prisma.JsonValue | null;
  data: Prisma.JsonValue | null;
  seq: number | null;
  isRunnable: boolean | null;
  /** #1201 — Node.role at capture time; see the schema note on why it is curated. */
  role: string | null;
  llmModel: string | null;
  aiAgent: string | null;
  authorshipKind: NodeAuthorshipKind | null;
  authoredByTask: string | null;
  authoredByRevision: number | null;
  authoredByHuman: string | null;
  authoredAt: Date | null;
}

/** Editor identity split per #620 — see module doc. */
export interface SnapshotEditor {
  /** User.id when a user is known → NodeRevision.editedBy. */
  userId?: string | null;
  /** Fallback principal info when no user → NodeRevision.editedByInfo. */
  info?: string | null;
  /** #1610 — the Worker behind the edit → NodeRevision.editedByWorkerId. */
  workerId?: string | null;
  /** #1610 — the Agent behind the edit → NodeRevision.editedByAgentId. */
  agentId?: string | null;
}

/**
 * Derive the snapshot editor from an auth/resolver context. When a `userId`
 * is present it fully identifies the editor and `info` stays null (#620 —
 * the PK supersedes the OAuth identity string). Without one, whatever is
 * known is captured as info: `clientId` ("github:<login>" / "email:<addr>" /
 * "user:<id>") or, for App-key principals, "app:<App.id>".
 */
export function editorFromAuth(auth: {
  userId?: string | null;
  clientId?: string | null;
  appId?: string | null;
}): SnapshotEditor {
  // #1610: the Worker / Agent come from the request's validated binding
  // (requestActor.ts), never from `auth` fields a caller could shape.
  const actor = currentActor();
  return {
    userId: auth.userId ?? null,
    info: auth.userId
      ? null
      : auth.clientId ?? (auth.appId ? `app:${auth.appId}` : null),
    workerId: actor.workerId,
    agentId: actor.agentId,
  };
}

/** Prisma Json columns reject bare null on write — map it to DbNull. */
export function jsonOrDbNull(v: Prisma.JsonValue | null | undefined) {
  return v == null ? Prisma.DbNull : (v as Prisma.InputJsonValue);
}

/**
 * Cap on `NodeRevision.revLabel` — a user-settable display label (same
 * rationale as USER_API_KEY_LABEL_MAX_LEN: the column is uncapped TEXT and a
 * label is not a document). The updateNodeRevision mutation rejects longer
 * input; the snapshot builder truncates (a long #88 `reason` must not abort
 * the edit that carries it).
 */
export const REV_LABEL_MAX_LEN = 500;

/**
 * Build the `data` payload for a `nodeRevision.create` call from the node's
 * PRE-edit state. `changes` names the fields the edit ABOUT to be applied
 * will modify (the delta between this snapshot and the state replacing it);
 * `revLabel` carries the caller-supplied #88 `reason` / revision label.
 */
export function buildNodeRevisionSnapshot(
  node: SnapshotSourceNode,
  editor: SnapshotEditor,
  opts?: { revLabel?: string | null; changes?: string[] },
) {
  return {
    nodeId: node.id,
    // Snapshot belongs to the memory the content lived in at capture (#602).
    memoryId: node.memoryId,
    loc: node.loc,
    name: node.name,
    alias: node.alias,
    description: node.description,
    abstract: node.abstract,
    abstractOriginHash: node.abstractOriginHash,
    content: node.content,
    tags: (node.tags ?? []) as string[],
    nodeType: node.nodeType,
    objectType: node.objectType,
    isLink: node.isLink,
    properties: jsonOrDbNull(node.properties),
    data: jsonOrDbNull(node.data),
    seq: node.seq,
    isRunnable: node.isRunnable,
    role: node.role,
    llmModel: node.llmModel,
    aiAgent: node.aiAgent,
    authorshipKind: node.authorshipKind,
    authoredByTask: node.authoredByTask,
    authoredByRevision: node.authoredByRevision,
    authoredByHuman: node.authoredByHuman,
    authoredAt: node.authoredAt,
    editedBy: editor.userId ?? null,
    editedByInfo: editor.userId ? null : editor.info ?? null,
    editedByWorkerId: editor.workerId ?? null,
    editedByAgentId: editor.agentId ?? null,
    revLabel: opts?.revLabel != null ? opts.revLabel.slice(0, REV_LABEL_MAX_LEN) : null,
    changes: opts?.changes ?? [],
    createdBy: editor.userId ?? editor.info ?? null,
  };
}

/**
 * Column default for `Memory.maxRevCount` (#621) — the per-node cap on
 * retained NodeRevision rows. Also the fallback when the snapshot's memory row
 * can't be read (defensive; every snapshot stamps a real memoryId).
 */
export const DEFAULT_MAX_REV_COUNT = 10;

/**
 * #1323 — internal fingerprint of every AT-REST field NodeRevision captures.
 *
 * This is intentionally not Node.contentHash (external-producer provenance)
 * or the skill artifact hash. PostgreSQL owns the canonical encoding through
 * `hadron_node_revision_state_hash(nodes)`: JSON/array formatting differs
 * between runtimes, so both reconciliation and sanctioned writers ask the DB
 * for the fingerprint rather than trying to duplicate it in JavaScript.
 *
 * The column retains its original `revisionContentHash` name because it is an
 * internal implementation detail introduced in the same unreleased change;
 * semantically it now covers the complete curated revision state.
 */
export async function computeRevisionStateHash(
  db: Pick<PrismaClient, '$queryRaw'>,
  nodeId: string,
): Promise<string | null> {
  const [row] = await db.$queryRaw<Array<{ hash: string }>>`
    SELECT hadron_node_revision_state_hash(n) AS hash
    FROM nodes n
    WHERE n.id = ${nodeId}
  `;
  return row?.hash ?? null;
}

/**
 * Value a sanctioned writer assigns to request a fingerprint refresh. The DB
 * trigger replaces it with the canonical hash of NEW before the row is stored.
 * A bypass writer does not touch the marker, so its tracked-field change leaves
 * the old hash behind and is detectable on the next exposed read.
 */
export function revisionStateHashRefreshMarker(): string {
  return 'refresh';
}

/** `NodeRevision.editedByInfo` of a server-authored drift reconcile — one spelling for writer and reader. */
export const RECONCILE_EDITOR_INFO = 'system:revision-reconcile';

/** #2063 caller cut: a reconciliation read must carry the outer fence's live context.
 * Existing writer callers are migrated in later cuts; this entry has no raw-client fallback.
 */
export async function reconcileNodeWithIncludeHistory(
  history: IncludeHistoryTransaction,
  nodeId: string,
  opts: { expectedMemoryId: string },
): Promise<number | null> {
  return ensureCurrentNodeRevisionInTransaction(includeHistoryClient(history), nodeId, opts);
}

/**
 * Row-lock and reconcile one node inside the caller's transaction. Callers that
 * render or hash node fields use this and then re-read those fields in the SAME
 * transaction: the row lock prevents a writer from pairing revision N+1 with
 * the body from the earlier, pre-lock query.
 */
export async function ensureCurrentNodeRevisionInTransaction(
  tx: Prisma.TransactionClient,
  nodeId: string,
  opts: {
    /**
     * REQUIRED: the memory the caller AUTHORIZED this node in. A READ that selected the
     * node in one memory must never reconcile it after a concurrent relocation
     * into another — that would write a revision (and possibly prune history)
     * in a tenant the reader may not even see (@codex P1, PR #1339). When the
     * locked row is elsewhere this returns null WITHOUT writing; the caller
     * treats it as not found.
     */
    expectedMemoryId: string;
  },
): Promise<number | null> {
  const locked = await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "nodes" WHERE "id" = ${nodeId} FOR UPDATE`;
  if (locked.length === 0) return null;
  const node = await tx.node.findUnique({ where: { id: nodeId } });
  if (!node) return null;
  if (node.memoryId !== opts.expectedMemoryId) return null;

  const actual = await computeRevisionStateHash(tx, node.id);
  if (actual == null) return null;
  if (node.revisionContentHash === actual) return node.revSeq;
  if (node.revisionContentHash == null) {
    await tx.node.update({
      where: { id: node.id },
      data: { revisionContentHash: actual },
    });
    return node.revSeq;
  }

  await createNodeRevision(
    tx,
    buildNodeRevisionSnapshot(
      // The old authored content is already gone: an out-of-band writer
      // changed the live row without a predecessor snapshot. The reconciled
      // state cannot truthfully inherit its old task/human stamp, either in
      // this new revision or on the live row. Known structural writers keep
      // their stamp by refreshing the fingerprint in their own transaction.
      { ...node, ...clearNodeAuthorship() },
      { userId: null, info: RECONCILE_EDITOR_INFO },
      {
        revLabel: 'Reconciled state changed outside a revisioned writer (#1323)',
        changes: [],
      },
    ),
  );
  await tx.node.update({
    where: { id: node.id },
    // The fingerprint computed above included the stale stamp. Recompute it
    // from the cleared live state, or the next read sees a second false drift.
    data: {
      ...clearNodeAuthorship(),
      revisionContentHash: revisionStateHashRefreshMarker(),
      // #1611: an approval that still claims the text, but whose hash the found
      // text no longer matches, was changed outside the revision system. The
      // reconcile is not a supported content change, so it does not move the
      // boundary by itself; do it here so the approval reads as no longer
      // covering the text (never APPROVED) while verify, which also reads this
      // reconcile snapshot, keeps reporting TAMPERED.
      ...(await approvalContradictedBy(tx, node) ? { contentRevSeq: node.revSeq + 1 } : {}),
    },
  });
  return node.revSeq + 1;
}

/**
 * Whether `node` holds an approval that still claims its text (#1611) yet the
 * text hashes differently. An encrypted memory has no approvals to contradict.
 */
async function approvalContradictedBy(
  tx: Prisma.TransactionClient,
  node: { memoryId: string; name: string; abstract: string | null; content: string | null; approvedRevNo: number | null; approvalHash: string | null; contentRevSeq: number },
): Promise<boolean> {
  if (node.approvedRevNo == null || node.approvalHash == null || node.contentRevSeq > node.approvedRevNo) return false;
  const memory = await tx.memory.findUnique({ where: { id: node.memoryId }, select: { isEncrypted: true } });
  if (!memory || memory.isEncrypted) return false;
  return computeApprovalHash({ title: node.name, abstract: node.abstract, content: node.content }) !== node.approvalHash;
}

/** The live node's approval columns (#1591). */
const NODE_APPROVAL_SELECT = {
  approvedRevNo: true,
  approvedBy: true,
  approvedByInfo: true,
  approvedAt: true,
  approvalHash: true,
} as const;

interface NodeApprovalColumns {
  approvedRevNo: number | null;
  approvedBy: string | null;
  approvedByInfo: string | null;
  approvedAt: Date | null;
  approvalHash: string | null;
}

/**
 * #1591 — the approval a snapshot of revision `revNo` carries: the live node's
 * approval when it names exactly that revision, otherwise none. This is how an
 * approval moves into history when its revision is edited away, so every
 * revision-write site gets it without passing anything.
 */
function approvalForSnapshot(node: NodeApprovalColumns | null, revNo: number) {
  if (!node || node.approvedRevNo !== revNo) return {};
  return {
    approvedBy: node.approvedBy,
    approvedByInfo: node.approvedByInfo,
    approvedAt: node.approvedAt,
    approvalHash: node.approvalHash,
  };
}

/**
 * Create a NodeRevision and prune the node's history to `Memory.maxRevCount`
 * (#621). Every revision-write site goes through here (not a bare
 * `nodeRevision.create`) so the cap is enforced in ONE place. After the insert,
 * any revisions beyond the newest `maxRevCount` for this node are deleted.
 *
 * `db` may be the base client or a transaction client (both satisfy the Pick).
 * The cap is read from the snapshot's memory — the memory the node lived in at
 * capture (#602); for a move that's the source memory, which is correct (the
 * pre-move history belonged there).
 */
export async function createNodeRevision(
  db: Pick<PrismaClient, 'nodeRevision' | 'memory' | 'node' | 'nodeSignature' | '$queryRaw'>,
  data: Prisma.NodeRevisionUncheckedCreateInput,
): Promise<void> {
  // #696/#1323: Node.revSeq names the LIVE state. Snapshot the pre-edit state
  // at its current number, then atomically advance the live row. The increment
  // remains the race-safe allocator; subtracting one from the returned value
  // gives the snapshot number. Skip when a guarded caller already claimed and
  // supplied the pre-edit number.
  let revNo = data.revNo ?? null;
  let approval: NodeApprovalColumns | null;
  if (revNo == null) {
    const bumped = await db.node.update({
      where: { id: data.nodeId },
      data: { revSeq: { increment: 1 } },
      select: { revSeq: true, ...NODE_APPROVAL_SELECT },
    });
    revNo = bumped.revSeq - 1;
    approval = bumped;
  } else {
    approval = await db.node.findUnique({ where: { id: data.nodeId }, select: NODE_APPROVAL_SELECT });
  }
  await db.nodeRevision.create({ data: { ...data, revNo, ...approvalForSnapshot(approval, revNo) } });

  // The cap is per (node, memory). A node MOVED across memories keeps its id
  // and carries revisions from each memory it lived in (moveNode snapshots the
  // SOURCE memory); maxRevCount lives on Memory. So this memory's cap must only
  // ever prune ITS OWN snapshots of the node — never another memory's retained
  // history (#621 review, Codex P2). A legacy NULL-memory snapshot has nothing
  // to scope to, so we skip pruning for it.
  const memoryId = data.memoryId;
  if (!memoryId) return;
  // #1641 §3.2 — a decision's history is its audit trail, and its approvals
  // and signatures are revision-keyed: never pruned. The snapshot carries the
  // role at capture; a decision's role never changes.
  const role = data.role !== undefined
    ? data.role
    : (await db.node.findUnique({ where: { id: data.nodeId }, select: { role: true } }))?.role;
  if (isDecisionFamilyRole(role)) return;

  const max =
    (
      await db.memory.findUnique({
        where: { id: memoryId },
        select: { maxRevCount: true },
      })
    )?.maxRevCount ?? DEFAULT_MAX_REV_COUNT;
  // Defensive: chk_memory_max_rev_count_positive enforces >= 1 at the DB.
  if (max < 1) return;

  // Cutoff = the `max`-th newest revision of this node in this memory
  // (createdAt desc, id as a deterministic tiebreak for same-ms rows). A single
  // range delete then removes everything older, so the prune stays O(1) in
  // query parameters even against a huge pre-cap / cap-lowered history — no
  // `id IN (…thousands…)` list that could blow the parameter limit (#621
  // review, Copilot).
  const cutoff = (
    await db.nodeRevision.findMany({
      where: { nodeId: data.nodeId, memoryId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: max - 1,
      take: 1,
      select: { id: true, createdAt: true },
    })
  )[0];
  if (!cutoff) return; // fewer than `max` rows for this memory → nothing to prune

  // Automatic pruning never removes a revision in the exempt set (see
  // revisionsExemptFromPruning); deliberate history clears still may.
  const exempt = [...(await revisionsExemptFromPruning(db, data.nodeId, memoryId))];
  await db.nodeRevision.deleteMany({
    where: {
      nodeId: data.nodeId,
      memoryId,
      AND: [
        { OR: [
          { createdAt: { lt: cutoff.createdAt } },
          { createdAt: cutoff.createdAt, id: { lt: cutoff.id } },
        ] },
        ...(exempt.length ? [{ OR: [{ revNo: null }, { revNo: { notIn: exempt } }] }] : []),
      ],
    },
  });
}

/**
 * The revision numbers of a node that automatic cap-pruning must keep: the ONE
 * seam every retention reason joins (#1838, #2063 replacement P4; #2047's
 * served revisions add their set here, never a second prune rule).
 *
 * - #1632 (cor:dmo:130:05, Holger #9901): a revision a signature was made on.
 * - #1838 (cor:dmo:060:04, R7): a revision whose row carries a recorded
 *   approval (a hash), because that row is the evidence identical-content
 *   revisions are judged approved by.
 *
 * - #2063 (hrn:node:hadronmemory.com:specs:cor:dmo:150:07): the newest
 *   revision the existing approval predicate qualifies, including a covered
 *   non-carrier. Includes themselves add no retention exemption.
 * - #2047 (cor:dmo:150:07, cor:dmo:060:04): the compiled revision an open
 *   session or an unfinished run was served (`served_prompts`). Revision
 *   identity there is `Node.revSeq`, which is `NodeRevision.revNo`.
 *
 * Deliberate deletion (`deleteNodeRevision`, `clearNodeHistory`, restore) is
 * not governed by this and stays allowed. A legacy row with no revNo can carry
 * neither a signature nor a pinnable approval, so it is never in the set and
 * stays prunable.
 */
export async function revisionsExemptFromPruning(
  db: Pick<PrismaClient, 'nodeSignature' | 'nodeRevision' | 'node' | 'memory' | '$queryRaw'> | Prisma.TransactionClient,
  nodeId: string,
  memoryId: string,
): Promise<Set<number>> {
  const [signed, carriers, servedOpen] = await Promise.all([
    db.nodeSignature.findMany({ where: { nodeId }, select: { revision: true }, distinct: ['revision'] }),
    db.nodeRevision.findMany({
      where: { nodeId, memoryId, approvalHash: { not: null }, revNo: { not: null } },
      select: { revNo: true },
    }),
    // #2047 (cor:dmo:150:07): the compiled revision an OPEN session or an unfinished run was served. A chat's record
    // retains nothing (the rule names sessions and runs), and an owner that has ended releases its own revision only.
    db.$queryRaw<Array<{ rev: number }>>`
      SELECT DISTINCT sp.served_rev_seq AS rev
      FROM served_prompts sp
      LEFT JOIN sessions s ON sp.kind = 'BIND' AND s.id = sp.session_id
      LEFT JOIN app_runs r ON sp.kind = 'RUN' AND r.id = sp.run_id
      WHERE sp.compiled_node_id = ${nodeId}
        AND ((sp.kind = 'BIND' AND s.id IS NOT NULL AND s.ended_at IS NULL)
          OR (sp.kind = 'RUN' AND r.status IN ('PENDING', 'RUNNING')))`,
  ]);
  const out = new Set<number>(signed.map((s) => s.revision));
  for (const c of carriers) if (c.revNo != null) out.add(c.revNo);
  for (const sv of servedOpen) out.add(Number(sv.rev));
  // The serving helper's default scan cap is an answer budget, not permission
  // to prune an older qualifying revision. Examine the entire retained set
  // plus the live candidate here; keep exactly the helper's current/historical
  // qualification (including capture-memory and encryption boundaries).
  const retained = await db.nodeRevision.count({ where: { nodeId, revNo: { not: null } } });
  const newest = await newestApprovedRevisionOf(db, nodeId, retained + 1);
  if (newest.found) out.add(newest.found.revNo);
  return out;
}

/**
 * Node fields eligible for the `changes` array — the versioned content
 * fields plus the addressing fields a move touches. Deliberately excludes
 * operational/derived columns (embedding*, tokens, contentHash) and audit
 * stamps, matching what the snapshot itself carries.
 */
export const TRACKED_NODE_FIELDS = [
  'memoryId',
  'loc',
  'name',
  'alias',
  'description',
  'abstract',
  'content',
  'tags',
  'nodeType',
  // #725's collection discriminator. It was captured by the snapshot and
  // restored by restorableNodeFields, but missing here — so an overwrite that
  // changed ONLY objectType recorded an empty `changes` (PR #977 review,
  // Copilot). Every diff caller already passes it.
  'objectType',
  // Spec 032's staleness fingerprint. Same defect as objectType above, found
  // the same way (PR #1127 review, Codex): captured by the snapshot and
  // restored by restorableNodeFields, but absent here — so an update that
  // changed ONLY the hash recorded an empty `changes`. #1126's
  // `abstractStillAccurate` is exactly such an update, and it SUPPRESSES a
  // correctness check, so a revision that does not name it hides the one
  // thing a reader of the history would want to see.
  'abstractOriginHash',
  'isLink',
  'properties',
  'data',
  'seq',
  'isRunnable',
  // #1201 — a role change must show in `changes`, because CLEARING a governed
  // role is the escalation #1202 exists for and an empty diff would hide it.
  'role',
  'llmModel',
  'aiAgent',
  'authorshipKind',
  'authoredByTask',
  'authoredByRevision',
  'authoredByHuman',
  'authoredAt',
] as const satisfies readonly (keyof SnapshotSourceNode)[];

/**
 * #1610 — the node fields whose write makes an AUTHORED edit, which stamps
 * `updatedByWorkerId` / `updatedByAgentId` (src/integrations/db/client.ts).
 * TRACKED_NODE_FIELDS minus the authorship stamps: the lazy reconcile clears
 * those on a READ, and a reader must never become the node's editor.
 */
export const ATTRIBUTED_NODE_FIELDS: ReadonlySet<string> = new Set(
  TRACKED_NODE_FIELDS.filter((field) => field !== 'authorshipKind' && !field.startsWith('authored')),
);

/**
 * Key-order-insensitive JSON encoding: Postgres JSONB does not preserve
 * object key order, so a caller re-sending a stored object in its own key
 * order must still compare equal (arrays stay order-sensitive — element
 * order is data).
 */
function stableStringify(v: unknown): string {
  return JSON.stringify(v, (_key, val) =>
    val && typeof val === 'object' && !Array.isArray(val)
      ? Object.fromEntries(
          Object.entries(val as Record<string, unknown>).sort(([a], [b]) =>
            a < b ? -1 : a > b ? 1 : 0,
          ),
        )
      : val,
  );
}

/** Structural equality — arrays/objects via stable JSON encoding. */
function fieldEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return a == null && b == null;
  if (typeof a === 'object' || typeof b === 'object') {
    return stableStringify(a) === stableStringify(b);
  }
  return false;
}

/**
 * Compute the `changes` list for a snapshot: the versioned fields the update
 * payload will actually modify. Only keys the caller SUPPLIED (value !==
 * undefined) are considered — omit-means-preserve, matching the update
 * contracts. On encrypted memories a supplied plaintext value is compared
 * against at-rest ciphertext and thus reads as changed; that over-report is
 * accepted (we cannot compare without decrypting, and the write happens
 * regardless).
 */
export function diffNodeChanges(
  existing: Partial<Record<(typeof TRACKED_NODE_FIELDS)[number], unknown>>,
  updates: Record<string, unknown>,
): string[] {
  const changed: string[] = [];
  for (const field of TRACKED_NODE_FIELDS) {
    if (!(field in updates) || updates[field] === undefined) continue;
    if (!fieldEquals(existing[field], updates[field])) changed.push(field);
  }
  return changed;
}

/** Whether two rows describe the same revisioned Node state. */
export function revisionStateMatches(
  left: Partial<SnapshotSourceNode>,
  right: Partial<SnapshotSourceNode>,
): boolean {
  if (left.id !== right.id) return false;
  return TRACKED_NODE_FIELDS.every((field) => fieldEquals(left[field], right[field]));
}

/**
 * The node fields a snapshot restores (restoreNodeRevision) — ONE home for
 * both the pre-restore `changes` diff and the write-back, so the field list
 * and the legacy sentinel can't drift between them (the spec-031 silent-drop
 * pattern). A NULL `nodeType` marks a pre-#620 LEGACY snapshot that never
 * captured the newer fields — restoring them would wipe live values to NULL,
 * so they are omitted entirely. Values are returned RAW (at-rest form); the
 * write site maps `properties`/`data` through jsonOrDbNull.
 */
export function restorableNodeFields(revision: {
  name: string;
  alias: string | null;
  description: string | null;
  abstract: string | null;
  abstractOriginHash: string | null;
  content: string | null;
  tags: unknown;
  nodeType: string | null;
  objectType: string | null;
  isLink: boolean | null;
  properties: Prisma.JsonValue | null;
  data: Prisma.JsonValue | null;
  seq: number | null;
  isRunnable: boolean | null;
  /** #1201 — Node.role at capture time; see the schema note on why it is curated. */
  role: string | null;
  llmModel: string | null;
  aiAgent: string | null;
  authorshipKind: NodeAuthorshipKind | null;
  authoredByTask: string | null;
  authoredByRevision: number | null;
  authoredByHuman: string | null;
  authoredAt: Date | null;
}): Record<string, unknown> {
  const base: Record<string, unknown> = {
    name: revision.name,
    alias: revision.alias,
    description: revision.description,
    abstract: revision.abstract,
    abstractOriginHash: revision.abstractOriginHash,
    content: revision.content,
    tags: (revision.tags ?? []) as string[],
  };
  if (revision.nodeType == null) return base;
  return {
    ...base,
    nodeType: revision.nodeType,
    objectType: revision.objectType,
    isLink: revision.isLink ?? false,
    properties: revision.properties,
    data: revision.data,
    seq: revision.seq,
    isRunnable: revision.isRunnable,
    // #1201 (@codex + @copilot, PR #1203). Captured but not restored is the
    // worst of both: restoring a pre-review snapshot would leave the live node
    // still marked `role: 'review'`, so the restore silently disagrees with the
    // revision it claims to reproduce. A field in the curated subset has to
    // round-trip both ways or it is decoration.
    // #1219: a historical '' (stored before the normalization) is the one
    // exception — restoring it RAW would resurrect a shape no write path can
    // produce anymore, so it restores as what it always meant: no role.
    role: normalizeRole(revision.role) ?? null,
    llmModel: revision.llmModel,
    aiAgent: revision.aiAgent,
    authorshipKind: revision.authorshipKind,
    authoredByTask: revision.authoredByTask,
    authoredByRevision: revision.authoredByRevision,
    authoredByHuman: revision.authoredByHuman,
    authoredAt: revision.authoredAt,
  };
}
