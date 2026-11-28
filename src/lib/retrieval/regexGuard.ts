/**
 * #5486 (#415 Slice 2; cor:api:090:01, Proposed amendment): what a regex-mode pattern may be, judged BEFORE any
 * database work. Both refusals are `BAD_USER_INPUT` with a fixed sentence that never echoes the pattern.
 *
 * - Length: at most `REGEX_PATTERN_MAX_CHARS` (200, Holger 2026-11-28; the portal's own cap). It is a tighter bound
 *   INSIDE the #435 entry bound (512), which still runs first.
 * - Backreferences: refused. Postgres matches an ordinary pattern in DFA time; a backreference is the one construct
 *   that forces backtracking, so refusing it removes the catastrophic class, and the length cap bounds the rest. A
 *   backreference is VALID syntax, so this is not the "invalid regular expression" error.
 *
 * Detection is a small scanner over the pattern, not a substring match: an escaped backslash followed by a digit
 * (`\\1`) is a literal backslash then `1`, and a bracket expression (`[\1]`, `[[:digit:]\1]`) holds no backreference.
 * An escape `\` + `1`-`9` outside a bracket expression is a backreference in the engine's ARE syntax (and, in the
 * `(?b)` basic syntax, `\1`-`\9` likewise), and a two-digit form (`\10`) begins with such a digit, so it is caught by
 * the same rule. Where the engine might read an escape as a literal instead (a `(?q)` literal pattern, a `#` comment in
 * `(?x)`), refusing is the conservative side.
 */
import { GraphQLError } from 'graphql';

export const REGEX_PATTERN_MAX_CHARS = 200;

/** True when `pattern` contains a backreference outside a bracket expression. */
export function hasRegexBackreference(pattern: string): boolean {
  let i = 0;
  const n = pattern.length;
  while (i < n) {
    const c = pattern[i]!;
    if (c === '\\') {
      const next = pattern[i + 1];
      if (next !== undefined && next >= '1' && next <= '9') return true;
      i += 2; // the escape and the character it escapes (`\\` is one escape)
      continue;
    }
    if (c === '[') {
      i = skipBracketExpression(pattern, i + 1);
      continue;
    }
    i += 1;
  }
  return false;
}

/** Index just past the bracket expression that opens at `start - 1`; `n` when it never closes (the engine refuses that). */
function skipBracketExpression(p: string, start: number): number {
  const n = p.length;
  let i = start;
  if (p[i] === '^') i += 1;
  if (p[i] === ']') i += 1; // a leading `]` is a member, not the close
  while (i < n) {
    const c = p[i]!;
    if (c === ']') return i + 1;
    if (c === '\\') { i += 2; continue; } // ARE: a backslash escapes inside brackets
    if (c === '[' && (p[i + 1] === ':' || p[i + 1] === '.' || p[i + 1] === '=')) {
      const close = p.indexOf(`${p[i + 1]}]`, i + 2);
      if (close === -1) return n;
      i = close + 2;
      continue;
    }
    i += 1;
  }
  return n;
}

/** Refuse an over-long or backreferencing pattern. Run on the trimmed pattern, after the #435 bound, before any search. */
export function assertRegexPatternAllowed(pattern: string): void {
  if (pattern.length > REGEX_PATTERN_MAX_CHARS) {
    throw new GraphQLError(
      `A regex pattern is too long: at most ${REGEX_PATTERN_MAX_CHARS} characters are allowed. Shorten it; it is never truncated.`,
      { extensions: { code: 'BAD_USER_INPUT' } });
  }
  if (hasRegexBackreference(pattern)) {
    throw new GraphQLError('A regex pattern may not use a backreference. Remove the back-reference.',
      { extensions: { code: 'BAD_USER_INPUT' } });
  }
}
