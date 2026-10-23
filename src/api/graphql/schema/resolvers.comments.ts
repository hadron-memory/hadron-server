import { stampEmbeddingObligation } from '../../../services/embedding/obligation.js';
/**
 * #1606 — the comment path (`cor:dmo:110`): the ONE way a comment node is
 * created or changed (`cor:dmo:110:04`). Contract of record:
 * `hrn:node:hadronmemory.com:hadron-server:design:comment-nodes-contract`.
 *
 * A comment is a `nodes` row (`nodeType = 'comment'`, loc `comments:<id>`) in
 * its target's memory, a 1:1 `comment_meta` row, and one governed edge: the
 * anchor (comment → target, carrying the anchor revision and its approval
 * hash) or the reply (reply → its thread's top-level comment). The database
 * enforces the shape (prisma/comment-invariants.sql); this module refuses
 * every case first with a typed code.
 *
 * Gates: reads use the target memory's READ gate (`110:02`); create, reply,
 * edit, resolve and reopen need WRITE access (`110:03`), and edit also the
 * author; deleteComment needs the author — with or without any access left
 * (#1765, `110:16`) — or a memory manager, and thread delete a memory
 * manager (#1721). Every gate, and deleteComment's authorship, is re-run
 * under the memory's authority lock (`withAuthorizedMemoryTx`), so a
 * concurrent ownership transfer cannot slip a stale grant through.
 *
 * The target is never written (`110:06`): no path here updates its row.
 */
import { enqueueNodeEmbedding } from '../../../services/embedding/enqueue.js';
import { GraphQLError } from 'graphql';
import { Prisma } from '../../../generated/prisma/index.js';
import type { Context } from './resolvers.helpers.js';
import {
  isAuthorizationDenial,
  isMemoryHiddenForWrite,
  isMemoryReadableCached,
  isMemoryReadableFresh,
  requireMemoryManageAccess,
  requireMemoryWriteAccess,
} from './resolvers.helpers.js';
import { resolveNodeRefForCaller } from './resolvers.nodeRefAccess.js';
import { resolveNodeUrnField } from './resolvers.types.js';
import { withAuthorizedMemoryTx } from './authorizedTx.js';
import { loadActorRef } from './resolvers.nodeAttribution.js';
import { NodeNotFoundError } from '../../../lib/entityRef/errors.js';
import { sessionKeyCache } from '../../../lib/sessionKeyCache.js';
import type { EncryptionKey } from '../../../lib/crypto.js';
import { decryptNodeFieldsWithKey, encryptNodeFieldsWithKey } from '../../../lib/nodeCrypto.js';
import { approvalFieldsOf } from '../../../lib/nodeApproval.js';
import { revisionStateHashRefreshMarker } from '../../../lib/nodeRevisionSnapshot.js';
import { computeApprovalHash } from '../../../lib/approvalHash.js';
import { portalUrlForUrn } from '../../../lib/portalUrl.js';
import { safeCanonicalUrn } from './resolvers.helpers.js';
import { generateId } from '../../../lib/id.js';
import {
  COMMENT_NODE_TYPE,
  COMMENTABLE_CLASSES,
  authorKeyOf,
  commentDataOf,
  commentEdgeLoc,
  commentError,
  commentLoc,
  parseAuthorKey,
  validateBody,
  validateQuote,
  validateReason,
  type CommentNodeData,
  type CommentOp,
} from '../../../lib/comments/index.js';
import { openThreadCounts, viewerOpenThreads } from '../../../lib/comments/summary.js';
import { deleteThreadsInTx } from '../../../lib/comments/lifecycle.js';

type Tx = Prisma.TransactionClient;

// ---------------------------------------------------------------------------
// Rows and views

const COMMENT_NODE_SELECT = {
  id: true, memoryId: true, loc: true, nodeType: true, revSeq: true, content: true, data: true,
  createdAt: true, updatedAt: true, createdBy: true, deletedAt: true,
  commentMeta: true, embeddingWorkToken: true,
} as const;

type CommentNodeRow = Prisma.NodeGetPayload<{ select: typeof COMMENT_NODE_SELECT }>;

/** The internal shape the `Comment` field resolvers read. */
export type CommentView = {
  id: string;
  memoryId: string;
  loc: string;
  threadRootId: string | null;
  isTopLevel: boolean;
  anchorRevision: number;
  anchorApprovalHash: string | null;
  quote: string | null;
  body: string | null;
  state: 'OPEN' | 'RESOLVED' | null;
  /** #1721 — deleted; a view of a live comment is deleted only as a stub kept for its replies. */
  deleted: boolean;
  deletedAt: Date | null;
  deletedByKey: string | null;
  resolvedAt: Date | null;
  resolvedByKey: string | null;
  authorKey: string;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date | null;
  /** #1721 — the last body/quote edit (cor:dmo:110:12); null when never edited. */
  editedAt: Date | null;
  editedByKey: string | null;
  revSeq: number;
  target: { id: string; loc: string; memoryId: string; name: string; nodeType: string; revSeq: number };
};

