import { execFile as execFileCb } from 'child_process';
import { createDecipheriv } from 'crypto';
import { promisify } from 'util';
import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'fs';
import { join, dirname, basename } from 'path';
import { stringify, parse } from 'yaml';
import { GRAPHS_PATH } from '../../config.js';
import { db } from '../db/client.js';
import { getInstallationToken, toHttpsUrl } from './githubApp.js';

const execFile = promisify(execFileCb);

export interface NodeForGit {
  id: string;
  loc: string;
  name: string;
  alias?: string | null;
  description?: string | null;
  /** Paragraph-length summary. Spec 031. Written to YAML frontmatter as `abstract`. */
  abstract?: string | null;
  content?: string | null;
  tags: string[];
  outgoingEdges: Array<{ target: { id: string }; label: string | null }>;
}

/**
 * Derive the local filesystem path for a memory's cloned repo.
 * Uses the URN slug (part after the colon) as the directory name.
 */
function memoryLocalPath(orgUrn: string, memoryUrn: string): string {
  const slug = memoryUrn.includes(':') ? memoryUrn.split(':').slice(1).join(':') : memoryUrn;
  return join(GRAPHS_PATH, orgUrn, slug);
}

/**
 * Write a node to the appropriate git repo and branch, then push.
 * Writes the new frontmatter markdown format with optional edge sidecar.
 * Fire-and-forget safe — errors are logged, not thrown.
 */
