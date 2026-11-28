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
 * the same rule. Where the engine might read an escape as a literal instead (a `(?q)` literal pattern), refusing is the
 * conservative side; the options that change how the scanner must read the pattern (`b`, `e`, `x`) are refused up front.
 *
 * CLOSURE LIST (SEC10, four desyncs found by review: options b/e, option x, `(?#`, `\cX`). The scanner agrees with the engine
 * because every construct that changes how characters are consumed is either modelled here or refused up front:
 *   - leading options `b`, `e`, `x` (basic/extended/expanded syntax): refused (`selectsNonAreSyntax`); the other options
 *     (`i c n p w s m t`) do not change bracket or escape parsing; `q` (literal) and `***=` only make the scanner over-refuse;
 *   - the `***:` director: stripped before the option check; options are valid only at the start;
 *   - the inline comment `(?#...)`: refused outside brackets (`hasRegexInlineComment`); `#` comments exist only under `x`;
 *   - escapes: `\X` consumes two characters, except `\cX` which takes the next character whatever it is (so three, modelled in
 *     both skip sites); `\x`, `\u`, `\U`, octal and class/constraint escapes take digits or nothing, so the digits are ordinary;
 *   - bracket expressions: a leading `^` and a leading `]` are members; `[:..:]`, `[.x.]`, `[=x=]` are skipped whole; a
 *     backslash escapes inside a bracket (ARE); an unterminated bracket is an engine error anyway.
 * A new ARE construct that consumes characters differently from these belongs on this list with its handling and a pin.
 */
import { GraphQLError } from 'graphql';

export const REGEX_PATTERN_MAX_CHARS = 200;

/**
 * #5486 SEC10 P2-1: the scanner reads brackets by the ARE rule (a backslash escapes inside brackets). A leading embedded
 * option `(?b)` (basic) or `(?e)` (extended) switches the engine to a syntax where a backslash in a bracket is an ordinary
 * character, so the scanner and the engine would disagree on where a bracket ends and a later backreference would pass.
 * `(?x)` (expanded) is the same class: a `#` then runs to the next newline, so a `[` inside that comment opens no bracket
 * while the scanner would read it as one and skip a later backreference (SEC10 P2-2). Embedded options are only valid at the
 * start of the pattern (after an optional `***:` director), so that is the only place looked at; a pattern that selects `b`,
 * `e` or `x` is refused, which keeps the scanner's assumptions (ARE rule, no comments) true. The other options (`i`, `c`, `n`,
 * `p`, `w`, `s`, `m`, `t`) do not change bracket or escape parsing, and `q` (literal) only makes the scanner over-refuse.
 */
export function selectsNonAreSyntax(pattern: string): boolean {
  let rest = pattern.startsWith('***:') ? pattern.slice(4) : pattern;
  for (;;) {
    const m = /^\(\?([A-Za-z]*)\)/.exec(rest);
    if (!m) return false;
    if (/[bex]/.test(m[1]!)) return true;
    rest = rest.slice(m[0].length);
  }
}

/**
 * #5486 SEC10 P2-3: an ARE inline comment `(?#...)` (default syntax, no option) ends at the first `)`, so a `[` inside it
 * opens no bracket while the scanner would read one and skip a later backreference. True when `pattern` holds `(?#` outside a
 * bracket expression and not escaped; the pattern is refused (a comment has no use in a search box).
 */
export function hasRegexInlineComment(pattern: string): boolean {
  return scan(pattern, 'comment');
}

/** True when `pattern` contains a backreference outside a bracket expression. */
export function hasRegexBackreference(pattern: string): boolean {
  return scan(pattern, 'backreference');
}

function scan(pattern: string, find: 'backreference' | 'comment'): boolean {
  let i = 0;
  const n = pattern.length;
  while (i < n) {
    const c = pattern[i]!;
    if (c === '\\') {
      const next = pattern[i + 1];
      if (find === 'backreference' && next !== undefined && next >= '1' && next <= '9') return true;
      i += next === 'c' ? 3 : 2; // the escape and what it takes: one character, or two for `\cX` (`\\` is one escape)
      continue;
    }
    if (c === '[') {
      i = skipBracketExpression(pattern, i + 1);
      continue;
    }
    if (find === 'comment' && c === '(' && pattern[i + 1] === '?' && pattern[i + 2] === '#') return true;
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
    if (c === '\\') { i += p[i + 1] === 'c' ? 3 : 2; continue; } // ARE: a backslash escapes inside brackets; `\cX` takes three characters
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

/** Refuse an over-long, non-ARE-syntax or backreferencing pattern. Run on the trimmed pattern, after the #435 bound, before any search. */
export function assertRegexPatternAllowed(pattern: string): void {
  if (pattern.length > REGEX_PATTERN_MAX_CHARS) {
    throw new GraphQLError(
      `A regex pattern is too long: at most ${REGEX_PATTERN_MAX_CHARS} characters are allowed. Shorten it; it is never truncated.`,
      { extensions: { code: 'BAD_USER_INPUT' } });
  }
  if (selectsNonAreSyntax(pattern)) {
    throw new GraphQLError('A regex pattern may not select the basic, extended or expanded syntax. Remove the leading option.',
      { extensions: { code: 'BAD_USER_INPUT' } });
  }
  if (hasRegexInlineComment(pattern)) {
    throw new GraphQLError('A regex pattern may not contain a comment. Remove the (?# ...) comment.',
      { extensions: { code: 'BAD_USER_INPUT' } });
  }
  if (hasRegexBackreference(pattern)) {
    throw new GraphQLError('A regex pattern may not use a backreference. Remove the back-reference.',
      { extensions: { code: 'BAD_USER_INPUT' } });
  }
}
