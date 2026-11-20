/**
 * #1641 §4 — question codes. A log issues `n = lastCode + 1` under its lock
 * and the code is `prefix + bijective-base-26(n)`: with prefix `Q`, 1 → QA,
 * 26 → QZ, 27 → QAA. Codes are never reused (withdrawn and purged questions
 * consume theirs), so earlier DA…DU codes are preserved by construction.
 */

const A = 'A'.charCodeAt(0);

/** Bijective base-26 letters for `n ≥ 1`: 1 → A, 26 → Z, 27 → AA, 702 → ZZ, 703 → AAA. */
export function bijectiveLetters(n: number): string {
  if (!Number.isSafeInteger(n) || n < 1) throw new RangeError(`question number must be a positive integer, got ${n}`);
  let out = '';
  let rest = n;
  while (rest > 0) {
    const digit = (rest - 1) % 26;
    out = String.fromCharCode(A + digit) + out;
    rest = Math.floor((rest - 1) / 26);
  }
  return out;
}

/** The inverse of {@link bijectiveLetters}; null for anything that is not upper-case letters. */
export function lettersToNumber(letters: string): number | null {
  if (!/^[A-Z]+$/.test(letters)) return null;
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - A + 1);
  return Number.isSafeInteger(n) ? n : null;
}

/** A log's code prefix: one to three upper-case letters (default `Q`, #4426). */
export const QUESTION_PREFIX_RE = /^[A-Z]{1,3}$/;
export const DEFAULT_QUESTION_PREFIX = 'Q';

/** The code of question `n` in a log with `prefix`. */
export function questionCode(prefix: string, n: number): string {
  return prefix + bijectiveLetters(n);
}

/** The loc of a question: `<logLoc>:<code>`. */
export function questionLoc(logLoc: string, code: string): string {
  return `${logLoc}:${code}`;
}

/**
 * Split a citation `QA` into its code and number, given the log's prefix.
 * Null when the citation is not of this log's shape. A part suffix (`QA-1`)
 * is not accepted: a node holds one question (#4426).
 */
export function parseQuestionCitation(
  citation: string,
  prefix: string,
): { code: string; n: number } | null {
  const m = /^([A-Z]+)$/.exec(citation.trim());
  if (!m || !m[1].startsWith(prefix)) return null;
  const n = lettersToNumber(m[1].slice(prefix.length));
  if (n == null || n < 1) return null;
  return { code: m[1], n };
}