export async function writeNodeToGit(
  node: NodeForGit,
  ownerRepo: string,
  clientId?: string | null,
  memoryId?: string,
): Promise<void> {
  // 1. Find Memory config — try by memoryId first, then ownerRepo
  let graphRecord = memoryId
    ? await db.memory.findUnique({ where: { id: memoryId }, include: { organization: true } })
    : null;

  if (!graphRecord && ownerRepo) {
    graphRecord = await db.memory.findFirst({
      where: { source: { contains: ownerRepo } },
      include: { organization: true },
    });
  }

  if (!graphRecord) {
    console.warn(`[writeNodeToGit] No Memory found for ownerRepo="${ownerRepo}" memoryId="${memoryId}"`);
    return;
  }

  if (!graphRecord.source) return; // DB-only mode

  const localPath = memoryLocalPath(graphRecord.organization.urn, graphRecord.urn);

  if (!existsSync(join(localPath, '.git'))) {
    console.warn(`[writeNodeToGit] Repo not cloned yet at ${localPath} — skipping git write`);
    return;
  }

  // 2. Resolve branch name
  const rawBranch = graphRecord.writeBranch ?? 'hadron-updates';
  const branch = rawBranch.replace('{client}', clientId ?? 'unknown');

  // 3. Get installation token
  let token: string | null = null;
  if (graphRecord.organization.githubInstallationId) {
    try {
      const org = graphRecord.organization;
      const credentials = org.githubAppId && org.githubAppPrivateKeyEncrypted
        ? { appId: org.githubAppId, privateKeyPem: decryptToken(org.githubAppPrivateKeyEncrypted) }
        : undefined;
      token = await getInstallationToken(graphRecord.organization.githubInstallationId, credentials);
    } catch (err) {
      console.error(`[writeNodeToGit] Failed to get installation token:`, err);
      return;
    }
  }

  // 4. Checkout / create the branch
  try {
    if (token) {
      const tokenUrl = toHttpsUrl(graphRecord.source, token);
      await execFile('git', ['remote', 'set-url', 'origin', tokenUrl], { cwd: localPath });
    }
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
    restoreRemote(localPath, graphRecord.source);
    return;
  }

  // 5. Write frontmatter markdown file
  const locParts = node.loc.split(':');
  let mdPath: string;
  let sidecarDir: string;

  if (locParts.length === 0 || node.loc === '') {
    // Root node → README.md
    mdPath = join(localPath, 'README.md');
    sidecarDir = join(localPath, '.README');
  } else {
    // Check if this node has children (is it a folder?)
    const folderPath = join(localPath, ...locParts);
    if (existsSync(folderPath) && hasChildNodes(folderPath)) {
      // Parent node → folder/README.md
      mdPath = join(folderPath, 'README.md');
      sidecarDir = join(dirname(folderPath), '.' + basename(folderPath));
    } else {
      // Leaf node → parent/name.md
      const name = locParts[locParts.length - 1];
      const parentParts = locParts.slice(0, -1);
      mdPath = join(localPath, ...parentParts, name + '.md');
      sidecarDir = join(localPath, ...parentParts, '.' + name);
    }
  }

  // Build frontmatter
  const frontmatter: Record<string, unknown> = { name: node.name, id: node.id };
  if (node.alias) frontmatter.alias = node.alias;
  if (node.description) frontmatter.description = node.description;
  // Spec 031 — abstract round-trips through YAML frontmatter. Omitted
  // when null so absent-in-YAML stays equivalent to NULL in the DB (and
  // a node that never had an abstract has no `abstract:` line cluttering
  // its frontmatter).
  if (node.abstract) frontmatter.abstract = node.abstract;
  if (node.tags.length > 0) frontmatter.tags = node.tags;

  // Preserve existing frontmatter fields we don't manage (urn, author, etc.)
  if (existsSync(mdPath)) {
    try {
      const existing = readFileSync(mdPath, 'utf-8');
      const fmMatch = existing.match(/^---\n([\s\S]*?)\n---/);
      if (fmMatch) {
        const existingMeta = parse(fmMatch[1]) as Record<string, unknown>;
        for (const key of ['urn', 'author']) {
          if (existingMeta[key] && !frontmatter[key]) {
            frontmatter[key] = existingMeta[key];
          }
        }
      }
    } catch {}
  }

  const fmYaml = stringify(frontmatter, { lineWidth: 0 }).trim();
  const body = node.content ?? '';
  mkdirSync(dirname(mdPath), { recursive: true });
  writeFileSync(mdPath, `---\n${fmYaml}\n---\n\n${body}\n`, 'utf-8');

  // Write edge sidecar if there are edges
  if (node.outgoingEdges.length > 0) {
    mkdirSync(sidecarDir, { recursive: true });
    const edges = node.outgoingEdges.map((e) => ({
      id: e.target.id,
      rel: e.label ?? '',
    }));
    writeFileSync(join(sidecarDir, 'edges.yaml'), stringify(edges), 'utf-8');
  }

  // 6. Commit and push
  try {
    await execFile('git', ['add', '-A'], { cwd: localPath });
    const { stdout } = await execFile('git', ['status', '--porcelain'], { cwd: localPath });
    if (!stdout.trim()) {
      restoreRemote(localPath, graphRecord.source);
      return;
    }

    const gitEnv = {
      ...process.env,
      GIT_AUTHOR_NAME: graphRecord.organization.name,
      GIT_AUTHOR_EMAIL: `hadron@${graphRecord.organization.urn}`,
      GIT_COMMITTER_NAME: graphRecord.organization.name,
      GIT_COMMITTER_EMAIL: `hadron@${graphRecord.organization.urn}`,
    };
    await execFile('git', [
      'commit', '-m', `Update node ${node.loc}\n\n[hadron-server]`,
    ], { cwd: localPath, env: gitEnv });

    try {
      await execFile('git', ['push', 'origin', branch], { cwd: localPath });
      console.log(`[writeNodeToGit] Pushed ${node.loc} → ${ownerRepo}@${branch}`);
    } finally {
      restoreRemote(localPath, graphRecord.source);
    }
  } catch (err) {
    console.error(`[writeNodeToGit] Commit/push failed for ${node.loc}:`, err);
    restoreRemote(localPath, graphRecord.source);
  }
}

function restoreRemote(localPath: string, originalUrl: string): void {
  execFile('git', ['remote', 'set-url', 'origin', originalUrl], { cwd: localPath }).catch(() => {});
}

function hasChildNodes(dir: string): boolean {
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    return entries.some((e) =>
      (e.isFile() && e.name.endsWith('.md') && e.name !== 'README.md') ||
      (e.isDirectory() && !e.name.startsWith('.'))
    );
  } catch {
    return false;
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
