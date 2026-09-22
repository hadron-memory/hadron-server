import type { Prisma, PrismaClient } from '../generated/prisma/index.js';

type EdgeCounter = Pick<PrismaClient, 'edge'>;

/**
 * Count edge rows a hard-delete of `nodes` would cascade from another memory.
 * The candidate predicate stays in SQL through the endpoint relations, so a
 * bulk cleanup does not have to materialize an unbounded node-id list.
 */
export async function countCrossMemoryEdgesForNodeDelete(
  db: EdgeCounter,
  memoryId: string,
  nodes: Prisma.NodeWhereInput,
): Promise<number> {
  return db.edge.count({
    where: {
      OR: [
        { source: nodes, target: { memoryId: { not: memoryId } } },
        { target: nodes, source: { memoryId: { not: memoryId } } },
      ],
    },
  });
}
