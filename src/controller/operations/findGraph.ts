import type { HadronGraph, Node } from '../../index.d.js';
import { graphNameToNamespace } from '../../config.js';
import { db } from '../../integrations/db/client.js';

/**
 * Load a graph from the database by name.
 * The graph name maps to a namespace prefix.
 */
export const findGraph = async (
  name: string,
): Promise<HadronGraph | null> => {
  const namespace = graphNameToNamespace(name);

  const nodes = await db.node.findMany({
    where: { namespace },
    orderBy: { loc: 'asc' },
    include: {
      outgoingEdges: { include: { target: true } },
      incomingEdges: { include: { source: true } },
    },
  });

  if (nodes.length === 0) return null;

  const ownerRepo = nodes[0].ownerRepo;

  return {
    name,
    namespace,
    ownerRepo,
    nodes: nodes as unknown as Node[],
  };
};
