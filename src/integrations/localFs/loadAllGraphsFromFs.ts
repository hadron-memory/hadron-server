import { join } from 'path';
import { existsSync } from 'fs';
import { loadGraphFromFs, type GraphEdge } from './loadGraphFromFs.js';

export interface LoadedGraph {
  graph: Awaited<ReturnType<typeof loadGraphFromFs>>['graph'];
  edges: GraphEdge[];
}

/**
 * Load all graphs from the filesystem based on the controller config.
 */
type GraphsInput = {
  graphs: Record<string, { source: string; path: string; version?: string; updatedAt?: string }>;
};

export const loadAllGraphsFromFs = async (
  sourcesPath: string,
  config: GraphsInput,
): Promise<LoadedGraph[]> => {
  const results: LoadedGraph[] = [];

  for (const [name, graphConf] of Object.entries(config.graphs)) {
    const graphPath = join(sourcesPath, graphConf.path);
    if (!existsSync(graphPath)) {
      console.warn(`Graph path not found, skipping: ${graphPath}`);
      continue;
    }

    // Derive ownerRepo from the git source URL
    // "git@github.com:micromentor-team/mmdata.git" → "micromentor-team/mmdata"
    const ownerRepo = extractOwnerRepo(graphConf.source);

    try {
      const result = await loadGraphFromFs(graphPath, name, ownerRepo);
      results.push(result);
      console.log(`Loaded graph "${name}": ${result.graph.nodes.length} nodes, ${result.edges.length} edges`);
    } catch (err) {
      console.error(`Failed to load graph "${name}":`, (err as Error).message);
    }
  }

  return results;
};

function extractOwnerRepo(gitUrl: string): string {
  // Handle SSH URLs: git@github.com:owner/repo.git
  const sshMatch = gitUrl.match(/:([^/]+\/[^/]+?)(?:\.git)?$/);
  if (sshMatch) return sshMatch[1];

  // Handle HTTPS URLs: https://github.com/owner/repo.git
  const httpsMatch = gitUrl.match(/github\.com\/([^/]+\/[^/]+?)(?:\.git)?$/);
  if (httpsMatch) return httpsMatch[1];

  return gitUrl;
}
