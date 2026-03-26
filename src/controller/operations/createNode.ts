import type { Node } from '../../index.d.js';
import { GRAPHS_PATH } from '../../config.js';
import { generateId } from '../../lib/id.js';
import { db } from '../../integrations/db/client.js';
import { serializeTags } from '../../integrations/db/provider.js';
import { saveNodeToFs } from '../../integrations/localFs/saveNodeToFs.js';

/**
 * Create a new node: save to filesystem and upsert into the database.
 */
export const createNode = async (
  node: Partial<Node> & { memoryId: string },
): Promise<Node> => {
  if (!node.loc || !node.name || !node.memoryId) {
    throw new Error('Node requires loc, name, and memoryId');
  }

  // Save to filesystem
  const fsResult = await saveNodeToFs(node, GRAPHS_PATH);
  if (fsResult.error) {
    throw new Error(`Failed to save node to filesystem: ${fsResult.error}`);
  }

  const id = node.id ?? generateId();

  const saved = await db.node.upsert({
    where: { loc_memoryId: { loc: node.loc, memoryId: node.memoryId } },
    create: {
      id,
      memoryId: node.memoryId,
      loc: node.loc,
      name: node.name,
      alias: node.alias ?? null,
      description: node.description ?? null,
      content: node.content ?? null,
      contentHash: node.contentHash ?? null,
      tags: serializeTags(node.tags ?? []) as string[],
      ownerRepo: node.ownerRepo ?? null,
    },
    update: {
      name: node.name,
      alias: node.alias ?? null,
      description: node.description ?? null,
      content: node.content ?? null,
      contentHash: node.contentHash ?? null,
      tags: serializeTags(node.tags ?? []) as string[],
      ownerRepo: node.ownerRepo ?? null,
    },
    include: {
      outgoingEdges: { include: { target: true } },
      incomingEdges: { include: { source: true } },
    },
  });

  return saved as unknown as Node;
};