/** The session key of an encrypted memory, `SESSION_EXPIRED` without one; null for plaintext. */
async function keyForMemory(db: Context['db'] | Tx, memoryId: string): Promise<EncryptionKey | null> {
  const memory = await db.memory.findUniqueOrThrow({ where: { id: memoryId }, select: { isEncrypted: true } });
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

/**
 * #1765 — the memory's session key only while one is cached. No delete path
 * needs to decrypt author content (a stub blanks it, a vanish never touches
 * it), so an author may always delete their own comment, session or not —
 * `keyForMemory`'s SESSION_EXPIRED never gates the delete.
 */
async function cachedKeyFor(db: Context['db'] | Tx, memoryId: string): Promise<EncryptionKey | null> {
  const memory = await db.memory.findUniqueOrThrow({ where: { id: memoryId }, select: { isEncrypted: true } });
  return memory.isEncrypted ? sessionKeyCache.getByMemoryId(memoryId) : null;
}

function decryptComment(row: { content: string | null; data: unknown }, key: EncryptionKey | null) {
  const plain = key
    ? decryptNodeFieldsWithKey({ content: row.content, data: row.data }, key)
    : { content: row.content, data: row.data };
  return { content: plain.content ?? null, data: commentDataOf(plain.data) };
}

/**
 * Load comments by id as views, in the given order. Missing or non-comment
 * ids are dropped. The caller has already passed the memory's read gate.
 */
const embeddingTokenOfView = new WeakMap<CommentView, string | null>();

async function loadCommentViews(db: Context['db'] | Tx, ids: string[], key: EncryptionKey | null): Promise<CommentView[]> {
  if (ids.length === 0) return [];
  const rows = await db.node.findMany({ where: { id: { in: ids }, nodeType: COMMENT_NODE_TYPE }, select: COMMENT_NODE_SELECT });
  const metas = rows.filter((r) => r.commentMeta);
  const rootIds = [...new Set(metas.map((r) => r.commentMeta!.threadRootId ?? r.id))];
  const anchors = await db.edge.findMany({
    where: { sourceId: { in: rootIds }, governedKind: 'COMMENT_ANCHOR' },
    select: { sourceId: true, anchorRevNo: true, anchorApprovalHash: true },
  });
  const anchorOf = new Map(anchors.map((a) => [a.sourceId, a]));
  const targets = await db.node.findMany({
    where: { id: { in: [...new Set(metas.map((r) => r.commentMeta!.targetNodeId))] } },
    select: { id: true, loc: true, memoryId: true, name: true, nodeType: true, revSeq: true, memory: { select: { isEncrypted: true } } },
  });
  const targetOf = new Map(targets.map((t) => [t.id, t]));
  const byId = new Map<string, CommentView>();
  for (const row of metas) {
    const meta = row.commentMeta!;
    const anchor = anchorOf.get(meta.threadRootId ?? row.id);
    const target = targetOf.get(meta.targetNodeId);
    if (!anchor || !target) continue; // the DB invariants make this unreachable
    const { content, data } = decryptComment(row, key);
    // A deleted comment is only ever loaded to answer the call that deleted
    // it (#1721); like a stub, it serves no text.
    const stub = meta.retractedAt != null || row.deletedAt != null;
    // A comment edited before #1721 has no lastEdit; its lastAction still
    // names the edit when nothing has written the row since.
    const edit = data.lastEdit ?? (data.lastAction?.op === 'edit' ? data.lastAction : undefined);
    byId.set(row.id, {
      id: row.id,
      memoryId: row.memoryId,
      loc: row.loc,
      threadRootId: meta.threadRootId,
      isTopLevel: meta.threadRootId == null,
      anchorRevision: anchor.anchorRevNo!,
      anchorApprovalHash: target.memory.isEncrypted ? null : anchor.anchorApprovalHash,
      quote: stub ? null : data.quote ?? null,
      body: stub ? null : content,
      state: meta.threadState,
      deleted: stub,
      deletedAt: meta.retractedAt ?? row.deletedAt,
      deletedByKey: meta.retractedBy ?? meta.threadDeletedBy,
      resolvedAt: meta.resolvedAt,
      resolvedByKey: meta.resolvedBy,
      authorKey: meta.authorKey,
      createdBy: row.createdBy,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      editedAt: edit ? new Date(edit.at) : null,
      editedByKey: edit?.by ?? null,
      revSeq: row.revSeq,
      target,
    });
    // Token and decrypted body originate in the SAME selected row; never adopt a later token for old text.
    embeddingTokenOfView.set(byId.get(row.id)!, row.embeddingWorkToken);
  }
  return ids.map((id) => byId.get(id)).filter((v): v is CommentView => v != null);
}

// ---------------------------------------------------------------------------
// Gates

/** Refuse a comment write the request may not make at all: impersonation, or no principal that can author. */
function requireCommentAuthor(ctx: Context): string {
  if (ctx.impersonation) {
    throw commentError('COMMENT_IMPERSONATION_REFUSED', 'Comments cannot be written under impersonation.');
  }
  const key = authorKeyOf(ctx);
  if (!key) throw commentError('COMMENT_FORBIDDEN', 'Sign in to comment.');
  return key;
}

/** The comment write gate: write access to the memory (`cor:dmo:110:03`). */
async function mayComment(ctx: Context, memoryId: string): Promise<void> {
  try {
    await requireMemoryWriteAccess(ctx, memoryId);
  } catch (error) {
    if (isAuthorizationDenial(error)) {
      throw commentError('COMMENT_FORBIDDEN', 'Commenting needs write access to the memory.');
    }
    throw error;
  }
}

/**
 * The moderation gate (`cor:dmo:110:05`, :11): who may delete others'
 * comments. The memory's manager: its owner user; otherwise owner/admins of
 * the owning org, and a platform admin (#1721, Holger: "they can delete
 * any/all comments"). A platform admin never reaches a personal memory's
 * comments: the read gate conceals them first.
 */
async function mayModerate(ctx: Context, memoryId: string): Promise<void> {
  const memory = await ctx.db.memory.findUniqueOrThrow({
    where: { id: memoryId },
    select: { class: true, userId: true, organizationId: true, ownerUserId: true },
  });
  try {
    await requireMemoryManageAccess(ctx, memory, 'ADMIN');
  } catch (error) {
    if (isAuthorizationDenial(error)) {
      throw commentError('COMMENT_ADMIN_REQUIRED', "Deleting someone else's comment, or a thread, needs a memory manager.");
    }
    throw error;
  }
}

/** Whether the caller may delete others' comments in the memory (no throw). */
async function isModerator(ctx: Context, memoryId: string): Promise<boolean> {
  try {
    await mayModerate(ctx, memoryId);
    return true;
  } catch (error) {
    if (error instanceof GraphQLError && error.extensions.code === 'COMMENT_ADMIN_REQUIRED') return false;
    throw error;
  }
}

/**
 * #1721/#1765 — the deleteComment gate for a caller who can read the memory:
 * a memory manager, a writer, or the comment's author (cor:dmo:110:16 — the
 * author may always delete their own, even with no write access left). The
 * author peek only opens the gate: `author_key` is immutable
 * (comment_meta_immutable), and the locked row re-decides the delete's cause
 * on the transaction.
 */
async function mayDeleteComment(ctx: Context, memoryId: string, authorKey: string, commentId: string): Promise<void> {
  if (await isModerator(ctx, memoryId)) return;
  try {
    await requireMemoryWriteAccess(ctx, memoryId);
  } catch (error) {
    if (!isAuthorizationDenial(error)) throw error;
    const meta = await ctx.db.commentMeta.findUnique({ where: { nodeId: commentId }, select: { authorKey: true } });
    if (meta?.authorKey !== authorKey) {
      // Not the author: the writer gate's own refusal, as before #1765.
      throw commentError('COMMENT_FORBIDDEN', 'Commenting needs write access to the memory.');
    }
  }
}

type Gate = 'write' | 'moderate';
const gateOf = (gate: Gate) => (gate === 'write' ? mayComment : mayModerate);

/** True when the caller may write the memory (no throw); memoized per request. */
const writerCache = new WeakMap<Context, Map<string, Promise<boolean>>>();
function canWriteCached(ctx: Context, memoryId: string): Promise<boolean> {
  let cache = writerCache.get(ctx);
  if (!cache) writerCache.set(ctx, (cache = new Map()));
  let pending = cache.get(memoryId);
  if (!pending) {
    pending = requireMemoryWriteAccess(ctx, memoryId).then(() => true, (error) => {
      if (isAuthorizationDenial(error)) return false;
      throw error;
    });
    cache.set(memoryId, pending);
  }
  return pending;
}

async function requireCommentableClass(db: Context['db'], memoryId: string): Promise<void> {
  const memory = await db.memory.findUniqueOrThrow({ where: { id: memoryId }, select: { class: true } });
  if (!COMMENTABLE_CLASSES.has(memory.class)) {
    throw commentError(
      'COMMENT_MEMORY_NOT_COMMENTABLE',
      `Nodes in a ${memory.class} memory cannot be commented on.`,
      { class: memory.class },
    );
  }
}

/** Resolve a node ref to a live, readable node, or answer `missing` (no existence oracle). */
async function resolveReadableNode(ctx: Context, ref: string, missing: () => GraphQLError) {
  let id: string;
  try {
    ({ id } = await resolveNodeRefForCaller(ctx, ref));
  } catch (error) {
    if (error instanceof NodeNotFoundError) throw missing();
    throw error;
  }
  const node = await ctx.db.node.findUnique({
    where: { id },
    select: { id: true, memoryId: true, nodeType: true, deletedAt: true },
  });
  if (!node || node.deletedAt || !(await isMemoryReadableCached(ctx, node.memoryId))) throw missing();
  return node;
}

/** Replies returned per thread by commentThreads; replyCount is always the full count. */
export const REPLIES_PER_THREAD = 200;

const targetMissing = () => commentError('COMMENT_TARGET_NOT_FOUND', 'Node not found');
const commentMissing = () => commentError('COMMENT_NOT_FOUND', 'Comment not found');

/**
 * The common prefix of every write: author key, readable live node, class,
 * the gate (before key availability, so a reader of an encrypted memory meets
 * the refusal whether or not a key is cached), then the key.
 */
async function prepareWrite(ctx: Context, ref: string, kind: 'target' | 'comment', gate: Gate) {
  const authorKey = requireCommentAuthor(ctx);
  const node = await resolveReadableNode(ctx, ref, kind === 'target' ? targetMissing : commentMissing);
  if (kind === 'target' && node.nodeType === COMMENT_NODE_TYPE) {
    throw commentError('COMMENT_TARGET_IS_COMMENT', 'A comment cannot be the target of a comment; use replyToComment.');
  }
  if (kind === 'comment' && node.nodeType !== COMMENT_NODE_TYPE) throw commentMissing();
  if (await isMemoryHiddenForWrite(ctx, node.memoryId, 'node')) throw kind === 'target' ? targetMissing() : commentMissing();
  await requireCommentableClass(ctx.db, node.memoryId);
  await gateOf(gate)(ctx, node.memoryId);
  const key = await keyForMemory(ctx.db, node.memoryId);
  return { authorKey, node, key };
}

/** Run `write` under the memory's authority lock, re-running the gate on the transaction. */
function commentTx<T>(ctx: Context, memoryId: string, gate: Gate, write: (tx: Tx, txCtx: Context) => Promise<T>): Promise<T> {
  return withAuthorizedMemoryTx(ctx, memoryId, [], (txCtx) => gateOf(gate)(txCtx, memoryId), write);
}

// ---------------------------------------------------------------------------
// Writes

/**
 * The node data after a comment-path write: its quote and reasons, the
 * operation that wrote it, and (#1721) the last edit, which only an edit moves.
 */
function nextData(prior: Partial<CommentNodeData>, op: CommentOp, actorKey: string, patch: Partial<CommentNodeData> = {}): CommentNodeData {
  const at = new Date().toISOString();
  const lastEdit = op === 'edit' ? { by: actorKey, at } : prior.lastEdit;
  return {
    quote: prior.quote ?? null,
    ...(prior.deleteReason ? { deleteReason: prior.deleteReason } : {}),
    ...(lastEdit ? { lastEdit } : {}),
    ...patch,
    lastAction: { op, by: actorKey, at },
  };
}

function encrypted<T extends { content?: string | null; data?: unknown }>(fields: T, key: EncryptionKey | null): T {
  return key ? encryptNodeFieldsWithKey(fields, key) : fields;
}

function actorCreatedBy(ctx: Context): string | null {
  return ctx.userId ?? ctx.clientId ?? null;
}

/** Map a one-open-thread unique violation to its typed refusal, naming the open thread. */
async function openThreadConflict(db: Context['db'], targetNodeId: string, authorKey: string): Promise<GraphQLError> {
  const open = await db.commentMeta.findFirst({
    where: {
      targetNodeId, authorKey, threadRootId: null, threadState: 'OPEN',
      retractedAt: null, threadDeletedAt: null,
    },
    select: { nodeId: true },
  });
  return commentError(
    'COMMENT_OPEN_THREAD_EXISTS',
    'You already have an open thread on this node: reply there, or resolve or delete it first.',
    { threadId: open?.nodeId ?? null },
  );
}

/**
 * A violation of the one-open-thread index specifically (#1663 review P3: not
 * any P2002). Prisma names a raw partial index by its name or its columns,
 * depending on the path, so both are accepted.
 */
function isOpenThreadUniqueViolation(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
    const target = JSON.stringify(error.meta ?? {});
    return target.includes('comment_meta_one_open_thread') || (target.includes('target_node_id') && target.includes('author_key'));
  }
  return error instanceof Error && /comment_meta_one_open_thread/.test(error.message);
}

