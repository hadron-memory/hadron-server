import { execFile as execFileCb } from 'child_process';
import { promisify } from 'util';
import { existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { SOURCES_PATH, graphNameToNamespace } from '../../config.js';
import { loadGraphFromFs } from '../localFs/loadGraphFromFs.js';
import { db } from '../db/client.js';
import { serializeTags } from '../db/provider.js';
import { getInstallationToken, toHttpsUrl } from './githubApp.js';
import type { HadronGraph, Organization } from '../../generated/prisma/index.js';

const execFile = promisify(execFileCb);

export type GraphWithOrg = HadronGraph & { organization: Organization };

/**
 * Sync a graph from GitHub: clone/pull the repo, load nodes from filesystem,
 * and upsert them into the database.
 *
 * @param graph HadronGraph record (with organization included)
 */
export const syncGraphFromGithub = async (
  graph: GraphWithOrg,
): Promise<{ error?: string; nodeCount?: number }> => {
  try {
    const graphName = graph.name;

    // DB-only mode — skip all git operations
    if (!graph.source) {
      console.log(`[syncGraphFromGithub] "${graphName}" is DB-only — skipping git sync`);
      return {};
    }

    const namespace = graphNameToNamespace(graphName);
    const localPath = join(SOURCES_PATH, graph.organization.slug, graphName);
    const ownerRepo = extractOwnerRepo(graph.source);

    // 1. Get installation token (if org has GitHub App installed)
    let cloneUrl = graph.source;
    if (graph.organization.githubInstallationId) {
      const token = await getInstallationToken(graph.organization.githubInstallationId);
      cloneUrl = toHttpsUrl(graph.source, token);
    }

    // 2. Clone or pull the repo
    await gitSync(cloneUrl, localPath, graph.readBranch ?? undefined);

    // 3. Load the graph from the filesystem
    const { graph: fsGraph, edges } = await loadGraphFromFs(localPath, graphName, ownerRepo);

    // 4. Upsert all nodes and edges into the database (transactional)
    await db.$transaction(async (tx: Parameters<Parameters<typeof db.$transaction>[0]>[0]) => {
      const upsertedIds: string[] = [];

      // Upsert nodes by id (from YAML) — loc can change on move, id is stable.
      // After each node upsert, resolve any PendingEdges that were waiting for it.
      for (const node of fsGraph.nodes) {
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
          await tx.edge.upsert({
            where: { sourceId_targetId: { sourceId: edge.sourceId, targetId: edge.targetId } },
            create: { sourceId: edge.sourceId, targetId: edge.targetId, label: edge.label },
            update: { label: edge.label },
          });
          await tx.pendingEdge.deleteMany({
            where: { sourceId: edge.sourceId, targetId: edge.targetId },
          });
        } else {
          await tx.pendingEdge.upsert({
            where: { sourceId_targetId: { sourceId: edge.sourceId, targetId: edge.targetId } },
            create: { sourceId: edge.sourceId, targetId: edge.targetId, label: edge.label },
            update: { label: edge.label },
          });
        }
      }
    });

    // 5. Record sync time (best-effort — record may not exist in tests)
    await db.hadronGraph.update({
      where: { id: graph.id },
      data: { lastSyncedAt: new Date() },
    }).catch(() => {});

    console.log(`Synced graph "${graphName}": ${fsGraph.nodes.length} nodes, ${edges.length} edges`);
    return { nodeCount: fsGraph.nodes.length };
  } catch (error) {
    console.error(`Failed to sync graph "${graph.name}":`, error);
    return { error: (error as Error).message };
  }
};

async function gitSync(cloneUrl: string, localPath: string, readBranch?: string): Promise<void> {
  if (existsSync(join(localPath, '.git'))) {
    if (readBranch) {
      await execFile('git', ['checkout', readBranch], { cwd: localPath });
    }
    await execFile('git', ['pull', '--ff-only'], { cwd: localPath });
  } else {
    mkdirSync(dirname(localPath), { recursive: true });
    const cloneArgs = ['clone'];
    if (readBranch) cloneArgs.push('--branch', readBranch);
    cloneArgs.push(cloneUrl, localPath);
    await execFile('git', cloneArgs);
  }
}

function extractOwnerRepo(gitUrl: string): string {
  const sshMatch = gitUrl.match(/:([^/]+\/[^/]+?)(?:\.git)?$/);
  if (sshMatch) return sshMatch[1];

  const httpsMatch = gitUrl.match(/github\.com\/([^/]+\/[^/]+?)(?:\.git)?$/);
  if (httpsMatch) return httpsMatch[1];

  return gitUrl;
}
