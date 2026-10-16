import type { Prisma } from '../generated/prisma/index.js';

/**
 * #1647: the OTHER memories a hard delete of `affectedIds` would edit through its edge cascade. An edge is held by its
 * source's memory (`Edge.memoryId`), and removing it also changes the far endpoint's view, so both count. The caller
 * must be able to WRITE each one before it may pass `cascadeCrossMemoryEdges`: acknowledging the cascade is not
 * authority over a holding that is not the caller's (a strict-owner personal/private memory especially).
 */
export async function foreignEdgeMemoryIds(
  tx: Pick<Prisma.TransactionClient, 'edge'>,
  affectedIds: string[],
  memoryId: string,
): Promise<string[]> {
  const edges = await tx.edge.findMany({
    where: {
      OR: [
        { targetId: { in: affectedIds }, source: { memoryId: { not: memoryId } } },
        { sourceId: { in: affectedIds }, target: { memoryId: { not: memoryId } } },
      ],
    },
    select: { memoryId: true, source: { select: { memoryId: true } }, target: { select: { memoryId: true } } },
  });
  const out = new Set<string>();
  for (const e of edges) for (const id of [e.memoryId, e.source.memoryId, e.target.memoryId]) if (id !== memoryId) out.add(id);
  return [...out];
}
