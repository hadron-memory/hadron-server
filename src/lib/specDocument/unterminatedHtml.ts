/**
 * #5033 (cor:spc:030:02, ruling 0206; option (b), Decided by Holger 2026-11-25): authored text that ends in an UNTERMINATED raw-HTML construct
 * swallows what follows it. The renderer puts the server's own `<a id>` anchor (and the next heading) right after a part's
 * body, so in an HTML5 parser an open tag takes the anchor's `id` as one of its own attributes, an open quoted value takes the
 * anchor and the heading with it, and a raw-text element (`<textarea>`, `<script>`, `<style>`, `<title>`), a comment, a
 * declaration or a CDATA section turns the rest of the document into its text. In a Markdown renderer a line that opens an
 * HTML block of CommonMark's types 1 to 5 does the same: it ends only at its closing marker, so the blank line the spec
 * requires does not end it ("in every reader" is not true for this input).
 *
 * The fix: the opening `<` of such a construct becomes `&lt;`. That is a character reference to the same character, so the
 * text reads exactly as authored in HTML and in Markdown, and the construct never opens. Nothing else is touched, and a text
 * with no unterminated construct comes back as the same string.
 *
 * Reader model (BLIND P2): the document is "one Markdown string" (cor:spc:030:02); the CLI prints it and the portal renders
 * it, so a Markdown pass sits between this renderer and the browser. Where that pass keeps a construct as text (code, fences,
 * a backslash escape) nothing is escaped. Where it passes the construct through as HTML, an HTML5 parser reads it and this
 * pass must have closed it. A reader that parses the raw string as HTML (the filing's) is stricter than any Markdown renderer
 * and is the acceptance oracle for everything the tokenizer reads; the Markdown-level rules below are pinned on the scanner.
 *
 * What counts as a construct (an approximation of the HTML5 tokenizer plus the CommonMark HTML blocks, strict where the two
 * differ so that neither reader is left open):
 *  - a start or end tag with no closing `>` (a quote opens a value only right after `=`; an unquoted value ends at a blank);
 *  - `</` and anything but a letter or `>`: a bogus comment, which runs to the next `>`;
 *  - a raw-text element (`script style textarea title xmp iframe noembed noframes noscript`) with no end tag of its own, and
 *    `plaintext`, which has none; a `template` with no end tag (its content is read as usual, but the anchor would sit in it) An end tag with no `>` leaves the element open. In the middle of a line the
 *    element is inline HTML, so only an end tag outside code, a fence and a backslash escape closes it; at the head of a line
 *    (script, style, textarea) it is a CommonMark type 1 block that ends at the first line holding the end tag, code or not;
 *  - a `pre` at the head of a line (CommonMark type 1) with none of `</pre>`, `</script>`, `</style>`, `</textarea>` after it;
 *  - a comment with no `-->`, a CDATA section with no `]]>`, a processing instruction with no `?>`, a declaration with no `>`
 *    (a construct that holds a `>` before its closer is left unterminated: a browser ends CDATA and a processing instruction at the
 *    first `>`, Markdown and htmlparser2 at the closer, and the readers would resume in different places).
 *  - inline (not at the head of a line), none of these may run past a block boundary: a heading, fence, quote, list item or
 *    blank line ends the paragraph, so a closer beyond one is no closer.
 * A raw-text element at the head of a line that CommonMark does not start a type 1 block with (`title`, `xmp`, `iframe` and the like)
 * is judged like an inline one, so an end tag only inside code leaves it open: stricter than needed, anchor-safe, and deliberate.
 * Not read: fenced code, indented code (also inside a block quote), inline code spans and a backslash-escaped `<` (Markdown
 * shows those as text, and a character reference is not decoded inside code, so escaping there would change what a code
 * sample shows). A four-space continuation of a list item is read as indented code, so an unterminated construct in one is
 * left as written. Line breaks are read as `\n`, as the rest of the renderer reads them.
 *
 * Containers (#5151): an HTML block or a fence may start after a line's own quote and list markers, and ends where those containers end.
 * The markers are read past and never changed. A raw reader takes a quote marker for a `>`, so a construct inside a quote may not cross a line.
 * Limits, pinned in unterminatedHtmlRender5151.test.ts: a tag whose attribute Markdown does not accept, a type 1 end tag alone on a line,
 * `<!-->` at the head of a line, and a four-space continuation of a list item.
 *
 * Cost: one linear scan per escape, each from the start of the escaped text (an open construct may hide another, and an open
 * `<template>` stays open after a later construct is escaped), at most {@link MAX_RESTARTS} times; a text that needs more has
 * every `<` in it escaped (a body that hides more than that many constructs behind one another is not an authoring case).
 */
import { stepFence, type OpenFence } from './fences.js';

/** Elements whose content is text up to their own end tag. */
const RAW_TEXT = new Set(['script', 'style', 'textarea', 'title', 'xmp', 'iframe', 'noembed', 'noframes', 'noscript']);
const MAX_RESTARTS = 32;
/** #5265 — the scans the last call of escapeUnterminatedHtml ran (one per model per escape), for a pin that bounds the work, not the wall clock. */
let scansRun = 0;
/** #5332 — a raw-text element's (or `plaintext`) start: it takes the rest of the page as text once a reader emits it. */
const RAW_TEXT_START = /<(script|style|textarea|title|xmp|iframe|noembed|noframes|noscript|plaintext)(?=[\s/>]|$)/i;
/**
 * #5332 — where a bogus comment (`<!` or `</` with no letter after it, at `at`, running to the `>` at `close`) hides a raw-text start that
 * Markdown emits, or -1. Markdown reads the `<!` or `</` as text and the tag before the `>` as a tag (`<!<script>` emits the `<script>` raw);
 * a browser reading the raw string ends a bogus comment at that `>`. Only a start tag Markdown accepts, on one line and ending at that `>`, with nothing
 * before it in the comment that Markdown could read another way (a `<`, a backtick, a backslash), on the comment's line or the next, and
 * not closed later by its own end tag (Markdown's raw text then ends where a browser's reading resumes anyway).
 */
function bogusHiddenTag(text: string, at: number, close: number, ctx: () => HiddenContext): number {
  const body = text.slice(at + 2, close + 1);
  const raw = RAW_TEXT_START.exec(body);
  if (raw === null) return -1;
  const before = body.slice(0, raw.index);
  // Before the first hidden start this pass escaped, the earlier, stricter test stands (#5332): a `<`, a backtick or a backslash before the tag
  // rules it out. Behind one, what that element's raw text masked is read afresh, so a tag there that Markdown emits must be caught (#5388 QA at
  // 722ea31f): only what Markdown could read another way rules it out there, a `<` that may start a construct holding the tag (a
  // comment, processing instruction or CDATA section with its closer somewhere after it, a declaration with a blank after its name, or a start
  // tag with a quoted value, the one place a tag holds a `<`; `</`, `<!<`, `<![` and a name followed by `<` are text), a backslash that escapes
  // the tag's own `<`, or a backtick run with a run of its length after the tag. Before a bare CR (a line break to every reader, not to the walk)
  // the stricter test stands there too.
  const strict = /[<`\\]/.test(before);
  const ruledOut = at < ctx().escapedFrom || before.includes('\r') ? strict : maskedRuledOut(text, ctx(), at, close, before);
  if (ruledOut || before.split('\n').length > 2 || !CM_OPEN_TAG.test(body.slice(raw.index)) || body.includes('\n', raw.index)) return -1;
  // At the head of a line the tag may start an HTML block in one reader and continue a paragraph in another (markdown-it's lazy lines), so
  // escaping it can move what follows into another block: only when nothing after it holds a tag. A block starts there only for a type 1 or 6
  // name, or a tag alone on its line (type 7); any other tag with more on its line is inline in every reader (#5388 QA).
  const lineHead = /[\n\r][ \t]*$/.test(before);
  const name0 = raw[1].toLowerCase();
  const blockish = TYPE1_NAMES.has(name0) || BLOCK6_NAMES.has(name0) || /^[ \t]*(?:[\r\n]|$)/.test(text.slice(close + 1, close + 1 + 256));
  if (lineHead && blockish && text.includes('<', close + 1)) return -1;
  if (inHtmlBlock(text, ctx(), at + 2 + raw.index)) return -1;
  const name = raw[1].toLowerCase();
  if (name !== 'plaintext') {
    if (emittedEndTag(text, ctx(), at, close + 1, name) !== -1) return -1;
  }
  return at + 2 + raw.index;
}

/** #5388 (QA) — the test of {@link bogusHiddenTag} behind an escaped hidden start: whether `before` holds what Markdown reads another way. */
function maskedRuledOut(text: string, ctx: HiddenContext, at: number, close: number, before: string): boolean {
  // Whether `closer` occurs at or after `k`: the last one is looked up once per text, so each hidden tag costs no rescan.
  const after = (closer: string, k: number): boolean => {
    let l = ctx.lastOf.get(closer);
    if (l === undefined) { l = text.lastIndexOf(closer); ctx.lastOf.set(closer, l); }
    return l >= k;
  };
  const opens = (re: RegExp, closer: string): boolean => { const m = re.exec(before); return m !== null && after(closer, at + 2 + m.index + 2); };
  return /<(?:![A-Za-z]+[ \t\r\n])|<[A-Za-z][^<]*["']/.test(before) || opens(/<!--/, '-->') || opens(/<!\[CDATA\[/, ']]>') || opens(/<\?/, '?>')
    || /(?:^|[^\\])(?:\\\\)*\\$/.test(before) || [...before.matchAll(/`+/g)].some((m) => runAfter(text, ctx, m[0].length, close + 1));
}

