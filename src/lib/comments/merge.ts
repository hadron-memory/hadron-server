/**
 * #1664 (`cor:dmo:110:02`) — a memory merge carries comment threads with their
 * targets.
 *
 * `mergeMemories` is BATCHED: it relocates the source graph in bounded,
 * separately committed transactions. So a thread can't relocate as an ordinary
 * row (it could commit in a different batch than its target and break the
 * same-memory invariant). Comments are left out of the merge's own paging and
 * move IN THE SAME TRANSACTION as their target ({@link carryThreadsInTx}).
 *
 * What a merge cannot do is re-anchor: a comment is anchored to its target's
 * identity, immutably (`cor:dmo:110:01`). A source node that FOLDS into a
 * same-loc target node ceases to exist, so live threads on it refuse the merge
 * up front ({@link preflightMergeComments}). An admin deletes them first, as for a
 * move into a private memory; deleted threads go with the folded node.
 */
import type { Prisma, PrismaClient } from '../../generated/prisma/index.js';
import { COMMENTABLE_CLASSES, COMMENT_NODE_TYPE, commentError } from './index.js';

type Db = Pick<PrismaClient, '$queryRaw' | 'memory'> | Prisma.TransactionClient;

/**
 * Refuse a merge that cannot carry its live threads, BEFORE anything commits:
 * a destination class that can't hold comments (`COMMENT_MOVE_UNCOMMENTABLE`),
 * or a commented source node that would be folded (`COMMENT_MERGE_FOLDS_THREADS`).
 */
export async function preflightMergeComments(db: Db, sourceMemoryId: string, targetMemoryId: string): Promise<void> {
  const live = await db.$queryRaw<Array<{ id: string; loc: string; comments: bigint; folds: boolean }>>`
    SELECT t.id, t.loc, count(*) AS comments,
      EXISTS (SELECT 1 FROM nodes x WHERE x.memory_id = ${targetMemoryId} AND x.deleted_at IS NULL AND x.loc = t.loc) AS folds
    FROM comment_meta cm
    JOIN nodes c ON c.id = cm.node_id AND c.deleted_at IS NULL
    JOIN nodes t ON t.id = cm.target_node_id AND t.memory_id = ${sourceMemoryId} AND t.deleted_at IS NULL
    GROUP BY t.id, t.loc
    ORDER BY t.loc`;
  if (live.length === 0) return;
  const target = await db.memory.findUniqueOrThrow({ where: { id: targetMemoryId }, select: { class: true } });
  const row = (r: (typeof live)[number]) => ({ nodeId: r.id, loc: r.loc, comments: Number(r.comments) });
  if (!COMMENTABLE_CLASSES.has(target.class)) {
    throw commentError(
      'COMMENT_MOVE_UNCOMMENTABLE',
      `Cannot merge into a ${target.class} memory: ${live.length} node(s) have comment threads. An admin of the source memory deletes them first.`,
      { class: target.class, nodes: live.map(row) },
    );
  }
  const folding = live.filter((r) => r.folds);
  if (folding.length > 0) {
    throw commentError(
      'COMMENT_MERGE_FOLDS_THREADS',
      `Cannot merge: ${folding.length} commented node(s) would be folded into a same-loc node of the target and cease to exist, and a comment's anchor can't move to another node (cor:dmo:110:01). An admin deletes those threads first, or the node is renamed apart before the merge.`,
      { nodes: folding.map(row) },
    );
  }
}

/**
 * Move every thread (live or deleted) whose target is among `targetIds` into
 * `toMemoryId`, with its governed edges, inside the caller's transaction (the
 * one that moved the targets). Returns how many comment nodes moved.
 */
export async function carryThreadsInTx(tx: Prisma.TransactionClient, targetIds: string[], toMemoryId: string): Promise<number> {
  if (targetIds.length === 0) return 0;
  const ids = (await tx.commentMeta.findMany({ where: { targetNodeId: { in: targetIds } }, select: { nodeId: true } }))
    .map((m) => m.nodeId).sort();
  if (ids.length === 0) return 0;
  await tx.$queryRaw`SELECT id FROM nodes WHERE id = ANY(${ids}::text[]) ORDER BY id FOR UPDATE`;
  await tx.node.updateMany({ where: { id: { in: ids }, nodeType: COMMENT_NODE_TYPE }, data: { memoryId: toMemoryId } });
  await tx.edge.updateMany({ where: { sourceId: { in: ids }, governedKind: { not: null } }, data: { memoryId: toMemoryId } });
  return ids.length;
}

/**
 * The fold's own re-check, under its locks: a thread created on a node after
 * the preflight would be destroyed by the fold, so the fold refuses instead.
 */
export async function refuseLiveThreadsOnFold(tx: Prisma.TransactionClient, foldedIds: string[]): Promise<void> {
  if (foldedIds.length === 0) return;
  const live = await tx.commentMeta.findFirst({
    where: { targetNodeId: { in: foldedIds }, node: { deletedAt: null } },
    select: { target: { select: { loc: true } } },
  });
  if (live) {
    throw commentError(
      'COMMENT_MERGE_FOLDS_THREADS',
      `Cannot fold "${live.target.loc}": a comment thread was posted on it during the merge. Delete the thread, then resume the merge.`,
      { nodes: [{ loc: live.target.loc }] },
    );
  }
}
