import type { Node } from '../../index.d.js';
import { SOURCES_PATH } from '../../config.js';
import { db } from '../../integrations/db/client.js';
import { serializeTags } from '../../integrations/db/provider.js';
import { saveNodeToFs } from '../../integrations/localFs/saveNodeToFs.js';

/**
 * Create a new node: save to filesystem and upsert into the database.
 */
export const createNode = async (
  node: Partial<Node>,
): Promise<Node> => {
  if (!node.loc || !node.name || !node.ownerRepo) {
    throw new Error('Node requires loc, name, and ownerRepo');
  }

  // Save to filesystem
  const fsResult = await saveNodeToFs(node, SOURCES_PATH);
  if (fsResult.error) {
    console.warn(`Failed to save node to filesystem: ${fsResult.error}`);
  }

  // Derive namespace from loc
  const namespace = node.loc.split('.').slice(0, 2).join('.');

  // Upsert into database
  const saved = await db.node.upsert({
    where: { loc: node.loc },
    create: {
      loc: node.loc,
      name: node.name,
      alias: node.alias ?? null,
      description: node.description ?? null,
      content: node.content ?? null,
      tags: serializeTags(node.tags ?? []) as string[],
      namespace,
      ownerRepo: node.ownerRepo,
    },
    update: {
      name: node.name,
      alias: node.alias ?? null,
      description: node.description ?? null,
      content: node.content ?? null,
      tags: serializeTags(node.tags ?? []) as string[],
      namespace,
      ownerRepo: node.ownerRepo,
    },
    include: {
      outgoingEdges: { include: { target: true } },
      incomingEdges: { include: { source: true } },
    },
  });

  return saved as unknown as Node;
};