/**
 * Validate the anchor revision and return its fields, or null for an encrypted
 * target (cor:dmo:110:01). Historical snapshots retain their own read gate.
 */
async function anchorFields(
  tx: Tx,
  txCtx: Context,
  target: { id: string; memoryId: string; revSeq: number; name: string; abstract: string | null; content: string | null },
  revision: number,
  key: EncryptionKey | null,
) {
  if (revision < 1 || revision > target.revSeq) {
    throw commentError(
      'COMMENT_ANCHOR_REVISION_INVALID',
      `anchorRevision must be between 1 and the current revision ${target.revSeq}.`,
      { currentRevision: target.revSeq },
    );
  }
  const memory = await tx.memory.findUniqueOrThrow({ where: { id: target.memoryId }, select: { isEncrypted: true } });
  if (revision === target.revSeq) return memory.isEncrypted ? null : approvalFieldsOf(target, key);
  const unavailable = () => commentError(
    'COMMENT_ANCHOR_REVISION_UNAVAILABLE',
    `Revision ${revision} of the target is no longer retained; comment on the current revision.`,
    { currentRevision: target.revSeq },
  );
  const snapshot = await tx.nodeRevision.findFirst({
    where: { nodeId: target.id, revNo: revision },
    select: { memoryId: true, name: true, abstract: true, content: true },
  });
  if (!snapshot) throw unavailable();
  const sourceId = snapshot.memoryId ?? target.memoryId;
  if (sourceId === target.memoryId) return memory.isEncrypted ? null : approvalFieldsOf(snapshot, key);
  // #1663 review (Atilla P2-3) — a snapshot captured in ANOTHER memory (before
  // a move) is anchored only when the caller may read that memory too, the
  // same per-snapshot gate as nodeRevisions. A cached key is not a grant.
  if (!(await isMemoryReadableFresh(txCtx, sourceId, tx))) throw unavailable();
  const source = await tx.memory.findUnique({ where: { id: sourceId }, select: { isEncrypted: true } });
  if (!source?.isEncrypted) return memory.isEncrypted ? null : approvalFieldsOf(snapshot, null);
  const foreignKey = sessionKeyCache.getByMemoryId(sourceId);
  if (!foreignKey) throw unavailable();
  return memory.isEncrypted ? null : approvalFieldsOf(snapshot, foreignKey);
}

/** Insert one comment (node + meta + governed edge) inside the caller's transaction. */
async function insertComment(
  tx: Tx,
  ctx: Context,
  args: {
    memoryId: string;
    targetNodeId: string;
    targetName: string;
    threadRootId: string | null;
    authorKey: string;
    body: string;
    quote: string | null;
    key: EncryptionKey | null;
    anchor: { revNo: number; hash: string | null } | null;
  },
): Promise<string> {
  const id = generateId();
  const op: CommentOp = args.threadRootId ? 'reply' : 'create';
  const fields = encrypted({ content: args.body, data: nextData({ quote: args.quote }, op, args.authorKey) as unknown }, args.key);
  const createdBy = actorCreatedBy(ctx);
  await tx.node.create({
    data: {
      id,
      memoryId: args.memoryId,
      loc: commentLoc(id),
      name: `Comment on ${args.targetName}`.slice(0, 500),
      nodeType: COMMENT_NODE_TYPE,
      content: fields.content,
      data: fields.data as Prisma.InputJsonValue,
      createdBy,
    },
  });
  await stampEmbeddingObligation(tx, id, args.memoryId);
  await tx.commentMeta.create({
    data: {
      nodeId: id,
      targetNodeId: args.targetNodeId,
      threadRootId: args.threadRootId,
      threadState: args.threadRootId ? null : 'OPEN',
      authorKey: args.authorKey,
    },
  });
  await tx.edge.create({
    data: args.anchor
      ? {
        memoryId: args.memoryId, sourceId: id, targetId: args.targetNodeId,
        loc: commentEdgeLoc(id, 'anchor'), name: 'comment-anchor', governedKind: 'COMMENT_ANCHOR',
        anchorRevNo: args.anchor.revNo, anchorApprovalHash: args.anchor.hash, createdBy,
      }
      : {
        memoryId: args.memoryId, sourceId: id, targetId: args.threadRootId!,
        loc: commentEdgeLoc(id, 'reply'), name: 'comment-reply', governedKind: 'COMMENT_REPLY', createdBy,
      },
  });
  return id;
}

