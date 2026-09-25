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

import { Prisma } from '../generated/prisma/index.js';
import type { PrismaClient } from '../generated/prisma/index.js';
import { generateId } from './id.js';

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
}

/** Editor identity split per #620 — see module doc. */
export interface SnapshotEditor {
  /** User.id when a user is known → NodeRevision.editedBy. */
  userId?: string | null;
  /** Fallback principal info when no user → NodeRevision.editedByInfo. */
  info?: string | null;
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
  return {
    userId: auth.userId ?? null,
    info: auth.userId
      ? null
      : auth.clientId ?? (auth.appId ? `app:${auth.appId}` : null),
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
    editedBy: editor.userId ?? null,
    editedByInfo: editor.userId ? null : editor.info ?? null,
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
      node,
      { userId: null, info: 'system:revision-reconcile' },
      {
        revLabel: 'Reconciled state changed outside a revisioned writer (#1323)',
        changes: [],
      },
    ),
  );
  await tx.node.update({
    where: { id: node.id },
    data: { revisionContentHash: actual },
  });
  return node.revSeq + 1;
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
  db: Pick<PrismaClient, 'nodeRevision' | 'memory' | 'node'>,
  data: Prisma.NodeRevisionUncheckedCreateInput,
): Promise<void> {
  // #696/#1323: Node.revSeq names the LIVE state. Snapshot the pre-edit state
  // at its current number, then atomically advance the live row. The increment
  // remains the race-safe allocator; subtracting one from the returned value
  // gives the snapshot number. Skip when a guarded caller already claimed and
  // supplied the pre-edit number.
  let revNo = data.revNo ?? null;
  if (revNo == null) {
    const bumped = await db.node.update({
      where: { id: data.nodeId },
      data: { revSeq: { increment: 1 } },
      select: { revSeq: true },
    });
    revNo = bumped.revSeq - 1;
  }
  await db.nodeRevision.create({ data: { ...data, revNo } });

  // The cap is per (node, memory). A node MOVED across memories keeps its id
  // and carries revisions from each memory it lived in (moveNode snapshots the
  // SOURCE memory); maxRevCount lives on Memory. So this memory's cap must only
  // ever prune ITS OWN snapshots of the node — never another memory's retained
  // history (#621 review, Codex P2). A legacy NULL-memory snapshot has nothing
  // to scope to, so we skip pruning for it.
  const memoryId = data.memoryId;
  if (!memoryId) return;

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

  await db.nodeRevision.deleteMany({
    where: {
      nodeId: data.nodeId,
      memoryId,
      OR: [
        { createdAt: { lt: cutoff.createdAt } },
        { createdAt: cutoff.createdAt, id: { lt: cutoff.id } },
      ],
    },
  });
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
] as const satisfies readonly (keyof SnapshotSourceNode)[];

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
    role: revision.role,
    llmModel: revision.llmModel,
    aiAgent: revision.aiAgent,
  };
}
