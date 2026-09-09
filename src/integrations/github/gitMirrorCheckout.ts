/**
 * The one "open the memory's repo, mutate the tree, commit, push" primitive
 * every DB → git mirror path shares.
 *
 * Extracted from writeNodeToGit (#1095) so a mirror that touches MORE than one
 * file — a move, which removes files at the old locs and writes them at the new
 * ones — lands as ONE commit on ONE branch instead of re-preparing the checkout
 * per node. writeNodeToGit is now a one-file caller of the same helper, so the
 * incremental single-node path and the batched move path can't drift on branch
 * selection, author identity, token handling, or the remote-URL restore.
 *
 * **Every failure here is soft.** The mirror is fire-and-forget by contract: a
 * missing clone, an unavailable installation token, a rejected push — all log
 * and return an outcome, never throw. A DB write that already committed must not
 * be failed retroactively because a repository was unreachable.
 */

import { createDecipheriv } from 'crypto';
import { existsSync } from 'fs';
import { join } from 'path';
import { GRAPHS_PATH } from '../../config.js';
import { db } from '../db/client.js';
import { getInstallationToken, toHttpsUrl } from './githubApp.js';
import { prepareWriteBranch } from './gitBranch.js';
import { execGit } from './execGit.js';

/** The prepared checkout handed to a mutate callback. */
export interface MirrorRepo {
  /** Absolute path of the memory's local clone, already on the write branch. */
  localPath: string;
  /** The write branch the mutation will be committed to. */
  branch: string;
}

/**
 * Why a mirror attempt ended. Only `mirrored` means the repository changed.
 * `skipped` covers every "this memory isn't mirrored here" reason (DB-only
 * memory, user-owned memory with no org, repo never cloned) — the common case
 * on a deployment where GRAPHS_PATH holds no clones at all.
 */
export type MirrorOutcome = 'mirrored' | 'no-changes' | 'skipped' | 'failed';

/**
 * Resolve a memory's clone, check out its write branch, run `mutate` against the
 * working tree, then commit and push whatever it changed.
 *
 * Identify the memory by `memoryId` (preferred) or `ownerRepo` (the legacy
 * lookup writeNodeToGit accepts when only the repo slug is in hand).
 *
 * `mutate` may write, overwrite, or delete files anywhere under `localPath`; it
 * runs BETWEEN the branch checkout and `git add -A`, so a callback that touches
 * several files still produces one commit. It should not throw — if it does, the
 * error is logged, the remote URL is restored, and nothing is committed.
 */
