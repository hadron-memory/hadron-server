/**
 * #1606 — comment threads following their target's lifecycle (`cor:dmo:110:02`,
 * `110:05`), for the generic delete / restore / sync paths to call in their own
 * transactions:
 *
 *   - a soft delete of a target soft-deletes its live threads, marked
 *     `TARGET`, and restoring the target restores exactly those (never a
 *     thread an admin deleted);
 *   - a hard delete of a target (or a git-sync prune) hard-deletes its
 *     threads first. A path that forgets is refused by the database:
 *     governed edges refuse a delete while their comment exists.
 */
import type { Prisma } from '../../generated/prisma/index.js';
import { COMMENT_NODE_TYPE } from './index.js';

type Tx = Prisma.TransactionClient;

/**
 * Soft-delete live comment threads (root + replies) in the caller's
 * transaction. `rootIds` are top-level comment ids.
 */
export async function deleteThreadsInTx(
  tx: Tx,
  rootIds: string[],
  opts: { actorKey: string | null; deletedBy: string | null; cause: 'ADMIN' | 'TARGET'; at?: Date },
): Promise<number> {
  if (rootIds.length === 0) return 0;
  // Lock the roots first (#1663 review P3): replyToComment inserts a reply
  // only while holding its root's row lock, so no reply can commit between
  // the member read below and the delete, and survive under a deleted root.
  await tx.$queryRaw`SELECT id FROM nodes WHERE id = ANY(${rootIds}::text[]) ORDER BY id FOR UPDATE`;
  const members = await tx.commentMeta.findMany({
    where: { OR: [{ nodeId: { in: rootIds } }, { threadRootId: { in: rootIds } }], node: { deletedAt: null } },
    select: { nodeId: true },
  });
  const ids = members.map((m) => m.nodeId);
  if (ids.length === 0) return 0;
  const at = opts.at ?? new Date();
  await tx.node.updateMany({ where: { id: { in: ids } }, data: { deletedAt: at, deletedBy: opts.deletedBy } });
  await tx.commentMeta.updateMany({
    where: { nodeId: { in: ids } },
    data: { threadDeletedAt: at, threadDeletedBy: opts.actorKey ?? opts.deletedBy, threadDeletedCause: opts.cause },
  });
  return ids.length;
}

/** Soft-delete every live thread on the given targets (the target was soft-deleted). */
export async function softDeleteThreadsOfTargets(
  tx: Tx,
  targetIds: string[],
  opts: { deletedBy: string | null; at: Date },
): Promise<number> {
  if (targetIds.length === 0) return 0;
  const roots = await tx.commentMeta.findMany({
    where: { targetNodeId: { in: targetIds }, threadRootId: null, node: { deletedAt: null } },
    select: { nodeId: true },
  });
  return deleteThreadsInTx(tx, roots.map((r) => r.nodeId), { actorKey: null, deletedBy: opts.deletedBy, cause: 'TARGET', at: opts.at });
}

/**
 * Restore the threads a target's soft delete took with it (cause `TARGET`),
 * when the target is restored. Threads an admin deleted stay deleted.
 */
export async function restoreThreadsOfTargets(tx: Tx, targetIds: string[]): Promise<number> {
  if (targetIds.length === 0) return 0;
  const members = await tx.commentMeta.findMany({
    where: { targetNodeId: { in: targetIds }, threadDeletedCause: 'TARGET' },
    select: { nodeId: true },
  });
  const ids = members.map((m) => m.nodeId);
  if (ids.length === 0) return 0;
  await tx.node.updateMany({ where: { id: { in: ids } }, data: { deletedAt: null, deletedBy: null } });
  await tx.commentMeta.updateMany({
    where: { nodeId: { in: ids } },
    data: { threadDeletedAt: null, threadDeletedBy: null, threadDeletedCause: null },
  });
  return ids.length;
}

/** Hard-delete every comment (live or not) on the given targets, before the targets themselves go. */
export async function hardDeleteThreadsOfTargets(tx: Tx, targetIds: string[]): Promise<number> {
  if (targetIds.length === 0) return 0;
  const members = await tx.commentMeta.findMany({ where: { targetNodeId: { in: targetIds } }, select: { nodeId: true } });
  if (members.length === 0) return 0;
  // One statement, so replies and their roots go together (a reply's edge
  // targets its root; the governed-edge trigger allows a delete only once the
  // edge's source is gone).
  const res = await tx.node.deleteMany({ where: { id: { in: members.map((m) => m.nodeId) }, nodeType: COMMENT_NODE_TYPE } });
  return res.count;
}

/** The comment nodes among `ids` (for a generic path to refuse them). */
export async function commentIdsAmong(tx: Pick<Tx, 'node'>, ids: string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const rows = await tx.node.findMany({ where: { id: { in: ids }, nodeType: COMMENT_NODE_TYPE }, select: { id: true } });
  return rows.map((r) => r.id);
}
