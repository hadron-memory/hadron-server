import { execFile as execFileCb } from 'child_process';
import { promisify } from 'util';

const execFile = promisify(execFileCb);

/** True if `ref` resolves in the repo at `cwd`. */
async function refExists(cwd: string, ref: string): Promise<boolean> {
  try {
    await execFile('git', ['rev-parse', '--verify', '--quiet', ref], { cwd });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check out the memory's write branch — creating it when needed — and
 * fast-forward it to `origin/<branch>` when a matching remote branch exists.
 * Assumes the caller has already populated remote-tracking refs (a fresh
 * `git clone`, or a `git fetch origin` on an existing clone).
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
export async function prepareWriteBranch(localPath: string, branch: string): Promise<void> {
  const localExists = await refExists(localPath, `refs/heads/${branch}`);
  const originExists = await refExists(localPath, `refs/remotes/origin/${branch}`);

  if (localExists) {
    await execFile('git', ['checkout', branch], { cwd: localPath });
    if (originExists) {
      // Fast-forward to origin when possible. A non-ff divergence is left for
      // `git push` to surface (rejected push) rather than silently merged or
      // reset — we never want to clobber local node writes here.
      await execFile('git', ['merge', '--ff-only', `origin/${branch}`], {
        cwd: localPath,
      }).catch(() => {});
    }
  } else if (originExists) {
    // Remote branch exists but we've never checked it out locally — create a
    // local branch tracking it.
    await execFile('git', ['checkout', '-b', branch, `origin/${branch}`], { cwd: localPath });
  } else {
    // Brand-new branch on both sides: fork it from the freshly fetched
    // mainline. `git push -u` (at the call sites) then publishes it.
    await execFile('git', ['checkout', '-b', branch, 'origin/main'], { cwd: localPath });
  }
}
