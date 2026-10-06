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
 * edit, retract, resolve and reopen need WRITE access (`110:03`), and edit /
 * retract also the author; hide and thread delete need memory ADMIN. Every
 * gate is re-run under the memory's authority lock (`withAuthorizedMemoryTx`),
 * so a concurrent ownership transfer cannot slip a stale grant through.
 *
 * The target is never written (`110:06`): no path here updates its row.
 */
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
import { buildNodeRevisionSnapshot, createNodeRevision, editorFromAuth } from '../../../lib/nodeRevisionSnapshot.js';
import { approvalFieldsOf } from '../../../lib/nodeApproval.js';
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
  commentMeta: true,
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
  anchorApprovalHash: string;
  quote: string | null;
  body: string | null;
  state: 'OPEN' | 'RESOLVED' | null;
  retracted: boolean;
  retractedAt: Date | null;
  hidden: boolean;
  hiddenAt: Date | null;
  resolvedAt: Date | null;
  resolvedByKey: string | null;
  authorKey: string;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date | null;
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
    select: { id: true, loc: true, memoryId: true, name: true, nodeType: true, revSeq: true },
  });
  const targetOf = new Map(targets.map((t) => [t.id, t]));
  const byId = new Map<string, CommentView>();
  for (const row of metas) {
    const meta = row.commentMeta!;
    const anchor = anchorOf.get(meta.threadRootId ?? row.id);
    const target = targetOf.get(meta.targetNodeId);
    if (!anchor || !target) continue; // the DB invariants make this unreachable
    const { content, data } = decryptComment(row, key);
    const stub = meta.retractedAt != null || meta.hiddenAt != null;
    byId.set(row.id, {
      id: row.id,
      memoryId: row.memoryId,
      loc: row.loc,
      threadRootId: meta.threadRootId,
      isTopLevel: meta.threadRootId == null,
      anchorRevision: anchor.anchorRevNo!,
      anchorApprovalHash: anchor.anchorApprovalHash!,
      quote: stub ? null : data.quote ?? null,
      body: stub ? null : content,
      state: meta.threadState,
      retracted: meta.retractedAt != null,
      retractedAt: meta.retractedAt,
      hidden: meta.hiddenAt != null,
      hiddenAt: meta.hiddenAt,
      resolvedAt: meta.resolvedAt,
      resolvedByKey: meta.resolvedBy,
      authorKey: meta.authorKey,
      createdBy: row.createdBy,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      revSeq: row.revSeq,
      target,
    });
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

/** The moderation gate: memory admin (`cor:dmo:110:05`). */
async function mayModerate(ctx: Context, memoryId: string): Promise<void> {
  const memory = await ctx.db.memory.findUniqueOrThrow({
    where: { id: memoryId },
    select: { class: true, userId: true, organizationId: true, ownerUserId: true },
  });
  try {
    await requireMemoryManageAccess(ctx, memory, 'ADMIN');
  } catch (error) {
    if (isAuthorizationDenial(error)) {
      throw commentError('COMMENT_ADMIN_REQUIRED', 'Hiding a comment or deleting a thread needs memory admin.');
    }
    throw error;
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

/** The node data of a comment revision: its quote and reasons plus the operation that wrote it. */
function nextData(prior: Partial<CommentNodeData>, op: CommentOp, actorKey: string, patch: Partial<CommentNodeData> = {}): CommentNodeData {
  return {
    quote: prior.quote ?? null,
    ...(prior.hiddenReason ? { hiddenReason: prior.hiddenReason } : {}),
    ...(prior.deleteReason ? { deleteReason: prior.deleteReason } : {}),
    ...patch,
    lastAction: { op, by: actorKey, at: new Date().toISOString() },
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
      retractedAt: null, hiddenAt: null, threadDeletedAt: null,
    },
    select: { nodeId: true },
  });
  return commentError(
    'COMMENT_OPEN_THREAD_EXISTS',
    'You already have an open thread on this node: reply there, or resolve or retract it first.',
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
 * The target's title/abstract/content at `revision`, for the anchor hash:
 * the live row when it is current, else its retained snapshot.
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
  if (revision === target.revSeq) return approvalFieldsOf(target, key);
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
  if (sourceId === target.memoryId) return approvalFieldsOf(snapshot, key);
  // #1663 review (Atilla P2-3) — a snapshot captured in ANOTHER memory (before
  // a move) is anchored only when the caller may read that memory too, the
  // same per-snapshot gate as nodeRevisions. A cached key is not a grant.
  if (!(await isMemoryReadableFresh(txCtx, sourceId, tx))) throw unavailable();
  const source = await tx.memory.findUnique({ where: { id: sourceId }, select: { isEncrypted: true } });
  if (!source?.isEncrypted) return approvalFieldsOf(snapshot, null);
  const foreignKey = sessionKeyCache.getByMemoryId(sourceId);
  if (!foreignKey) throw unavailable();
  return approvalFieldsOf(snapshot, foreignKey);
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
    anchor: { revNo: number; hash: string } | null;
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
 * Record one comment-path change as a revision of the comment (`cor:dmo:110:05`):
 * snapshot the pre-change row, advance its revision, and write the new
 * content/data. Attribution (`editedBy*`, `updatedBy*`) comes from the request.
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
  const { content: priorContent, data: priorData } = decryptComment(row, key);
  const changes = ['data', ...(patch.content !== undefined && patch.content !== priorContent ? ['content'] : [])];
  const { commentMeta: _meta, ...snapshotRow } = row;
  await createNodeRevision(tx, buildNodeRevisionSnapshot(snapshotRow, editorFromAuth(ctx), { revLabel: op, changes }));
  const fields = encrypted({
    ...(patch.content !== undefined ? { content: patch.content } : {}),
    data: nextData(priorData, op, actorKey, patch.data) as unknown,
  }, key);
  await tx.node.update({
    where: { id: row.id },
    data: { ...fields, data: fields.data as Prisma.InputJsonValue, updatedBy: actorCreatedBy(ctx), ...extra },
  });
}

async function viewOf(ctx: Context, id: string, key: EncryptionKey | null): Promise<CommentView> {
  const [view] = await loadCommentViews(ctx.db, [id], key);
  if (!view) throw commentMissing();
  return view;
}

/**
 * Shared body of the single-comment state operations: resolve, lock, check
 * the revision and the op's own preconditions, write one revision.
 */
async function changeComment(
  ctx: Context,
  ref: string,
  gate: Gate,
  op: CommentOp,
  apply: (row: LockedComment, actorKey: string) => {
    patch: { content?: string | null; data?: Partial<CommentNodeData> };
    meta: Prisma.CommentMetaUpdateInput;
    targetRow?: 'root';
  },
  expectedRevision: number,
): Promise<CommentView> {
  const { authorKey, node, key } = await prepareWrite(ctx, ref, 'comment', gate);
  let metaForConflict: { targetNodeId: string; authorKey: string } | null = null;
  try {
    await commentTx(ctx, node.memoryId, gate, async (tx, txCtx) => {
      const row = await lockComment(tx, node.id, node.memoryId);
      metaForConflict = { targetNodeId: row.commentMeta!.targetNodeId, authorKey: row.commentMeta!.authorKey };
      requireRevision(row, expectedRevision);
      const change = apply(row, authorKey);
      await reviseComment(tx, txCtx, row, key, op, authorKey, change.patch);
      await tx.commentMeta.update({ where: { nodeId: row.id }, data: change.meta });
    });
  } catch (error) {
    if (metaForConflict && isOpenThreadUniqueViolation(error)) {
      const { targetNodeId, authorKey: owner } = metaForConflict;
      throw await openThreadConflict(ctx.db, targetNodeId, owner);
    }
    throw error;
  }
  return viewOf(ctx, node.id, key);
}

/**
 * #1663 review (Atilla/Dan/local P2) — retracting or hiding BLANKS the live
 * row's body and quote, so no generic read surface (node(ref:), lists, search,
 * MCP, export) can serve the text a stub conceals. The text survives only in
 * the comment's revision history (cor:dmo:110:05 "its history is kept"),
 * whose reads are gated to memory admins once the comment is a stub
 * ({@link isConcealedCommentHistory}).
 */
const STUB_PATCH = { content: null, data: { quote: null } } as const;

function refuseStub(meta: NonNullable<LockedComment['commentMeta']>): void {
  if (meta.hiddenAt) throw commentError('COMMENT_HIDDEN', 'This comment is hidden.');
  if (meta.retractedAt) throw commentError('COMMENT_RETRACTED', 'This comment is retracted.');
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
    const { authorKey, node: target, key } = await prepareWrite(ctx, args.targetRef, 'target', 'write');
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
        const hash = computeApprovalHash(await anchorFields(tx, txCtx, row, revision, key));
        const open = await tx.commentMeta.findFirst({
          where: {
            targetNodeId: row.id, authorKey, threadRootId: null, threadState: 'OPEN',
            retractedAt: null, hiddenAt: null, threadDeletedAt: null,
          },
          select: { nodeId: true },
        });
        if (open) {
          throw commentError('COMMENT_OPEN_THREAD_EXISTS',
            'You already have an open thread on this node: reply there, or resolve or retract it first.',
            { threadId: open.nodeId });
        }
        return insertComment(tx, txCtx, {
          memoryId: row.memoryId, targetNodeId: row.id, targetName: row.name, threadRootId: null,
          authorKey, body, quote, key, anchor: { revNo: revision, hash },
        });
      });
    } catch (error) {
      if (isOpenThreadUniqueViolation(error)) throw await openThreadConflict(ctx.db, target.id, authorKey);
      throw error;
    }
    return viewOf(ctx, id, key);
  },

  /**
   * Reply in a thread; `commentRef` may be any comment of it. A resolved
   * thread accepts replies and stays resolved (DAB, Holger, team chat #6989).
   */
  replyToComment: async (_: unknown, args: { commentRef: string; body: string }, ctx: Context): Promise<CommentView> => {
    const body = validateBody(args.body);
    const { authorKey, node, key } = await prepareWrite(ctx, args.commentRef, 'comment', 'write');
    const id = await commentTx(ctx, node.memoryId, 'write', async (tx, txCtx) => {
      const addressed = await lockComment(tx, node.id, node.memoryId);
      const rootId = addressed.commentMeta!.threadRootId ?? addressed.id;
      const root = rootId === addressed.id ? addressed : await lockComment(tx, rootId, node.memoryId);
      refuseStub(root.commentMeta!);
      const target = await tx.node.findUniqueOrThrow({ where: { id: root.commentMeta!.targetNodeId }, select: { name: true } });
      return insertComment(tx, txCtx, {
        memoryId: node.memoryId, targetNodeId: root.commentMeta!.targetNodeId, targetName: target.name,
        threadRootId: root.id, authorKey, body, quote: null, key, anchor: null,
      });
    });
    return viewOf(ctx, id, key);
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

  /** The author retracts a comment, leaving a stub; its history is kept. */
  retractComment: async (_: unknown, args: { commentRef: string; expectedRevision: number }, ctx: Context) =>
    changeComment(ctx, args.commentRef, 'write', 'retract', (row, actorKey) => {
      requireAuthor(row.commentMeta!, actorKey);
      refuseStub(row.commentMeta!);
      return { patch: STUB_PATCH, meta: { retractedAt: new Date(), retractedBy: actorKey } };
    }, args.expectedRevision),

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

  /** A memory admin hides an abusive comment, leaving a stub. */
  hideComment: async (_: unknown, args: { commentRef: string; reason: string; expectedRevision: number }, ctx: Context) => {
    const reason = validateReason(args.reason);
    return changeComment(ctx, args.commentRef, 'moderate', 'hide', (row, actorKey) => {
      if (row.commentMeta!.hiddenAt) throw commentError('COMMENT_HIDDEN', 'This comment is already hidden.');
      return { patch: { content: null, data: { quote: null, hiddenReason: reason } }, meta: { hiddenAt: new Date(), hiddenBy: actorKey } };
    }, args.expectedRevision);
  },

  /**
   * A memory admin deletes a whole thread (soft): the root and every reply
   * leave every read, limit and check; their history is kept for audit.
   */
  deleteCommentThread: async (_: unknown, args: { commentRef: string; reason: string }, ctx: Context): Promise<boolean> => {
    const reason = validateReason(args.reason);
    const { authorKey, node, key } = await prepareWrite(ctx, args.commentRef, 'comment', 'moderate');
    await commentTx(ctx, node.memoryId, 'moderate', async (tx, txCtx) => {
      const addressed = await lockComment(tx, node.id, node.memoryId);
      const rootId = addressed.commentMeta!.threadRootId ?? addressed.id;
      const root = rootId === addressed.id ? addressed : await lockComment(tx, rootId, node.memoryId);
      await reviseComment(tx, txCtx, root, key, 'delete-thread', authorKey, { data: { deleteReason: reason } });
      await deleteThreadsInTx(tx, [root.id], { actorKey: authorKey, deletedBy: actorCreatedBy(txCtx), cause: 'ADMIN' });
    });
    return true;
  },
};

