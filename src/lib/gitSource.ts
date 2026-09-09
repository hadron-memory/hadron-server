/**
 * `Memory.source` — what a caller may put in it (#561).
 *
 * `source` names the GitHub repository a memory mirrors to and syncs from. It
 * is caller-settable (`createMemory`, `updateMemory`) and it reaches `git` as a
 * remote URL, which makes it the one memory column that selects a *transport*
 * rather than describing data.
 *
 * Measured on the git that serves this code (2.50.1 local, 2.54.0 prd, no
 * `protocol.*` config), an unconstrained `source` bought a caller:
 *
 *   - **a clone of any local repository** the server process can read, whose
 *     files are then ingested as nodes — `protocol.file.allow` defaults to
 *     `user` and a server-issued clone counts as `user`, so this worked;
 *   - **an outbound request to any https host**, since nothing pinned
 *     github.com — the SSRF half, and the one only this allowlist closes;
 *   - **command execution via `ext::`**, which those git versions refuse by
 *     their own default (see execGit.ts — the issue's premise, corrected) but
 *     which nothing in this repo or its deployment pins.
 *
 * So the column is allowlisted at the boundary. This is the primary fix; the
 * transport guard in `execGit` is defense-in-depth for a value that got into
 * the column some other way.
 *
 * ## What is accepted, and why it is not a narrowing
 *
 * The two spellings `toHttpsUrl` already knows how to rewrite:
 *
 *   https://github.com/<owner>/<repo>[.git]
 *   git@github.com:<owner>/<repo>[.git]
 *
 * Pinning the host to github.com describes the integration as built rather than
 * restricting it: authentication is a GitHub App installation token minted
 * against a hardcoded `https://api.github.com`, and `toHttpsUrl` only rewrites
 * github.com URLs — a source on any other host clones unauthenticated or not at
 * all. Measured before choosing the shape (2026-09-08): every non-null `source`
 * in dev (12) and prod (12) is `https://github.com/<owner>/<repo>[.git]`, so no
 * stored row is invalidated and nothing that works today stops working. GitHub
 * Enterprise would need `GITHUB_API` to become configurable first, and this
 * allowlist alongside it.
 *
 * `null` is accepted and means DB-only: a memory with no repository behind it.
 */

/** Thrown on a rejected `source`; the resolvers map it to INVALID_MEMORY_SOURCE. */
export class GitSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitSourceError';
  }
}

/**
 * One path segment of a GitHub owner or repository name.
 *
 * GitHub allows letters, digits, `-`, `_` and `.`. The class deliberately
 * excludes `/` (which would let one segment carry a path) and every whitespace
 * or control character; `.` and `..` are rejected separately below, since the
 * class alone would admit them.
 */
const SEGMENT = String.raw`[A-Za-z0-9._-]+`;

const HTTPS_SOURCE_RE = new RegExp(`^https://github\\.com/(${SEGMENT})/(${SEGMENT})(?:\\.git)?/?$`);
const SSH_SOURCE_RE = new RegExp(`^git@github\\.com:(${SEGMENT})/(${SEGMENT})(?:\\.git)?$`);

/** A segment that traverses rather than names. */
function isDotSegment(segment: string): boolean {
  return segment === '.' || segment === '..';
}

/**
 * Validate a caller-supplied `Memory.source`.
 *
 * Returns normally for an accepted value (including `null`/`undefined`, which
 * mean "no repository" / "unchanged"); throws `GitSourceError` otherwise. The
 * message names both accepted spellings, because the caller's next move is to
 * retype the value and a bare refusal makes them guess.
 */
export function validateMemorySource(source: string | null | undefined): void {
  if (source == null) return;

  const match = HTTPS_SOURCE_RE.exec(source) ?? SSH_SOURCE_RE.exec(source);
  const owner = match?.[1];
  const repo = match?.[2];

  if (!match || !owner || !repo || isDotSegment(owner) || isDotSegment(repo)) {
    throw new GitSourceError(
      `Invalid memory source "${source}": expected a GitHub repository URL — ` +
        `"https://github.com/<owner>/<repo>" or "git@github.com:<owner>/<repo>" ` +
        `(a ".git" suffix is optional). Pass null for a memory with no git repository.`,
    );
  }
}
