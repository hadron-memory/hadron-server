/**
 * Work-ref normalization (#947) — the equality-lookup contract of the team
 * worklog (spec cor:agt:020, the provenance N:M join).
 *
 * The worklog answers "which sessions produced this PR?" by EQUALITY lookup on
 * the stored `ref`, so every writer and every reader must agree on one
 * spelling per artifact. This module is that agreement: it accepts every
 * spelling a human or tool plausibly pastes and emits exactly ONE canonical
 * form. It is server-only code, but the GRAMMAR below is the documented
 * contract clients (hadron-cli help text, portal placeholders) may restate —
 * the spelling contract, not the implementation (#947 implementer decision 2).
 *
 * ## Canonical spellings (tool `github`), one per artifact kind
 *
 *   pr | issue :  `owner/repo#N`        (PRs and issues share GitHub's number
 *                                        space, so they share the spelling —
 *                                        a lookup by `o/r#371` finds both)
 *   commit     :  `owner/repo@sha`      (sha lowercased, 7–40 hex chars,
 *                                        stored at the length given)
 *   branch     :  `owner/repo:branch`   (branch case is preserved — git
 *                                        refnames are case-sensitive)
 *   repo       :  `owner/repo`
 *
 * `owner` and `repo` are LOWERCASED (GitHub treats them case-insensitively).
 *
 * ## Accepted input spellings
 *
 *   - any canonical form (normalization is idempotent)
 *   - web URLs, with or without scheme/`www.`, query and fragment stripped:
 *       `https://github.com/o/r`             → repo   `o/r`
 *       `https://github.com/o/r/pull/371`    → pr     `o/r#371`
 *       `https://github.com/o/r/issues/42`   → issue  `o/r#42`
 *         (`/pull/N` and `/issues/N` are each accepted for BOTH pr and issue —
 *          GitHub redirects freely between them and the canonical spelling is
 *          identical, so distinguishing them would only manufacture refusals)
 *       `https://github.com/o/r/commit/<sha>` → commit `o/r@<sha>`
 *       `https://github.com/o/r/tree/feat/x`  → branch `o/r:feat/x`
 *          (everything after `/tree/` is the branch — branch names contain `/`)
 *       trailing URL segments after a number/sha (`/files`, `/checks`) are
 *       tolerated and dropped
 *   - the SSH remote form `git@github.com:o/r[.git]` → repo `o/r`
 *   - a `.git` suffix on a repo path is stripped
 *
 * NOT accepted: a bare number (`371`, `#371`). Inferring the repo from a git
 * remote is CLIENT-inherent context (the CLI's job); the server never guesses
 * a repo (#947).
 *
 * ## Other tools
 *
 * The grammar above is `tool: 'github'`'s. Other tools have no defined grammar
 * in v1: their refs are stored VERBATIM (trimmed), and equality lookups match
 * bytes. A grammar added later slots in per-tool without touching stored
 * github refs.
 */

/** The closed worklog artifact-kind vocabulary (#947 record shape). */
export const WORK_KINDS = ['pr', 'issue', 'commit', 'branch', 'repo'] as const;
export type WorkKind = (typeof WORK_KINDS)[number];

/** Thrown for a ref that fits no accepted spelling (or contradicts the given
 * kind); the resolver maps it to the typed WORK_REF_INVALID. */
export class WorkRefInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkRefInvalidError';
  }
}

/** A successfully parsed ref: the canonical spelling plus the kind(s) that
 * spelling can denote (`o/r#N` is legal as pr AND issue). */
export interface ParsedWorkRef {
  ref: string;
  kinds: WorkKind[];
}

const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;
const REPO_RE = /^[A-Za-z0-9._-]+$/;
const SHA_RE = /^[0-9a-fA-F]{7,40}$/;
const NUMBER_RE = /^[1-9][0-9]*$/;
// Git refname pragmatics: no whitespace, and no ':' (git forbids it — which is
// also what makes the short form's first-':' split unambiguous).
const BRANCH_RE = /^[^\s:]+$/;

/** Validate + lowercase an owner/repo pair; null when either part is illegal. */
function ownerRepo(owner: string, repo: string): string | null {
  const r = repo.endsWith('.git') ? repo.slice(0, -4) : repo;
  if (!OWNER_RE.test(owner) || !REPO_RE.test(r) || r === '' ) return null;
  return `${owner.toLowerCase()}/${r.toLowerCase()}`;
}

