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
import { prepareWriteBranch, unpublishedCommitCount } from './gitBranch.js';
import { execGit } from './execGit.js';
import { sourceNamesRepo, validateMemorySource, GitSourceError } from '../../lib/gitSource.js';
import { validateGitBranch } from '../../lib/gitRef.js';
import { withMirrorCheckoutLock } from './mirrorCheckoutLock.js';

/** The prepared checkout handed to a mutate callback. */
export interface MirrorRepo {
  /** Current memory identity, used for the root README loc (#1228). */
  memoryUrn: string;
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
    /** Node-file writes capture request-scoped key presence at dispatch. Path-only
     * removals omit it: deleting a stale file needs no decryption key. */
    nodeWriteKeyAvailable?: boolean;
    /** Commit subject line; `[hadron-server]` is appended as the body. */
    commitSubject: string;
    /** Log-line prefix identifying the calling mirror path. */
    logPrefix: string;
  },
  mutate: (repo: MirrorRepo) => void | boolean | Promise<void | boolean>,
): Promise<MirrorOutcome> {
  const { memoryId, ownerRepo, clientId, commitSubject, logPrefix } = opts;

  // 1. Find the Memory config — by id first, then by repo slug.
  let memory = memoryId
    ? await db.memory.findUnique({ where: { id: memoryId }, include: { organization: true } })
    : null;

  if (!memory && ownerRepo) {
    // #1145: `contains` narrows, it does not IDENTIFY. Prisma compiles it to
    // LIKE '%…%', and `_` and `%` are legal in a GitHub repo name — `_` being a
    // single-character wildcard, so `acme/my_repo` also matched a stored
    // `acme/myXrepo`, picking another tenant's memory with no ownership
    // predicate beside it. The filter stays as a cheap coarse narrowing; the
    // selection below is exact.
    const candidates = await db.memory.findMany({
      // `mode: 'insensitive'` because `sourceNamesRepo` compares
      // case-insensitively, as GitHub does — and Postgres `LIKE` does not
      // (@copilot, PR #1247). A sensitive narrowing in front of an
      // insensitive comparison silently excludes the rows the comparison was
      // written to accept: a stored `github.com/Acme/Repo` would never be
      // offered for a slug of `acme/repo`, and the exact match never runs.
      where: { source: { contains: ownerRepo, mode: 'insensitive' } },
      include: { organization: true },
    });
    memory = candidates.find((m) => sourceNamesRepo(m.source, ownerRepo)) ?? null;
  }

  if (!memory) {
    console.warn(`${logPrefix} No Memory found for ownerRepo="${ownerRepo}" memoryId="${memoryId}"`);
    return 'skipped';
  }

  if (!memory.source) return 'skipped'; // DB-only mode
  // #561 — re-validate the STORED value; see the note in syncGraphFromGithub.
  // This path never clones, but it does `remote set-url` + `fetch` against the
  // source, so a legacy non-github https row would still reach the network.
  // Soft-fails like every other refusal here: the mirror is fire-and-forget and
  // must never fail a DB write that already committed.
  try {
    validateMemorySource(memory.source);
  } catch (e) {
    if (e instanceof GitSourceError) {
      console.warn(`${logPrefix} Refusing to mirror ${memory.urn}: ${e.message}`);
      return 'skipped';
    }
    throw e;
  }
  // spec 047: git-mirror is org-scoped (needs the org's GitHub App). A
  // user-owned memory has no org → nothing to mirror to.
  if (!memory.organization) return 'skipped';

  // Hold one cross-process lock through checkout, file mutation, commit,
  // push, and remote restoration. Node, Edge, and move mirrors all use this
  // primitive, so a process-local queue would leave a race between workers.
  try {
    const resolvedMemoryId = memory.id;
    return await withMirrorCheckoutLock(resolvedMemoryId, async () => {
      // Source, branch, and organization may have changed while this mirror
      // waited for another writer. Use the current config under the lock.
      const memory = await db.memory.findUnique({
        where: { id: resolvedMemoryId }, include: { organization: true },
      });
      if (!memory || !memory.organization || !memory.source) return 'skipped';
      // #1273 / cor:sec:040:05: a keyless structural merge is legal in the
      // DB, but cannot export either ciphertext or plaintext. Check the live
      // encryption state after the checkout wait, before ANY Git/filesystem
      // mutation, and record the deferral. The next keyed write can mirror
      // the latest state; this fire-and-forget path has no durable retry queue.
      if (memory.isEncrypted && opts.nodeWriteKeyAvailable === false) {
        console.warn(`[git-mirror] Deferring node write for memory ${memory.id}: no request-carried key at dispatch`);
        return 'skipped';
      }
      try {
        validateMemorySource(memory.source);
      } catch (e) {
        if (e instanceof GitSourceError) {
          console.warn(`${logPrefix} Refusing to mirror ${memory.urn}: ${e.message}`);
          return 'skipped';
        }
        throw e;
      }

      const localPath = memoryLocalPath(memory.organization.urn, memory.urn);

      if (!existsSync(join(localPath, '.git'))) {
        console.warn(`${logPrefix} Repo not cloned yet at ${localPath} — skipping git write`);
        return 'skipped';
      }

      // 2. Resolve the branch name.
      const rawBranch = memory.writeBranch ?? 'hadron-updates';
      const branch = rawBranch.replace('{client}', clientId ?? 'unknown');
      // #1146: validate the SUBSTITUTED result, not the template. `branch` reaches
      // `git checkout` and `git push` as a positional argument, and `clientId` is
      // caller-supplied — a `writeBranch` of exactly `{client}` makes the whole
      // branch name the client's to choose, leading `-` included. Neither the
      // mutation guard nor a check on `rawBranch` would see that, because the
      // dangerous value does not exist until this line.
      try {
        validateGitBranch(branch, 'writeBranch');
      } catch (e) {
        console.warn(`${logPrefix} Refusing branch "${branch}" for ${memory.urn}: ${String(e)}`);
        return 'skipped';
      }

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
        await restoreRemote(localPath, memory.source);
        return 'failed';
      }

      // 5. Let the caller reshape the working tree.
      try {
        // Git preparation can wait on the remote. An encryption flip during
        // that wait must also stop a previously-plaintext keyless snapshot.
        if (opts.nodeWriteKeyAvailable === false) {
          const current = await db.memory.findUnique({
            where: { id: resolvedMemoryId }, select: { isEncrypted: true },
          });
          if (!current || current.isEncrypted) {
            console.warn(`[git-mirror] Deferring node write for memory ${resolvedMemoryId}: memory changed during preparation, no request-carried key at dispatch`);
            await restoreRemote(localPath, memory.source);
            return 'skipped';
          }
        }
        const shouldCommit = await mutate({ localPath, branch, memoryUrn: memory.urn });
        if (shouldCommit === false) {
          await restoreRemote(localPath, memory.source);
          return 'skipped';
        }
      } catch (err) {
        console.error(`${logPrefix} Mirror write failed for ${commitSubject}:`, err);
        await restoreRemote(localPath, memory.source);
        return 'failed';
      }

      // 6. Commit and push.
      try {
        await execGit(['add', '-A'], { cwd: localPath });
        const { stdout } = await execGit(['status', '--porcelain'], { cwd: localPath });
        if (!stdout.trim()) {
          // #2308: a clean tree is not "nothing to publish": a failed push leaves
          // its commit on the write branch, and the retry sees a clean tree. Push
          // when the branch carries unpublished commits; a throw here (unknown
          // ahead state) lands in the catch below as 'failed', never 'no-changes'.
          if ((await unpublishedCommitCount(localPath, branch, memory.readBranch ?? undefined)) === 0) {
            await restoreRemote(localPath, memory.source);
            return 'no-changes';
          }
        } else {
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
        }

        try {
          // `-u` sets upstream tracking so the branch isn't left tracking-less —
          // the original root cause of the "branch already exists" failure.
          // Explicit refspec — see pushMemoryToGit for why a bare name is parsed
          // rather than used (@codex, PR #1247).
          await execGit(
            ['push', '-u', 'origin', `refs/heads/${branch}:refs/heads/${branch}`],
            { cwd: localPath },
          );
          console.log(`${logPrefix} Pushed ${commitSubject} → ${memory.urn}@${branch}`);
        } finally {
          await restoreRemote(localPath, memory.source);
        }
        return 'mirrored';
      } catch (err) {
        console.error(`${logPrefix} Commit/push failed for ${commitSubject}:`, err);
        await restoreRemote(localPath, memory.source);
        return 'failed';
      }
    });
  } catch (err) {
    console.error(`${logPrefix} Checkout lock failed for ${commitSubject}:`, err);
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

async function restoreRemote(localPath: string, originalUrl: string): Promise<void> {
  try {
    await execGit(['remote', 'set-url', 'origin', originalUrl], { cwd: localPath });
  } catch (err) {
    console.error(`[git-mirror] Failed to restore remote URL at ${localPath}:`, err);
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