type LockedComment = Prisma.NodeGetPayload<{ include: { commentMeta: true } }>;

/**
 * Lock a comment for a write that may touch its thread, thread root FIRST
 * (#1727 review, Diego P2). A thread delete locks the root and then writes
 * every reply, so a path that held a reply and then waited for its root
 * could deadlock against it. `threadRootId` is immutable (comment-invariants
 * trigger), so reading it before the lock is safe.
 */
async function lockInThread(tx: Tx, id: string, memoryId: string): Promise<{ addressed: LockedComment; root: LockedComment }> {
  const meta = await tx.commentMeta.findUnique({ where: { nodeId: id }, select: { threadRootId: true } });
  const rootId = meta?.threadRootId ?? null;
  const root = rootId ? await lockComment(tx, rootId, memoryId) : null;
  const addressed = await lockComment(tx, id, memoryId);
  return { addressed, root: root ?? addressed };
}

/** Lock a live comment row and read it (with its meta) on the transaction. */
async function lockComment(tx: Tx, id: string, memoryId: string): Promise<LockedComment> {
  await tx.$queryRaw`SELECT id FROM nodes WHERE id = ${id} FOR UPDATE`;
  const row = await tx.node.findUnique({ where: { id }, include: { commentMeta: true } });
  if (!row || row.deletedAt || row.memoryId !== memoryId || row.nodeType !== COMMENT_NODE_TYPE || !row.commentMeta) {
    throw commentMissing();
  }
  return row;
}

function requireRevision(row: { revSeq: number }, expectedRevision: number): void {
  if (row.revSeq !== expectedRevision) {
    throw new GraphQLError(
      `NODE_WRITE_CONFLICT: the comment is at revision ${row.revSeq}, not ${expectedRevision}. Reload and retry.`,
      { extensions: { code: 'NODE_WRITE_CONFLICT', currentRevision: row.revSeq } },
    );
  }
}

/**
 * Write one comment-path change to the comment row. #1721: a comment keeps no
 * revision history (cor:dmo:110:12), so the change overwrites the row; revSeq
 * still advances, because it is what `expectedRevision` is checked against.
 * Attribution (`updatedBy`) comes from the request.
 */
async function reviseComment(
  tx: Tx,
  ctx: Context,
  row: LockedComment,
  key: EncryptionKey | null,
  op: CommentOp,
  actorKey: string,
  patch: { content?: string | null; data?: Partial<CommentNodeData> },
  extra: Prisma.NodeUpdateInput = {},
): Promise<void> {
  const { data: priorData } = decryptComment(row, key);
  const fields = encrypted({
    ...(patch.content !== undefined ? { content: patch.content } : {}),
    data: nextData(priorData, op, actorKey, patch.data) as unknown,
  }, key);
  await tx.node.update({
    where: { id: row.id },
    data: {
      ...fields, data: fields.data as Prisma.InputJsonValue, updatedBy: actorCreatedBy(ctx),
      // This IS the sanctioned writer of a comment: refresh the fingerprint, or
      // the #1323 drift reconcile would read the change as out-of-band and
      // snapshot it as a revision on the next read.
      revSeq: { increment: 1 }, revisionContentHash: revisionStateHashRefreshMarker(), ...extra,
    },
  });
  if (patch.content !== undefined) await stampEmbeddingObligation(tx, row.id, row.memoryId);
}

/**
 * #1608 — (re-)index a comment's text for search after a write: comment text
 * is searchable feedback (cor:dmo:110:08), and the CONTENT default keeps it
 * out of ordinary results. A stub's blanked body leaves nothing to index. The
 * plaintext comes from the view, so an encrypted memory embeds plaintext.
 * A no-op unless the memory has a vector index.
 */
function indexed(ctx: Context, view: CommentView): CommentView {
  void enqueueNodeEmbedding(ctx.db, {
    nodeId: view.id,
    workToken: embeddingTokenOfView.get(view) ?? null,
    memoryId: view.memoryId,
    plaintext: { content: view.body, abstract: null },
  }).catch((error) => console.error('[comments] embedding enqueue failed:', error));
  return view;
}

async function viewOf(ctx: Context, id: string, key: EncryptionKey | null): Promise<CommentView> {
  const [view] = await loadCommentViews(ctx.db, [id], key);
  if (!view) throw commentMissing();
  return view;
}

/**
 * Shared body of the single-comment state operations: resolve, lock, check
 * the revision and the op's own preconditions, write the change.
 */
async function changeComment(
  ctx: Context,
  ref: string,
  gate: Gate,
  op: CommentOp,
  apply: (row: LockedComment, actorKey: string, tx: Tx, txCtx: Context) => CommentChange | Promise<CommentChange>,
  expectedRevision: number,
): Promise<CommentView> {
  const { authorKey, node, key } = await prepareWrite(ctx, ref, 'comment', gate);
  let metaForConflict: { targetNodeId: string; authorKey: string } | null = null;
  try {
    await commentTx(ctx, node.memoryId, gate, async (tx, txCtx) => {
      const { addressed: row } = await lockInThread(tx, node.id, node.memoryId);
      metaForConflict = { targetNodeId: row.commentMeta!.targetNodeId, authorKey: row.commentMeta!.authorKey };
      requireRevision(row, expectedRevision);
      const change = await apply(row, authorKey, tx, txCtx);
      // #1721 (Marco, #7693): resolve and reopen change only the thread state.
      // They never write the comment row, so its updatedAt and updatedBy move
      // only when the comment itself changes.
      if (op !== 'resolve' && op !== 'reopen') await reviseComment(tx, txCtx, row, key, op, authorKey, change.patch);
      await tx.commentMeta.update({ where: { nodeId: row.id }, data: change.meta });
    });
  } catch (error) {
    if (metaForConflict && isOpenThreadUniqueViolation(error)) {
      const { targetNodeId, authorKey: owner } = metaForConflict;
      throw await openThreadConflict(ctx.db, targetNodeId, owner);
    }
    throw error;
  }
  const view = await viewOf(ctx, node.id, key);
  // Resolve and reopen change no text, so there is nothing to re-index.
  return op === 'resolve' || op === 'reopen' ? view : indexed(ctx, view);
}

type CommentChange = {
  patch: { content?: string | null; data?: Partial<CommentNodeData> };
  meta: Prisma.CommentMetaUpdateInput;
};

/**
 * #1721/#1765 — the delete body proper, on the locked row: the author, or a
 * memory manager (re-decided here, on the locked row — §10), then a stub
 * while replies remain, else a soft delete that leaves no stub. Returns
 * whether the comment vanished.
 */
async function deleteLockedComment(
  tx: Tx,
  txCtx: Context,
  row: LockedComment,
  actorKey: string,
  key: EncryptionKey | null,
): Promise<boolean> {
  const meta = row.commentMeta!;
  const cause = meta.authorKey === actorKey ? 'AUTHOR' : 'MANAGER';
  if (cause === 'MANAGER' && !(await isModerator(txCtx, row.memoryId))) {
    throw commentError('COMMENT_NOT_AUTHOR', "Only the comment's author or a memory manager may delete it.");
  }
  refuseStub(meta);
  const deleted = { retractedAt: new Date(), retractedBy: actorKey };
  const hasReplies = meta.threadRootId == null && (await liveReplyCount(tx, row.id)) > 0;
  // #1608 — a stub's vectors (they hold its old text, including passage
  // chunk_text) go in the same transaction that conceals it, never by
  // eventual cleanup (#1674 review, Jane P2-4). A deleted comment's too.
  await tx.nodeEmbedding.deleteMany({ where: { nodeId: row.id } });
  if (!hasReplies) {
    await tx.commentMeta.update({ where: { nodeId: row.id }, data: deleted });
    await vanishComment(tx, txCtx, row, actorKey, cause);
    return true;
  }
  await reviseComment(tx, txCtx, row, key, 'delete', actorKey, STUB_PATCH);
  await tx.commentMeta.update({ where: { nodeId: row.id }, data: deleted });
  return false;
}

