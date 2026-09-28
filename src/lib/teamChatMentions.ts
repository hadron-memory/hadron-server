/** Mark Markdown code regions without changing offsets used by the mention matcher. */
function markdownCodeMask(body: string): Uint8Array {
  const mask = new Uint8Array(body.length);
  const mark = (start: number, end: number): void => { mask.fill(1, start, end); };
  let fence: { marker: string; length: number } | null = null;
  let paragraphActive = false;

  for (let start = 0; start < body.length;) {
    const newline = body.indexOf('\n', start);
    const end = newline < 0 ? body.length : newline + 1;
    const line = body.slice(start, newline < 0 ? end : newline).replace(/\r$/, '');
    if (fence) {
      mark(start, end);
      const closer = /^ {0,3}(`+|~+)[ \t]*$/.exec(line);
      if (closer && closer[1][0] === fence.marker && closer[1].length >= fence.length) fence = null;
    } else if (line.trim() === '') {
      paragraphActive = false;
    } else {
      const opener = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
      if (opener && (opener[1][0] === '~' || !opener[2].includes('`'))) {
        fence = { marker: opener[1][0], length: opener[1].length };
        mark(start, end);
        paragraphActive = false;
      } else if (!paragraphActive && /^(?: {4}|\t)/.test(line)) {
        mark(start, end);
      } else {
        paragraphActive = true;
      }
    }
    start = end;
  }

  // A code span closes at the next run of exactly the opener's length.
  // Runs inside fenced or indented blocks cannot open or close one.
  const runs: Array<{ start: number; end: number; length: number }> = [];
  for (let i = 0; i < body.length;) {
    if (mask[i] || body[i] !== '`') { i++; continue; }
    const start = i;
    while (i < body.length && !mask[i] && body[i] === '`') i++;
    let escapes = 0;
    while (start - escapes - 1 >= 0 && body[start - escapes - 1] === '\\') escapes++;
    if (escapes % 2 === 1) continue;
    runs.push({ start, end: i, length: i - start });
  }
  const next = new Array<number>(runs.length).fill(-1);
  const nextByLength = new Map<number, number>();
  for (let i = runs.length - 1; i >= 0; i--) {
    next[i] = nextByLength.get(runs[i].length) ?? -1;
    nextByLength.set(runs[i].length, i);
  }
  for (let i = 0; i < runs.length;) {
    const close = next[i];
    if (close < 0) { i++; continue; }
    mark(runs[i].start, runs[close].end);
    i = close + 1;
  }
  return mask;
}

/**
 * Extract write-time mention tokens (cor:agt:020:04), excluding Markdown code
 * per the local #1423 policy candidate. Email boundaries and token spelling
 * retain the existing #939 behavior.
 */
export function extractMentions(body: string): string[] {
  const code = markdownCodeMask(body);
  const seen = new Set<string>();
  for (const match of body.matchAll(/(?<=^|[^A-Za-z0-9._-])@([A-Za-z0-9][A-Za-z0-9._-]*)/g)) {
    if (code[match.index]) continue;
    const token = match[1].replace(/[^A-Za-z0-9]+$/, '').toLowerCase();
    if (token) seen.add(token);
  }
  return [...seen];
}
