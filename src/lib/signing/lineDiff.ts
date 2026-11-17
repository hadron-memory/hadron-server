/**
 * #1632 S2b-2 (cor:dmo:130:08) — a line diff for the signing page: what changed since the last signed revision.
 * Pure and bounded: past the size cap it degrades to "all old lines out, all new lines in", which is a true diff
 * (just not a minimal one), never a refusal and never a partial one.
 */
export interface DiffLine { kind: 'same' | 'add' | 'del'; text: string }

/** `old.length * new.length` above this is not worth an LCS table on a request path. */
const MAX_CELLS = 4_000_000;

const linesOf = (s: string | null | undefined): string[] => (s == null || s === '' ? [] : s.split('\n'));

/** Line diff of `before` against `after` (null reads as empty). Equal inputs are all `same`. */
export function lineDiff(before: string | null | undefined, after: string | null | undefined): DiffLine[] {
  const a = linesOf(before);
  const b = linesOf(after);
  // Trim the shared head and tail: most edits touch a small middle, and this keeps the table small.
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail += 1;
  const am = a.slice(head, a.length - tail);
  const bm = b.slice(head, b.length - tail);
  const out: DiffLine[] = [];
  for (let k = 0; k < head; k += 1) out.push({ kind: 'same', text: a[k] });
  if (am.length * bm.length > MAX_CELLS) {
    // Loops, never spreads: a spread passes every line as an argument and throws RangeError on a large revision.
    for (const text of am) out.push({ kind: 'del', text });
    for (const text of bm) out.push({ kind: 'add', text });
  } else {
    // lcs[i][j] = LCS length of am[i..] and bm[j..].
    const w = bm.length + 1;
    const lcs = new Uint32Array((am.length + 1) * w);
    for (let i = am.length - 1; i >= 0; i -= 1) {
      for (let j = bm.length - 1; j >= 0; j -= 1) {
        lcs[i * w + j] = am[i] === bm[j] ? lcs[(i + 1) * w + j + 1] + 1 : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < am.length && j < bm.length) {
      if (am[i] === bm[j]) { out.push({ kind: 'same', text: am[i] }); i += 1; j += 1; }
      else if (lcs[(i + 1) * w + j] >= lcs[i * w + j + 1]) { out.push({ kind: 'del', text: am[i] }); i += 1; }
      else { out.push({ kind: 'add', text: bm[j] }); j += 1; }
    }
    while (i < am.length) { out.push({ kind: 'del', text: am[i] }); i += 1; }
    while (j < bm.length) { out.push({ kind: 'add', text: bm[j] }); j += 1; }
  }
  for (let k = a.length - tail; k < a.length; k += 1) out.push({ kind: 'same', text: a[k] });
  return out;
}
