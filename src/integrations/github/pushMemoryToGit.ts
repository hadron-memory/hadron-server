import { createDecipheriv } from 'crypto';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { stringify } from 'yaml';
import { GRAPHS_PATH } from '../../config.js';
import { db } from '../db/client.js';
import { getInstallationToken, toHttpsUrl } from './githubApp.js';
import { prepareWriteBranch, unpublishedCommitCount } from './gitBranch.js';
import { execGit } from './execGit.js';
import { validateMemorySource, GitSourceError } from '../../lib/gitSource.js';
import { deserializeTags } from '../db/provider.js';
import {
  buildNodeFrontmatter,
  preserveUnmanagedFrontmatter,
  nodeFilePath,
  orphanedLegacyPaths,
} from './nodeFrontmatter.js';
import { validateGitBranch } from '../../lib/gitRef.js';
import { withMirrorCheckoutLock } from './mirrorCheckoutLock.js';

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
  // A manual full push uses the same clone as incremental Node/Edge mirrors.
  // Hold their cross-process checkout lock through the entire push, including
  // the final remote-URL restoration.
  try {
    return await withMirrorCheckoutLock(memoryId, () => pushMemoryToGitUnderLock(memoryId));
  } catch (err) {
    console.error('[pushMemoryToGit] Checkout lock failed:', err);
    return { nodeCount: 0, error: `Git checkout lock failed: ${String(err)}` };
  }
}