export async function withMirrorCheckout(
  opts: {
    memoryId?: string;
    ownerRepo?: string;
    clientId?: string | null;
    /** Commit subject line; `[hadron-server]` is appended as the body. */
    commitSubject: string;
    /** Log-line prefix identifying the calling mirror path. */
    logPrefix: string;
  },
  mutate: (repo: MirrorRepo) => void | Promise<void>,
): Promise<MirrorOutcome> {
  const { memoryId, ownerRepo, clientId, commitSubject, logPrefix } = opts;

  // 1. Find the Memory config — by id first, then by repo slug.
  let memory = memoryId
    ? await db.memory.findUnique({ where: { id: memoryId }, include: { organization: true } })
    : null;

  if (!memory && ownerRepo) {
    memory = await db.memory.findFirst({
      where: { source: { contains: ownerRepo } },
      include: { organization: true },
    });
  }

  if (!memory) {
    console.warn(`${logPrefix} No Memory found for ownerRepo="${ownerRepo}" memoryId="${memoryId}"`);
    return 'skipped';
  }

  if (!memory.source) return 'skipped'; // DB-only mode
  // spec 047: git-mirror is org-scoped (needs the org's GitHub App). A
  // user-owned memory has no org → nothing to mirror to.
  if (!memory.organization) return 'skipped';

  const localPath = memoryLocalPath(memory.organization.urn, memory.urn);

  if (!existsSync(join(localPath, '.git'))) {
    console.warn(`${logPrefix} Repo not cloned yet at ${localPath} — skipping git write`);
    return 'skipped';
  }

  // 2. Resolve the branch name.
  const rawBranch = memory.writeBranch ?? 'hadron-updates';
  const branch = rawBranch.replace('{client}', clientId ?? 'unknown');

  // 3. Get the installation token.
  let token: string | null = null;
  if (memory.organization.githubInstallationId) {
    try {
      const org = memory.organization;
      const credentials = org.githubAppId && org.githubAppPrivateKeyEncrypted
        ? { appId: org.githubAppId, privateKeyPem: decryptToken(org.githubAppPrivateKeyEncrypted) }
        : undefined;
      token = await getInstallationToken(memory.organization.githubInstallationId, credentials);
    } catch (err) {
      console.error(`${logPrefix} Failed to get installation token:`, err);
      return 'failed';
    }
  }

  // 4. Checkout / create the branch. `prepareWriteBranch` selects checkout vs.
  // create from the branch's real local+remote existence — the old
  // "pull --ff-only; on failure checkout -b origin/main" path failed on a
  // non-default branch with no upstream tracking (see gitBranch.ts).
  try {
    if (token) {
      const tokenUrl = toHttpsUrl(memory.source, token);
      await execGit(['remote', 'set-url', 'origin', tokenUrl], { cwd: localPath });
    }
    await execGit(['fetch', 'origin'], { cwd: localPath });
    await prepareWriteBranch(localPath, branch, memory.readBranch ?? undefined);
  } catch (err) {
    console.error(`${logPrefix} Branch setup failed (${branch}) for ${commitSubject}:`, err);
    restoreRemote(localPath, memory.source);
    return 'failed';
  }

  // 5. Let the caller reshape the working tree.
  try {
    await mutate({ localPath, branch });
  } catch (err) {
    console.error(`${logPrefix} Mirror write failed for ${commitSubject}:`, err);
    restoreRemote(localPath, memory.source);
    return 'failed';
  }

  // 6. Commit and push.
  try {
    await execGit(['add', '-A'], { cwd: localPath });
    const { stdout } = await execGit(['status', '--porcelain'], { cwd: localPath });
    if (!stdout.trim()) {
      restoreRemote(localPath, memory.source);
      return 'no-changes';
    }

    const gitEnv = {
      ...process.env,
      GIT_AUTHOR_NAME: memory.organization.name,
      GIT_AUTHOR_EMAIL: `hadron@${memory.organization.urn}`,
      GIT_COMMITTER_NAME: memory.organization.name,
      GIT_COMMITTER_EMAIL: `hadron@${memory.organization.urn}`,
    };
    await execGit([
      'commit', '-m', `${commitSubject}\n\n[hadron-server]`,
    ], { cwd: localPath, env: gitEnv });

    try {
      // `-u` sets upstream tracking so the branch isn't left tracking-less —
      // the original root cause of the "branch already exists" failure.
      await execGit(['push', '-u', 'origin', branch], { cwd: localPath });
      console.log(`${logPrefix} Pushed ${commitSubject} → ${memory.urn}@${branch}`);
    } finally {
      restoreRemote(localPath, memory.source);
    }
    return 'mirrored';
  } catch (err) {
    console.error(`${logPrefix} Commit/push failed for ${commitSubject}:`, err);
    restoreRemote(localPath, memory.source);
    return 'failed';
  }
}

/**
 * Derive the local filesystem path for a memory's cloned repo.
 * Uses the URN slug (part after the colon) as the directory name.
 */
export function memoryLocalPath(orgUrn: string, memoryUrn: string): string {
  const slug = memoryUrn.includes(':') ? memoryUrn.split(':').slice(1).join(':') : memoryUrn;
  return join(GRAPHS_PATH, orgUrn, slug);
}

function restoreRemote(localPath: string, originalUrl: string): void {
  execGit(['remote', 'set-url', 'origin', originalUrl], { cwd: localPath }).catch(() => {});
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