/**
 * #1765 — the delete path for a caller who can read the memory: the standard
 * comment gates, with one widening — the comment's author passes the delete
 * gate without write access. The delete itself runs under the memory's
 * authority lock with the gate re-run there.
 */
async function deleteCommentReadable(
  ctx: Context,
  head: { id: string; memoryId: string },
  authorKey: string,
  expectedRevision: number,
): Promise<CommentView> {
  if (await isMemoryHiddenForWrite(ctx, head.memoryId, 'node')) throw commentMissing();
  await requireCommentableClass(ctx.db, head.memoryId);
  await mayDeleteComment(ctx, head.memoryId, authorKey, head.id);
  const key = await cachedKeyFor(ctx.db, head.memoryId);
  let vanished = false;
  await withAuthorizedMemoryTx(ctx, head.memoryId, [],
    (txCtx) => mayDeleteComment(txCtx, head.memoryId, authorKey, head.id),
    async (tx, txCtx) => {
      const { addressed: row } = await lockInThread(tx, head.id, head.memoryId);
      requireRevision(row, expectedRevision);
      vanished = await deleteLockedComment(tx, txCtx, row, authorKey, key);
    });
  const view = await viewOf(ctx, head.id, key);
  return vanished ? view : indexed(ctx, view);
}

/**
 * #1765 — the no-access acknowledgment (cycle-1 seats: Anne P2-1, Xylon
 * P2-2): the deleted comment's own record, and nothing else. Everything
 * served is the comment's own data, the author-known anchor record, or the
 * deletion itself. The target's identity is read for the URN; its name is
 * blanked (the SDL field is non-null) and its revision is the anchor's, so
 * no post-revocation rename or edit is reflected; the thread state reads
 * null, never its live value. Read on the transaction, after the delete.
 */
async function frozenDeletedViewOf(tx: Tx, commentId: string): Promise<CommentView> {
  const row = await tx.node.findUnique({ where: { id: commentId }, select: COMMENT_NODE_SELECT });
  const meta = row?.commentMeta;
  if (!row || !meta) throw commentMissing();
  const [anchor, target] = await Promise.all([
    tx.edge.findUnique({
      where: { loc_memoryId: { loc: commentEdgeLoc(meta.threadRootId ?? row.id, 'anchor'), memoryId: row.memoryId } },
      select: { anchorRevNo: true, anchorApprovalHash: true },
    }),
    tx.node.findUnique({
      where: { id: meta.targetNodeId },
      select: { id: true, loc: true, memoryId: true, nodeType: true, memory: { select: { isEncrypted: true } } },
    }),
  ]);
  // The DB invariants make a comment without its anchor or target unreachable.
  if (!anchor?.anchorRevNo || !target) throw commentMissing();
  const data = commentDataOf(row.data);
  return {
    id: row.id,
    memoryId: row.memoryId,
    loc: row.loc,
    threadRootId: meta.threadRootId,
    isTopLevel: meta.threadRootId == null,
    anchorRevision: anchor.anchorRevNo,
    anchorApprovalHash: target.memory.isEncrypted ? null : anchor.anchorApprovalHash,
    quote: null,
    body: null,
    state: null,
    deleted: true,
    deletedAt: meta.retractedAt ?? row.deletedAt,
    deletedByKey: meta.retractedBy ?? meta.threadDeletedBy,
    resolvedAt: null,
    resolvedByKey: null,
    authorKey: meta.authorKey,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    editedAt: data.lastEdit ? new Date(data.lastEdit.at) : null,
    editedByKey: data.lastEdit?.by ?? null,
    revSeq: row.revSeq,
    target: { ...target, name: '', revSeq: anchor.anchorRevNo },
  };
}

/**
 * #1765 — the author's carried right (cor:dmo:110:16): delete their own
 * comment with no memory access at all. A non-author is turned away by the
 * UNLOCKED authorKey peek below, before any transaction or lock is taken on
 * a memory they cannot read (#9888, Rook P2-1 — the locked row still
 * re-checks); `author_key` is immutable, so the peek cannot go stale. The
 * author proceeds inside the memory's authority bracket, which fences caller
 * liveness and a concurrent ownership transfer. Anything else about the
 * memory is concealed: a non-author meets the same COMMENT_NOT_FOUND as a
 * missing comment (before the revision can leak), and an authority denial
 * (the memory gone mid-call) answers as missing too. The process-wide cached
 * key, when one exists, encrypts only the stub write — nothing in the frozen
 * acknowledgment is decrypted with it.
 */
async function deleteOwnCommentWithoutAccess(
  ctx: Context,
  head: { id: string; memoryId: string },
  authorKey: string,
  expectedRevision: number,
): Promise<CommentView> {
  const meta = await ctx.db.commentMeta.findUnique({ where: { nodeId: head.id }, select: { authorKey: true } });
  if (meta?.authorKey !== authorKey) throw commentMissing();
  let view: CommentView;
  try {
    view = await withAuthorizedMemoryTx(ctx, head.memoryId, [], async () => {
      // No access gate to re-run: authorship of the locked row below is the
      // whole gate, so there is nothing access-shaped to recheck here.
    }, async (tx, txCtx) => {
      const key = await cachedKeyFor(tx, head.memoryId);
      const { addressed: row } = await lockInThread(tx, head.id, head.memoryId);
      if (row.commentMeta!.authorKey !== authorKey) throw commentMissing();
      requireRevision(row, expectedRevision);
      await deleteLockedComment(tx, txCtx, row, authorKey, key);
      return frozenDeletedViewOf(tx, head.id);
    });
  } catch (error) {
    if (isAuthorizationDenial(error)) throw commentMissing();
    throw error;
  }
  // Nothing to re-index for a no-access caller: the delete already removed
  // the vectors, and the acknowledgment serves no text.
  return view;
}

/** Live (not deleted) replies under a top-level comment. */
function liveReplyCount(tx: Tx, rootId: string): Promise<number> {
  return tx.commentMeta.count({ where: { threadRootId: rootId, node: { deletedAt: null } } });
}

/**
 * #1721 — delete a comment that leaves no stub (cor:dmo:110:05): soft-delete it,
 * so it is gone from every read, limit and check. When it was the last live
 * reply under a stub, the stub goes too ("a stub disappears once its last
 * reply is deleted", Holger, team chat #7636).
 */
async function vanishComment(tx: Tx, txCtx: Context, row: LockedComment, actorKey: string, cause: 'AUTHOR' | 'MANAGER'): Promise<void> {
  const deletedBy = actorCreatedBy(txCtx);
  await deleteThreadsInTx(tx, [row.id], { actorKey, deletedBy, cause });
  const rootId = row.commentMeta!.threadRootId;
  if (!rootId) return;
  await tx.$queryRaw`SELECT id FROM nodes WHERE id = ${rootId} FOR UPDATE`;
  const root = await tx.node.findUnique({ where: { id: rootId }, include: { commentMeta: true } });
  const meta = root?.commentMeta;
  if (root && !root.deletedAt && meta?.retractedAt != null && (await liveReplyCount(tx, rootId)) === 0) {
    // The stub's deletion was already decided, by whoever deleted it; record that.
    const stubCause = meta.retractedBy === meta.authorKey ? 'AUTHOR' : 'MANAGER';
    await deleteThreadsInTx(tx, [rootId], { actorKey: meta.retractedBy, deletedBy, cause: stubCause });
  }
}

