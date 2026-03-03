import { execFile as execFileCb } from 'child_process';
import { promisify } from 'util';
import { existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { loadConfig, SOURCES_PATH, graphNameToNamespace } from '../../config.js';
import { loadGraphFromFs } from '../localFs/loadGraphFromFs.js';
import { db } from '../db/client.js';
import { serializeTags } from '../db/provider.js';

const execFile = promisify(execFileCb);

/**
 * Sync a graph from GitHub: clone/pull the repo, load nodes from filesystem,
 * and upsert them into the database.
 *
 * @param graphName Key from .hadron-controller.yaml, e.g. "micromentor-org/mmdata"
 */
export const syncGraphFromGithub = async (
  graphName: string,
): Promise<{ error?: string; nodeCount?: number }> => {
  try {
    const config = loadConfig();
    const graphConf = config.graphs[graphName];
    if (!graphConf) {
      return { error: `Graph "${graphName}" not found in config` };
    }

    const graphPath = join(SOURCES_PATH, graphConf.path);
    const namespace = graphNameToNamespace(graphName);

    // 1. Clone or pull the repo
    await gitSync(graphConf.source, graphPath);

    // 2. Load the graph from the filesystem
    const { graph, edges } = await loadGraphFromFs(graphPath, graphName, extractOwnerRepo(graphConf.source));

    // 3. Upsert all nodes and edges into the database (transactional)
    await db.$transaction(async (tx: Parameters<Parameters<typeof db.$transaction>[0]>[0]) => {
      // Delete existing nodes for this namespace + ownerRepo
      await tx.node.deleteMany({
        where: { namespace, ownerRepo: extractOwnerRepo(graphConf.source) },
      });

      // Create all nodes (use the graph's canonical namespace, not the node-derived one)
      for (const node of graph.nodes) {
        await tx.node.create({
          data: {
            loc: node.loc,
            name: node.name,
            alias: node.alias,
            description: node.description,
            content: node.content,
            tags: serializeTags(node.tags ?? []) as string[],
            namespace,
            ownerRepo: node.ownerRepo,
          },
        });
      }

      // Create edges (only where both source and target exist)
      for (const edge of edges) {
        const source = await tx.node.findUnique({ where: { loc: edge.sourceLoc } });
        const target = await tx.node.findUnique({ where: { loc: edge.targetLoc } });
        if (source && target) {
          await tx.edge.upsert({
            where: { sourceId_targetId: { sourceId: source.id, targetId: target.id } },
            create: { sourceId: source.id, targetId: target.id, label: edge.label },
            update: { label: edge.label },
          });
        }
      }
    });

    console.log(`Synced graph "${graphName}": ${graph.nodes.length} nodes, ${edges.length} edges`);
    return { nodeCount: graph.nodes.length };
  } catch (error) {
    console.error(`Failed to sync graph "${graphName}":`, error);
    return { error: (error as Error).message };
  }
};

async function gitSync(gitUrl: string, localPath: string): Promise<void> {
  if (existsSync(join(localPath, '.git'))) {
    // Pull latest changes
    await execFile('git', ['pull', '--ff-only'], { cwd: localPath });
  } else {
    // Clone the repo
    mkdirSync(dirname(localPath), { recursive: true });
    await execFile('git', ['clone', gitUrl, localPath]);
  }
}

function extractOwnerRepo(gitUrl: string): string {
  const sshMatch = gitUrl.match(/:([^/]+\/[^/]+?)(?:\.git)?$/);
  if (sshMatch) return sshMatch[1];

  const httpsMatch = gitUrl.match(/github\.com\/([^/]+\/[^/]+?)(?:\.git)?$/);
  if (httpsMatch) return httpsMatch[1];

  return gitUrl;
}
