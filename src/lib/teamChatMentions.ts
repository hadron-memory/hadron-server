/** Mark Markdown code regions without changing offsets used by the mention matcher. */
function markdownCodeMask(body: string): Uint8Array {
  const mask = new Uint8Array(body.length);
  const mark = (start: number, end: number): void => { mask.fill(1, start, end); };
  let fence: { marker: string; length: number; quoteDepth: number; listIndent: number | null } | null = null;
  let paragraphActive = false;
  let quoteDepth = 0;
  let listIndent: number | null = null;

  for (let start = 0; start < body.length;) {
    const newline = body.indexOf('\n', start);
    const end = newline < 0 ? body.length : newline + 1;
    const rawLine = body.slice(start, newline < 0 ? end : newline).replace(/\r$/, '');
    let line = rawLine;

    if (fence) {
      // Only the quote markers that CONTAIN the fence are structural. A
      // further '>' is literal code (for example, a pasted shell prompt).
      let inContainer = true;
      for (let depth = 0; depth < fence.quoteDepth; depth++) {
        const quote = /^ {0,3}>[ \t]?/.exec(line);
        if (!quote) { inContainer = false; break; }
        line = line.slice(quote[0].length);
      }
      if (inContainer && fence.listIndent !== null && line.trim() !== '') {
        const spaces = /^( *)/.exec(line)![1].length;
        if (spaces >= fence.listIndent) line = line.slice(fence.listIndent);
        else inContainer = false;
      }
      if (inContainer) {
        mark(start, end);
        const closer = /^ {0,3}(`+|~+)[ \t]*$/.exec(line);
        if (closer && closer[1][0] === fence.marker && closer[1].length >= fence.length) fence = null;
        start = end;
        continue;
      }
      // A required quote or list marker disappeared: parse the raw line as a
      // new block, since a fenced block has no lazy container continuation.
      fence = null;
      line = rawLine;
    }

    let currentQuoteDepth = 0;
    for (;;) {
      const quote = /^ {0,3}>[ \t]?/.exec(line);
      if (!quote) break;
      currentQuoteDepth++;
      line = line.slice(quote[0].length);
    }
    if (currentQuoteDepth !== quoteDepth) {
      quoteDepth = currentQuoteDepth;
      listIndent = null;
      paragraphActive = false;
    }

    // Inside a list item, indentation is relative to its content column.
    // Four absolute spaces may still be ordinary list prose or a list fence.
    if (listIndent !== null && line.trim() !== '') {
      const spaces = /^( *)/.exec(line)![1].length;
      if (spaces >= listIndent) line = line.slice(listIndent);
      else {
        listIndent = null;
        paragraphActive = false;
      }
    }

    if (line.trim() === '') {
      paragraphActive = false;
    } else {
      const listMarker = /^ {0,3}(?:[-+*]|\d{1,9}[.)])(?:[ \t]+|$)/.exec(line);
      if (listMarker) {
        listIndent = (listIndent ?? 0) + listMarker[0].length;
        line = line.slice(listMarker[0].length);
        paragraphActive = false;
      }
      const opener = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
      if (opener && (opener[1][0] === '~' || !opener[2].includes('`'))) {
        fence = { marker: opener[1][0], length: opener[1].length, quoteDepth, listIndent };
        mark(start, end);
        paragraphActive = false;
      } else if (!paragraphActive && /^(?: {4}|\t)/.test(line)) {
        mark(start, end);
      } else if (/^ {0,3}#{1,6}(?:[ \t]|$)/.test(line)) {
        paragraphActive = false;
      } else {
        paragraphActive = true;
      }
    }
    start = end;
  }

  // A code span closes at the next run of exactly the opener's length.
  // Runs inside fenced or indented blocks cannot open or close one.
  const runs: Array<{ start: number; end: number; length: number; escaped: boolean }> = [];
  for (let i = 0; i < body.length;) {
    if (mask[i] || body[i] !== '`') { i++; continue; }
    const start = i;
    while (i < body.length && !mask[i] && body[i] === '`') i++;
    let escapes = 0;
    while (start - escapes - 1 >= 0 && body[start - escapes - 1] === '\\') escapes++;
    runs.push({ start, end: i, length: i - start, escaped: escapes % 2 === 1 });
  }
  const next = new Array<number>(runs.length).fill(-1);
  const nextByLength = new Map<number, number>();
  for (let i = runs.length - 1; i >= 0; i--) {
    next[i] = nextByLength.get(runs[i].length) ?? -1;
    nextByLength.set(runs[i].length, i);
  }
  for (let i = 0; i < runs.length;) {
    if (runs[i].escaped) { i++; continue; }
    const close = next[i];
    if (close < 0) { i++; continue; }
    mark(runs[i].start, runs[close].end);
    i = close + 1;
  }
  return mask;
}

/**
 * Extract write-time mention tokens (cor:agt:020:04), excluding Markdown code
 * per Holger's #1423 ruling. Email boundaries and token spelling
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