/** Parse the path segments after `github.com/` (query/fragment pre-stripped). */
function parseGithubPath(path: string): ParsedWorkRef | null {
  const segments = path.replace(/\/+$/, '').split('/').filter((s) => s !== '');
  if (segments.length < 2) return null;
  const or = ownerRepo(segments[0], segments[1]);
  if (!or) return null;
  if (segments.length === 2) return { ref: or, kinds: ['repo'] };
  const [, , kindSeg, ...rest] = segments;
  if ((kindSeg === 'pull' || kindSeg === 'issues') && rest.length >= 1 && NUMBER_RE.test(rest[0])) {
    // Trailing segments (`/files`, `/commits`) tolerated: the artifact is the number.
    return { ref: `${or}#${rest[0]}`, kinds: ['pr', 'issue'] };
  }
  if (kindSeg === 'commit' && rest.length >= 1 && SHA_RE.test(rest[0])) {
    return { ref: `${or}@${rest[0].toLowerCase()}`, kinds: ['commit'] };
  }
  if (kindSeg === 'tree' && rest.length >= 1) {
    const branch = rest.join('/');
    if (BRANCH_RE.test(branch)) return { ref: `${or}:${branch}`, kinds: ['branch'] };
  }
  return null;
}

/**
 * Parse a github work ref in any accepted spelling. Returns the canonical
 * spelling + the kind(s) it can denote, or null when nothing matches. Pure and
 * total — the throwing wrapper is {@link normalizeWorkRef}.
 */
export function parseWorkRef(raw: string): ParsedWorkRef | null {
  const input = raw.trim();
  if (input === '') return null;

  // SSH remote: git@github.com:owner/repo[.git]
  const ssh = /^git@github\.com:([^/\s]+)\/([^/\s]+?)$/i.exec(input);
  if (ssh) {
    const or = ownerRepo(ssh[1], ssh[2]);
    return or ? { ref: or, kinds: ['repo'] } : null;
  }

  // Web URL: [http(s)://][www.]github.com/<path>[?query][#fragment]
  const url = /^(?:https?:\/\/)?(?:www\.)?github\.com\/(.+)$/i.exec(input);
  if (url) {
    const path = url[1].replace(/[?#].*$/, '');
    return parseGithubPath(path);
  }

  // Short forms: owner/repo optionally followed by #N | @sha | :branch.
  const short = /^([^/\s]+)\/([^/\s#@:]+)(?:(#|@|:)(.*))?$/.exec(input);
  if (!short) return null;
  const or = ownerRepo(short[1], short[2]);
  if (!or) return null;
  const sep = short[3];
  const tail = short[4] ?? '';
  if (sep === undefined) return { ref: or, kinds: ['repo'] };
  if (sep === '#') {
    return NUMBER_RE.test(tail) ? { ref: `${or}#${tail}`, kinds: ['pr', 'issue'] } : null;
  }
  if (sep === '@') {
    return SHA_RE.test(tail) ? { ref: `${or}@${tail.toLowerCase()}`, kinds: ['commit'] } : null;
  }
  // sep === ':'
  return BRANCH_RE.test(tail) ? { ref: `${or}:${tail}`, kinds: ['branch'] } : null;
}

/** Read-filter-only spelling with no owner. It identifies a suffix, never a
 * canonical ref: several repositories may match it. Bare numbers stay invalid
 * because they contain no repository hint at all. */
export function parseOwnerlessWorkRef(raw: string): ParsedWorkRef | null {
  const input = raw.trim();
  if (input === '' || input.includes('/') || NUMBER_RE.test(input)) return null;
  const parsed = parseWorkRef(`x/${input}`);
  return parsed ? { ref: parsed.ref.slice(2), kinds: parsed.kinds } : null;
}

/**
 * Normalize a github work ref to its ONE canonical spelling, checking it
 * against the declared artifact kind. Throws {@link WorkRefInvalidError} when
 * the ref fits no accepted spelling, or when its spelling contradicts `kind`
 * (`kind: 'commit'` with `o/r#5`) — a contradiction is a client bug worth a
 * loud refusal, never a silent reinterpretation.
 */
export function normalizeWorkRef(raw: string, kind?: WorkKind): string {
  const parsed = parseWorkRef(raw);
  if (!parsed) {
    throw new WorkRefInvalidError(
      `"${raw}" is not a recognized github work ref. Accepted spellings: owner/repo, ` +
        `owner/repo#N (PR/issue), owner/repo@sha, owner/repo:branch, or the matching ` +
        `github.com URL. A bare number is not accepted — the server never infers a repo.`,
    );
  }
  if (kind && !parsed.kinds.includes(kind)) {
    throw new WorkRefInvalidError(
      `"${raw}" normalizes to "${parsed.ref}" (${parsed.kinds.join('/')}), which cannot denote a ${kind}.`,
    );
  }
  return parsed.ref;
}
