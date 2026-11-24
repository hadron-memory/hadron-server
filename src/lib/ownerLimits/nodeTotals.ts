/** The drift check and repair behind scripts/db/reconcile-memory-node-totals.ts (#5078). The truth is always the recount of `nodes`. */
import { Prisma, type PrismaClient } from '../../generated/prisma/index.js';

export interface NodeTotalDrift {
  memoryId: string;
  stored: bigint;
  counted: bigint;
}

/** Every memory whose stored figure differs from its recount, in one statement and so in one snapshot. A missing row counts as 0. */
export function findMemoryNodeTotalDrift(db: Pick<PrismaClient, '$queryRaw'>): Promise<NodeTotalDrift[]> {
  return db.$queryRaw<NodeTotalDrift[]>(Prisma.sql`
    SELECT m.id AS "memoryId", COALESCE(t.live_nodes, 0)::bigint AS stored, COALESCE(c.n, 0)::bigint AS counted
    FROM memories m
    LEFT JOIN memory_node_totals t ON t.memory_id = m.id
    LEFT JOIN (SELECT memory_id, count(*) AS n FROM nodes WHERE deleted_at IS NULL GROUP BY memory_id) c ON c.memory_id = m.id
    WHERE COALESCE(t.live_nodes, 0) <> COALESCE(c.n, 0)
    ORDER BY m.id`);
}

/**
 * Set one memory's figure to its recount. The total row is locked FIRST and the recount is a later statement of a READ COMMITTED
 * transaction: a writer that has already counted holds the row to its commit, so this waits and then sees its nodes; one that has not
 * counted yet waits for this and adds on top. `nodes` is never locked.
 */
export async function repairMemoryNodeTotal(db: Pick<PrismaClient, '$transaction'>, memoryId: string): Promise<void> {
  await db.$transaction(async (tx) => {
    // The memory may be gone since the scan; then there is nothing to repair.
    await tx.$executeRaw`
      INSERT INTO memory_node_totals (memory_id, live_nodes) SELECT id, 0 FROM memories WHERE id = ${memoryId}
      ON CONFLICT (memory_id) DO NOTHING`;
    await tx.$queryRaw`SELECT 1 FROM memory_node_totals WHERE memory_id = ${memoryId} FOR UPDATE`;
    await tx.$executeRaw`
      UPDATE memory_node_totals SET live_nodes = (SELECT count(*) FROM nodes WHERE memory_id = ${memoryId} AND deleted_at IS NULL)
      WHERE memory_id = ${memoryId}`;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 120_000 });
}
