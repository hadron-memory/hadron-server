import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { stringify } from 'yaml';
import type { Node } from '../../index.d.js';

/**
 * Save a node to the filesystem.
 *
 * @param node        The node to save
 * @param sourcesPath Absolute path to the graphs root directory
 */
export const saveNodeToFs = async (
  node: Partial<Node>,
  sourcesPath: string,
): Promise<{ error?: string; written?: { yaml?: string; topic?: string } }> => {
  if (!node.loc) {
    return { error: 'Node has no loc' };
  }

  // #2731: what has reached disk so far, reported even when a later write throws.
  const written: { yaml?: string; topic?: string } = {};
  try {
    // Derive directory path: micromentor-org:mmdata:services → micromentor-org/mmdata/services
    const dirPath = join(sourcesPath, ...node.loc.split(':'));
    const nodeDir = join(dirPath, '.node');

    mkdirSync(nodeDir, { recursive: true });

    // Build node.yaml
    const meta: Record<string, unknown> = {
      id: node.id,
      name: node.name,
    };
    if (node.description) meta.description = node.description;
    if (node.alias) meta.alias = node.alias;
    if (node.tags && node.tags.length > 0) meta.tags = node.tags;

    const yaml = stringify(meta);
    writeFileSync(join(nodeDir, 'node.yaml'), yaml, 'utf-8');
    written.yaml = yaml;

    // Write topic.md
    if (node.content) {
      writeFileSync(join(nodeDir, 'topic.md'), node.content, 'utf-8');
      written.topic = node.content;
    }

    // #2731: what this call wrote, so a rollback removes only its own bytes.
    return { written };
  } catch (error) {
    return { error: (error as Error).message, written };
  }
};
