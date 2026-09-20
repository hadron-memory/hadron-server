/**
 * `Memory.readBranch` / `Memory.writeBranch` — what a caller may put in them
 * (#1146).
 *
 * Both columns are caller-settable (org-ADMIN, via `createMemory` /
 * `updateMemory`) and both reach `git` as POSITIONAL ARGUMENTS:
 *
 *   execGit(['checkout', readBranch], …)
 *   execGit(['checkout', '-b', branch, `origin/${branch}`], …)
 *   execGit(['push', '-u', 'origin', branch], …)
 *
 * ## What this is, and what it is not
 *
 * It is NOT shell injection. `execGit` runs `git` via `execFile` with no shell,
 * so metacharacters are inert — which is why this survived the #561 transport
 * hardening, whose subject was the remote URL.
 *
 * It is ARGUMENT injection. A value beginning with `-` is read by git as an
 * OPTION rather than as a branch name. Measured on git 2.50.1, `git checkout`
 * with a leading-dash value parses it as an option and complains that the
 * option needs a value — proving the argv position is under the caller's
 * control rather than being taken as a ref.
 *
 * ## Why `--` is NOT the fix, though the issue proposed it
 *
 * #1146's done-criteria asks for `--` before every caller-derived ref. Measured
 * before implementing it, that BREAKS the feature: for `git checkout`, `--`
 * introduces a PATHSPEC, not a ref.
 *
 *   $ git checkout -- feature
 *   error: pathspec 'feature' did not match any file(s) known to git
 *
 * HEAD does not move. `git switch -- <branch>` does work, and
 * `git checkout refs/heads/<branch>` works but DETACHES HEAD — so neither is a
 * drop-in either. The separator that disambiguates is subcommand-specific, and
 * getting it wrong fails closed in the worst way: silently checking out
 * nothing.
 *
 * So the guard is VALIDATION, which is subcommand-independent and does not
 * depend on option-parsing behaviour that differs per git verb and per release.
 * That is the same reasoning as #561's transport allowlist: the behaviour being
 * defended against belongs to a binary this repo does not pin
 * (`findings:exploit-chains-that-end-in-another-binary`).
 *
 * ## Where it is enforced
 *
 * At the mutations (so a bad value never reaches the column) AND at each point
 * of use (so a row that arrived some other way — a migration, a direct DB
 * write, a restored snapshot — still cannot reach git). That division of labour
 * mirrors `validateMemorySource`, for the same reason.
 */

/** Thrown on a rejected branch name; the resolvers map it to INVALID_GIT_BRANCH. */
export class GitRefError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitRefError';
  }
}

/**
 * git's own `check-ref-format --branch` rules, as far as they bear on a branch
 * name. Verified against git 2.50.1 rather than transcribed from memory: each
 * rule below was checked to reject (or, for `my_repo`, to ACCEPT — underscores
 * are legal and a guard that refused them would break ordinary branches).
 *
 * The leading-dash rule is the security-critical one; the rest are here because
 * a value that git will refuse at use time should be refused at write time,
 * where the caller can still see the error.
 */
function branchNameProblem(value: string): string | null {
  if (value.length === 0) return 'must not be empty';
  // THE argument-injection rule. Everything else is hygiene.
  if (value.startsWith('-')) return 'must not begin with "-" (git would read it as an option)';
  if (value.length > 255) return 'must be 255 characters or fewer';
  if (value.startsWith('.') || value.includes('/.')) return 'must not begin a path segment with "."';
  if (value.endsWith('.')) return 'must not end with "."';
  if (value.endsWith('.lock') || value.includes('.lock/')) return 'must not end a path segment with ".lock"';
  if (value.includes('..')) return 'must not contain ".."';
  if (value.startsWith('/') || value.endsWith('/') || value.includes('//'))
    return 'must not begin or end with "/" or contain "//"';
  if (value === '@') return 'must not be "@"';
  if (value.includes('@{')) return 'must not contain "@{"';
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f ~^:?*[\\]/.test(value))
    return 'must not contain whitespace, control characters, or any of ~ ^ : ? * [ \\';
  return null;
}

/** True when `value` is a branch name git will accept and cannot misread as an option. */
export function isValidGitBranch(value: string): boolean {
  return branchNameProblem(value) === null;
}

/**
 * Validate a caller-supplied branch name.
 *
 * Returns normally for an accepted value, and for `null`/`undefined`, which
 * mean "unset" / "unchanged" — the columns are optional and a memory with no
 * branch override is the common case. Throws `GitRefError` otherwise.
 *
 * `field` names which column failed, because both are settable in one mutation
 * and a bare refusal makes the caller guess which one to retype.
 */
export function validateGitBranch(value: string | null | undefined, field: string): void {
  if (value == null) return;
  const problem = branchNameProblem(value);
  if (problem !== null) {
    throw new GitRefError(`Invalid ${field} "${value}": a git branch name ${problem}.`);
  }
}
