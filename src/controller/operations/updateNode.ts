import type { Node } from '../../index.d.js';
import { createNode } from './createNode.js';

/**
 * Update an existing node: save to filesystem and upsert into the database.
 * This is identical to createNode since both use upsert semantics.
 */
export const updateNode = async (
  node: Partial<Node>,
): Promise<Node> => {
  return createNode(node);
};
