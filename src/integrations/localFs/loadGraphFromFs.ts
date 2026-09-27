import { readdirSync, existsSync } from 'fs';
import { join } from 'path';
import { InvalidNodeLocError, loadNodeFromFs, type LoadedNode } from './loadNodeFromFs.js';

interface FsGraph {
  name: string;
  ownerRepo: string;
  nodes: LoadedNode[];
}

/**
 * A file the loader could not address (#1224) — its path does not derive a
 * valid loc.
 *
 * `nodeId` is the file's FRONTMATTER id and may be absent (an id-less file is
 * accepted by this loader) or name a row in another memory. The caller must
 * therefore RESOLVE it against this memory rather than trust it, and treat an
 * unresolvable entry as "a row I cannot vouch for" — see the deletion pass in
 * `syncGraphFromGithub`.
 */
export interface SkippedFile {
  /** Absolute path of the file, for an operator who has to go rename it. */
  source: string;
  /** The file's frontmatter id, if it carried one. */
  nodeId?: string;
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
): Promise<{ graph: FsGraph; edges: GraphEdge[]; skippedInvalidLoc: SkippedFile[] }> => {
  const nodes: LoadedNode[] = [];
  const edges: GraphEdge[] = [];
  // Files skipped for an unusable path (#1224). The caller must keep the rows
  // they name ALIVE: sync is repo-wins, so a row absent from the loaded graph
  // is hard-deleted, and a file renamed to an invalid name would otherwise
  // destroy the node instead of failing to move it.
  //
  // Scoped to THIS failure class on purpose. Every other load failure (broken
  // YAML, an unreadable file) keeps its pre-existing behaviour — the row is
  // cleaned up — because widening that here would change how a class of
  // failures this PR is not about behaves, silently.
  const skippedInvalidLoc: SkippedFile[] = [];

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
      if (err instanceof InvalidNodeLocError) {
        // Recorded even WITHOUT an id: an id-less skip is the case the caller
        // most needs to hear about, because it is the one it cannot protect.
        skippedInvalidLoc.push({ source: err.source, ...(err.nodeId ? { nodeId: err.nodeId } : {}) });
      }
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
    skippedInvalidLoc,
  };
};
