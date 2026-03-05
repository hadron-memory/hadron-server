import { execFile as execFileCb } from 'child_process';
import { promisify } from 'util';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { stringify } from 'yaml';
import { SOURCES_PATH } from '../../config.js';
import { db } from '../db/client.js';
import { getInstallationToken, toHttpsUrl } from './githubApp.js';

const execFile = promisify(execFileCb);

export interface NodeForGit {
  id: string;
  loc: string;
  name: string;
  alias?: string | null;
  description?: string | null;
  content?: string | null;
  tags: string[];
  outgoingEdges: Array<{ target: { id: string }; label: string | null }>;
}

/**
 * Write a node to the appropriate git repo and branch, then push.
 * Fire-and-forget safe — errors are logged, not thrown.
 *
 * Branch resolution (from HadronGraph.writeBranch):
 *   "main"                    → push directly to main
 *   "hadron-updates"          → push to shared feature branch
 *   "hadron-updates-{client}" → push to per-client branch
 */
export async function writeNodeToGit(
  node: NodeForGit,
  ownerRepo: string,
  clientId?: string | null,
): Promise<void> {
  // 1. Find HadronGraph config for this ownerRepo
  const graphRecord = await db.hadronGraph.findFirst({
    where: { source: { contains: ownerRepo } },
    include: { organization: true },
  });

  if (!graphRecord) {
    console.warn(`[writeNodeToGit] No HadronGraph found for ownerRepo "${ownerRepo}"`);
    return;
  }

  if (!graphRecord.source) {
    // DB-only mode — no git push
    return;
  }

  const localPath = join(SOURCES_PATH, graphRecord.organization.slug, graphRecord.name);

  if (!existsSync(join(localPath, '.git'))) {
    console.warn(`[writeNodeToGit] Repo not cloned yet at ${localPath} — skipping git write`);
    return;
  }

  // 2. Resolve branch name
  const rawBranch = graphRecord.writeBranch ?? 'hadron-updates';
  const branch = rawBranch.replace('{client}', clientId ?? 'unknown');

  // 3. Get installation token (if org has GitHub App installed)
  let token: string | null = null;
  if (graphRecord.organization.githubInstallationId) {
    try {
      token = await getInstallationToken(graphRecord.organization.githubInstallationId);
    } catch (err) {
      console.error(`[writeNodeToGit] Failed to get installation token:`, err);
      return;
    }
  }

  // 4. Checkout / create the branch
  try {
    await execFile('git', ['fetch', 'origin'], { cwd: localPath });

    if (branch === 'main' || branch === 'master') {
      await execFile('git', ['checkout', branch], { cwd: localPath });
      await execFile('git', ['pull', '--ff-only'], { cwd: localPath });
    } else {
      try {
        await execFile('git', ['checkout', branch], { cwd: localPath });
        await execFile('git', ['pull', '--ff-only'], { cwd: localPath });
      } catch {
        await execFile('git', ['checkout', '-b', branch, 'origin/main'], { cwd: localPath });
      }
    }
  } catch (err) {
    console.error(`[writeNodeToGit] Branch setup failed (${branch}) for ${node.loc}:`, err);
    return;
  }

  // 5. Write node.yaml
  const locParts = node.loc.split('.');
  const nodeDir = join(localPath, '.hadron', ...locParts, '.node');
  mkdirSync(nodeDir, { recursive: true });

  const yamlData: Record<string, unknown> = { id: node.id, name: node.name };
  if (node.alias)       yamlData.alias       = node.alias;
  if (node.description) yamlData.description = node.description;
  if (node.tags.length > 0) yamlData.tags = node.tags;
  if (node.outgoingEdges.length > 0) {
    yamlData.nodes = node.outgoingEdges.map((e) => ({
      id: e.target.id,
      ...(e.label ? { rel: e.label } : {}),
    }));
  }

  writeFileSync(join(nodeDir, 'node.yaml'), stringify(yamlData), 'utf-8');

  // 6. Write topic.md if content present
  if (node.content) {
    writeFileSync(join(nodeDir, 'topic.md'), node.content, 'utf-8');
  }

  // 7. Commit and push (skip if nothing changed)
  try {
    await execFile('git', ['add', nodeDir], { cwd: localPath });
    const { stdout } = await execFile('git', ['status', '--porcelain'], { cwd: localPath });
    if (!stdout.trim()) return; // nothing to commit

    await execFile('git', [
      'commit', '-m', `Update node ${node.loc}\n\n[hadron-controller]`,
    ], { cwd: localPath });

    // Embed token in remote URL for push, then restore original
    if (token) {
      const tokenUrl = toHttpsUrl(graphRecord.source, token);
      await execFile('git', ['remote', 'set-url', 'origin', tokenUrl], { cwd: localPath });
    }

    try {
      await execFile('git', ['push', 'origin', branch], { cwd: localPath });
      console.log(`[writeNodeToGit] Pushed ${node.loc} → ${ownerRepo}@${branch}`);
    } finally {
      // Always restore original remote URL
      if (token) {
        await execFile('git', ['remote', 'set-url', 'origin', graphRecord.source], { cwd: localPath });
      }
    }
  } catch (err) {
    console.error(`[writeNodeToGit] Commit/push failed for ${node.loc}:`, err);
  }
}
