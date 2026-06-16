import { execFile as execFileCb } from 'child_process';
import { createDecipheriv } from 'crypto';
import { promisify } from 'util';
import { existsSync, mkdirSync, writeFileSync, readdirSync } from 'fs';
import { join, dirname, basename } from 'path';
import { stringify } from 'yaml';
import { GRAPHS_PATH } from '../../config.js';
import { db } from '../db/client.js';
import { getInstallationToken, toHttpsUrl } from './githubApp.js';
import { deserializeTags } from '../db/provider.js';
import { buildNodeFrontmatter, buildEdgeSidecar, preserveUnmanagedFrontmatter } from './nodeFrontmatter.js';

const execFile = promisify(execFileCb);

function memoryLocalPath(orgUrn: string, memoryUrn: string): string {
  const slug = memoryUrn.includes(':') ? memoryUrn.split(':').slice(1).join(':') : memoryUrn;
  return join(GRAPHS_PATH, orgUrn, slug);
}

/**
 * Push all nodes in a memory to its git repo as frontmatter markdown files.
 * Creates a single commit with all nodes. Clones the repo first if needed.
 *
 * Returns { nodeCount, error? }
 */
export async function pushMemoryToGit(
  memoryId: string,
): Promise<{ nodeCount: number; error?: string }> {
  // 1. Load memory + org
  const memory = await db.memory.findUnique({
    where: { id: memoryId },
    include: { organization: true },
  });

  if (!memory) return { nodeCount: 0, error: 'Memory not found' };
  if (!memory.source) return { nodeCount: 0, error: 'Memory has no git source configured' };

  const org = memory.organization;
  const localPath = memoryLocalPath(org.urn, memory.urn);

  // 2. Get installation token
  let token: string | null = null;
  if (org.githubInstallationId) {
    try {
      const credentials = org.githubAppId && org.githubAppPrivateKeyEncrypted
        ? { appId: org.githubAppId, privateKeyPem: decryptToken(org.githubAppPrivateKeyEncrypted) }
        : undefined;
      token = await getInstallationToken(org.githubInstallationId, credentials);
    } catch (err) {
      return { nodeCount: 0, error: `Failed to get installation token: ${(err as Error).message}` };
    }
  }

  // 3. Clone or pull the repo
  try {
    const cloneUrl = token ? toHttpsUrl(memory.source, token) : memory.source;

    if (existsSync(join(localPath, '.git'))) {
      if (token) {
        await execFile('git', ['remote', 'set-url', 'origin', cloneUrl], { cwd: localPath });
      }
      await execFile('git', ['fetch', 'origin'], { cwd: localPath });
      const branch = memory.writeBranch ?? 'main';
      try {
        await execFile('git', ['checkout', branch], { cwd: localPath });
        await execFile('git', ['pull', '--ff-only'], { cwd: localPath });
      } catch {
        // Branch doesn't exist yet — create it
        await execFile('git', ['checkout', '-b', branch, 'origin/main'], { cwd: localPath });
      }
    } else {
      mkdirSync(dirname(localPath), { recursive: true });
      const cloneArgs = ['clone'];
      if (memory.readBranch) cloneArgs.push('--branch', memory.readBranch);
      cloneArgs.push(cloneUrl, localPath);
      await execFile('git', cloneArgs);

      // If writeBranch differs from readBranch, checkout/create it
      const writeBranch = memory.writeBranch ?? 'main';
      if (writeBranch !== (memory.readBranch ?? 'main')) {
        try {
          await execFile('git', ['checkout', writeBranch], { cwd: localPath });
        } catch {
          await execFile('git', ['checkout', '-b', writeBranch], { cwd: localPath });
        }
      }
    }
  } catch (err) {
    restoreRemote(localPath, memory.source);
    return { nodeCount: 0, error: `Git setup failed: ${(err as Error).message}` };
  }

  // 4. Load all nodes with edges
  const nodes = await db.node.findMany({
    where: { memoryId, nodeType: { not: 'data' } },
    include: {
      outgoingEdges: { include: { target: true } },
    },
    orderBy: { loc: 'asc' },
  });

  // Build a set of locs that have children (for folder detection)
  const locSet = new Set(nodes.map((n) => n.loc));
  const parentLocs = new Set<string>();
  for (const n of nodes) {
    const parts = n.loc.split(':');
    for (let i = 1; i < parts.length; i++) {
      parentLocs.add(parts.slice(0, i).join(':'));
    }
  }

  // 5. Write each node as frontmatter markdown
  for (const node of nodes) {
    const isParent = parentLocs.has(node.loc);
    const locParts = node.loc.split(':');

    let mdPath: string;
    let sidecarDir: string;

    if (isParent) {
      // Parent node → folder/README.md
      const folderPath = join(localPath, ...locParts);
      mdPath = join(folderPath, 'README.md');
      sidecarDir = join(dirname(folderPath), '.' + basename(folderPath));
    } else {
      // Leaf node → parent/name.md
      const name = locParts[locParts.length - 1];
      const parentParts = locParts.slice(0, -1);
      mdPath = join(localPath, ...parentParts, name + '.md');
      sidecarDir = join(localPath, ...parentParts, '.' + name);
    }

    // Build frontmatter (shared builder — keeps this bulk path and the
    // incremental writeNodeToGit path emitting the exact same fields).
    const frontmatter = buildNodeFrontmatter({
      id: node.id,
      name: node.name,
      nodeType: node.nodeType,
      alias: node.alias,
      description: node.description,
      abstract: node.abstract,
      abstractOriginHash: node.abstractOriginHash,
      contentHash: node.contentHash,
      tags: deserializeTags(node.tags) as string[],
      seq: node.seq,
      data: node.data,
      properties: node.properties,
    });
    preserveUnmanagedFrontmatter(frontmatter, mdPath);

    const fmYaml = stringify(frontmatter, { lineWidth: 0 }).trim();
    const body = node.content ?? '';
    mkdirSync(dirname(mdPath), { recursive: true });
    writeFileSync(mdPath, `---\n${fmYaml}\n---\n\n${body}\n`, 'utf-8');

    // Write edge sidecar if there are edges
    if (node.outgoingEdges.length > 0) {
      mkdirSync(sidecarDir, { recursive: true });
      const edges = buildEdgeSidecar(node.outgoingEdges);
      writeFileSync(join(sidecarDir, 'edges.yaml'), stringify(edges), 'utf-8');
    }
  }

  // 6. Write root README.md with memory manifest (if no root node exists)
  const hasRootNode = nodes.some((n) => !n.loc.includes(':') && n.loc.length < 20);
  if (!hasRootNode) {
    const rootPath = join(localPath, 'README.md');
    if (!existsSync(rootPath)) {
      const rootFm = stringify({
        urn: memory.urn,
        name: memory.name,
        description: memory.shortDescription ?? memory.description ?? '',
        tags: memory.tags,
      }, { lineWidth: 0 }).trim();
      writeFileSync(rootPath, `---\n${rootFm}\n---\n\n# ${memory.name}\n\n${memory.description ?? ''}\n`, 'utf-8');
    }
  }

  // 7. Commit and push
  try {
    await execFile('git', ['add', '-A'], { cwd: localPath });
    const { stdout } = await execFile('git', ['status', '--porcelain'], { cwd: localPath });
    if (!stdout.trim()) {
      restoreRemote(localPath, memory.source);
      return { nodeCount: nodes.length, error: undefined };
    }

    const gitEnv = {
      ...process.env,
      GIT_AUTHOR_NAME: org.name,
      GIT_AUTHOR_EMAIL: `hadron@${org.urn}`,
      GIT_COMMITTER_NAME: org.name,
      GIT_COMMITTER_EMAIL: `hadron@${org.urn}`,
    };

    const branch = memory.writeBranch ?? 'main';
    await execFile('git', [
      'commit', '-m', `Push ${nodes.length} nodes from Hadron\n\n[hadron-server pushMemoryToGit]`,
    ], { cwd: localPath, env: gitEnv });

    if (token) {
      const tokenUrl = toHttpsUrl(memory.source, token);
      await execFile('git', ['remote', 'set-url', 'origin', tokenUrl], { cwd: localPath });
    }

    try {
      await execFile('git', ['push', 'origin', branch], { cwd: localPath });
      console.log(`[pushMemoryToGit] Pushed ${nodes.length} nodes → ${memory.urn}@${branch}`);
    } finally {
      restoreRemote(localPath, memory.source);
    }

    return { nodeCount: nodes.length };
  } catch (err) {
    restoreRemote(localPath, memory.source);
    return { nodeCount: 0, error: `Commit/push failed: ${(err as Error).message}` };
  }
}

function restoreRemote(localPath: string, originalUrl: string): void {
  if (existsSync(join(localPath, '.git'))) {
    execFile('git', ['remote', 'set-url', 'origin', originalUrl], { cwd: localPath }).catch(() => {});
  }
}

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
