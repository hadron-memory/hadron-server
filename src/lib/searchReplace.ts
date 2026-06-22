/**
 * Pure search-and-replace primitives shared by the `searchReplaceInNodes`
 * GraphQL mutation (and, later, its MCP / CLI surfaces).
 *
 * Two matching modes:
 *   - literal (default): `oldText` is matched as a verbatim substring. The
 *     replacement is inserted literally — `$1` / `$&` in `newText` are NOT
 *     interpreted as replacement patterns.
 *   - regex (opt-in): `oldText` is compiled as a JS `RegExp` source and
 *     `newText` IS a replacement pattern (so `$1`, `$<name>`, `$&` work).
 *
 * The `caseInsensitive` flag toggles the `i` flag in both modes. Matching is
 * always global (every occurrence is replaced).
 *
 * REGEX SAFETY: a caller-supplied regex runs on the main event loop, so a
 * catastrophically-backtracking pattern is a self-inflicted DoS vector. v1
 * caps the pattern source length and rejects patterns that match the empty
 * string (which would otherwise splice `newText` between every character).
 * This is a best-effort guard, not a hard ReDoS defence — adopting a
 * linear-time engine (`re2`) is the tracked follow-up before regex mode is
 * exposed to lower-trust callers.
 */

/** Max characters allowed in a regex-mode pattern source. */
export const MAX_REGEX_SOURCE = 1000;

export interface ReplacerOptions {
  caseInsensitive?: boolean;
  regex?: boolean;
}

/**
 * Thrown when `oldText` is empty, or (regex mode) the source is too long,
 * fails to compile, or matches the empty string. Mapped to a GraphQL error
 * with `extensions.code = 'SearchReplaceInvalidPatternError'`.
 */
export class SearchReplaceInvalidPatternError extends Error {
  constructor(
    public readonly pattern: string,
    public readonly reason: string,
  ) {
    super(`Invalid search pattern: ${reason}`);
    this.name = 'SearchReplaceInvalidPatternError';
  }
}

/** Escape a literal string so it can be embedded in a RegExp source. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export interface Replacer {
  /** Replace every match in `input`; `count` is the number of matches. */
  apply(input: string): { value: string; count: number };
}

/**
 * Build a reusable replacer for `oldText` → `newText`. Validation (empty
 * pattern, regex compile / length / empty-match) happens here so callers get
 * a single typed failure point before touching any data.
 */
export function buildReplacer(
  oldText: string,
  newText: string,
  opts: ReplacerOptions = {},
): Replacer {
  if (oldText.length === 0) {
    throw new SearchReplaceInvalidPatternError(oldText, 'oldText must be non-empty');
  }

  const flags = 'g' + (opts.caseInsensitive ? 'i' : '');
  const literal = !opts.regex;
  let re: RegExp;

  if (literal) {
    re = new RegExp(escapeRegExp(oldText), flags);
  } else {
    if (oldText.length > MAX_REGEX_SOURCE) {
      throw new SearchReplaceInvalidPatternError(
        oldText,
        `regex source exceeds ${MAX_REGEX_SOURCE} characters`,
      );
    }
    try {
      re = new RegExp(oldText, flags);
    } catch (e) {
      throw new SearchReplaceInvalidPatternError(oldText, (e as Error).message);
    }
    // A pattern that matches the empty string (e.g. `a*`, `(?:)`) would splice
    // `newText` at every position — reject it. Test with a non-global clone so
    // `lastIndex` state can't skew the result.
    if (new RegExp(oldText, opts.caseInsensitive ? 'i' : '').test('')) {
      throw new SearchReplaceInvalidPatternError(
        oldText,
        'pattern must not match the empty string',
      );
    }
  }

  return {
    apply(input: string) {
      if (input.length === 0) return { value: input, count: 0 };
      re.lastIndex = 0;
      let count = 0;
      // matchAll iterates over a clone, leaving `re.lastIndex` for `replace`.
      for (const _m of input.matchAll(re)) count++;
      if (count === 0) return { value: input, count: 0 };
      re.lastIndex = 0;
      const value = literal
        ? input.replace(re, () => newText) // function replacer → literal insert
        : input.replace(re, newText); // string replacer → $-patterns honored
      return { value, count };
    },
  };
}

/**
 * Apply a replacer across a tag array. A tag whose value is emptied *by the
 * replacement* is dropped (an empty tag is meaningless); unaffected tags pass
 * through verbatim — no surprise trimming or de-duplication of pre-existing
 * tags. Returns the original array unchanged when nothing matched.
 */
export function replaceInTags(
  tags: string[],
  replacer: Replacer,
): { value: string[]; count: number } {
  let count = 0;
  const out: string[] = [];
  for (const t of tags) {
    const r = replacer.apply(t);
    count += r.count;
    if (r.count > 0 && r.value.trim() === '') continue; // emptied by replace → drop
    out.push(r.value);
  }
  if (count === 0) return { value: tags, count: 0 };
  return { value: out, count };
}
