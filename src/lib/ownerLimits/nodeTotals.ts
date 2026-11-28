/** The drift check and repair behind scripts/db/reconcile-memory-node-totals.ts (#5078). The truth is always the recount of `nodes`. */
import { Prisma, type PrismaClient } from '../../generated/prisma/index.js';

export interface NodeTotalDrift {
  memoryId: string;
  /** The stored figure: the total plus its pending rows. */
  stored: bigint;
  counted: bigint;
  /** Committed pending rows. Another transaction's live rows are never visible, so each one is left over. */
  pending: bigint;
}

/**
 * Every memory whose stored figure differs from its recount, or that has left-over pending rows, in one statement and so in one snapshot.
 * A missing total counts as 0. A pending row of a memory that no longer exists is reported too.
 */
export function findMemoryNodeTotalDrift(db: Pick<PrismaClient, '$queryRaw'>): Promise<NodeTotalDrift[]> {
  return db.$queryRaw<NodeTotalDrift[]>(Prisma.sql`
    SELECT i.id AS "memoryId", (COALESCE(t.live_nodes, 0) + COALESCE(p.n, 0))::bigint AS stored, COALESCE(c.n, 0)::bigint AS counted,
           COALESCE(p.rows, 0)::bigint AS pending
    FROM (SELECT id FROM memories UNION SELECT memory_id FROM memory_node_pending) i
    LEFT JOIN memory_node_totals t ON t.memory_id = i.id
    LEFT JOIN (SELECT memory_id, sum(delta) AS n, count(*) AS rows FROM memory_node_pending GROUP BY memory_id) p ON p.memory_id = i.id
    LEFT JOIN (SELECT memory_id, count(*) AS n FROM nodes WHERE deleted_at IS NULL GROUP BY memory_id) c ON c.memory_id = i.id
    WHERE COALESCE(t.live_nodes, 0) <> COALESCE(c.n, 0) OR p.rows > 0
    ORDER BY i.id`);
}

/**
 * Set one memory's total to its recount and clear its left-over pending rows. The total row is locked FIRST and the recount is a later
 * statement of a READ COMMITTED transaction: a writer that has folded its change holds the row to its commit, so this waits and then sees
 * its nodes; one that has not folded yet waits for this and adds on top. `nodes` is never locked.
 */
export async function repairMemoryNodeTotal(db: Pick<PrismaClient, '$transaction'>, memoryId: string): Promise<void> {
  await db.$transaction(async (tx) => {
    // The memory may be gone; then only its pending rows are cleared.
    await tx.$executeRaw`
      INSERT INTO memory_node_totals (memory_id, live_nodes) SELECT id, 0 FROM memories WHERE id = ${memoryId}
      ON CONFLICT (memory_id) DO NOTHING`;
    await tx.$queryRaw`SELECT 1 FROM memory_node_totals WHERE memory_id = ${memoryId} FOR UPDATE`;
    await tx.$executeRaw`DELETE FROM memory_node_pending WHERE memory_id = ${memoryId}`;
    await tx.$executeRaw`
      UPDATE memory_node_totals SET live_nodes = (SELECT count(*) FROM nodes WHERE memory_id = ${memoryId} AND deleted_at IS NULL)
      WHERE memory_id = ${memoryId}`;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 120_000 });
}