/**
 * #5369 — what the two checks below need of one text, built once per scan (#5388 LOCAL P1: each check used to rescan the text per hidden tag,
 * which made a 40 KB body cost seconds). Lines end at LF, CRLF and a bare CR, as in the readers.
 */
interface HiddenContext {
  /** The earliest offset from which an end tag has a fence-like line or a link destination, title or reference definition before it. */
  readonly codeFrom: number;
  /** Per raw-text name, the end tags of that name (see {@link endTagIndex}). */
  readonly endTags: Map<string, EndTagIndex>;
  /** Per closer string, where its last occurrence starts (-1 for none), filled on first use. */
  readonly lastOf: Map<string, number>;
  /** Per backtick run length, where the last run of exactly that length starts (see {@link runAfter}), built on first use. */
  lastRun?: Map<number, number>;
  /** #5388 (QA) — where the first hidden raw-text start this pass escaped (`<!&lt;name`, `</&lt;name`) begins (Infinity for none). */
  readonly escapedFrom: number;
  /** The raw reader's one pass over the text (see {@link rawReader}), built on first use. */
  raw?: RawWalks;
  /** Where each line starts. */
  readonly lineStarts: number[];
  /** The walk of {@link inHtmlBlock}: where each step starts, and the walk's state before it. */
  readonly steps: number[];
  readonly states: BlockState[];
}
/**
 * The end tags of one name, in order (`at`). `next[i]` is the first end tag from `i` on that decides the search of {@link emittedEndTag} (one
 * not held in indented code or behind a backslash, or one at or after `codeFrom`), -1 for none; `fenced[i]` whether `at[i]` is at or after
 * `codeFrom`; `upTo[i]` the furthest backtick run start before one of the end tags `at[i]` to `at[next[i]]` that a run of its length after
 * that end tag could close (-1 for none).
 */
interface EndTagIndex { readonly at: number[]; readonly next: number[]; readonly fenced: boolean[]; readonly upTo: number[] }
interface BlockState { readonly fence: RegExp | null; readonly opened: boolean; readonly afterText: boolean }

function hiddenContext(text: string): HiddenContext {
  // The earliest end of a fence-like line (its first three markers) and of a `](` or `]:`: an end tag at or after either is held as code or link text by some reader.
  const fence = /(?:^|[\r\n])[ \t>*+\-\d.)]*(?:`{3}|~{3})/.exec(text);
  const link = /\][ \t\r\n]*[(:]/.exec(text);
  const codeFrom = Math.min(fence === null ? Infinity : fence.index + fence[0].length, link === null ? Infinity : link.index + link[0].length);
  const steps: number[] = [];
  const states: BlockState[] = [];
  walkBlocks(text, 0, { fence: null, opened: false, afterText: false }, Infinity, (s, state) => { steps.push(s); states.push(state); });
  const lineStarts = [0];
  for (const m of text.matchAll(LINE_END)) lineStarts.push(m.index + m[0].length);
  const escaped = /<[!/]&lt;(?:script|style|textarea|title|xmp|iframe|noembed|noframes|noscript|plaintext)(?=[\s/>]|$)/i.exec(text);
  return { codeFrom, endTags: new Map(), lastOf: new Map(), escapedFrom: escaped === null ? Infinity : escaped.index, lineStarts, steps, states };
}

/** The offset just past the next line end at or after `k` (-1 for none), and that line end (the text's length for none). */
const LINE_END = /\r\n|\r|\n/g;
/** The line ends of the last text asked about (start and length of each), so a lookup is a binary search, not a scan to the next one. */
let lineEndsOf: { text: string; at: number[]; len: number[] } | null = null;
function lineEndFrom(text: string, k: number): { end: number; next: number } {
  if (lineEndsOf === null || lineEndsOf.text !== text) {
    const at: number[] = [];
    const len: number[] = [];
    for (const m of text.matchAll(LINE_END)) { at.push(m.index); len.push(m[0].length); }
    lineEndsOf = { text, at, len };
  }
  const { at, len } = lineEndsOf;
  let lo = 0;
  let hi = at.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (at[mid] < k) lo = mid + 1; else hi = mid; }
  return lo === at.length ? { end: text.length, next: -1 } : { end: at[lo], next: at[lo] + len[lo] };
}

/**
 * #5369 (#5370 BLIND P2b) — the end tag of `name` after `from` that closes the hidden element (its offset, -1 for none): one every reader emits raw. Only a tag
 * Markdown accepts (`</name>`, spaces or tabs before the `>`), with no fence-like line, link destination, link title or reference definition
 * anywhere before it, no backtick run between `from` and it that a run of the same length after it could close into a code span, no indent
 * before it on its line that could make the line code (a tab or four spaces among the line's leading blanks and quote and list markers,
 * stacked or not), and no backslash right before it. Anything else is not counted, which keeps the escape. The first end tag that is not
 * held in code or behind a backslash decides; one before it held in a code span keeps the escape as well.
 */
function emittedEndTag(text: string, ctx: HiddenContext, at: number, from: number, name: string): number {
  let index = ctx.endTags.get(name);
  if (index === undefined) { index = endTagIndex(text, ctx, name); ctx.endTags.set(name, index); }
  let lo = 0;
  let hi = index.at.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (index.at[mid] < from) lo = mid + 1; else hi = mid; }
  if (lo === index.at.length) return -1;
  const stop = index.next[lo];
  if (stop === -1 || index.fenced[stop] || index.upTo[lo] >= from) return -1;
  // #5388 QA F1: Markdown's raw text ends at this end tag, so a browser resumes right after it; a raw reader of the string must be in data
  // there too, or what follows is read two ways. It is when the end tag starts a token in data, or a token ends at its own `>`: a raw-text
  // element of its own name that the reader opened after the bogus comment, or a bogus comment that holds it. The reading is the
  // pass of {@link rawReader} from the start when that pass reads the bogus comment at `at` from data too; otherwise a walk from the comment's
  // `>`, which stops where it meets a token an earlier walk read from data (both read alike from there), so every offset is walked once.
  const end = index.at[stop];
  const walks = (ctx.raw ??= { owner: new Map(), walks: [] });
  if (walks.walks.length === 0) rawReader(text, 0, walks);
  let w = walks.owner.get(at) === 0 ? walks.walks[0] : rawReader(text, from, walks);
  while (w.joinAt !== -1 && end >= w.joinAt) w = walks.walks[w.joinWalk];
  return w.data.has(end) || w.ends.has(text.indexOf('>', end) + 1) ? end : -1;
}

/**
 * Where a raw reader's tokens start in data, where each token ends (a raw-text element's at its end tag's `>`), and where the walk
 * joined an earlier one (from `joinAt` on, walk `joinWalk` holds the reading; -1 for none).
 */
interface RawReading { data: Set<number>; ends: Set<number>; joinAt: number; joinWalk: number }
/** The walks of {@link rawReader} over one text: which walk first read each token start from data, and each walk (0 is from the start). */
interface RawWalks { owner: Map<number, number>; walks: RawReading[] }
/**
 * #5388 (QA F1) — an HTML tokenizer's reading of `text` from `from` (in data), up to a token an earlier walk read: the offsets of the `<` that start a token
 * in data, and just past each token. Comments end at `-->` or `--!>`; `<!`, `<?` and `</`
 * before a non-letter are bogus comments to the next `>`; a tag ends at the first `>` outside a quoted value; `<` before anything else is text.
 */
/** A comment from its `<!--` to the first `-->` or `--!>` (sticky: its one user sets `lastIndex` first). */
const RAW_COMMENT = /<!--[\s\S]*?--!?>/y;
function rawReader(text: string, from: number, walks: RawWalks): RawReading {
  const data = new Set<number>();
  const ends = new Set<number>();
  const self = walks.walks.length;
  const reading: RawReading = { data, ends, joinAt: -1, joinWalk: -1 };
  walks.walks.push(reading);
  const tagEnd = (k: number): number => {
    for (let j = k; j < text.length; j += 1) {
      const c = text[j];
      if (c === '>') return j;
      if ((c === '"' || c === "'") && /=[ \t\n\f\r]*$/.test(text.slice(Math.max(k, j - 8), j))) { const q = text.indexOf(c, j + 1); if (q === -1) return -1; j = q; }
    }
    return -1;
  };
  let i = text.indexOf('<', from);
  while (i !== -1) {
    const owner = walks.owner.get(i);
    if (owner !== undefined && owner !== self) { reading.joinAt = i; reading.joinWalk = owner; break; }
    walks.owner.set(i, self);
    data.add(i);
    const c = text[i + 1];
    let next: number;
    if (text.startsWith('<!--', i)) {
      // `<!-->` and `<!--->` end at once (handled here); any other comment, `<!---x` included, runs to `-->` or `--!>` (#5388 BLIND P2 at dabc70c5).
      RAW_COMMENT.lastIndex = i;
      const r = text.startsWith('<!-->', i) ? i + 5 : text.startsWith('<!--->', i) ? i + 6 : (RAW_COMMENT.exec(text) ? RAW_COMMENT.lastIndex : -1);
      next = r;
    } else if (c === '!' || c === '?' || (c === '/' && !isLetter(text[i + 2]) && text[i + 2] !== '>')) {
      const r = text.indexOf('>', i + 2);
      next = r === -1 ? -1 : r + 1;
    } else if (c === '/' && text[i + 2] === '>') {
      next = i + 3;
    } else if (isLetter(c) || (c === '/' && isLetter(text[i + 2]))) {
      const r = tagEnd(i + 1);
      next = r === -1 ? -1 : r + 1;
      const name = c === '/' ? null : (/^[A-Za-z][^\s/>]*/.exec(text.slice(i + 1, i + 40)) as RegExpExecArray)[0].toLowerCase();
      if (next !== -1 && name === 'plaintext') next = -1;
      else if (next !== -1 && name !== null && RAW_TEXT.has(name)) {
        const close = new RegExp(`</${name}(?=[\\t\\n\\f\\r />])`, 'gi');
        close.lastIndex = next;
        const m = close.exec(text);
        if (m === null) next = -1;
        else { const r2 = tagEnd(m.index + 2); next = r2 === -1 ? -1 : r2 + 1; }
      }
    } else {
      next = i + 1;
    }
    if (next === -1) break;
    ends.add(next);
    i = text.indexOf('<', next);
  }
  return reading;
}

/** #5388 (QA) — whether a backtick run of exactly `len` starts at or after `k` (the last start per length is found once per text). */
function runAfter(text: string, ctx: HiddenContext, len: number, k: number): boolean {
  if (ctx.lastRun === undefined) {
    const last = new Map<number, number>();
    for (const m of text.matchAll(/`+/g)) last.set(m[0].length, m.index);
    ctx.lastRun = last;
  }
  return (ctx.lastRun.get(len) ?? -1) >= k;
}

