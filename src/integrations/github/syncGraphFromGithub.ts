import { execFile as execFileCb } from 'child_process';
import { createDecipheriv } from 'crypto';
import { generateId } from '../../lib/id.js';
import { promisify } from 'util';
import { existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { GRAPHS_PATH } from '../../config.js';
import { loadGraphFromFs } from '../localFs/loadGraphFromFs.js';
import { db } from '../db/client.js';
import { serializeTags } from '../db/provider.js';
import { getInstallationToken, toHttpsUrl } from './githubApp.js';
import type { Memory, Organization } from '../../generated/prisma/index.js';

const execFile = promisify(execFileCb);

function decryptToken(ciphertext: string): string {
  const key = process.env.HADRON_ENCRYPTION_KEY;
  if (!key) throw new Error('HADRON_ENCRYPTION_KEY env var is required');
  const keyBuf = Buffer.from(key, 'hex');
  const buf = Buffer.from(ciphertext, 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const data = buf.subarray(28);
  const decipher = createDecipheriv('aes-256-gcm', keyBuf, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

export type MemoryWithOrg = Memory & { organization: Organization };

/**
 * Sync a memory from GitHub: clone/pull the repo, load nodes from filesystem,
 * and upsert them into the database.
 */
export const syncGraphFromGithub = async (
  graph: MemoryWithOrg,
): Promise<{ error?: string; nodeCount?: number }> => {
  try {
    const graphName = graph.urn;

    // DB-only mode — skip all git operations
    if (!graph.source) {
      console.log(`[syncGraphFromGithub] "${graphName}" is DB-only — skipping git sync`);
      return {};
    }

    // Update sync status to SYNCING
    await db.memory.update({
      where: { id: graph.id },
      data: { syncStatus: 'SYNCING', syncError: null },
    }).catch(() => {});

    const slug = graphName.includes(':') ? graphName.split(':').slice(1).join(':') : graphName;
    const localPath = join(GRAPHS_PATH, graph.organization.urn, slug);
    const ownerRepo = extractOwnerRepo(graph.source);

    // 1. Get installation token (requires GitHub App installation)
    if (!graph.organization.githubInstallationId) {
      console.warn(
        `[syncGraphFromGithub] "${graphName}" — skipping: organization "${graph.organization.urn}" has no githubInstallationId`,
      );
      return {};
    }

    // Build per-org credentials if available
    const org = graph.organization;
    const credentials = org.githubAppId && org.githubAppPrivateKeyEncrypted
      ? { appId: org.githubAppId, privateKeyPem: decryptToken(org.githubAppPrivateKeyEncrypted) }
      : undefined;

    const token = await getInstallationToken(graph.organization.githubInstallationId, credentials);
    const cloneUrl = toHttpsUrl(graph.source, token);

    // 2. Clone or pull the repo
    await gitSync(cloneUrl, localPath, graph.readBranch ?? undefined);

    // 3. Load the graph from the filesystem
    const { graph: fsGraph, edges } = await loadGraphFromFs(localPath, graphName, ownerRepo);

    // 4. Upsert all nodes and edges into the database (transactional)
    let pendingEdgeCount = 0;
    await db.$transaction(async (tx: Parameters<Parameters<typeof db.$transaction>[0]>[0]) => {
      const upsertedIds: string[] = [];

      for (const node of fsGraph.nodes) {
        const loc = node.loc!;
        const name = node.name!;
        const nodeId = node.id ?? generateId();
        const update = {
          loc,
          name,
          alias: node.alias ?? null,
          isLink: node.isLink ?? false,
          description: node.description ?? null,
          // Spec 031 — abstract round-trips through the importer. Already
          // normalized (trim-then-check) by loadNodeFromFs before reaching
          // here; just pass through.
          abstract: node.abstract ?? null,
          content: node.content ?? null,
          contentHash: node.contentHash ?? null,
          tags: serializeTags(node.tags ?? []) as string[],
          ownerRepo,
        };
        await tx.node.upsert({
          where: { loc_memoryId: { loc, memoryId: graph.id } },
          create: { id: nodeId, memoryId: graph.id, ...update },
          update,
        });
        upsertedIds.push(nodeId);

        // Resolve any cross-repo PendingEdges that were waiting for this node
        const pending = await tx.pendingEdge.findMany({ where: { targetId: nodeId } });
        for (const p of pending) {
          const label = p.label ?? '';
          await tx.edge.upsert({
            where: { sourceId_targetId_label: { sourceId: p.sourceId, targetId: p.targetId, label } },
            create: { id: generateId(), sourceId: p.sourceId, targetId: p.targetId, label },
            update: {},
          });
          await tx.pendingEdge.delete({ where: { id: p.id } });
        }
      }

      await tx.node.deleteMany({
        where: { ownerRepo, memoryId: graph.id, id: { notIn: upsertedIds } },
      });

      for (const edge of edges) {
        const label = edge.label ?? '';
        const targetExists = await tx.node.findUnique({
          where: { id: edge.targetId },
          select: { id: true },
        });
        if (targetExists) {
          await tx.edge.upsert({
            where: { sourceId_targetId_label: { sourceId: edge.sourceId, targetId: edge.targetId, label } },
            create: { id: generateId(), sourceId: edge.sourceId, targetId: edge.targetId, label },
            update: {},
          });
          await tx.pendingEdge.deleteMany({
            where: { sourceId: edge.sourceId, targetId: edge.targetId },
          });
        } else {
          await tx.pendingEdge.upsert({
            where: { sourceId_targetId: { sourceId: edge.sourceId, targetId: edge.targetId } },
            create: { id: generateId(), sourceId: edge.sourceId, targetId: edge.targetId, label: edge.label },
            update: { label: edge.label },
          });
          pendingEdgeCount++;
        }
      }
    });

    // 5. Record sync time and status
    await db.memory.update({
      where: { id: graph.id },
      data: { lastSyncedAt: new Date(), syncStatus: 'OK', syncError: null, pendingEdgeCount },
    }).catch(() => {});

    console.log(`Synced memory "${graphName}": ${fsGraph.nodes.length} nodes, ${edges.length} edges`);
    return { nodeCount: fsGraph.nodes.length };
  } catch (error) {
    // Update sync status to ERROR
    await db.memory.update({
      where: { id: graph.id },
      data: { syncStatus: 'ERROR', syncError: (error as Error).message },
    }).catch(() => {});
    console.error(`Failed to sync memory "${graph.name}":`, error);
    return { error: (error as Error).message };
  }
};

async function gitSync(cloneUrl: string, localPath: string, readBranch?: string): Promise<void> {
  if (existsSync(join(localPath, '.git'))) {
    // Update remote URL with fresh token before pulling
    await execFile('git', ['remote', 'set-url', 'origin', cloneUrl], { cwd: localPath });
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
