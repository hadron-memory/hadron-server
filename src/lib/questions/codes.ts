/**
 * #1641 §4 — decision codes. A log issues `n = lastCode + 1` under its lock
 * and the code is `prefix + bijective-base-26(n)`: with prefix `D`, 1 → DA,
 * 26 → DZ, 27 → DAA. Codes are never reused (withdrawn and purged decisions
 * consume theirs), so today's DA…DU are preserved by construction.
 */

const A = 'A'.charCodeAt(0);

/** Bijective base-26 letters for `n ≥ 1`: 1 → A, 26 → Z, 27 → AA, 702 → ZZ, 703 → AAA. */
export function bijectiveLetters(n: number): string {
  if (!Number.isSafeInteger(n) || n < 1) throw new RangeError(`decision number must be a positive integer, got ${n}`);
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

/** A log's code prefix: one to three upper-case letters (default `D`). */
export const DECISION_PREFIX_RE = /^[A-Z]{1,3}$/;
export const DEFAULT_DECISION_PREFIX = 'D';

/** The code of decision `n` in a log with `prefix`. */
export function decisionCode(prefix: string, n: number): string {
  return prefix + bijectiveLetters(n);
}

/** The loc of a decision: `<logLoc>:<code>`. */
export function decisionLoc(logLoc: string, code: string): string {
  return `${logLoc}:${code}`;
}

/**
 * Split a citation `DU` or `DU-1` into its code and optional part number,
 * given the log's prefix. Null when the citation is not of this log's shape.
 */
export function parseDecisionCitation(
  citation: string,
  prefix: string,
): { code: string; n: number; part: number | null } | null {
  const m = /^([A-Z]+)(?:-([1-9][0-9]{0,3}))?$/.exec(citation.trim());
  if (!m || !m[1].startsWith(prefix)) return null;
  const n = lettersToNumber(m[1].slice(prefix.length));
  if (n == null || n < 1) return null;
  return { code: m[1], n, part: m[2] ? Number(m[2]) : null };
}