/**
 * #5388 (QA F2) — whether a line between `at` and `close` that continues the `<!`'s paragraph opens a comment or a CDATA section (up to
 * three spaces in) that runs past `close`: Markdown holds that block to its closer, and a reader that keeps CDATA (htmlparser2) or the comment
 * would too. A bare CR is not a line break here, as in the walk: a stated limit (#5401), pinned in the #5369 tests; treating it as one here
 * alone, while the walk does not, loses anchors main keeps (BLIND P2 at dabc70c5, measured).
 */
/** Where each line-head `<!--` or `<![CDATA[` of the last text asked about starts, found once per text. */
let commentLinesOf: { text: string; open: number[]; kind: string[] } | null = null;
function commentLineCrossed(text: string, at: number, close: number): boolean {
  if (commentLinesOf === null || commentLinesOf.text !== text) {
    const open: number[] = [];
    const kind: string[] = [];
    for (const m of text.matchAll(/\n {0,3}(<!--|<!\[CDATA\[)/g)) { open.push(m.index + m[0].length - m[1].length); kind.push(m[1]); }
    commentLinesOf = { text, open, kind };
  }
  const { open: opens, kind } = commentLinesOf;
  let lo = 0;
  let hi = opens.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (opens[mid] <= at) lo = mid + 1; else hi = mid; }
  for (let x = lo; x < opens.length && opens[x] < close; x += 1) {
    const open = opens[x];
    // Only a line that continues the `<!`'s paragraph: past a blank line, or a line that opens another HTML block, the opener is in that
    // block, and both readers read it the same way.
    if (/\n[ \t]*\n|\n {0,3}<(?:[?!]|\/?(?:script|style|textarea|pre)[\s>])/i.test(text.slice(at, open - 1))) break;
    const end = kind[x] === '<![CDATA[' ? text.indexOf(']]>', open + 9)
      : text.startsWith('<!-->', open) ? open + 2 : text.startsWith('<!--->', open) ? open + 3 : text.indexOf('-->', open + 4);
    if (end === -1 || end > close - 2) return true;
  }
  return false;
}


function endTagIndex(text: string, ctx: HiddenContext, name: string): EndTagIndex {
  const at: number[] = [];
  const re = new RegExp(`</${name}[ \\t]*>`, 'gi');
  for (let m = re.exec(text); m !== null; m = re.exec(text)) at.push(m.index);
  // Backtick runs, in order; for each length, where the last run of that length starts.
  const runs: Array<[number, number]> = [];
  const lastOf = new Map<number, number>();
  for (const m of text.matchAll(/`+/g)) { runs.push([m.index, m[0].length]); lastOf.set(m[0].length, m.index); }
  // For each end tag, the latest run before it whose length has a run after it (a max-heap of the latest run start per length, entries
  // dropped once stale or once no run of their length follows).
  const latest = new Map<number, number>();
  const heap: Array<[number, number]> = [];
  const push = (e: [number, number]): void => {
    heap.push(e);
    for (let i = heap.length - 1; i > 0;) { const p = (i - 1) >> 1; if (heap[p][0] >= heap[i][0]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; }
  };
  const pop = (): void => {
    const last = heap.pop() as [number, number];
    if (heap.length === 0) return;
    heap[0] = last;
    for (let i = 0; ;) {
      const l = 2 * i + 1;
      const r = l + 1;
      let top = i;
      if (l < heap.length && heap[l][0] > heap[top][0]) top = l;
      if (r < heap.length && heap[r][0] > heap[top][0]) top = r;
      if (top === i) break;
      [heap[top], heap[i]] = [heap[i], heap[top]];
      i = top;
    }
  };
  const open: number[] = [];
  let r = 0;
  for (const pos of at) {
    for (; r < runs.length && runs[r][0] < pos; r += 1) { latest.set(runs[r][1], runs[r][0]); push([runs[r][0], runs[r][1]]); }
    while (heap.length > 0 && (latest.get(heap[0][1]) !== heap[0][0] || (lastOf.get(heap[0][1]) as number) < pos)) pop();
    open.push(heap.length === 0 ? -1 : heap[0][0]);
  }
  const indented = new Map<number, boolean>();
  const fenced = at.map((pos) => pos >= ctx.codeFrom);
  let line = 0;
  const decisive = at.map((pos, i) => {
    if (fenced[i]) return true;
    for (; line + 1 < ctx.lineStarts.length && ctx.lineStarts[line + 1] <= pos; line += 1);
    const start = ctx.lineStarts[line];
    let code = indented.get(start);
    if (code === undefined) {
      // The line's leading blanks and quote and list markers (the end tag's `<` ends them): a tab or four spaces among them may make it code.
      code = /\t| {4}/.test((/^[ \t>*+\-\d.)]*/.exec(text.slice(start, pos)) as RegExpExecArray)[0]);
      indented.set(start, code);
    }
    return !code && text[pos - 1] !== '\\';
  });
  const next = new Array<number>(at.length);
  const upTo = new Array<number>(at.length);
  for (let i = at.length - 1; i >= 0; i -= 1) {
    const tail = decisive[i] || i === at.length - 1;
    next[i] = decisive[i] ? i : i === at.length - 1 ? -1 : next[i + 1];
    upTo[i] = tail ? open[i] : Math.max(open[i], upTo[i + 1]);
  }
  return { at, next, fenced, upTo };
}

/**
 * #5369 — whether every reader has `at` (a raw-text start a bogus comment hides) inside an HTML block, where Markdown passes the bogus comment
 * through and the browser reads it, so the tag it hides is inert. Only blocks that open at column 0 count, so that no list item or quote can
 * hold the line instead: a type 6 block up to the next blank line, and a type 1 to 5 block up to where both readers end it (CommonMark ends
 * one of types 1 and 2 with the line that holds its closer, marked ends types 3 to 5 right after the closer). The lines before are read for
 * what could hold the opener line instead (a fence, a block of types 1 to 5 that is still open): any of those, even one that only looks like
 * it, and the answer is no, which keeps the escape. After a paragraph line an opener counts only as a tag alone on its line: marked reads a
 * paragraph line, an opener line holding more and a `-` line as one heading. The walk is the context's, resumed at the step holding `at`.
 */
function inHtmlBlock(text: string, ctx: HiddenContext, at: number): boolean {
  let lo = 0;
  let hi = ctx.steps.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (ctx.steps[mid] <= at) lo = mid; else hi = mid - 1; }
  return walkBlocks(text, ctx.steps[lo], ctx.states[lo], at, () => undefined);
}

/** The walk of {@link inHtmlBlock} from line start `s` in `state`, up to `at` (each step reported before it is taken). */
function walkBlocks(text: string, s0: number, state: BlockState, at: number, step: (s: number, state: BlockState) => void): boolean {
  let { fence, opened, afterText } = state;
  for (let s = s0; s !== -1 && s <= at;) {
    step(s, { fence, opened, afterText });
    const { end: e, next } = lineEndFrom(text, s);
    const line = text.slice(s, Math.min(e, at));
    const before = afterText;
    afterText = false;
    if (fence !== null) { if (fence.test(line)) fence = null; s = next; continue; }
    if (line.trim() === '') { opened = false; s = next; continue; }
    if (opened) { s = next; continue; }
    if (BLOCK6_LINE.test(line) && (!before || /^<\/?[A-Za-z0-9]+ *\/?>$/.test(line))) { opened = true; s = next; continue; }
    const f = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (f) { fence = new RegExp(`^ {0,3}${f[1][0] === '`' ? '`' : '~'}{${f[1].length},}[ \\t]*$`); s = next; continue; }
    const t = TYPE15.find((x) => x.open.test(text.slice(s, e)));
    if (t) {
      // CommonMark and markdown-it test the closer on the opener's line from its `<` (`<?>` closes at once); marked searches after the opener.
      const find = (from: number): [number, number] => {
        t.close.lastIndex = from;
        const c = t.close.exec(text);
        return c === null ? [text.length, text.length] : [c.index, c.index + c[0].length];
      };
      const [, cmEnd] = find(s);
      const [mAt, mEnd] = find(s + t.from);
      // Where every reader keeps the block raw: CommonMark to the end of the closer's line; marked to its closer, or that line's end for types 1 and 2.
      const rawTo = Math.min(lineEndFrom(text, cmEnd).end, t.wholeLine ? lineEndFrom(text, mEnd).end : mAt);
      if (!before && line[0] === '<' && at < rawTo) return true;
      const closeEnd = Math.max(cmEnd, mEnd);
      const closeLine = lineEndFrom(text, closeEnd);
      afterText = !t.wholeLine && text.slice(mEnd, closeLine.end).trim() !== '';
      s = closeLine.next;
      continue;
    }
    afterText = true;
    s = next;
  }
  return opened;
}
/** HTML blocks of types 1 to 5 (CommonMark): the line start that opens one, where its closer is searched from, the closer, and whether marked keeps the rest of the closer's line in the block. */
// The `close` patterns are global for a positioned `exec`: their one user sets `lastIndex` before each call (#5388 BLIND P3).
const TYPE15: ReadonlyArray<{ open: RegExp; from: number; close: RegExp; wholeLine: boolean }> = [
  { open: /^ {0,3}<(?:script|pre|style|textarea)(?:[ \t>]|$)/i, from: 1, close: /<\/(?:script|pre|style|textarea)>/gi, wholeLine: true },
  { open: /^ {0,3}<!--/, from: 2, close: /-->/g, wholeLine: true },
  { open: /^ {0,3}<\?/, from: 2, close: /\?>/g, wholeLine: false },
  { open: /^ {0,3}<![A-Za-z]/, from: 2, close: />/g, wholeLine: false },
  { open: /^ {0,3}<!\[CDATA\[/, from: 9, close: /\]\]>/g, wholeLine: false },
];

const isLetter = (c: string | undefined): boolean => c !== undefined && ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z'));
const isBlank = (c: string): boolean => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f';
const isAsciiPunct = (c: string | undefined): boolean => c !== undefined && /[!-/:-@[-`{-~]/.test(c);

/**
 * The end of the inline run that holds `i`: where a code span that opened at `i` can no longer close. A code span never crosses a
 * block boundary, so the run ends at a blank line (also with CRLF) or at a line that starts another block: an ATX heading, a fence,
 * a quote, a list item, a thematic break or an HTML block of CommonMark's types 1 to 6 (type 7 cannot interrupt a paragraph). A heading is one line, so a span that opens in one ends with it. Where a line only
 * looks like a block start the run is cut short, which means fewer code spans are skipped and more `<` are judged: the safe side.
 */
/**
 * A CommonMark autolink (spec 0.31, 6.4): `<scheme:...>` or `<local@domain>` with no blank, `<` or `>` inside. It is not an HTML tag, so `=`, a
 * quote and the like are legal in it and the tag rules do not apply: it is complete as written.
 */
const AUTOLINK = /<(?:[A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s<>]*|[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*)>/y;

/**
 * #5211 — a tag CommonMark accepts as raw HTML (spec 0.31, 6.6): a name, attributes whose names and unquoted values hold none of the
 * characters it forbids, and a closing `>`. Anything else is text to Markdown, which then reads what the tag holds.
 */
const CM_OPEN_TAG = /^<[A-Za-z][A-Za-z0-9-]*(?:\s+[A-Za-z_:][A-Za-z0-9_.:-]*(?:\s*=\s*(?:[^\s"'=<>`]+|'[^']*'|"[^"]*"))?)*\s*\/?>$/;
const CM_CLOSE_TAG = /^<\/[A-Za-z][A-Za-z0-9-]*\s*>$/;

/** CommonMark HTML block type 6 (spec 0.31): the tag names that start a block (the name may be an opening or a closing tag). */
const BLOCK6 = 'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h1|h2|h3|h4|h5|h6|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';
const BLOCK6_NAMES: ReadonlySet<string> = new Set(BLOCK6.split('|'));
/** #5369 — a line that opens an HTML block of type 6 at column 0 in every reader (marked needs a space, not a tab, after the name). */
const BLOCK6_LINE = new RegExp(`^<\\/?(?:${BLOCK6})(?: |>|\\/>|$)`, 'i');
/** HTML block type 1: the elements whose block runs to a literal end tag. */
const TYPE1_NAMES: ReadonlySet<string> = new Set(['script', 'style', 'textarea', 'pre']);
const BLOCK_START = new RegExp(
  `\\n(?: {0,3}(?:${[
    '#{1,6}(?:[ \\t\\r]|$)', '`{3,}', '~{3,}', '>', '[-+*][ \\t]+\\S', '1[.)][ \\t]+\\S', '(?:[-*_][ \\t]*){3,}\\r?(?:\\n|$)',
    '<(?:script|pre|style|textarea)(?:[ \\t>\\r]|$)', '<!--', '<\\?', '<![A-Za-z]', '<!\\[CDATA\\[',
    `<\\/?(?:${BLOCK6})(?:[ \\t>\\r]|\\/>|$)`,
  ].join('|')})|[ \\t\\r]*\\n)`,
  'gim',
);
/**
 * #5211, #5265 — a line that starts another block, and so closes an open list item rather than continuing it lazily: a heading, a quote, a
 * fence, a thematic break (one character repeated: `-*-` is paragraph text) or an HTML block of types 1 to 6.
 */
const LIST_CLOSING_LINE = new RegExp(
  `^ {0,3}(?:#{1,6}(?:[ \\t]|$)|>|\`{3,}|~{3,}|(?:-[ \\t]*){3,}$|(?:\\*[ \\t]*){3,}$|(?:_[ \\t]*){3,}$|<(?:script|pre|style|textarea)(?:[\\s>]|$)|<!--|<\\?|<![A-Za-z]|<!\\[CDATA\\[|<\\/?(?:${BLOCK6})(?:[\\s/>]|$))`,
  'i',
);
function paragraphEnd(text: string, i: number): number {
  const lineStart = text.lastIndexOf('\n', i - 1) + 1;
  const eol = text.indexOf('\n', i);
  const lineEnd = eol === -1 ? text.length : eol;
  if (/^ {0,3}#{1,6}(?:[ \t\r]|$)/.test(text.slice(lineStart, lineEnd))) return lineEnd;
  const re = new RegExp(BLOCK_START.source, BLOCK_START.flags);
  re.lastIndex = i;
  const m = re.exec(text);
  return m ? m.index : text.length;
}

/**
 * The index just past the `>` that ends the start or end tag at `i` (`<name ...>` or `</name ...>`), or -1 when the tag never
 * ends: a quote opens a value only right after `=`, an unquoted value ends at a blank or `>`, and an unclosed value takes the
 * rest of the text.
 */
function tagEndOf(text: string, i: number, nameFrom: number): number {
  const n = text.length;
  let p = nameFrom;
  while (p < n && !isBlank(text[p]) && text[p] !== '/' && text[p] !== '>') p += 1;
  while (p < n) {
    const ch = text[p];
    if (ch === '>') return p + 1;
    if (ch === '=') {
      p += 1;
      while (p < n && isBlank(text[p])) p += 1;
      const q = text[p];
      if (q === '"' || q === "'") {
        // An unclosed value takes the rest of the text, so no `>` ends the tag.
        const close = text.indexOf(q, p + 1);
        p = close === -1 ? n : close + 1;
      } else {
        while (p < n && !isBlank(text[p]) && text[p] !== '>') p += 1;
      }
      continue;
    }
    p += 1;
  }
  return -1;
}

/** The column `s` ends at when it starts at column `col` (tab stops of four). */
function columnAfter(s: string, col = 0): number {
  let c = col;
  for (const ch of s) c += ch === '\t' ? 4 - (c % 4) : 1;
  return c;
}

/** A container a line sits in: a block quote, or a list item whose content starts `width` columns further in. */
type Container = { quote: true } | { quote: false; width: number };

/** The containers a line's own markers open or continue, outermost first, and the index in `line` where its content starts. */
function containersOf(line: string): { list: Container[]; at: number } {
  const list: Container[] = [];
  let at = 0;
  let col = 0;
  for (;;) {
    let p = at;
    while (line[p] === ' ') p += 1;
    const indent = p - at;
    if (indent > 3) break;
    if (line[p] === '>') {
      at = p + 1;
      col += indent + 1;
      // The one blank after the marker belongs to it (of a tab, one column does: the rest is content indent, which only `<` at a tab's far side sees).
      if (line[at] === ' ' || line[at] === '\t') { col += line[at] === '\t' ? 4 - (col % 4) : 1; at += 1; }
      list.push({ quote: true });
      continue;
    }
    const m = /^(?:[-+*]|\d{1,9}[.)])/.exec(line.slice(p, p + 10));
    if (!m) break;
    let q = p + m[0].length;
    const markerEnd = col + indent + m[0].length;
    let c = markerEnd;
    while (line[q] === ' ' || line[q] === '\t') { c += line[q] === '\t' ? 4 - (c % 4) : 1; q += 1; }
    // Nothing after the marker, or content five or more columns in (indented code inside the item): no HTML block on this line.
    if (c === markerEnd || c - markerEnd > 4 || q >= line.length) break;
    list.push({ quote: false, width: c - col });
    at = q;
    col = c;
  }
  return { list, at };
}

/** The content of `line` inside `list`, or null when the line is outside one of them (a lazy continuation is outside: it never continues an HTML block). */
function contentInside(line: string, list: readonly Container[]): string | null {
  let at = 0;
  let col = 0;
  for (const c of list) {
    if (c.quote) {
      let p = at;
      while (line[p] === ' ') p += 1;
      if (p - at > 3 || line[p] !== '>') return null;
      col += p - at + 1;
      at = p + 1;
      if (line[at] === ' ' || line[at] === '\t') { col += line[at] === '\t' ? 4 - (col % 4) : 1; at += 1; }
    } else {
      if (line.slice(at).trim() === '') return '';
      const to = col + c.width;
      while (col < to && (line[at] === ' ' || line[at] === '\t')) { col += line[at] === '\t' ? 4 - (col % 4) : 1; at += 1; }
      if (col < to) return null;
    }
  }
  return line.slice(at);
}

/**
 * The columns of the `k`-th quote marker of `line` (1-based) and of the content after it (the one blank that belongs to the marker
 * included), in one walk; Infinity for both when the line has fewer markers. `k = 0` is the line's own start.
 */
function quoteColumns(line: string, k: number): { marker: number; content: number } {
  let at = 0;
  let col = 0;
  for (let q = 1; q <= k; q += 1) {
    let p = at;
    while (line[p] === ' ' || line[p] === '\t') p += 1;
    if (line[p] !== '>') return { marker: Infinity, content: Infinity };
    const marker = columnAfter(line.slice(at, p), col);
    col = marker + 1;
    at = p + 1;
    // The marker's one blank: a space, or one column of a tab. The rest of the tab is the content's indent, so the walk stays on it,
    // unless that column was all of it (a tab at column 3, 7, ...), which the next pass would otherwise measure again as a whole tab.
    if (line[at] === ' ') { col += 1; at += 1; } else if (line[at] === '\t') { col += 1; if (col % 4 === 0) at += 1; }
    if (q === k) return { marker, content: col };
  }
  return { marker: 0, content: 0 };
}

/** Main's list-closing line, kept for a text with a bare CR (#5265). */
const LIST_CLOSING_LINE_MAIN = /^ {0,3}(?:#{1,6}(?:[ \t]|$)|>|`{3,}|~{3,}|(?:[-*_][ \t]*){3,}$)/;
/** #5265 — marked's line: any HTML tag or comment closes the item, but no instruction, CDATA or declaration. The mixed `-*-` line is left as main
 * reads it here: CommonMark's line decides those bodies (one escape serves both models). */
const LIST_CLOSING_LINE_MARKED = /^ {0,3}(?:#{1,6}(?:[ \t]|$)|>|`{3,}|~{3,}|(?:[-*_][ \t]*){3,}$|<(?:[a-z].*>|!--))/i;
/** What a line of the text was, for the rules that depend on whether a paragraph is open. */
type LineKind = 'blank' | 'code' | 'nonpara' | 'marker' | 'other';

/**
 * #5211 — the Markdown reader a scan models. They differ on three shapes, and the pass escapes what either needs (escapeUnterminatedHtml):
 * CommonMark (commonmark.js, markdown-it) starts a type 7 block at a type 1 end tag alone on a line and reads any `<!` and a name as a
 * declaration; marked (the portal's) does neither (it needs a blank after the name), and reads a line after a fence its containers ended
 * as markup.
 */
type ReaderModel = 'commonmark' | 'marked';

/** The index of the `<` that opens the first unterminated construct at or after `from`, or -1, as `model` reads the text. */
function firstUnterminated(text: string, from: number, model: ReaderModel = 'commonmark'): number {
  scansRun += 1;
  // #5265 — a bare CR ends a line for the readers but not for this walk, which then misreads the code line it sits in once the item-2 rule
  // has closed the list: a text holding one keeps main's list close.
  const bareCr = /\r(?!\n)/.test(text);
  let blocks: HiddenContext | undefined;
  const hiddenCtx = (): HiddenContext => (blocks ??= hiddenContext(text));
  const n = text.length;
  let fence: OpenFence | null = null;
  let fenceContainers: Container[] = [];
  let paraEnd = -1;
  // What the previous line was. 'other' is a line of a paragraph (or anything that a following line can continue); every other kind leaves
  // no paragraph open: after it a four-space line is indented code and a type 7 tag may start an HTML block. 'nonpara' is a heading (ATX, or a setext underline), a
  // thematic break, a link reference definition (one line, or a label alone with the destination and a title on the next lines), a fence
  // line or the last line of an HTML block. A line is judged after its block quote markers are taken off (`> # h`, a bare `>`); the lines
  // of a quote or list item that continue a paragraph lazily are paragraph lines. A line that only looks like one of these
  // is taken for it: an extra raw region means extra escaping, the safe side. 'marker' is a bare list marker (`-`, `1.`): no paragraph is open, so a
  // type 7 tag at the line head starts a block, but an indented line after it is the item's content. Content four
  // columns past the marker is code in the item; it is still read (more `<` are judged), and leaves no paragraph open.
  let prev: LineKind = 'blank';
  // The kind of the line before the one being read (`prev` is already the current line's kind once its head is handled).
  let prevBefore: LineKind = 'blank';
  // A link reference definition may spread over lines: its destination (and then its title) can sit on the next line. 1: the line before was a
  // label alone (`[a]:`), so this line is the destination; 2: the line before was a definition with a destination, so a title may follow; 3: inside a title that opened on an earlier line.
  let lrd: 0 | 1 | 2 | 3 = 0;
  // The closing delimiter of the title that is open (lrd 3).
  let titleCloser = '';
  // Whether the line before was a line of a link reference definition: to Markdown a paragraph is still open there.
  let inDefinition = false;
  // How wide the last bare list marker is, with its one blank: content that much plus four columns in is code in its item.
  let markerWidth = 0;
  // Whether the line before was in a list, so that an item with any number continues it.
  let inList = false;
  // #5211 — the column the content of the innermost open list item starts at, or -1: a line indented to it continues the item.
  let listCol = -1;
  let listDepth = 0;
  // The quote depth of the line before: a line that opens a deeper quote starts a container, with no paragraph open in it.
  let prevDepth = 0;
  // A raw-text element opened in the middle of a line is inline HTML: Markdown goes on parsing after it, so only an end tag
  // that Markdown also reads as HTML (outside code, a fence and a backslash escape) closes it. -1 when none is open.
  let rawStart = -1;
  let rawName = '';
  // Open `<template>` elements: their content is tokenized as usual, but the anchor of the next block would sit in the inert content.
  const templates: number[] = [];
  // How far a construct that starts at `j` may run. A construct opened inside a line is inline HTML, which never crosses a block boundary, so
  // its end must come before the boundary or it is unterminated (and the scan must not jump past a fence opener or a heading to find one).
  // At the head of a line, a tag runs to the next blank line, and an HTML block of type 2 to 5 (a comment, CDATA, a processing instruction, a
  // declaration) runs to its closer wherever that is. A bound found at `j` holds for every later position below it.
  let inlineFrom = -1;
  let inlineTo = -1;
  const inlineBound = (j: number): number => {
    if (j >= inlineFrom && j < inlineTo) return inlineTo;
    inlineFrom = j;
    inlineTo = paragraphEnd(text, j);
    return inlineTo;
  };
  let blankFrom = -1;
  let blankTo = -1;
  const blankBound = (j: number): number => {
    if (j >= blankFrom && j < blankTo) return blankTo;
    blankFrom = j;
    const re = /\n[ \t\r]*\n/g;
    re.lastIndex = j;
    const m = re.exec(text);
    blankTo = m ? m.index : n;
    return blankTo;
  };
  // Whether the `<` at `j` is the first non-space of its line after its container markers, within three spaces of indent (where CommonMark starts an HTML block). The
  // facts of a line are found once, so a line of many constructs costs its length once, not once per construct.
  let lineFrom = -1;
  let lineTo = -2;
  let lineFirst = -1;
  // marked ends a line-head declaration block at its first `>` and starts the next block right after it (#5211).
  let markedBlockAt = -1;
  // Whether the line before was taken for a link reference definition: marked's grammar for one is stricter, so it may be a paragraph there.
  let prevDefinition = false;
  let lineContent = -1;
  let lineContainers: Container[] = [];
  const startsLine = (j: number): boolean => {
    if (j < lineFrom || j > lineTo) {
      lineFrom = text.lastIndexOf('\n', j - 1) + 1;
      const nl = text.indexOf('\n', j);
      lineTo = nl === -1 ? n : nl;
      const line = text.slice(lineFrom, lineTo);
      // A line inside an HTML block opens no container: it sits in the block's own.
      const inner = lineFrom > 0 && lineFrom < rawUntil ? contentInside(line, rawContainers) : null;
      const c = inner === null ? containersOf(line) : { list: rawContainers, at: line.length - inner.length };
      lineContainers = c.list;
      lineContent = lineFrom + c.at;
      let f = lineContent;
      while (f < lineTo && (text[f] === ' ' || text[f] === '\t')) f += 1;
      const from = columnAfter(text.slice(lineFrom, lineContent));
      lineFirst = columnAfter(text.slice(lineContent, f), from) - from <= 3 ? f : -1;
    }
    return lineFirst === j || j === markedBlockAt;
  };
  // Where the containers of the line at `j` end (`blank`: or the first line that is blank inside them). `startsLine(j)` was asked first. A line
  // in the same containers below a known end has the same end, so a long quote is walked once.
  const containerEnds = new Map<string, { from: number; to: number }>();
  const containerEnd = (j: number, blank: boolean): number => {
    if (lineContainers.length === 0) return blank ? blankBound(j) : n;
    const key = `${blank}${lineContainers.map((c) => (c.quote ? '>' : c.width)).join()}`;
    const known = containerEnds.get(key);
    if (known && j >= known.from && j < known.to) return known.to;
    let to = lineTo;
    while (to < n) {
      const nl = text.indexOf('\n', to + 1);
      const end = nl === -1 ? n : nl;
      const content = contentInside(text.slice(to + 1, end), lineContainers);
      if (content === null || (blank && content.trim() === '')) break;
      to = end;
    }
    containerEnds.set(key, { from: j, to });
    return to;
  };
  const inQuote = (): boolean => lineContainers.some((c) => c.quote);
  // Whether a type 7 tag at the head of the line at `j` would interrupt a paragraph. A line that opens a list item or a deeper quote starts afresh.
  const interrupts = (): boolean => {
    if (prevBefore !== 'other') return false;
    if (lineContainers.some((c) => !c.quote)) return false;
    const before = lineFrom === 0 ? '' : text.slice(text.lastIndexOf('\n', lineFrom - 2) + 1, lineFrom - 1);
    const depth = (l: readonly Container[]): number => l.filter((c) => c.quote).length;
    return depth(lineContainers) <= depth(containersOf(before).list);
  };
  // A tag runs to the next blank line only where it opens an HTML block (a type 6 name, or a type 1 start tag); anywhere else it is inline
  // HTML, which no block boundary lets through, even at the head of a line.
  // Inside an HTML block (types 1 to 7) Markdown reads no fence, code span, backslash escape or indented code: the lines are raw HTML, and
  // a browser reads them as markup. `rawUntil` is the end of the last such line; the scan skips the Markdown rules below it.
  let rawUntil = -1;
  // Whether that block sits in a block quote. Markdown takes the quote markers off and a reader of the raw text does not (a marker is a `>` to
  // it), so a construct there may not run past its line.
  let rawQuoted = false;
  let rawContainers: Container[] = [];
  const raw = (to: number): void => {
    if (to <= rawUntil) return;
    rawUntil = to;
    rawQuoted = inQuote();
    rawContainers = lineContainers;
  };
  const rawLimit = (j: number): number => (rawQuoted ? Math.min(rawUntil, lineEndAt(j)) : rawUntil);
  const headLimit = (j: number, blank: boolean): number => (inQuote() ? lineEndAt(j) : containerEnd(j, blank));
  // Inside an HTML block's raw region no Markdown block start applies: a construct there runs to the end of the region.
  const tagLimit = (j: number, opensBlock: boolean): number =>
    (j < rawUntil ? rawLimit(j) : opensBlock && startsLine(j) ? headLimit(j, true) : inlineBound(j));
  const blockLimit = (j: number): number => (j < rawUntil ? rawLimit(j) : startsLine(j) ? headLimit(j, false) : inlineBound(j));
  const lineEndAt = (j: number): number => {
    const nl = text.indexOf('\n', j);
    return nl === -1 ? n : nl;
  };
  // A backtick run of length N that found no closer in its paragraph: no later run of N in the same paragraph has one either.
  const noCloser = new Map<number, number>();
  let i = from;
  while (i < n) {
    if ((i === 0 || text[i - 1] === '\n') && i < rawUntil) {
      prevBefore = prev;
      prev = 'nonpara';
      lrd = 0;
      inDefinition = false;
    } else if (i === 0 || text[i - 1] === '\n') {
      // The line before was the last raw line of an HTML block: nothing is open after it.
      if (i - 1 === rawUntil) { prev = 'nonpara'; lrd = 0; inDefinition = false; }
      prevBefore = prev;
      const nl = text.indexOf('\n', i);
      const end = nl === -1 ? n : nl;
      const line = text.slice(i, end);
      // Block quote markers do not change what is code inside them.
      const inner = line.replace(/^ {0,3}(?:> ?)+/, '');
      let here = containersOf(line);
      const listed = here.list.some((c) => !c.quote);
      // A number other than 1 starts no list in the middle of a paragraph; it is an item only where a list is open already.
      if (listed && prev === 'other' && !inList && /^ {0,3}(?:> ?)*(?!0*1[.)])\d/.test(line)) here = { list: [], at: 0 };
      if (here.list.some((c) => !c.quote)) inList = true;
      else if (line.trim() !== '' && prev === 'blank' && !/^[ \t]{2}/.test(line)) inList = false;
      const content = line.slice(here.at);
      // A fence lives in the containers of the line that opened it, and ends with them.
      const within = fence === null ? null : contentInside(line, fenceContainers);
      // #5211 — the fence ended because its containers did: marked reads the next line as markup, whatever its indent.
      const fenceCut = fence !== null && within === null;
      if (within === null) fence = null;
      const wasOpen = fence !== null;
      const step = stepFence(within ?? content, fence);
      if (!wasOpen && step.open !== null) fenceContainers = here.list;
      fence = step.open;
      if (step.fenceLine || wasOpen) { prev = 'nonpara'; lrd = 0; inDefinition = false; i = end + 1; continue; }
      // An indented code block: a line of four spaces or a tab, after a blank line, the start of the text or another such line.
      const quotes = line.slice(0, line.length - inner.length);
      const from = columnAfter(quotes);
      // A tab right after a quote marker gives its first column to the marker.
      const tabAfterQuote = quotes.endsWith('>') && inner.startsWith('\t');
      const indent = model === 'marked' && tabAfterQuote
        ? columnAfter((/^[ \t]*/.exec(inner.slice(1)) as RegExpExecArray)[0])
        : columnAfter((/^[ \t]*/.exec(inner) as RegExpExecArray)[0], from) - from - (tabAfterQuote ? 1 : 0);
      // A line right after a definition's line continues its paragraph, so its indent makes no code of it.
      const afterDefinition = inDefinition;
      prevDefinition = afterDefinition;
      inDefinition = false;
      // #5211 — a list item: a line indented to its content continues it, and is code only four columns past that.
      // Columns are counted inside the line's quotes, and a list belongs to the quote depth it opened at.
      const depth = here.list.filter((c) => c.quote).length;
      const lineCols = columnAfter((/^[ \t]*/.exec(inner) as RegExpExecArray)[0], from) - from;
      const listedHere = here.list.some((c) => !c.quote);
      if (listedHere) { listCol = columnAfter(line.slice(0, here.at)) - from; listDepth = depth; }
      // A quote that opens inside the item continues it when its marker sits at the item's content; leaving the item's own quote ends it.
      else if (depth > listDepth && listCol > 0 && quoteColumns(line, listDepth + 1).marker - quoteColumns(line, listDepth).content < listCol) listCol = -1;
      else if (depth < listDepth) listCol = -1;
      // A line that starts another block closes the item; only a paragraph line may continue it lazily.
      else if (depth === listDepth && inner.trim() !== '' && lineCols < listCol && (prev !== 'other' || (bareCr ? LIST_CLOSING_LINE_MAIN : model === 'marked' ? LIST_CLOSING_LINE_MARKED : LIST_CLOSING_LINE).test(inner))) listCol = -1;
      // Inside a deeper quote the item's content is that quote's to measure from.
      const opensQuote = depth > prevDepth;
      prevDepth = depth;
      const codeIndent = listCol > 0 && !listedHere && depth === listDepth && lineCols >= listCol ? lineCols - listCol : indent;
      if (codeIndent >= 4 && inner.trim() !== '' && ((prev !== 'other' && prev !== 'marker') || opensQuote) && !afterDefinition && !(fenceCut && model === 'marked')) { prev = 'code'; lrd = 0; i = end + 1; continue; }
      if (lrd === 3) {
        // Inside a title that opened on an earlier line: still the definition, until the line that closes it (or a blank line, which ends the attempt).
        if (inner.trim() === '') { prev = prev === 'code' ? 'code' : 'blank'; lrd = 0; } else { prev = 'nonpara'; inDefinition = true; lrd = hasCloser(inner, titleCloser) ? 0 : 3; }
      } else if (lrd === 1 && inner.trim() !== '') {
        prev = 'nonpara';
        inDefinition = true;
        titleCloser = titleOpens(inner);
        lrd = titleCloser ? 3 : 2;
      } else if (lrd === 2 && /^[ \t]*["'(]/.test(inner)) {
        prev = 'nonpara';
        inDefinition = true;
        titleCloser = titleOpens(inner);
        lrd = titleCloser ? 3 : 0;
      } else {
        const label = /^ {0,3}\[(?:[^\]\\]|\\.)+\]:([ \t]*)/.exec(content);
        titleCloser = label && label[0].length !== content.length ? titleOpens(content.slice(label[0].length)) : '';
        inDefinition = label !== null;
        lrd = label ? (label[0].length === content.length ? 1 : titleCloser ? 3 : 2) : 0;
        prev = inner.trim() === '' ? (prev === 'code' ? 'code' : 'blank') : label || /^ {0,3}(?:#{1,6}(?:[ \t]|$)|(?:[-*_][ \t]*){3,}$|=+[ \t]*$)/.test(inner) || /^ {0,3}#{1,6}(?:[ \t]|$)/.test(content) ? 'nonpara' : /^ {0,3}(?:[-+*]|\d{1,9}[.)])[ \t]*$/.test(inner)
          ? (prev === 'other' ? 'other' : 'marker')
          : prev === 'marker' && indent >= markerWidth + 4 ? 'marker' : 'other';
        if (prev === 'marker' && indent < 4) markerWidth = inner.trim().length + 1;
      }
    }
    const c = text[i];
    if (c === '\\' && i >= rawUntil) { i += isAsciiPunct(text[i + 1]) ? 2 : 1; continue; }
    if (c === '`' && i >= rawUntil) {
      let len = 1;
      while (text[i + len] === '`') len += 1;
      // #5388 QA (at 722ea31f): marked never opens a code span with a run right after an unescaped `~` (its text rule takes the run).
      if (model === 'marked' && text[i - 1] === '~' && /(?:^|[^\\])(?:\\\\)*$/.test(text.slice(Math.max(0, i - 65), i - 1))) { i += len; continue; }
      paraEnd = inlineBound(i);
      if ((noCloser.get(len) ?? -1) >= paraEnd) { i += len; continue; }
      let k = i + len;
      let closed = -1;
      for (let j = text.indexOf('`', k); j !== -1 && j < paraEnd; j = text.indexOf('`', k)) {
        let m = 1;
        while (text[j + m] === '`') m += 1;
        if (m === len) { closed = j + m; break; }
        k = j + m;
      }
      if (closed === -1) noCloser.set(len, paraEnd);
      i = closed === -1 ? i + len : closed;
      continue;
    }
    if (c !== '<') { i += 1; continue; }

    if (rawStart !== -1) {
      // Inside an inline raw-text element: the only markup is its own end tag.
      if (text[i + 1] === '/' && text.slice(i + 2, i + 2 + rawName.length).toLowerCase() === rawName && /[\s/>]/.test(text[i + 2 + rawName.length] ?? 'x')) {
        // Same rule as at the head of a line: `</name/` is an end tag for a browser and not for the others, so the element stays open.
        if (text[i + 2 + rawName.length] === '/') return rawStart;
        const end = tagEndOf(text, i, i + 2);
        if (end === -1 || end > tagLimit(i, false)) return rawStart;
        rawStart = -1;
        i = end;
      } else i += 1;
      continue;
    }
    if (text.startsWith('<!--', i)) {
      // #5211 — at the head of a line these are a whole type 2 block, so the rest of their line is raw.
      // marked takes such a line as a block only when a blank line or the end follows it; otherwise it is inline.
      const wholeBlock = (): void => {
        if (!startsLine(i)) return;
        const e = lineEndAt(i);
        if (model === 'commonmark' || e >= n || /^[ \t]*(?:\n|$)/.test(text.slice(e + 1))) raw(e);
      };
      if (text.startsWith('<!-->', i)) { wholeBlock(); i += 5; continue; }
      if (text.startsWith('<!--->', i)) { wholeBlock(); i += 6; continue; }
      const close = text.indexOf('-->', i + 4);
      if (close === -1 || close + 3 > blockLimit(i)) return i;
      if (startsLine(i)) raw(lineEndAt(close));
      i = close + 3;
      continue;
    }
    // CDATA and a processing instruction: Markdown (and htmlparser2) end the construct at `]]>` / `?>`, a browser reads either as a bogus
    // comment that ends at the FIRST `>`. Where the two are the same `>` there is one answer; where a `>` comes before the closer the readers
    // resume in different places, so the construct is left unterminated (escaped) rather than guessed. The closer is searched RAW, on purpose:
    // inline HTML of this kind takes everything up to its closer, backticks included, so a closer inside what looks like a code span
    // is still its closer (unlike a raw-text element, whose end tag is a separate tag that code can hide).
    if (text.startsWith('<![CDATA[', i)) {
      const first = text.indexOf('>', i + 2);
      const closer = text.indexOf(']]>', i + 9);
      if (first === -1 || closer === -1 || first !== closer + 2 || closer + 3 > blockLimit(i)) return i;
      if (startsLine(i)) raw(lineEndAt(closer));
      i = first + 1;
      continue;
    }
    if (text.startsWith('<?', i)) {
      const first = text.indexOf('>', i + 2);
      const closer = text.indexOf('?>', i + 1);
      if (first === -1 || closer === -1 || first !== closer + 1 || closer + 2 > blockLimit(i)) return i;
      if (startsLine(i)) raw(lineEndAt(closer));
      i = first + 1;
      continue;
    }
    // #5211 — marked takes a declaration only when a blank follows its name; any other `<!` and a name is text to it, so what follows is read.
    // At the head of a line that interrupts no paragraph it starts an HTML block in marked too, and is complete there.
    if (model === 'marked' && /<![A-Za-z]+(?![A-Za-z\s])/y.test(text.slice(i, text.indexOf('\n', i) === -1 ? n : text.indexOf('\n', i) + 1)) && !(startsLine(i) && prevBefore !== 'other' && prevBefore !== 'marker' && !prevDefinition)) { i += 2; continue; }
    if (text.startsWith('<!', i)) {
      const close = text.indexOf('>', i + 2);
      if (close === -1 || close + 1 > blockLimit(i)) return i;
      // #5388 QA F2 (at 722ea31f): `<!` and no letter is text to Markdown, so a later line that opens a comment block (type 2, which
      // interrupts a paragraph) is read afresh there, while a browser reading the raw string has that `<!--` inside the bogus comment. When the
      // comment it opens does not end before the bogus comment's `>`, the two readings resume in different places: escape the `<!`.
      if (i >= rawUntil && !isLetter(text[i + 2]) && commentLineCrossed(text, i, close)) return i;
      if (i >= rawUntil && !isLetter(text[i + 2])) {
        const hidden = bogusHiddenTag(text, i, close, hiddenCtx);
        if (hidden !== -1) return hidden;
      }
      // marked ends such a block at the declaration's first `>` and reads the rest of the line as text (#5211); CommonMark keeps it raw.
      if (startsLine(i) && isLetter(text[i + 2]) && model === 'commonmark') raw(lineEndAt(close));
      if (startsLine(i) && isLetter(text[i + 2]) && model === 'marked') {
        markedBlockAt = close + 1;
        // #5320 — marked starts the next block right after the `>`: a fence opener there that nothing closes takes the anchor with it. The
        // declaration stays as written (escaping it turns the line into paragraph text and moves later lines' readings, #5291); the opener's
        // first character is written as a character reference instead, which a browser decodes to the same character.
        if (i >= rawUntil && lineContainers.length === 0 && lineFirst === i && prevBefore !== 'other' && prevBefore !== 'marker' && !prevDefinition && !loneEqualsAbove(text, i)) {
          const f = markedUnclosedFenceAfter(text, close + 1);
          if (f !== -1) return f;
        }
      }
      i = close + 1;
      continue;
    }
    const isEnd = text[i + 1] === '/';
    if (isEnd && !isLetter(text[i + 2]) && text[i + 2] !== '>') {
      // `</` and anything but a letter or `>` is a bogus comment, which runs to the next `>`.
      const close = text.indexOf('>', i + 2);
      if (close === -1 || close + 1 > tagLimit(i, false)) return i;
      if (i >= rawUntil) {
        const hidden = bogusHiddenTag(text, i, close, hiddenCtx);
        if (hidden !== -1) return hidden;
      }
      i = close + 1;
      continue;
    }
    if (!isLetter(text[i + (isEnd ? 2 : 1)])) { i += 1; continue; }

    // A complete autolink is not a tag: it is inert as written. Inside an HTML block Markdown reads no autolink, and a browser reads a tag.
    if (!isEnd && i >= rawUntil) {
      AUTOLINK.lastIndex = i;
      const link = AUTOLINK.exec(text);
      if (link) { i += link[0].length; continue; }
    }
    // A start or end tag: the name, then attributes up to the `>` outside a quoted value.
    const nameStart = i + (isEnd ? 2 : 1);
    let nameEnd = nameStart;
    while (nameEnd < n && !isBlank(text[nameEnd]) && text[nameEnd] !== '/' && text[nameEnd] !== '>') nameEnd += 1;
    const name = text.slice(nameStart, nameEnd).toLowerCase();
    const opensBlock = BLOCK6_NAMES.has(name) || (!isEnd && TYPE1_NAMES.has(name));
    // A name that holds `=`, `<` or a quote is read as a name by a browser and fails in htmlparser2: ambiguous, so unterminated.
    if (/[=<"'`]/.test(name)) return i;
    const tagEnd = tagEndOf(text, i, nameStart);
    if (tagEnd === -1 || tagEnd > tagLimit(i, opensBlock)) return i;
    // An end tag takes attributes in a browser (a quote hides a `>`) but htmlparser2 ends it at the first `>`; where the two ends differ the
    // readers resume in different places, so the tag is left unterminated rather than guessed.
    if (isEnd && tagEnd !== text.indexOf('>', i) + 1) return i;
    // #5211 — outside an HTML block, a tag CommonMark does not accept is text to Markdown, which reads what it holds: the scan goes on inside
    // it. A raw-text element, a template and a block opener at the head of a line keep the browser's reading, which is the stricter one.
    // #5289 — that holds for a tag whose value holds `<template` too: Markdown emits it live and the anchor lands in its content (parse5).
    if (i >= rawUntil && !RAW_TEXT.has(name) && name !== 'template' && name !== 'plaintext' && !(startsLine(i) && opensBlock)
      && !(isEnd ? CM_CLOSE_TAG : CM_OPEN_TAG).test(text.slice(i, tagEnd))) { i += 1; continue; }
    // A block-level tag at the head of a line (type 6), or a complete tag alone on its line that does not interrupt a paragraph (type 7),
    // starts an HTML block that runs to the next blank line.
    if (startsLine(i)) {
      if (BLOCK6_NAMES.has(name)) raw(containerEnd(i, true));
      else if ((!TYPE1_NAMES.has(name) || (isEnd && model === 'commonmark')) && !text.slice(i, tagEnd).includes('\n') && text.slice(tagEnd, lineEndAt(tagEnd)).trim() === '' && !interrupts()) {
        raw(containerEnd(i, true));
      }
    }
    if (isEnd) {
      if (name === 'template') templates.pop();
      i = tagEnd;
      continue;
    }
    if (name === 'template') templates.push(i);

    if (name === 'plaintext') return i;
    if (RAW_TEXT.has(name)) {
      if (startsLine(i) && (name === 'script' || name === 'style' || name === 'textarea')) {
        // CommonMark type 1: the block runs raw to the first line that holds an end tag, code or not.
        // Markdown ends the block only at a line that holds `</name>` itself, so that literal end tag must exist. A browser ends the element
        // at the first `</name` followed by a blank, `/` or `>` (and that tag's own `>`), and reads as markup what comes after it, inside the
        // block: the scan resumes there.
        const literal = new RegExp(`</${name}>`, 'gi');
        literal.lastIndex = tagEnd;
        // The block is cut where its containers end, so an end tag beyond them is none of its own.
        if (!literal.test(text) || literal.lastIndex > containerEnd(i, false)) return i;
        raw(lineEndAt(literal.lastIndex));
        const closer = new RegExp(`</${name}(?=[\\s/>])`, 'gi');
        closer.lastIndex = tagEnd;
        const m = closer.exec(text);
        if (!m) return i;
        // `</name/`: a browser ends the element there, htmlparser2 and CommonMark do not. The readers disagree on where the markup resumes,
        // so the element is left unterminated rather than guessed.
        if (text[m.index + 2 + name.length] === '/') return i;
        const end = tagEndOf(text, m.index, m.index + 2);
        if (end === -1 || (inQuote() && end > lineEndAt(m.index))) return i;
        i = end;
      } else {
        rawStart = i;
        rawName = name;
        i = tagEnd;
      }
      continue;
    }
    if (name === 'pre' && startsLine(i)) {
      // CommonMark type 1 ends at a line holding any one of these four end tags.
      const closer = /<\/(?:pre|script|style|textarea)>/gi;
      closer.lastIndex = i;
      const end = containerEnd(i, false);
      if (closer.test(text) && closer.lastIndex <= end) raw(lineEndAt(closer.lastIndex));
      // #5332 — in a quote the block ends with the quote, which ends before the next part's anchor: it absorbs nothing, and what it holds is
      // read as a browser reads it. Not in a list item: marked ends a list's HTML block elsewhere.
      // Only where the quote ends at a blank line or the end of the text with no bare CR inside: markdown-it carries a quote on through a
      // lazy line, and every reader breaks a line at a bare CR, which this walk does not.
      else if (lineContainers.length > 0 && lineContainers.every((c) => c.quote) && !/\r(?!\n)/.test(text.slice(i, end)) && /^(?:\r?\n[ \t]*(?:\r?\n|$)|$)/.test(text.slice(end))) raw(end);
      else return i;
    }
    i = tagEnd;
  }
  const open = [rawStart, ...templates.slice(0, 1)].filter((x) => x !== -1);
  return open.length === 0 ? -1 : Math.min(...open);
}

/** The delimiter that closes the title a line leaves open, or '' when it leaves none: a quote or parenthesis that starts a title (at the start or after a blank) with no closing delimiter after it on the line. An empty answer only widens the definition, which escapes more. */
function titleOpens(rest: string): string {
  const m = /(?:^|[ \t])(["'(])/.exec(rest);
  if (!m) return '';
  const close = m[1] === '(' ? ')' : m[1];
  const after = rest.slice(m.index + m[0].length);
  for (let k = 0; k < after.length; k += 1) {
    if (after[k] === '\\') k += 1;
    else if (after[k] === close) return '';
  }
  return close;
}

/** Whether a line holds an unescaped `close`: the title that is open ends there (any text after it only makes the definition invalid, which escapes more). */
function hasCloser(line: string, close: string): boolean {
  for (let k = 0; k < line.length; k += 1) {
    if (line[k] === '\\') k += 1;
    else if (line[k] === close) return true;
  }
  return false;
}

/**
 * `text` with the opening `<` of every unterminated raw-HTML construct written as `&lt;`; the same string when there is none.
 * Each escape rescans the whole escaped text from the start: a construct that was open may have hidden another, and a `<template>`
 * opened before the construct just escaped is still open after it, so no scan state is carried over. The result is a fixed point.
 */
export function escapeUnterminatedHtml(text: string): string {
  scansRun = 0;
  if (!text.includes('<')) return text;
  // #5388 LOCAL P3 at dabc70c5: the per-text caches hold the last text (up to 2 MB) and its offsets; release them when the call ends.
  try { return escapeLoop(text); } finally { lineEndsOf = null; commentLinesOf = null; }
}

/**
 * #5320 — where the first character of a fence opener is, when the rest of the line at `from` (just past a declaration's `>`) opens a fenced
 * code block in marked (up to three spaces, then three or more backticks with none in the info string, or three or more tildes) and no
 * line after it closes the fence; -1 otherwise. A closer is the same character, at least as many, up to three spaces and then only blanks.
 */
function markedUnclosedFenceAfter(text: string, from: number): number {
  const nl = text.indexOf('\n', from);
  const rest = text.slice(from, nl === -1 ? text.length : nl).replace(/\r$/, '');
  const m = /^( {0,3})(`{3,}(?=[^`]*$)|~{3,})/.exec(rest);
  if (m === null) return -1;
  const mark = m[2]!;
  const closer = new RegExp(`^ {0,3}${mark[0] === '`' ? '`' : '~'}{${mark.length},}[ \\t]*$`);
  for (let s = nl === -1 ? text.length : nl + 1; s < text.length;) {
    const e = text.indexOf('\n', s);
    const line = text.slice(s, e === -1 ? text.length : e).replace(/\r$/, '');
    if (closer.test(line)) return -1;
    if (e === -1) break;
    s = e + 1;
  }
  return from + m[1]!.length;
}

/**
 * #5320 — whether the line above the one at `at` is `=` signs alone with no paragraph line above them: then it is paragraph text, not a setext
 * underline (the scan files every such line as a heading), and the declaration after it continues that paragraph, which starts no block in marked.
 */
function loneEqualsAbove(text: string, at: number): boolean {
  const end = text.lastIndexOf('\n', at - 1);
  if (end <= 0) return false;
  const start = text.lastIndexOf('\n', end - 1) + 1;
  if (!/^ {0,3}=+[ \t]*\r?$/.test(text.slice(start, end))) return false;
  if (start === 0) return true;
  const above = text.slice(text.lastIndexOf('\n', start - 2) + 1, start - 1);
  return above.trim() === '';
}

/** The one-character escape for `c`: `<` as `&lt;`; a fence character (#5320) as its numeric reference. */
const ESCAPES: Readonly<Record<string, string>> = { '<': '&lt;', '`': '&#96;', '~': '&#126;' };

function escapeLoop(text: string): string {
  let cur = text;
  for (let k = 0; ; k += 1) {
    const ats = [firstUnterminated(cur, 0, 'commonmark'), firstUnterminated(cur, 0, 'marked')].filter((x) => x !== -1);
    const at = ats.length === 0 ? -1 : Math.min(...ats);
    if (at === -1) return cur;
    // A text that keeps hiding another construct behind the one just escaped: close the question for every `<` it holds.
    if (k === MAX_RESTARTS) return cur.replace(/</g, '&lt;');
    cur = `${cur.slice(0, at)}${ESCAPES[cur[at]!] ?? '&lt;'}${cur.slice(at + 1)}`;
  }
}

/** Test seam: the scans the last call of {@link escapeUnterminatedHtml} ran. */
export const scansOfLastCallForTests = (): number => scansRun;
