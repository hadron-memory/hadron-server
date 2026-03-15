import { readdirSync, statSync, existsSync } from 'fs';
import { join } from 'path';
import type { Node } from '../../index.d.js';

interface FsGraph {
  name: string;
  namespace: string;
  ownerRepo: string;
  nodes: Partial<Node>[];
}
import { loadNodeFromFs } from './loadNodeFromFs.js';

export interface GraphEdge {
  sourceId: string;
  targetId: string;
  label: string;
}

/**
 * Load an entire graph from the filesystem by recursively walking for `.node/` dirs.
 *
 * @param graphPath Absolute path to the graph root directory
 * @param graphName Graph name (config key), e.g. "micromentor-org/mmdata"
 * @param ownerRepo GitHub repo slug, e.g. "micromentor-team/mmdata"
 */
export const loadGraphFromFs = async (
  graphPath: string,
  graphName: string,
  ownerRepo: string,
): Promise<{ graph: FsGraph; edges: GraphEdge[] }> => {
  const namespace = graphName.replace(/\//g, '.');
  const nodes: Partial<Node>[] = [];
  const edges: GraphEdge[] = [];

  // Recursively find directories containing `.node/`
  const walk = (dir: string) => {
    if (!existsSync(dir)) return;

    const entries = readdirSync(dir, { withFileTypes: true });
    const hasNodeDir = entries.some((e) => e.isDirectory() && e.name === '.node');

    if (hasNodeDir) {
      // This directory is a node — load it synchronously via the async fn
      // We'll collect promises and resolve them after the walk
      nodeDirs.push(dir);
    }

    // Continue walking subdirectories.
    // Walk .hadron/ (where node graphs live in project repos) but skip all other
    // hidden dirs, .node/ subdirs (leaf data only), and node_modules.
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name === 'node_modules' || entry.name === '.node') continue;
      if (entry.name.startsWith('.') && entry.name !== '.hadron') continue;
      walk(join(dir, entry.name));
    }
  };

  const nodeDirs: string[] = [];
  walk(graphPath);

  // Load all discovered nodes
  for (const dir of nodeDirs) {
    try {
      const result = await loadNodeFromFs(dir, graphPath, ownerRepo);
      nodes.push(result.node);

      // Map edges: source is this node's id
      for (const edge of result.edges) {
        edges.push({
          sourceId: result.node.id!,
          targetId: edge.targetId,
          label: edge.label,
        });
      }
    } catch (err) {
      console.warn(`Failed to load node at ${dir}:`, (err as Error).message);
    }
  }

  return {
    graph: {
      name: graphName,
      namespace,
      ownerRepo,
      nodes,
    },
    edges,
  };
};
