/**
 * #1606 / #1607 — counting open feedback (`cor:dmo:110:07`): the per-node
 * summary behind `Node.commentSummary` and the `unresolvedFeedback` warning on
 * mint and approve-all reports. Only LIVE comments count (a deleted thread is
 * gone from every read and check, `cor:dmo:110:05`).
 *
 * An OPEN thread is a live top-level comment in state OPEN that is neither
 * a deleted-with-replies stub: the same predicate as the one-open-thread index.
 */
import type { Prisma, PrismaClient } from '../../generated/prisma/index.js';

type Db = Pick<PrismaClient, '$queryRaw'> | Prisma.TransactionClient;

export type CommentCounts = { openThreads: number; resolvedThreads: number; comments: number };

/** Per-target counts for the given node ids; targets with no comments are absent. */
export async function openThreadCounts(db: Db, targetIds: string[]): Promise<Map<string, CommentCounts>> {
  if (targetIds.length === 0) return new Map();
  const rows = await db.$queryRaw<Array<{ target_node_id: string; open: bigint; resolved: bigint; comments: bigint }>>`
    SELECT cm.target_node_id,
      count(*) FILTER (WHERE cm.thread_root_id IS NULL AND cm.thread_state = 'OPEN'
                       AND cm.retracted_at IS NULL) AS open,
      count(*) FILTER (WHERE cm.thread_root_id IS NULL AND cm.thread_state = 'RESOLVED') AS resolved,
      count(*) AS comments
    FROM comment_meta cm JOIN nodes n ON n.id = cm.node_id
    WHERE cm.target_node_id = ANY(${targetIds}) AND n.deleted_at IS NULL
    GROUP BY cm.target_node_id`;
  return new Map(rows.map((r) => [r.target_node_id, {
    openThreads: Number(r.open), resolvedThreads: Number(r.resolved), comments: Number(r.comments),
  }]));
}

/** The caller's own open thread per target (at most one each, by the unique index). */
export async function viewerOpenThreads(db: Db, targetIds: string[], authorKey: string): Promise<Map<string, string>> {
  if (targetIds.length === 0) return new Map();
  const rows = await db.$queryRaw<Array<{ target_node_id: string; node_id: string }>>`
    SELECT cm.target_node_id, cm.node_id
    FROM comment_meta cm JOIN nodes n ON n.id = cm.node_id
    WHERE cm.target_node_id = ANY(${targetIds}) AND cm.author_key = ${authorKey}
      AND cm.thread_root_id IS NULL AND cm.thread_state = 'OPEN'
      AND cm.retracted_at IS NULL AND n.deleted_at IS NULL`;
  return new Map(rows.map((r) => [r.target_node_id, r.node_id]));
}

/** One `UnresolvedFeedback` row; `urn` is resolved by the GraphQL field resolver from loc + memory. */
export type UnresolvedFeedbackRow = { nodeId: string; loc: string; memoryId: string; openThreads: number };

/**
 * #1607 — the `unresolvedFeedback` warning rows for the given nodes: those
 * with at least one open thread, ordered by loc. A warning, never a blocker.
 */
export async function unresolvedFeedbackOf(
  db: Db,
  nodes: Array<{ id: string; loc: string }>,
): Promise<Array<{ nodeId: string; loc: string; openThreads: number }>> {
  const counts = await openThreadCounts(db, nodes.map((n) => n.id));
  return nodes
    .filter((n) => (counts.get(n.id)?.openThreads ?? 0) > 0)
    .map((n) => ({ nodeId: n.id, loc: n.loc, openThreads: counts.get(n.id)!.openThreads }))
    .sort((a, b) => (a.loc < b.loc ? -1 : a.loc > b.loc ? 1 : 0));
}
