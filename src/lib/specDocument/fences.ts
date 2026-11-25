/** Fenced code blocks of a spec body, shared by the renderer and the unterminated-HTML pass (#5033). */

/** An open fenced code block: the delimiter character and the length it opened with (CommonMark 4.5). */
export interface OpenFence { ch: string; len: number }

/**
 * One line against the fence state. A fence opens with 3+ backticks or tildes (up to 3 spaces of indent; a
 * backtick fence's info string holds no backtick) and closes only on the same character, at least as long,
 * with nothing after it but whitespace. A shorter or different delimiter inside is body text.
 */
export function stepFence(line: string, open: OpenFence | null): { open: OpenFence | null; fenceLine: boolean } {
  if (open === null) {
    const f = /^ {0,3}(?=(`{3,}|~{3,}))\1(.*)$/.exec(line);
    if (f && !(f[1][0] === '`' && f[2].includes('`'))) return { open: { ch: f[1][0], len: f[1].length }, fenceLine: true };
    return { open: null, fenceLine: false };
  }
  const c = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
  if (c && c[1][0] === open.ch && c[1].length >= open.len) return { open: null, fenceLine: true };
  return { open, fenceLine: false };
}