/**
 * #1663 review (Atilla/Dan/local P2) — a stub's live row is BLANKED (body and
 * quote), so no generic read surface (node(ref:), lists, search, MCP, export)
 * can serve the text. #1721: a comment keeps no revision history, so the text
 * is gone.
 */
const STUB_PATCH = { content: null, data: { quote: null } } as const;

function refuseStub(meta: NonNullable<LockedComment['commentMeta']>): void {
  if (meta.retractedAt) throw commentError('COMMENT_DELETED', 'This comment is deleted.');
}

function requireTopLevel(meta: NonNullable<LockedComment['commentMeta']>): void {
  if (meta.threadRootId) {
    throw commentError('COMMENT_NOT_TOP_LEVEL', 'Resolve and reopen apply to a thread: address its top-level comment.', { threadRootId: meta.threadRootId });
  }
}

function requireAuthor(meta: NonNullable<LockedComment['commentMeta']>, actorKey: string): void {
  if (meta.authorKey !== actorKey) throw commentError('COMMENT_NOT_AUTHOR', 'Only the comment\'s author may do this.');
}

export const commentMutations = {
  /** Start a thread on a node (`cor:dmo:110:01`–`05`). */
  createComment: async (
    _: unknown,
    args: { targetRef: string; body: string; quote?: string | null; anchorRevision?: number | null },
    ctx: Context,
  ): Promise<CommentView> => {
    const body = validateBody(args.body);
    const quote = validateQuote(args.quote);
    const { authorKey, node: target } = await prepareWrite(ctx, args.targetRef, 'target', 'write');
    let id: string;
    try {
      id = await commentTx(ctx, target.memoryId, 'write', async (tx, txCtx) => {
        // Hold the target still while its revision is hashed; the target row is
        // only READ (cor:dmo:110:06).
        await tx.$queryRaw`SELECT id FROM nodes WHERE id = ${target.id} FOR SHARE`;
        const row = await tx.node.findUnique({
          where: { id: target.id },
          select: { id: true, memoryId: true, nodeType: true, deletedAt: true, revSeq: true, name: true, abstract: true, content: true },
        });
        if (!row || row.deletedAt || row.memoryId !== target.memoryId) throw targetMissing();
        if (row.nodeType === COMMENT_NODE_TYPE) {
          throw commentError('COMMENT_TARGET_IS_COMMENT', 'A comment cannot be the target of a comment; use replyToComment.');
        }
        const revision = args.anchorRevision ?? row.revSeq;
        // Re-read encryption and its key under the memory fence (cor:dmo:110:01).
        const writeKey = await keyForMemory(tx, row.memoryId);
        const fields = await anchorFields(tx, txCtx, row, revision, writeKey);
        const hash = fields === null ? null : computeApprovalHash(fields);
        const open = await tx.commentMeta.findFirst({
          where: {
            targetNodeId: row.id, authorKey, threadRootId: null, threadState: 'OPEN',
            retractedAt: null, threadDeletedAt: null,
          },
          select: { nodeId: true },
        });
        if (open) {
          throw commentError('COMMENT_OPEN_THREAD_EXISTS',
            'You already have an open thread on this node: reply there, or resolve or delete it first.',
            { threadId: open.nodeId });
        }
        return insertComment(tx, txCtx, {
          memoryId: row.memoryId, targetNodeId: row.id, targetName: row.name, threadRootId: null,
          authorKey, body, quote, key: writeKey, anchor: { revNo: revision, hash },
        });
      });
    } catch (error) {
      if (isOpenThreadUniqueViolation(error)) throw await openThreadConflict(ctx.db, target.id, authorKey);
      throw error;
    }
    return indexed(ctx, await viewOf(ctx, id, await keyForMemory(ctx.db, target.memoryId)));
  },

  /**
   * Reply in a thread; `commentRef` may be any comment of it. A resolved
   * thread accepts replies and stays resolved (DAB, Holger, team chat #6989).
   */
  replyToComment: async (_: unknown, args: { commentRef: string; body: string }, ctx: Context): Promise<CommentView> => {
    const body = validateBody(args.body);
    const { authorKey, node, key } = await prepareWrite(ctx, args.commentRef, 'comment', 'write');
    const id = await commentTx(ctx, node.memoryId, 'write', async (tx, txCtx) => {
      const { root } = await lockInThread(tx, node.id, node.memoryId);
      refuseStub(root.commentMeta!);
      const target = await tx.node.findUniqueOrThrow({ where: { id: root.commentMeta!.targetNodeId }, select: { name: true } });
      return insertComment(tx, txCtx, {
        memoryId: node.memoryId, targetNodeId: root.commentMeta!.targetNodeId, targetName: target.name,
        threadRootId: root.id, authorKey, body, quote: null, key, anchor: null,
      });
    });
    return indexed(ctx, await viewOf(ctx, id, key));
  },

  /** The author edits the body and/or quote (`cor:dmo:110:05`). */
  editComment: async (
    _: unknown,
    args: { commentRef: string; body?: string | null; quote?: string | null; expectedRevision: number },
    ctx: Context,
  ): Promise<CommentView> => {
    if (args.body == null && args.quote === undefined) {
      throw commentError('COMMENT_BODY_INVALID', 'Pass a new body, a new quote, or both.', { field: 'body' });
    }
    const body = args.body != null ? validateBody(args.body) : undefined;
    const quote = args.quote !== undefined ? validateQuote(args.quote) : undefined;
    return changeComment(ctx, args.commentRef, 'write', 'edit', (row, actorKey) => {
      requireAuthor(row.commentMeta!, actorKey);
      refuseStub(row.commentMeta!);
      return { patch: { content: body, data: quote !== undefined ? { quote } : {} }, meta: {} };
    }, args.expectedRevision);
  },

  /**
   * Delete one comment (cor:dmo:110:05/:16, #1721, #1765): its author — with
   * or without any access left — or anyone who may delete others' comments. A
   * top-level comment with live replies stays as a "deleted" stub, so the
   * replies keep their context; any other comment is soft-deleted and no
   * longer shown. The stub goes with its last reply.
   */
  deleteComment: async (_: unknown, args: { commentRef: string; expectedRevision: number }, ctx: Context): Promise<CommentView> => {
    const authorKey = requireCommentAuthor(ctx);
    // #1765 — resolve the ref with no memory read gate: the author's right to
    // delete their own comment survives losing all access, so the resolver
    // cannot demand readability up front. Every miss below answers the one
    // concealed COMMENT_NOT_FOUND, so the resolution stays no-oracle.
    let id: string;
    try {
      ({ id } = await resolveNodeRefForCaller(ctx, args.commentRef));
    } catch (error) {
      if (error instanceof NodeNotFoundError) throw commentMissing();
      throw error;
    }
    const head = await ctx.db.node.findUnique({
      where: { id },
      select: { id: true, memoryId: true, nodeType: true, deletedAt: true },
    });
    if (!head || head.deletedAt || head.nodeType !== COMMENT_NODE_TYPE) throw commentMissing();
    if (await isMemoryReadableCached(ctx, head.memoryId)) {
      return deleteCommentReadable(ctx, head, authorKey, args.expectedRevision);
    }
    return deleteOwnCommentWithoutAccess(ctx, head, authorKey, args.expectedRevision);
  },

  /** Resolve a thread: its author or any writer of the memory. */
  resolveCommentThread: async (_: unknown, args: { commentRef: string; expectedRevision: number }, ctx: Context) =>
    changeComment(ctx, args.commentRef, 'write', 'resolve', (row, actorKey) => {
      const meta = row.commentMeta!;
      requireTopLevel(meta);
      refuseStub(meta);
      if (meta.threadState === 'RESOLVED') throw commentError('COMMENT_THREAD_STATE', 'The thread is already resolved.', { state: 'RESOLVED' });
      return { patch: {}, meta: { threadState: 'RESOLVED', resolvedAt: new Date(), resolvedBy: actorKey } };
    }, args.expectedRevision),

  /** Reopen a resolved thread: its author or any writer of the memory. */
  reopenCommentThread: async (_: unknown, args: { commentRef: string; expectedRevision: number }, ctx: Context) =>
    changeComment(ctx, args.commentRef, 'write', 'reopen', (row) => {
      const meta = row.commentMeta!;
      requireTopLevel(meta);
      refuseStub(meta);
      if (meta.threadState === 'OPEN') throw commentError('COMMENT_THREAD_STATE', 'The thread is already open.', { state: 'OPEN' });
      return { patch: {}, meta: { threadState: 'OPEN', resolvedAt: null, resolvedBy: null } };
    }, args.expectedRevision),

  /**
   * A memory admin deletes a whole thread (soft): the root and every reply
   * leave every read, limit and check. The rows stay (soft-deleted) for
   * audit; a comment keeps no revision history (#1721).
   */
  deleteCommentThread: async (_: unknown, args: { commentRef: string; reason: string }, ctx: Context): Promise<boolean> => {
    const reason = validateReason(args.reason);
    const { authorKey, node, key } = await prepareWrite(ctx, args.commentRef, 'comment', 'moderate');
    await commentTx(ctx, node.memoryId, 'moderate', async (tx, txCtx) => {
      const { root } = await lockInThread(tx, node.id, node.memoryId);
      await reviseComment(tx, txCtx, root, key, 'delete-thread', authorKey, { data: { deleteReason: reason } });
      await deleteThreadsInTx(tx, [root.id], { actorKey: authorKey, deletedBy: actorCreatedBy(txCtx), cause: 'ADMIN' });
    });
    return true;
  },
};