/**
 * #1663 review — whether `nodeId` is a retracted or hidden comment whose
 * revision history the caller may not read. A stub's live row is blank; its
 * earlier text lives only in revisions, kept for audit (cor:dmo:110:05), so
 * once a comment is a stub its history is for memory admins alone. Every
 * revision read surface (nodeRevisions, nodeRevision, a noderev URN) asks this.
 */
export async function isConcealedCommentHistory(ctx: Context, nodeId: string): Promise<boolean> {
  const row = await ctx.db.node.findUnique({
    where: { id: nodeId },
    select: { nodeType: true, memoryId: true, commentMeta: { select: { retractedAt: true, hiddenAt: true } } },
  });
  if (row?.nodeType !== COMMENT_NODE_TYPE || !row.commentMeta) return false;
  if (!row.commentMeta.retractedAt && !row.commentMeta.hiddenAt) return false;
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

type CommentActorRef = { id: string; name: string | null; handle: string | null; urn: string | null };

const actorRefCaches = new WeakMap<Context, Map<string, Promise<CommentActorRef | null>>>();

/** A public projection of one user / worker / agent / App, memoized per request. Never the full object (#552). */
function loadCommentActor(ctx: Context, kind: 'user' | 'worker' | 'agent' | 'app', id: string): Promise<CommentActorRef | null> {
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
