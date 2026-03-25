import { db } from '../../integrations/db/client.js';

/**
 * Load a graph from the database by name.
 * Returns the Graph record with its nodes.
 */
export const findGraph = async (name: string) => {
  const graph = await db.memory.findFirst({
    where: { name, deletedAt: null },
    include: {
      organization: true,
      nodes: {
        orderBy: { loc: 'asc' },
        include: {
          outgoingEdges: { include: { target: true } },
          incomingEdges: { include: { source: true } },
        },
      },
    },
  });

  return graph;
};