/**
 * #1663 review — whether `nodeId` is a stub whose revision history the caller
 * may not read: memory managers alone. Every revision read surface
 * (nodeRevisions, nodeRevision, a noderev URN) asks this. #1721: comments
 * write no revisions any more, so this guards only revisions written before.
 */
export async function isConcealedCommentHistory(ctx: Context, nodeId: string): Promise<boolean> {
  const row = await ctx.db.node.findUnique({
    where: { id: nodeId },
    select: { nodeType: true, memoryId: true, commentMeta: { select: { retractedAt: true } } },
  });
  if (row?.nodeType !== COMMENT_NODE_TYPE || !row.commentMeta) return false;
  if (!row.commentMeta.retractedAt) return false;
  try {
    await mayModerate(ctx, row.memoryId);
    return false;
  } catch (error) {
    if (error instanceof GraphQLError && error.extensions.code === 'COMMENT_ADMIN_REQUIRED') return true;
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Reads

export const commentQueries = {
  /** The discussion on a node, newest thread first (`cor:dmo:110:02` read gate). */
  commentThreads: async (
    _: unknown,
    args: { targetRef: string; state?: Array<'OPEN' | 'RESOLVED'> | null; limit?: number | null; offset?: number | null },
    ctx: Context,
  ) => {
    const target = await resolveReadableNode(ctx, args.targetRef, targetMissing);
    if (target.nodeType === COMMENT_NODE_TYPE) {
      throw commentError('COMMENT_TARGET_IS_COMMENT', 'A comment has no threads of its own; read its thread through its target.');
    }
    const limit = Math.min(Math.max(args.limit ?? 50, 0), 200);
    const offset = Math.max(args.offset ?? 0, 0);
    const where: Prisma.CommentMetaWhereInput = {
      targetNodeId: target.id,
      threadRootId: null,
      node: { deletedAt: null },
      ...(args.state?.length ? { threadState: { in: args.state } } : {}),
    };
    const [total, roots] = await Promise.all([
      ctx.db.commentMeta.count({ where }),
      ctx.db.commentMeta.findMany({ where, orderBy: [{ createdAt: 'desc' }, { nodeId: 'desc' }], skip: offset, take: limit, select: { nodeId: true } }),
    ]);
    if (roots.length === 0) return { items: [], total };
    const key = await keyForMemory(ctx.db, target.memoryId);
    const rootIds = roots.map((r) => r.nodeId);
    // The first REPLIES_PER_THREAD replies of each thread, oldest first, in one
    // query (#1663 review P3: bounded); replyCount stays exact.
    const replies = await ctx.db.$queryRaw<Array<{ node_id: string; thread_root_id: string }>>`
      SELECT node_id, thread_root_id FROM (
        SELECT cm.node_id, cm.thread_root_id,
          row_number() OVER (PARTITION BY cm.thread_root_id ORDER BY cm.created_at, cm.node_id) AS n
        FROM comment_meta cm JOIN nodes nd ON nd.id = cm.node_id
        WHERE cm.thread_root_id = ANY(${rootIds}::text[]) AND nd.deleted_at IS NULL
      ) ranked WHERE n <= ${REPLIES_PER_THREAD} ORDER BY thread_root_id, n`;
    const counts = await ctx.db.commentMeta.groupBy({
      by: ['threadRootId'],
      where: { threadRootId: { in: rootIds }, node: { deletedAt: null } },
      _count: { _all: true },
    });
    const countOf = new Map(counts.map((c) => [c.threadRootId, c._count._all]));
    const views = await loadCommentViews(ctx.db, [...rootIds, ...replies.map((r) => r.node_id)], key);
    const viewOfId = new Map(views.map((v) => [v.id, v]));
    const items = rootIds.flatMap((rootId) => {
      const root = viewOfId.get(rootId);
      if (!root) return [];
      const threadReplies = replies.filter((r) => r.thread_root_id === rootId).map((r) => viewOfId.get(r.node_id)).filter((v): v is CommentView => v != null);
      return [{ root, replies: threadReplies, replyCount: countOf.get(rootId) ?? 0 }];
    });
    return { items, total };
  },

  /** One comment by id or URN; null when missing, deleted or unreadable. */
  comment: async (_: unknown, args: { ref: string }, ctx: Context): Promise<CommentView | null> => {
    let node: { id: string; memoryId: string; nodeType: string };
    try {
      node = await resolveReadableNode(ctx, args.ref, commentMissing);
    } catch (error) {
      if (error instanceof GraphQLError && error.extensions.code === 'COMMENT_NOT_FOUND') return null;
      throw error;
    }
    if (node.nodeType !== COMMENT_NODE_TYPE) return null;
    const key = await keyForMemory(ctx.db, node.memoryId);
    const [view] = await loadCommentViews(ctx.db, [node.id], key);
    return view ?? null;
  },
};

// ---------------------------------------------------------------------------
// Field resolvers

export type CommentActorRef = { id: string; name: string | null; handle: string | null; urn: string | null };

const actorRefCaches = new WeakMap<Context, Map<string, Promise<CommentActorRef | null>>>();

/** A public projection of one user / worker / agent / App, memoized per request. Never the full object (#552). */
export function loadCommentActor(ctx: Context, kind: 'user' | 'worker' | 'agent' | 'app', id: string): Promise<CommentActorRef | null> {
  let cache = actorRefCaches.get(ctx);
  if (!cache) actorRefCaches.set(ctx, (cache = new Map()));
  const cacheKey = `${kind}:${id}`;
  let pending = cache.get(cacheKey);
  if (!pending) {
    pending = (async (): Promise<CommentActorRef | null> => {
      if (kind === 'worker' || kind === 'agent') {
        const ref = await loadActorRef(ctx, kind, id);
        return ref ? { id: ref.id, name: ref.name, handle: null, urn: ref.urn } : null;
      }
      if (kind === 'user') {
        const user = await ctx.db.user.findUnique({ where: { id }, select: { id: true, name: true, handle: true } });
        return user ? { id: user.id, name: user.name, handle: user.handle, urn: null } : null;
      }
      const app = await ctx.db.app.findUnique({ where: { id }, select: { id: true, name: true, urn: true } });
      return app ? { id: app.id, name: app.name, handle: null, urn: safeCanonicalUrn('app', app.urn) } : null;
    })();
    cache.set(cacheKey, pending);
  }
  return pending;
}

/** Resolve an actor key (`w:` / `ua:` / `u:` / `app:`) to the ref that names it. */
async function actorOfKey(ctx: Context, key: string | null): Promise<CommentActorRef | null> {
  if (!key) return null;
  const parsed = parseAuthorKey(key);
  switch (parsed.kind) {
    case 'WORKER': return loadCommentActor(ctx, 'worker', parsed.workerId);
    case 'USER':
    case 'USER_AGENT': return loadCommentActor(ctx, 'user', parsed.userId);
    case 'APP': return loadCommentActor(ctx, 'app', parsed.appId);
  }
}

export const commentFieldResolvers = {
  Comment: {
    urn: (c: CommentView, _: unknown, ctx: Context) => resolveNodeUrnField(c, ctx),
    portalUrl: async (c: CommentView, _: unknown, ctx: Context) => portalUrlForUrn(await resolveNodeUrnField(c, ctx)),
    target: async (c: CommentView, _: unknown, ctx: Context) => ({
      id: c.target.id,
      urn: await resolveNodeUrnField(c.target, ctx),
      name: c.target.name,
      nodeType: c.target.nodeType,
      revSeq: c.target.revSeq,
    }),
    anchorIsCurrent: (c: CommentView) => c.anchorRevision === c.target.revSeq,
    resolvedBy: (c: CommentView, _: unknown, ctx: Context) => actorOfKey(ctx, c.resolvedByKey),
    editedBy: (c: CommentView, _: unknown, ctx: Context) => actorOfKey(ctx, c.editedByKey),
    deletedBy: (c: CommentView, _: unknown, ctx: Context) => actorOfKey(ctx, c.deletedByKey),
    author: async (c: CommentView, _: unknown, ctx: Context) => {
      const parsed = parseAuthorKey(c.authorKey);
      switch (parsed.kind) {
        case 'WORKER':
          return { kind: 'WORKER', worker: await loadCommentActor(ctx, 'worker', parsed.workerId), user: null, agent: null, app: null };
        case 'USER_AGENT':
          return {
            kind: 'USER_AGENT',
            worker: null,
            user: await loadCommentActor(ctx, 'user', parsed.userId),
            agent: await loadCommentActor(ctx, 'agent', parsed.agentId),
            app: null,
          };
        case 'USER':
          return { kind: 'USER', worker: null, user: await loadCommentActor(ctx, 'user', parsed.userId), agent: null, app: null };
        case 'APP':
          return { kind: 'APP', worker: null, user: null, agent: null, app: await loadCommentActor(ctx, 'app', parsed.appId) };
      }
    },
    viewerIsAuthor: (c: CommentView, _: unknown, ctx: Context) => !ctx.impersonation && authorKeyOf(ctx) === c.authorKey,
    /** Worker comments only, and only for memory writers (DAB, #6989): the binding user, as provenance. */
    provenanceUser: async (c: CommentView, _: unknown, ctx: Context) => {
      if (!c.authorKey.startsWith('w:') || !c.createdBy) return null;
      if (ctx.impersonation || !(await canWriteCached(ctx, c.memoryId))) return null;
      return loadCommentActor(ctx, 'user', c.createdBy);
    },
  },
  /** #1607 — the warning row's node URN, from its loc + memory (the same string as Node.urn). */
  UnresolvedFeedback: {
    urn: (r: { loc: string; memoryId: string }, _: unknown, ctx: Context) => resolveNodeUrnField(r, ctx),
  },
  /** The slim list node (memoryNodes) carries the same cue; the list already passed the memory read gate. */
  GraphNode: {
    openThreads: async (n: { id: string }, _: unknown, ctx: Context) => (await loadSummary(ctx, n.id)).openThreads,
  },
  Node: {
    /**
     * #1608 — a comment hit as its Comment view. The Node itself already passed
     * its memory's read gate, and a comment shares its target's memory.
     */
    asComment: async (n: { id: string; nodeType?: string; memoryId?: string }, _: unknown, ctx: Context): Promise<CommentView | null> => {
      if (n.nodeType !== undefined && n.nodeType !== COMMENT_NODE_TYPE) return null;
      const row = await ctx.db.node.findUnique({ where: { id: n.id }, select: { nodeType: true, memoryId: true } });
      if (row?.nodeType !== COMMENT_NODE_TYPE) return null;
      const [view] = await loadCommentViews(ctx.db, [n.id], await keyForMemory(ctx.db, row.memoryId));
      return view ?? null;
    },
    /** The trust cue (`cor:dmo:110:07`), batched per request. */
    commentSummary: async (n: { id: string }, _: unknown, ctx: Context) => {
      const [counts, viewerOpen] = await Promise.all([
        loadSummary(ctx, n.id),
        loadViewerOpen(ctx, n.id),
      ]);
      return { ...counts, viewerOpenThreadId: viewerOpen };
    },
  },
};

// Same-tick batching, the pattern of Node.approvalStatus: every Node in one
// response asks in the same tick, and one grouped query answers all of them.
type Batch<T> = { ids: Set<string>; flushed: boolean; result: Promise<Map<string, T>> };
const summaryBatches = new WeakMap<Context, Batch<{ openThreads: number; resolvedThreads: number; comments: number }>>();
const viewerBatches = new WeakMap<Context, Batch<string>>();

function batched<T>(
  store: WeakMap<Context, Batch<T>>,
  ctx: Context,
  id: string,
  run: (ids: string[]) => Promise<Map<string, T>>,
): Promise<T | undefined> {
  let batch = store.get(ctx);
  if (!batch || batch.flushed) {
    const ids = new Set<string>();
    const fresh = { ids, flushed: false } as Batch<T>;
    fresh.result = new Promise((resolve, reject) => {
      setImmediate(() => {
        fresh.flushed = true;
        run([...ids]).then(resolve, reject);
      });
    });
    store.set(ctx, fresh);
    batch = fresh;
  }
  batch.ids.add(id);
  return batch.result.then((m) => m.get(id));
}

async function loadSummary(ctx: Context, nodeId: string) {
  const counts = await batched(summaryBatches, ctx, nodeId, (ids) => openThreadCounts(ctx.db, ids));
  return counts ?? { openThreads: 0, resolvedThreads: 0, comments: 0 };
}

async function loadViewerOpen(ctx: Context, nodeId: string): Promise<string | null> {
  const key = ctx.impersonation ? null : authorKeyOf(ctx);
  if (!key) return null;
  return (await batched(viewerBatches, ctx, nodeId, (ids) => viewerOpenThreads(ctx.db, ids, key))) ?? null;
}
