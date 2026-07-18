import { execFile as execFileCb } from 'child_process';
import { createDecipheriv } from 'crypto';
import { promisify } from 'util';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { stringify } from 'yaml';
import { GRAPHS_PATH } from '../../config.js';
import { db } from '../db/client.js';
import { getInstallationToken, toHttpsUrl } from './githubApp.js';
import { prepareWriteBranch } from './gitBranch.js';
import {
  buildNodeFrontmatter,
  preserveUnmanagedFrontmatter,
  nodeFilePath,
  orphanedLegacyPaths,
} from './nodeFrontmatter.js';

const execFile = promisify(execFileCb);

export interface NodeForGit {
  id: string;
  loc: string;
  name: string;
  /** Node type (info/data/task/record/…). Exported as `type` for non-`info`;
   *  the importer reads it back as `isLink: type === 'link'`, so it must
   *  round-trip. */
  nodeType?: string | null;
  /** #725 — collection discriminator; round-tripped via frontmatter `objectType`. */
  objectType?: string | null;
  alias?: string | null;
  description?: string | null;
  /** Paragraph-length summary. Spec 031. Written to YAML frontmatter as `abstract`. */
  abstract?: string | null;
  /** Spec 032 — fingerprint exported alongside `abstract` so the
   *  round-trip preserves the staleness signal byte-for-byte. Omitted
   *  from YAML frontmatter when null (consistent with `abstract`). */
  abstractOriginHash?: string | null;
  /** SHA256(yaml+md)[0:8] change-detection hash. Importer-consumed, so it
   *  must be exported or a re-sync nulls it. */
  contentHash?: string | null;
  content?: string | null;
  tags: string[];
  /** Sort order among siblings; exported for a faithful mirror. */
  seq?: number | null;
  /** Node-level structured JSON; exported for a faithful mirror. */
  data?: unknown;
  properties?: unknown;
  outgoingEdges: Array<{
    target: { id: string; loc?: string | null };
    name: string | null;
    /** The edge's own loc (spec 037), emitted as `edgeLoc`. A scalar column on
     *  the Prisma edge row, so it's returned by default wherever the edge is
     *  loaded — no explicit select needed on either git path. */
    loc?: string | null;
    description?: string | null;
    isRunnable?: boolean | null;
    /** JSONLogic gating expression; null when the edge always fires. */
    condition?: unknown;
    /** Resolution-order hook (lower fires first), DB default 0. */
    priority?: number | null;
  }>;
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
 * Writes one self-contained frontmatter markdown file per node (props + edges
 * inline; no README, no edge sidecar) via the shared `nodeFrontmatter`
 * builders. Fire-and-forget safe — errors are logged, not thrown.
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
  // spec 047: git-mirror is org-scoped (needs the org's GitHub App). A
  // user-owned memory has no org → nothing to mirror to.
  if (!graphRecord.organization) return;

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

  // 4. Checkout / create the branch. `prepareWriteBranch` selects checkout vs.
  // create from the branch's real local+remote existence — the old
  // "pull --ff-only; on failure checkout -b origin/main" path failed on a
  // non-default branch with no upstream tracking (see gitBranch.ts).
  try {
    if (token) {
      const tokenUrl = toHttpsUrl(graphRecord.source, token);
      await execFile('git', ['remote', 'set-url', 'origin', tokenUrl], { cwd: localPath });
    }
    await execFile('git', ['fetch', 'origin'], { cwd: localPath });
    await prepareWriteBranch(localPath, branch, graphRecord.readBranch ?? undefined);
  } catch (err) {
    console.error(`[writeNodeToGit] Branch setup failed (${branch}) for ${node.loc}:`, err);
    restoreRemote(localPath, graphRecord.source);
    return;
  }

  // 5. Write frontmatter markdown file. A node — leaf or parent — is one
  // self-contained `<...loc>.md` (children live in the sibling `<seg>/`
  // folder); edges are inline in the frontmatter `nodes:` array, no sidecar.
  const mdPath = nodeFilePath(localPath, node.loc);

  // Build frontmatter (shared builder — keeps this incremental path and the
  // bulk pushMemoryToGit path emitting the exact same fields, edges included).
  // Every importer-consumed field (abstract, abstractOriginHash, contentHash,
  // type, nodes) is emitted when set, or a re-sync would null it; see
  // nodeFrontmatter.ts.
  const frontmatter = buildNodeFrontmatter({
    id: node.id,
    name: node.name,
    nodeType: node.nodeType,
    objectType: node.objectType,
    alias: node.alias,
    description: node.description,
    abstract: node.abstract,
    abstractOriginHash: node.abstractOriginHash,
    contentHash: node.contentHash,
    tags: node.tags,
    seq: node.seq,
    data: node.data,
    properties: node.properties,
  }, node.outgoingEdges);
  preserveUnmanagedFrontmatter(frontmatter, mdPath);

  const fmYaml = stringify(frontmatter, { lineWidth: 0 }).trim();
  const body = node.content ?? '';
  mkdirSync(dirname(mdPath), { recursive: true });
  writeFileSync(mdPath, `---\n${fmYaml}\n---\n\n${body}\n`, 'utf-8');

  // Remove any leftover old-format files for this node (parent `README.md` +
  // edge sidecar dir) so a migrating repo reshapes cleanly and a stale sidecar
  // can't mask the inline edges on re-import. `git add -A` stages the
  // deletions. Skipped for the empty-loc root, whose file IS README.md.
  if (node.loc !== '') {
    const legacy = orphanedLegacyPaths(localPath, node.loc);
    rmSync(legacy.readme, { force: true });
    rmSync(legacy.sidecar, { recursive: true, force: true });
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
      // `-u` sets upstream tracking so the branch isn't left tracking-less —
      // the original root cause of the "branch already exists" failure.
      await execFile('git', ['push', '-u', 'origin', branch], { cwd: localPath });
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