async function pushMemoryToGitUnderLock(
  memoryId: string,
): Promise<{ nodeCount: number; error?: string }> {
  // 1. Load memory + org
  const memory = await db.memory.findUnique({
    where: { id: memoryId },
    include: { organization: true },
  });

  if (!memory) return { nodeCount: 0, error: 'Memory not found' };
  if (!memory.source) return { nodeCount: 0, error: 'Memory has no git source configured' };
  // #561 — re-validate the STORED value; see the note in syncGraphFromGithub.
  // This path needs it most: it clones with the RAW source when the org has no
  // installation token, and requires no GitHub App installation at all.
  try {
    validateMemorySource(memory.source);
  } catch (e) {
    if (e instanceof GitSourceError) return { nodeCount: 0, error: e.message };
    throw e;
  }

  const org = memory.organization;
  // spec 047: git-mirror is org-scoped (it needs the org's GitHub App). A
  // user-owned memory has no org, so there's nothing to sync it to.
  if (!org) return { nodeCount: 0, error: 'Memory has no organization (user-owned memories are not git-synced)' };
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

  // 3. Clone or pull the repo, then check out the write branch. `prepareWriteBranch`
  // picks checkout/create from the branch's real local+remote existence — see
  // gitBranch.ts for why the old "pull --ff-only; on failure checkout -b" logic
  // mis-fired on a non-default write branch.
  const branch = memory.writeBranch ?? 'main';
  try {
    // #1146: BOTH branch columns reach git from this function — `writeBranch`
    // via push and prepareWriteBranch, `readBranch` via `clone --branch` on
    // the fresh-clone path below. The first version validated only
    // `writeBranch`, and did it OUTSIDE this try (@copilot, PR #1247): the
    // read branch reached git unchecked, and a refusal escaped as an uncaught
    // rejection instead of the `{ nodeCount, error? }` result this function
    // documents. Inside the try, a refusal is reported like every other
    // failure here.
    validateGitBranch(branch, 'writeBranch');
    validateGitBranch(memory.readBranch, 'readBranch');

    const cloneUrl = token ? toHttpsUrl(memory.source, token) : memory.source;

    if (existsSync(join(localPath, '.git'))) {
      if (token) {
        await execGit(['remote', 'set-url', 'origin', cloneUrl], { cwd: localPath });
      }
      await execGit(['fetch', 'origin'], { cwd: localPath });
    } else {
      // A previous clone may have been interrupted, leaving a non-empty dir
      // without a `.git` — `git clone` would then fail forever with
      // "destination path already exists and is not an empty directory".
      // Clearing it first makes the clone self-healing. (force ignores ENOENT.)
      rmSync(localPath, { recursive: true, force: true });
      mkdirSync(dirname(localPath), { recursive: true });
      const cloneArgs = ['clone'];
      if (memory.readBranch) cloneArgs.push('--branch', memory.readBranch);
      // `--` ends option parsing (#561) — see the note in syncGraphFromGithub's
      // gitSync, including why the option-injection variant does not reproduce
      // through this argv today (the `rmSync` above guarantees the destination
      // is absent, so git fails on the missing repository first).
      //
      // This path is still the one to watch: it clones with the RAW
      // `memory.source` whenever the org has no installation token — never
      // passing through `toHttpsUrl` — and, unlike syncGraphFromGithub, it does
      // not require a GitHub App installation at all. Its precondition is
      // weaker than the one #561 names.
      cloneArgs.push('--', cloneUrl, localPath);
      await execGit(cloneArgs);
    }
    await prepareWriteBranch(localPath, branch, memory.readBranch ?? undefined);
  } catch (err) {
    await restoreRemote(localPath, memory.source);
    return { nodeCount: 0, error: `Git setup failed: ${(err as Error).message}` };
  }

  // 4. Load all LIVE nodes with edges. A soft-deleted node is a tombstone, not
  // content: exporting it re-published deleted text on every full push (#425).
  // This only stops new writes — pruning files already in the repo is a
  // separate, gated change.
  const nodes = await db.node.findMany({
    where: { memoryId, nodeType: { not: 'data' }, deletedAt: null },
    include: {
      outgoingEdges: { include: { target: true } },
    },
    orderBy: { loc: 'asc' },
  });

  // 5. Write each node as a self-contained frontmatter markdown file. A node
  // — leaf or parent — is `<...loc>.md` (children live in the sibling
  // `<seg>/` folder); edges are inline in `nodes:`, no sidecar.
  for (const node of nodes) {
    const mdPath = nodeFilePath(localPath, node.loc, memory.urn);

    // Build frontmatter (shared builder — keeps this bulk path and the
    // incremental writeNodeToGit path emitting the exact same fields, edges
    // included).
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
      tags: deserializeTags(node.tags) as string[],
      seq: node.seq,
      data: node.data,
      properties: node.properties,
      // #1218 — governed signals cross the mirror on the bulk path too, or the
      // two export paths disagree about what a faithful mirror contains.
      role: node.role,
      isRunnable: node.isRunnable,
      isPlaceholder: node.isPlaceholder,
    }, node.outgoingEdges);
    preserveUnmanagedFrontmatter(frontmatter, mdPath);

    const fmYaml = stringify(frontmatter, { lineWidth: 0 }).trim();
    const body = node.content ?? '';
    mkdirSync(dirname(mdPath), { recursive: true });
    writeFileSync(mdPath, `---\n${fmYaml}\n---\n\n${body}\n`, 'utf-8');

    // Remove leftover old-format files (parent README + sidecar dir) so a
    // migrating repo reshapes cleanly and no stale sidecar masks the inline
    // edges on re-import. `git add -A` stages the deletions. Skipped for the
    // empty-loc root (its file IS README.md, owned by the manifest below).
    if (node.loc !== '' && mdPath === nodeFilePath(localPath, node.loc)) {
      const legacy = orphanedLegacyPaths(localPath, node.loc);
      rmSync(legacy.readme, { force: true });
      rmSync(legacy.sidecar, { recursive: true, force: true });
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
    await execGit(['add', '-A'], { cwd: localPath });
    const { stdout } = await execGit(['status', '--porcelain'], { cwd: localPath });
    if (!stdout.trim()) {
      // #2308: a clean tree is not "nothing to publish" (see withMirrorCheckout):
      // an earlier failed push leaves its commit on the write branch. An unknown
      // ahead state throws into the catch below, never a silent success.
      if ((await unpublishedCommitCount(localPath, branch, memory.readBranch ?? undefined)) === 0) {
        await restoreRemote(localPath, memory.source);
        return { nodeCount: nodes.length, error: undefined };
      }
    } else {
      const gitEnv = {
        ...process.env,
        GIT_AUTHOR_NAME: org.name,
        GIT_AUTHOR_EMAIL: `hadron@${org.urn}`,
        GIT_COMMITTER_NAME: org.name,
        GIT_COMMITTER_EMAIL: `hadron@${org.urn}`,
      };

      await execGit([
        'commit', '-m', `Push ${nodes.length} nodes from Hadron\n\n[hadron-server pushMemoryToGit]`,
      ], { cwd: localPath, env: gitEnv });
    }

    if (token) {
      const tokenUrl = toHttpsUrl(memory.source, token);
      await execGit(['remote', 'set-url', 'origin', tokenUrl], { cwd: localPath });
    }

    try {
      // `-u` sets upstream tracking so the branch isn't left tracking-less —
      // the original root cause of the "branch already exists" failure.
      // An explicit refspec rather than a bare name: as a bare `<refspec>`
      // operand git reads leading `+` as the force marker and `:` as a
      // src:dst separator, so the branch name would be parsed rather than
      // used (@codex, PR #1247). Both characters are refused by
      // validateGitBranch as well; this removes the class rather than the
      // instance.
      await execGit(
        ['push', '-u', 'origin', `refs/heads/${branch}:refs/heads/${branch}`],
        { cwd: localPath },
      );
      console.log(`[pushMemoryToGit] Pushed ${nodes.length} nodes → ${memory.urn}@${branch}`);
    } finally {
      await restoreRemote(localPath, memory.source);
    }

    return { nodeCount: nodes.length };
  } catch (err) {
    await restoreRemote(localPath, memory.source);
    return { nodeCount: 0, error: `Commit/push failed: ${(err as Error).message}` };
  }
}

async function restoreRemote(localPath: string, originalUrl: string): Promise<void> {
  if (existsSync(join(localPath, '.git'))) {
    try {
      await execGit(['remote', 'set-url', 'origin', originalUrl], { cwd: localPath });
    } catch (err) {
      console.error(`[pushMemoryToGit] Failed to restore remote URL at ${localPath}:`, err);
    }
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
