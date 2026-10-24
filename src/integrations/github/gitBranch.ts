import { execGit } from './execGit.js';
import { validateGitBranch } from '../../lib/gitRef.js';

/** True if `ref` resolves in the repo at `cwd`. */
async function refExists(cwd: string, ref: string): Promise<boolean> {
  try {
    await execGit(['rev-parse', '--verify', '--quiet', ref], { cwd });
    return true;
  } catch {
    return false;
  }
}

/**
 * Pick the start point for a brand-new write branch. Order of preference:
 *   1. the memory's configured read branch (`origin/<readBranch>`) — a write
 *      branch holds Hadron's outgoing changes to be reviewed against the read
 *      branch, so that's the correct base;
 *   2. the remote's default branch (`origin/HEAD`);
 *   3. the conventional `origin/main` / `origin/master`.
 * Returns null when none resolve (an essentially empty remote), in which case
 * the caller forks from the current HEAD with no explicit start point.
 *
 * Avoids the old hardcoded `origin/main`, which failed on repos whose default
 * branch is `master` / a custom name, or whose read branch isn't `main`.
 */
export async function resolveBaseRef(localPath: string, baseBranch?: string): Promise<string | null> {
  const candidates = [
    baseBranch ? `origin/${baseBranch}` : undefined,
    'origin/HEAD',
    'origin/main',
    'origin/master',
  ].filter((r): r is string => !!r);
  for (const ref of candidates) {
    if (await refExists(localPath, ref)) return ref;
  }
  return null;
}

/**
 * Check out the memory's write branch — creating it when needed — and
 * fast-forward it to `origin/<branch>` when a matching remote branch exists.
 * Assumes the caller has already populated remote-tracking refs (a fresh
 * `git clone`, or a `git fetch origin` on an existing clone). `baseBranch` is
 * the memory's read branch, used as the fork point for a brand-new branch.
 *
 * Replaces the older "checkout; pull --ff-only; on ANY failure
 * `checkout -b <branch> origin/main`" logic, which conflated two unrelated
 * outcomes and broke on a non-default write branch:
 *
 *   1. A branch first created locally (`git checkout -b <branch>`, then pushed
 *      WITHOUT `-u`) has no upstream, so `git pull --ff-only` always failed
 *      with "There is no tracking information for the current branch" — even
 *      though the branch was perfectly fine. The catch then ran
 *      `git checkout -b <branch> origin/main`, which dies with
 *      "fatal: a branch named '<branch>' already exists". This is the
 *      "tries to recreate a branch that already exists" symptom.
 *   2. Any other pull failure (diverged history) was likewise misread as
 *      "branch missing" and routed into the same doomed `checkout -b`.
 *
 * Choosing the command from the branch's real local/remote existence avoids
 * both, and never depends on upstream tracking being configured.
 */
export async function prepareWriteBranch(
  localPath: string,
  branch: string,
  baseBranch?: string,
): Promise<void> {
  // #1146: this value reaches `git checkout` as a POSITIONAL argument, so a
  // leading `-` is read as an option rather than a ref. Validated at the
  // mutations too; re-validated here because a row that arrived by migration,
  // restore or a direct DB write never passed through them — the same
  // division of labour as `validateMemorySource`, and for the same reason.
  validateGitBranch(branch, 'writeBranch');
  if (baseBranch !== undefined) validateGitBranch(baseBranch, 'baseBranch');

  const localExists = await refExists(localPath, `refs/heads/${branch}`);
  const originExists = await refExists(localPath, `refs/remotes/origin/${branch}`);

  if (localExists) {
    await execGit(['checkout', branch], { cwd: localPath });
    if (originExists) {
      // Fast-forward to origin when possible. A non-ff divergence is left for
      // `git push` to surface (rejected push) rather than silently merged or
      // reset — we never want to clobber local node writes here.
      await execGit(['merge', '--ff-only', `origin/${branch}`], {
        cwd: localPath,
      }).catch(() => {});
    }
  } else if (originExists) {
    // Remote branch exists but we've never checked it out locally — create a
    // local branch tracking it.
    await execGit(['checkout', '-b', branch, `origin/${branch}`], { cwd: localPath });
  } else {
    // Brand-new branch on both sides: fork it from the read branch (or the
    // remote default). `git push -u` (at the call sites) then publishes it.
    const base = await resolveBaseRef(localPath, baseBranch);
    await execGit(['checkout', '-b', branch, ...(base ? [base] : [])], { cwd: localPath });
  }
}

/**
 * #2308 — how many commits on the write branch `branch` are not yet published,
 * so a retry after a failed push can tell "clean and synced" from "clean but
 * the last commit never left". Counted against the SELECTED branch only:
 *
 *   - `origin/<branch>` exists: `origin/<branch>..<branch>`;
 *   - it does not: against the base a brand-new write branch forks from, the
 *     SAME {@link resolveBaseRef} chain `prepareWriteBranch` uses (one rule, not
 *     a second one), so 0 means the branch carries nothing beyond its base.
 *
 * Throws when the answer is unknown (no origin twin and no resolvable base, a
 * failed `rev-list`, unparsable output). Callers treat a throw as a failed
 * mirror: an unknown ahead state must never read as "nothing to publish".
 * Read-only; never resets, rebases or discards a local commit.
 */
export async function unpublishedCommitCount(
  localPath: string,
  branch: string,
  baseBranch?: string,
): Promise<number> {
  validateGitBranch(branch, 'writeBranch');
  if (baseBranch !== undefined) validateGitBranch(baseBranch, 'baseBranch');
  const twin = `refs/remotes/origin/${branch}`;
  const base = (await refExists(localPath, twin)) ? twin : await resolveBaseRef(localPath, baseBranch);
  if (!base) throw new Error(`No fork point to compare ${branch} against`);
  const { stdout } = await execGit(['rev-list', '--count', `${base}..refs/heads/${branch}`], { cwd: localPath });
  const count = Number.parseInt(stdout.trim(), 10);
  if (!Number.isSafeInteger(count) || count < 0) throw new Error('Unparsable unpublished commit count');
  return count;
}
