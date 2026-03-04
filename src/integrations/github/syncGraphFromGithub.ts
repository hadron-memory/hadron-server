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

    const ownerRepo = extractOwnerRepo(graphConf.source);

    // 1. Clone or pull the repo
    await gitSync(graphConf.source, graphPath);

    // 2. Load the graph from the filesystem
    const { graph, edges } = await loadGraphFromFs(graphPath, graphName, ownerRepo);

    // 3. Upsert all nodes and edges into the database (transactional)
    await db.$transaction(async (tx: Parameters<Parameters<typeof db.$transaction>[0]>[0]) => {
      const upsertedIds: string[] = [];

      // Upsert nodes by id (from YAML) — loc can change on move, id is stable.
      // After each node upsert, resolve any PendingEdges that were waiting for it.
      for (const node of graph.nodes) {
        const update = {
          loc: node.loc,
          name: node.name,
          alias: node.alias,
          description: node.description,
          content: node.content,
          contentHash: node.contentHash,
          tags: serializeTags(node.tags ?? []) as string[],
          namespace,
          ownerRepo,
        };
        await tx.node.upsert({
          where: { id: node.id },
          create: { id: node.id!, ...update },
          update,
        });
        upsertedIds.push(node.id!);

        // Resolve any cross-repo PendingEdges that were waiting for this node
        const pending = await tx.pendingEdge.findMany({ where: { targetId: node.id! } });
        for (const p of pending) {
          await tx.edge.upsert({
            where: { sourceId_targetId: { sourceId: p.sourceId, targetId: p.targetId } },
            create: { sourceId: p.sourceId, targetId: p.targetId, label: p.label },
            update: { label: p.label },
          });
          await tx.pendingEdge.delete({ where: { id: p.id } });
        }
      }

      // Delete nodes that were in this namespace+ownerRepo but are no longer in the sync set
      await tx.node.deleteMany({
        where: { namespace, ownerRepo, id: { notIn: upsertedIds } },
      });

      // Upsert edges — sourceId and targetId come directly from the YAML
      for (const edge of edges) {
        const targetExists = await tx.node.findUnique({
          where: { id: edge.targetId },
          select: { id: true },
        });
        if (targetExists) {
          // Target is in DB — create a real edge, clean up any pending record
          await tx.edge.upsert({
            where: { sourceId_targetId: { sourceId: edge.sourceId, targetId: edge.targetId } },
            create: { sourceId: edge.sourceId, targetId: edge.targetId, label: edge.label },
            update: { label: edge.label },
          });
          await tx.pendingEdge.deleteMany({
            where: { sourceId: edge.sourceId, targetId: edge.targetId },
          });
        } else {
          // Target not yet in DB — park as a pending edge until the target repo is synced
          await tx.pendingEdge.upsert({
            where: { sourceId_targetId: { sourceId: edge.sourceId, targetId: edge.targetId } },
            create: { sourceId: edge.sourceId, targetId: edge.targetId, label: edge.label },
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
