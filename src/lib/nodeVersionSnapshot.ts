/**
 * Shared NodeVersion snapshot builder (#620).
 *
 * A NodeVersion is a hand-curated subset of Node columns captured at every
 * write site (spec cor:dmo:060:04) — upsertNode, searchReplaceInNodes,
 * moveNode, mergeNodes, restoreNodeVersion, hadron_update_node,
 * hadron_move_node, and mergeMemories. Before #620 each site assembled the
 * row literal by hand, which is exactly how new Node columns kept getting
 * silently dropped from history (the spec-031 lesson). Every site now goes
 * through `buildNodeVersionSnapshot`, so adding a versioned field is a
 * one-place change (plus the restoreNodeVersion write-back).
 *
 * Editor capture (#620): `editedBy` holds ONLY a User.id. When no user is
 * known, whatever we do know about the principal goes to `editedByInfo`
 * ("github:<login>" / "email:<addr>" / "user:<id>" from AuthContext.clientId,
 * or "app:<App.id>" for App-key principals). The #88 `reason` rationale is
 * captured as `revLabel` — it previously squatted in `editedBy`.
 */

import { Prisma } from '../generated/prisma/index.js';

/**
 * The curated subset of Node fields every snapshot captures. On encrypted
 * memories `content` / `abstract` / `data` are the AT-REST ciphertext,
 * deliberately (versions store the at-rest form; spec 041).
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
  isLink: boolean;
  properties: Prisma.JsonValue | null;
  data: Prisma.JsonValue | null;
  seq: number | null;
  isRunnable: boolean | null;
  llmModel: string | null;
  aiAgent: string | null;
}

/** Editor identity split per #620 — see module doc. */
export interface SnapshotEditor {
  /** User.id when a user is known → NodeVersion.editedBy. */
  userId?: string | null;
  /** Fallback principal info when no user → NodeVersion.editedByInfo. */
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
 * Cap on `NodeVersion.revLabel` — a user-settable display label (same
 * rationale as USER_API_KEY_LABEL_MAX_LEN: the column is uncapped TEXT and a
 * label is not a document). The updateNodeVersion mutation rejects longer
 * input; the snapshot builder truncates (a long #88 `reason` must not abort
 * the edit that carries it).
 */
export const REV_LABEL_MAX_LEN = 500;

/**
 * Build the `data` payload for a `nodeVersion.create` call from the node's
 * PRE-edit state. `changes` names the fields the edit ABOUT to be applied
 * will modify (the delta between this snapshot and the state replacing it);
 * `revLabel` carries the caller-supplied #88 `reason` / version label.
 */
export function buildNodeVersionSnapshot(
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
    isLink: node.isLink,
    properties: jsonOrDbNull(node.properties),
    data: jsonOrDbNull(node.data),
    seq: node.seq,
    isRunnable: node.isRunnable,
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
 * Node fields eligible for the `changes` array — the versioned content
 * fields plus the addressing fields a move touches. Deliberately excludes
 * operational/derived columns (embedding*, tokens, contentHash) and audit
 * stamps, matching what the snapshot itself carries.
 */
export const VERSIONED_NODE_FIELDS = [
  'memoryId',
  'loc',
  'name',
  'alias',
  'description',
  'abstract',
  'content',
  'tags',
  'nodeType',
  'isLink',
  'properties',
  'data',
  'seq',
  'isRunnable',
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
  existing: Partial<Record<(typeof VERSIONED_NODE_FIELDS)[number], unknown>>,
  updates: Record<string, unknown>,
): string[] {
  const changed: string[] = [];
  for (const field of VERSIONED_NODE_FIELDS) {
    if (!(field in updates) || updates[field] === undefined) continue;
    if (!fieldEquals(existing[field], updates[field])) changed.push(field);
  }
  return changed;
}

/**
 * The node fields a snapshot restores (restoreNodeVersion) — ONE home for
 * both the pre-restore `changes` diff and the write-back, so the field list
 * and the legacy sentinel can't drift between them (the spec-031 silent-drop
 * pattern). A NULL `nodeType` marks a pre-#620 LEGACY snapshot that never
 * captured the newer fields — restoring them would wipe live values to NULL,
 * so they are omitted entirely. Values are returned RAW (at-rest form); the
 * write site maps `properties`/`data` through jsonOrDbNull.
 */
export function restorableNodeFields(version: {
  name: string;
  alias: string | null;
  description: string | null;
  abstract: string | null;
  abstractOriginHash: string | null;
  content: string | null;
  tags: unknown;
  nodeType: string | null;
  isLink: boolean | null;
  properties: Prisma.JsonValue | null;
  data: Prisma.JsonValue | null;
  seq: number | null;
  isRunnable: boolean | null;
  llmModel: string | null;
  aiAgent: string | null;
}): Record<string, unknown> {
  const base: Record<string, unknown> = {
    name: version.name,
    alias: version.alias,
    description: version.description,
    abstract: version.abstract,
    abstractOriginHash: version.abstractOriginHash,
    content: version.content,
    tags: (version.tags ?? []) as string[],
  };
  if (version.nodeType == null) return base;
  return {
    ...base,
    nodeType: version.nodeType,
    isLink: version.isLink ?? false,
    properties: version.properties,
    data: version.data,
    seq: version.seq,
    isRunnable: version.isRunnable,
    llmModel: version.llmModel,
    aiAgent: version.aiAgent,
  };
}
