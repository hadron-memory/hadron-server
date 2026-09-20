import { readdirSync, existsSync } from 'fs';
import { join } from 'path';
import type { Node } from '../../index.d.js';
import { InvalidNodeLocError, loadNodeFromFs } from './loadNodeFromFs.js';

interface FsGraph {
  name: string;
  ownerRepo: string;
  nodes: Partial<Node>[];
}

export interface GraphEdge {
  sourceId: string;
  /** Source node's loc — used to derive the edge loc at sync-write time. */
  sourceLoc: string;
  targetId: string;
  /** Relationship name (was `label`). */
  name: string | null;
  description?: string | null;
  isRunnable?: boolean | null;
  /** JSONLogic gating expression preserved through .node/ import. Null/undefined = always fires. */
  condition?: unknown;
  /** Edge resolution-order hook (lower fires first). */
  priority?: number;
}

/**
 * Load an entire graph from the filesystem.
 *
 * Supports two layouts:
 * 1. **Legacy**: directories with `.node/node.yaml` + `.node/topic.md`
 * 2. **Frontmatter (Obsidian vault)**: `.md` files with YAML frontmatter + optional `.name/edges.yaml` sidecars
 *
 * Both formats can coexist in the same graph.
 */
export const loadGraphFromFs = async (
  graphPath: string,
  graphName: string,
  ownerRepo: string,
): Promise<{ graph: FsGraph; edges: GraphEdge[]; skippedNodeIds: string[] }> => {
  const nodes: Partial<Node>[] = [];
  const edges: GraphEdge[] = [];
  // Frontmatter ids of files skipped for an unusable path (#1224). The caller
  // must keep these rows ALIVE: sync is repo-wins, so a row absent from the
  // loaded graph is hard-deleted, and a file renamed to an invalid name would
  // otherwise destroy the node instead of failing to move it.
  const skippedNodeIds: string[] = [];

  // Collect node sources: either directory paths (legacy) or .md file paths (frontmatter)
  const nodeSources: string[] = [];

  const walk = (dir: string) => {
    if (!existsSync(dir)) return;

    const entries = readdirSync(dir, { withFileTypes: true });

    // Legacy format: directory contains `.node/`
    const hasNodeDir = entries.some((e) => e.isDirectory() && e.name === '.node');
    if (hasNodeDir) {
      nodeSources.push(dir);
    }

    // Frontmatter format: `.md` files in this directory (not inside .node/)
    if (!hasNodeDir) {
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        if (!entry.name.endsWith('.md')) continue;
        if (entry.name.startsWith('.')) continue;
        nodeSources.push(join(dir, entry.name));
      }
    }

    // Continue walking subdirectories.
    // Walk .hadron/ but skip other hidden dirs, .node/ dirs, and node_modules.
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name === 'node_modules' || entry.name === '.node') continue;
      if (entry.name.startsWith('.') && entry.name !== '.hadron') continue;
      walk(join(dir, entry.name));
    }
  };

  walk(graphPath);

  // Load all discovered nodes
  for (const source of nodeSources) {
    try {
      const result = await loadNodeFromFs(source, graphPath, ownerRepo);
      nodes.push(result.node);

      for (const edge of result.edges) {
        edges.push({
          sourceId: result.node.id!,
          sourceLoc: result.node.loc!,
          targetId: edge.targetId,
          name: edge.name,
          ...(edge.description != null ? { description: edge.description } : {}),
          ...(edge.isRunnable != null ? { isRunnable: edge.isRunnable } : {}),
          ...(edge.condition !== undefined ? { condition: edge.condition } : {}),
          ...(edge.priority !== undefined ? { priority: edge.priority } : {}),
        });
      }
    } catch (err) {
      if (err instanceof InvalidNodeLocError && err.nodeId) skippedNodeIds.push(err.nodeId);
      console.warn(`Failed to load node at ${source}:`, (err as Error).message);
    }
  }

  return {
    graph: {
      name: graphName,
      ownerRepo,
      nodes,
    },
    edges,
    skippedNodeIds,
  };
};
