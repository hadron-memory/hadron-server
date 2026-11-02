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
import { pathUnderGraphsRoot } from '../localFs/pathUnderGraphsRoot.js';
import { db as defaultDb } from '../db/client.js';
import type { PrismaClient } from '../../generated/prisma/index.js';
import { getInstallationToken, toHttpsUrl } from './githubApp.js';
import { prepareWriteBranch, unpublishedCommitCount } from './gitBranch.js';
import { mirrorFailureMetadata } from './mirrorFailureMetadata.js';
import { execGit } from './execGit.js';
import { sourceNamesRepo, validateMemorySource, GitSourceError } from '../../lib/gitSource.js';
import { validateGitBranch } from '../../lib/gitRef.js';
import { withMirrorCheckoutLock, EncryptedMemoryFenceError } from './mirrorCheckoutLock.js';
import { logEncryptedGitSyncRefusal } from './encryptedGitSync.js';
import {
  settleMirrorObligations, tryTakeAttemptSeq,
  type MirrorErrorClass, type MirrorObligationRef, type MirrorSettlement,
} from './mirrorObligations.js';

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
/** `refused-encrypted`: R206 — an encrypted memory never syncs to Git (see encryptedGitSync.ts). */
export type MirrorOutcome = 'mirrored' | 'no-changes' | 'skipped' | 'failed' | 'refused-encrypted';

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
    /**
     * #430: the files this attempt owes the repository. Each is settled into `git_mirror_obligations` INSIDE the checkout
     * lock, before it releases: a failure records a redacted row, a success (or a memory that is not mirrored) clears it.
     * Absent means the call records nothing, so a new write trigger needs no edit here.
     */
    obligations?: readonly MirrorObligationRef[];
    /** Retry consumers use the same checkout/lock, but never create work for an ineligible or no-longer-due row. */
    retry?: { now: Date; maxAttempts: number };
    db?: PrismaClient;
    /** Under the lock, before ANY Git: false means the debt no longer requires a file operation. */
    beforeGit?: () => Promise<boolean>;
    /** A pushed/no-change checkout must satisfy this before its debt is cleared. */
    verify?: (repo: MirrorRepo) => boolean | Promise<boolean>;
  },
  mutate: (repo: MirrorRepo) => void | boolean | Promise<void | boolean>,
): Promise<MirrorOutcome> {
  const { memoryId, ownerRepo, clientId, commitSubject, logPrefix } = opts;
  const db = opts.db ?? defaultDb;
  let obligations = opts.obligations ?? [];

  // #430: taken BEFORE the configuration is read, so a "not mirrored" observation below can only clear rows older than
  // any attempt that starts after the configuration it saw changed. Null (not taken) records nothing for this call.
  const preSeq = !opts.retry && obligations.length > 0 ? await tryTakeAttemptSeq(db) : null;

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

  // #430: every return before the lock is a memory that is NOT mirrored (configuration, not a failure): its rows go.
  const foundMemoryId = memory.id;
  const notMirrored = async (outcome: MirrorOutcome): Promise<MirrorOutcome> => {
    if (preSeq !== null) await settleMirrorObligations(db, foundMemoryId, obligations, { result: 'cleared' }, preSeq);
    return outcome;
  };

  if (!memory.source) return notMirrored('skipped'); // DB-only mode
  // R206: no Git work of any kind for an encrypted memory, before validation or I/O.
  if (memory.isEncrypted) {
    logEncryptedGitSyncRefusal(logPrefix, memory.id);
    return notMirrored('refused-encrypted');
  }
  // #561 — re-validate the STORED value; see the note in syncGraphFromGithub.
  // This path never clones, but it does `remote set-url` + `fetch` against the
  // source, so a legacy non-github https row would still reach the network.
  // Soft-fails like every other refusal here: the mirror is fire-and-forget and
  // must never fail a DB write that already committed.
  try {
    validateMemorySource(memory.source);
  } catch (e) {
    if (e instanceof GitSourceError) {
      console.warn(`${logPrefix} Refusing to mirror ${memory.urn}: invalid stored source`);
      return notMirrored('skipped');
    }
    throw e;
  }
  // spec 047: git-mirror is org-scoped (needs the org's GitHub App). A
  // user-owned memory has no org → nothing to mirror to.
  if (!memory.organization) return notMirrored('skipped');

  // Hold one cross-process lock through checkout, file mutation, commit,
  // push, and remote restoration. Node, Edge, and move mirrors all use this
  // primitive, so a process-local queue would leave a race between workers.
  // #3156: retain a retry's fence for any throw escaping the locked callback.
  // Before it takes a sequence, a retry records nothing (and never invents one in the catch).
  let retryAttemptSeq: bigint | null = null;
  try {
    const resolvedMemoryId = memory.id;
    return await withMirrorCheckoutLock(resolvedMemoryId, async () => {
      // #430: the attempt number is taken HERE, inside the lock, and the settle below runs before it releases, so settles for
      // one memory apply in lock order. Every return of the attempt that is not a failure settles as `cleared`: a success, or
      // a memory that is not mirrored.
      let attemptSeq = !opts.retry && obligations.length > 0 ? await tryTakeAttemptSeq(db) : null;
      let settlement: MirrorSettlement = { result: 'cleared' };
      const fail = (errorClass: MirrorErrorClass): 'failed' => {
        settlement = { result: 'failed', errorClass };
        return 'failed';
      };
      // (the attempt keeps its original indentation to keep this change reviewable)
      const outcome = await (async (): Promise<MirrorOutcome> => {
      // Source, branch, and organization may have changed while this mirror
      // waited for another writer. Use the current config under the lock.
      const memory = await db.memory.findUnique({
        where: { id: resolvedMemoryId }, include: { organization: true },
      });
      if (!memory || !memory.organization || !memory.source || (opts.retry && memory.deletedAt)) return 'skipped';
      // The branch may have changed while this retry waited. No sequence or attempt without a provable route (#3042).
      if (opts.retry && memory.writeBranch?.includes('{client}')) return 'skipped';
      // R206 / cor:sec:040:05: re-check the live encryption state after the
      // checkout wait, before ANY Git/filesystem mutation. No key (request,
      // session or cache) is an exception, and neither is a path-only cleanup.
      if (memory.isEncrypted) {
        logEncryptedGitSyncRefusal(logPrefix, memory.id);
        return 'refused-encrypted';
      }
      try {
        validateMemorySource(memory.source);
      } catch (e) {
        if (e instanceof GitSourceError) {
          console.warn(`${logPrefix} Refusing to mirror ${memory.urn}: invalid stored source`);
          return 'skipped';
        }
        throw e;
      }

      const localPath = memoryLocalPath(memory.organization.urn, memory.urn);

      if (!existsSync(join(localPath, '.git'))) {
        console.warn(`${logPrefix} Repo not cloned yet at ${localPath} — skipping git write`);
        if (!opts.retry) settlement = { result: 'failed', errorClass: 'NOT_CLONED' };
        return 'skipped';
      }

      if (opts.retry) {
        // Selection is only a hint: another server/writer may have settled while we waited.
        const rows = await db.gitMirrorObligation.findMany({ where: {
          memoryId: resolvedMemoryId, state: { in: ['FAILED', 'NOT_CLONED'] },
          attempts: { lt: opts.retry.maxAttempts },
          OR: obligations.map(r => ({ nodeId: r.nodeId, kind: r.kind, removeLoc: r.removeLoc ?? '' })),
        } });
        const now = opts.retry.now.getTime();
        obligations = rows.filter(r => r.lastAttemptAt.getTime() + Math.min(300_000 * 2 ** Math.min(r.attempts - 1, 7), 21_600_000) <= now)
          .map(r => ({ nodeId: r.nodeId, kind: r.kind, removeLoc: r.removeLoc }));
        if (!obligations.length) return 'skipped';
        attemptSeq = retryAttemptSeq = await tryTakeAttemptSeq(db);
        if (attemptSeq === null) return 'skipped'; // a retry must not run without its settlement fence
      }
      if (opts.beforeGit && !await opts.beforeGit()) return 'no-changes';

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
        console.warn(`${logPrefix} Refusing branch "${branch}" for ${memory.urn}: invalid branch`);
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
          console.error(`${logPrefix} Failed to get installation token`, mirrorFailureMetadata(err, 'token', 'TOKEN_UNAVAILABLE'));
          return fail('TOKEN_UNAVAILABLE');
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
        console.error(`${logPrefix} Branch setup failed (${branch}) for ${commitSubject}`, mirrorFailureMetadata(err, 'branch', 'BRANCH_SETUP'));
        await restoreRemote(localPath, memory.source);
        return fail('BRANCH_SETUP');
      }

      // 5. Let the caller reshape the working tree.
      try {
        // Git preparation can wait on the remote. An encryption flip during
        // that wait must stop the write at the last boundary before mutation.
        const current = await db.memory.findUnique({
          where: { id: resolvedMemoryId }, select: { isEncrypted: true },
        });
        if (!current || current.isEncrypted) {
          if (current) logEncryptedGitSyncRefusal(logPrefix, resolvedMemoryId);
          else console.warn(`${logPrefix} Skipping write for memory ${resolvedMemoryId}: memory changed during preparation`);
          await restoreRemote(localPath, memory.source);
          return current ? 'refused-encrypted' : 'skipped';
        }
        const shouldCommit = await mutate({ localPath, branch, memoryUrn: memory.urn });
        if (shouldCommit === false) {
          await restoreRemote(localPath, memory.source);
          return 'skipped';
        }
      } catch (err) {
        console.error(`${logPrefix} Mirror write failed for ${commitSubject}`, mirrorFailureMetadata(err, 'tree', 'TREE_WRITE'));
        await restoreRemote(localPath, memory.source);
        return fail('TREE_WRITE');
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
            if (opts.verify && !await opts.verify({ localPath, branch, memoryUrn: memory.urn })) return fail('TREE_WRITE');
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
        if (opts.verify && !await opts.verify({ localPath, branch, memoryUrn: memory.urn })) return fail('TREE_WRITE');
        return 'mirrored';
      } catch (err) {
        console.error(`${logPrefix} Commit/push failed for ${commitSubject}`, mirrorFailureMetadata(err, 'push', 'PUSH_FAILED'));
        await restoreRemote(localPath, memory.source);
        return fail('PUSH_FAILED');
      }
      })();
      if (attemptSeq !== null) await settleMirrorObligations(db, resolvedMemoryId, obligations, settlement, attemptSeq, opts.retry?.maxAttempts);
      return outcome;
    }, { fenceEncryption: true });
  } catch (err) {
    if (err instanceof EncryptedMemoryFenceError) {
      logEncryptedGitSyncRefusal(logPrefix, memory.id);
      return notMirrored('refused-encrypted');
    }
    console.error(`${logPrefix} Checkout lock failed for ${commitSubject}`, mirrorFailureMetadata(err, 'lock', 'LOCK_FAILED'));
    // Outside the lock by definition (it could not be taken, or the attempt threw before settling), so this settle is not
    // lock-ordered: the sequence number still makes it a no-op against any newer row.
    const lockFailedSeq = opts.retry
      ? retryAttemptSeq
      : obligations.length > 0 ? await tryTakeAttemptSeq(db) : null;
    if (lockFailedSeq !== null) {
      await settleMirrorObligations(db, foundMemoryId, obligations, { result: 'failed', errorClass: 'LOCK_FAILED' }, lockFailedSeq, opts.retry?.maxAttempts);
    }
    return 'failed';
  }
}

/**
 * Derive the local filesystem path for a memory's cloned repo.
 * Uses the URN slug (part after the colon) as the directory name.
 */
export function memoryLocalPath(orgUrn: string, memoryUrn: string): string {
  const slug = memoryUrn.includes(':') ? memoryUrn.split(':').slice(1).join(':') : memoryUrn;
  return pathUnderGraphsRoot(GRAPHS_PATH, orgUrn, slug);
}

async function restoreRemote(localPath: string, originalUrl: string): Promise<void> {
  try {
    await execGit(['remote', 'set-url', 'origin', originalUrl], { cwd: localPath });
  } catch (err) {
    console.error(`[git-mirror] Failed to restore remote URL at ${localPath}`, mirrorFailureMetadata(err, 'restore', 'REMOTE_RESTORE'));
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
