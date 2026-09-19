/**
 * #1177 — skill name derivation and the two grammars (D8).
 *
 * A skill's name is DERIVED from its prefix and its node loc, never hand-set.
 * The pre-#580 stored name is accepted during transition only where it equals
 * the derived value, which is a lint rule rather than a fallback here.
 */

import { runeCount } from './normalize.js';

/** The host's skill-name grammar: kebab-case, lowercase letters and digits. */
const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * The export-prefix grammar, mirroring the server's own validation of
 * `Organization.skillPrefix` (#1164): the stored value IS the literal prefix,
 * trailing hyphen included. Applied to a `--prefix` override too, so an
 * override cannot mint a name the org field could never hold.
 */
const PREFIX_RE = /^[a-z][a-z0-9]*-$/;

/** The host's caps, counted in CODE POINTS (A6). */
export const MAX_NAME_LEN = 64;
export const MAX_DESCRIPTION_LEN = 1024;

/** The fallback prefix for a user-owned memory, which has no org to carry one. */
export const DEFAULT_PREFIX = 'hadron-';

/**
 * An export prefix and whether it is KNOWN.
 *
 * The pair is carried rather than a bare string because "unknown" and "empty"
 * are different states: a resolution that ever coerced an unset org prefix to
 * `''` would read as resolved, and every rule needing a prefix would silently
 * derive a name from nothing. Rules that need one say so (`skill-prefix-missing`)
 * instead of guessing.
 */
export interface Prefix {
  value: string;
  known: boolean;
}

/**
 * Compose a skill's name from its export prefix and its node loc.
 *
 * The leading `tasks` segment is STRUCTURE rather than name and is dropped when
 * the loc has more than one segment; the rest join with hyphens:
 *
 *   `tasks:create-release-tag`      → `<prefix>create-release-tag`
 *   `export-task-as-claude-skill`   → `<prefix>export-task-as-claude-skill`
 *   `tasks:review:run`              → `<prefix>review-run`
 *
 * The result is NOT validated here — see `validName` — so a caller can report
 * the derived value that failed rather than an empty string. A loc deriving to
 * an invalid name is a lint error naming the loc, never a silent munge.
 */
export function deriveName(prefix: string, loc: string): string {
  let segs = loc.split(':');
  if (segs.length > 1 && segs[0] === 'tasks') segs = segs.slice(1);
  return prefix + segs.join('-');
}

/** Whether `name` satisfies the host's grammar and its 64-code-point cap. */
export function validName(name: string): boolean {
  return runeCount(name) <= MAX_NAME_LEN && NAME_RE.test(name);
}

/** Whether `p` is a legal export prefix. */
export function validPrefix(p: string): boolean {
  return PREFIX_RE.test(p);
}
