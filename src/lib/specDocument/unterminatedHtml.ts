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

const isLetter = (c: string | undefined): boolean => c !== undefined && ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z'));
const isBlank = (c: string): boolean => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f';
const isAsciiPunct = (c: string | undefined): boolean => c !== undefined && /[!-/:-@[-`{-~]/.test(c);

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
/** HTML block type 1: the elements whose block runs to a literal end tag. */
const TYPE1_NAMES: ReadonlySet<string> = new Set(['script', 'style', 'textarea', 'pre']);
const BLOCK_START = new RegExp(
  `\\n(?: {0,3}(?:${[
    '#{1,6}(?:[ \\t\\r]|$)', '`{3,}', '~{3,}', '>', '[-+*][ \\t]+\\S', '1[.)][ \\t]+\\S', '(?:-[ \\t]*){3,}\\r?(?:\\n|$)', '(?:\\*[ \\t]*){3,}\\r?(?:\\n|$)', '(?:_[ \\t]*){3,}\\r?(?:\\n|$)', '(?:=+|-+)[ \\t]*\\r?(?:\\n|$)',
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
  `^ {0,3}(?:#{1,6}(?:[ \\t]|$)|>|\`{3,}|~{3,}|(?:-[ \\t]*){3,}$|(?:\\*[ \\t]*){3,}$|(?:_[ \\t]*){3,}$|<(?:script|pre|style|textarea)(?:[\\s>]|$)|<!--|<\\?|<![A-Za-z]|<!\\[CDATA\\[|<\\/?(?:${BLOCK6})(?:[\\s>]|\\/>|$))`,
  'i',
);
/**
 * #5265 — marked 17 closes an open list item at fewer HTML lines than CommonMark: its `htmlBeginRegex` takes a start tag (`<` and a
 * letter, then a `>` on the line) or a comment, and no declaration, processing instruction, CDATA or end tag.
 */
const LIST_CLOSING_LINE_MARKED = /^ {0,3}(?:#{1,6}(?:[ \t]|$)|>|`{3,}|~{3,}|(?:-[ \t]*){3,}$|(?:\*[ \t]*){3,}$|(?:_[ \t]*){3,}$|<(?:[a-z].*>|!--))/i;
/**
 * The end of the inline run that holds `i`: where a code span that opened at `i` can no longer close. A code span never crosses a
 * block boundary, so the run ends at a blank line (also with CRLF) or at a line that starts another block: an ATX heading, a fence,
 * a quote, a list item, a thematic break, a setext underline (#5265; it ends the heading's paragraph, but not one that is lazy text in a quote or list item) or an HTML block of CommonMark's types 1 to 6 (type 7 cannot interrupt a paragraph). A heading is one line, so a span that opens in one ends with it. Where a line only
 * looks like a block start the run is cut short, which means fewer code spans are skipped and more `<` are judged: the safe side.
 */
function paragraphEnd(text: string, i: number, ctx: RunContext = NO_CONTAINER): number {
  const lineStart = text.lastIndexOf('\n', i - 1) + 1;
  const eol = text.indexOf('\n', i);
  const lineEnd = eol === -1 ? text.length : eol;
  if (/^ {0,3}#{1,6}(?:[ \t\r]|$)/.test(text.slice(lineStart, lineEnd))) return lineEnd;
  const re = new RegExp(BLOCK_START.source, BLOCK_START.flags);
  re.lastIndex = i;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const eol = text.indexOf('\n', m.index + 1);
    const line = text.slice(m.index + 1, eol === -1 ? text.length : eol);
    // A setext underline cannot be lazy: a `=` or `-` line outside the paragraph's quote, or short of its list item's content, is its text.
    const lazy = SETEXT_ONLY.test(line) && (ctx.quoted || (ctx.listCol > 0 && columnAfter((/^[ \t]*/.exec(line) as RegExpExecArray)[0]) < ctx.listCol));
    if (!lazy) return m.index;
    re.lastIndex = m.index + 1;
  }
  return text.length;
}

/** The containers of the line an inline run starts on, for the underline rule of {@link paragraphEnd}. */
interface RunContext { quoted: boolean; listCol: number }
const NO_CONTAINER: RunContext = { quoted: false, listCol: -1 };
/**
 * A setext underline that lazy text may hold: `=` or `--`. Three or more `-` are a thematic break and a lone `-` an empty list item, and
 * either ends a lazy paragraph too.
 */
const SETEXT_ONLY = /^ {0,3}(?:=+|--)[ \t]*\r?$/;

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

/**
 * The containers a line's own markers open or continue, outermost first, and the index in `line` where its content starts. `item` is the
 * column the content of the innermost list item starts at and `itemQuotes` the number of quotes outside it (-1 and 0 when there is none):
 * a quote opened inside the item (`- > x`) is not the item's content column. `items` holds the content columns of the items outside every quote,
 * outermost first (`- - x`: 2 and 4).
 */
function containersOf(line: string): { list: Container[]; at: number; item: number; itemQuotes: number; items: number[] } {
  const list: Container[] = [];
  let at = 0;
  let col = 0;
  let item = -1;
  let itemQuotes = 0;
  const items: number[] = [];
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
    item = c;
    itemQuotes = list.filter((x) => x.quote).length;
    if (itemQuotes === 0) items.push(c);
  }
  return { list, at, item, itemQuotes, items };
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
    // The marker's one blank: a space, or one column of a tab. The rest of the tab is the content's indent, so the walk stays on the tab
    // and `col` at its start: measured from one column further in, a tab one column wide would count four.
    let content = col;
    if (line[at] === ' ') { col += 1; at += 1; content = col; } else if (line[at] === '\t') content = col + 1;
    if (q === k) return { marker, content };
  }
  return { marker: 0, content: 0 };
}

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
  // Two constructs may be left as written (exempt), after which the text is read again; each is judged only when the scan reports it, so
  // the CommonMark reads run a bounded number of times per call, not once per construct.
  // #5265 — a `<pre>` at the head of a top-level line with no closer is a block that runs raw to the end of the text, so no fence is open
  // there as written. Where escaping it would open one that never closes (`<pre>`, then `~~~`), the anchor after it is code in every
  // reader: it is exempt. The same judgement in both models, from the text alone (CommonMark's reading). One that only marked reads as a
  // block (right after a declaration it ended, `<!y><pre>`) is judged by marked's reading.
  // #5265 — in marked, a top-level declaration whose fence never closes is escaped, unless escaping it would leave a fence open to the end
  // of the text in CommonMark where none is open as written: then it is exempt.
  const exempt = new Set<number>();
  let asWritten: boolean | null = null;
  for (let k = 0; ; k += 1) {
    const r = scan(text, from, model, exempt);
    if (r.at === -1 || k === MAX_RESTARTS) return r.at;
    const escaped = (): string => `${text.slice(0, r.at)}&lt;${text.slice(r.at + 1)}`;
    if (r.pre) {
      if (!FENCE_LINE.test(text.slice(r.at)) || !endsInOpenFence(escaped(), r.pre === 'line' ? 'commonmark' : 'marked')) return r.at;
    } else {
      if (model === 'commonmark' || r.at !== r.decl) return r.at;
      asWritten ??= endsInOpenFence(text);
      if (asWritten || !endsInOpenFence(escaped())) return r.at;
    }
    exempt.add(r.at);
  }
}

/** A line that may open a fence: the cheap test before a CommonMark read. */
const FENCE_LINE = /\n[ \t]*(?:`{3,}|~{3,})/;

const NO_EXEMPT: ReadonlySet<number> = new Set();

/** Whether `model` (CommonMark unless named) reads a fence outside every container that is still open at the end of `text`: it takes the anchor after it as code. */
function endsInOpenFence(text: string, model: ReaderModel = 'commonmark'): boolean {
  // The constructs CommonMark itself leaves open are escaped first, as the pass would.
  let cur = text;
  for (let k = 0; k <= MAX_RESTARTS; k += 1) {
    const r = scan(cur, 0, model);
    if (r.at === -1) return r.topLevelFence;
    cur = `${cur.slice(0, r.at)}&lt;${cur.slice(r.at + 1)}`;
  }
  return false;
}

/** {@link firstUnterminated}, and whether a fence outside every container is open at the end (read only when nothing is unterminated). */
function scan(text: string, from: number, model: ReaderModel, exempt: ReadonlySet<number> = NO_EXEMPT): { at: number; topLevelFence: boolean; decl: number; pre?: 'line' | 'restart' } {
  const n = text.length;
  let fence: OpenFence | null = null;
  let fenceContainers: Container[] = [];
  let fenceInItem = false;
  // The column the content of the item that holds such a fence starts at: a non-blank line indented less ends the item, and the fence with it.
  let fenceItemCol = 0;
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
  // #5265 — the column the content of an item opened by a bare marker (`-`, `  1.`) starts at, its indent included, or -1: a top-level line
  // indented to it is still in the item (a fence there ends with the item); a line indented less, other than a paragraph's lazy line, ends it.
  const bareCols: number[] = [];
  const bareCol = (): number => (bareCols.length === 0 ? -1 : bareCols[bareCols.length - 1]);
  // Whether the line before was in a list, so that an item with any number continues it.
  let inList = false;
  // #5211 — the column the content of the innermost open list item starts at, or -1: a line indented to it continues the item.
  let listCol = -1;
  let listDepth = 0;
  // #5265 — the content columns of the items outside every quote that the line setting listCol opened or continued (read while listCol is set).
  let listCols: number[] = [];
  // A line at column `col` that ends the innermost item stays in the items outside it that it is indented into (outside every quote only).
  const leaveItems = (col: number): void => {
    listCols = listDepth === 0 ? listCols.filter((c) => c <= col) : [];
    listCol = listCols.length === 0 ? -1 : listCols[listCols.length - 1];
  };
  // The quote depth of the line before: a line that opens a deeper quote starts a container, with no paragraph open in it.
  let prevDepth = 0;
  // #5265 — marked takes no `=` or `-` line for an underline under a paragraph whose first line is a lone tag it reads as text (`<div/x>`:
  // a name, then `/` and more before the `>`; a declaration or a whole tag is an HTML block to it), nor under the lazy lines
  // after a block quote line with content (it carries the quote's paragraph on through them).
  let markedNoSetext = false;
  // Whether the line before (and the line being read) is a quote line with content: only after one does marked carry the quote on lazily.
  let prevQuoted = false;
  let quoted = false;
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
  // The containers of the line being read, for the underline rule of paragraphEnd.
  let runContext: RunContext = NO_CONTAINER;
  // marked's closer of the declaration's fence (\`markedClose\` below), built once per fence.
  let markedCloser: RegExp | null = null;
  const inlineBound = (j: number): number => {
    if (j >= inlineFrom && j < inlineTo) return inlineTo;
    inlineFrom = j;
    inlineTo = paragraphEnd(text, j, runContext);
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
  // #5265 — whether that declaration was itself outside every container (a quote or list marker before it keeps what follows inside).
  let blockAtTop = false;
  // #5265 — the same after a CDATA or processing instruction block, read only by marked's block rules below (not a line head to the rest).
  let markedRestartAt = -1;
  // Whether the line being read leaves the item of a bare marker on the line before (marked starts a block there).
  let leftBare = false;
  // Whether the last bare marker ended at its line's end: marked takes a marker followed by spaces or tabs and nothing else for paragraph text.
  let markerTight = false;
  // #5265 — the `<` of the top-level declaration whose fence (marked) is still open, or -1.
  let declFence = -1;
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
      const c = inner === null ? containersOf(line) : { list: rawContainers, at: line.length - inner.length, item: -1, itemQuotes: 0, items: [] };
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
  // #5265 — marked ends a declaration, CDATA or processing instruction block that starts a line at its closer and starts the next block right
  // after it. A list marker there (`<!T>-`, `<![CDATA[]]>- a`) opens an item from the column marked restarts at: a fence indented into it
  // under the line is the item's, and ends with it. Its content starts one column past a bare marker, else past the marker's one to four
  // spaces (five or more: one, the rest is code). `j` is the construct's `<`, `after` the index after its closer, on the same line.
  const markedHead = (j: number): boolean => (j === markedBlockAt && blockAtTop) || j === markedRestartAt || /^ {0,3}$/.test(text.slice(text.lastIndexOf('\n', j - 1) + 1, j));
  const markedItemAfter = (j: number, after: number): void => {
    if (!markedHead(j)) return;
    const rest = text.slice(after, lineEndAt(after));
    const item = /^( {0,3})((?:[-+*]|\d{1,9}[.)]))(?:[ \t\r]*$|( +)(?=[^ \t\r\n]))/.exec(rest);
    if (item === null) {
      // What the rest of the line is decides whether a paragraph is left open for the next line to continue: nothing more, a heading, a
      // rule, a quote that holds nothing or only code, a comment (marked's comment block takes the rest of its line), or indented code leave none; anything else is taken
      // for a paragraph. Both mistakes can lose the anchor (a continued paragraph reads the next line inline, a closed one lets a
      // declaration there open a block), so the line is classified rather than guessed one way.
      if (/^(?: {0,3}(?:#{1,6}(?:[ \t]|\r?$)|(?:-[ \t]*){3,}\r?$|(?:\*[ \t]*){3,}\r?$|(?:_[ \t]*){3,}\r?$|>(?:[ \t]*>)*(?:[ \t\r]*$| {5,}[^ \t\r])|<!--)| {4,}[^ \t\r]|[ \t\r]*$)/.test(rest)) prev = 'nonpara';
      return;
    }
    const bare = item[3] === undefined;
    bareCols.length = 0;
    bareCols.push(item[1].length + item[2].length + (bare || item[3].length > 4 ? 1 : item[3].length));
    if (bare) { markerWidth = item[2].length + 1; prev = 'marker'; markerTight = !/[ \t]\r?$/.test(rest); }
  };
  // #5265 — a fence that starts right after such a closer (`<!x>~~~`, `<??>~~~`) opens in marked, outside every container; it is the
  // construct's own (`declFence`), so a fence that never closes escapes the construct (firstUnterminated may exempt it). Whether it opened.
  const markedFenceAfter = (j: number, after: number): boolean => {
    if (exempt.has(j) || !/^ {0,3}(?:`{3,}|~{3,})/.test(text.slice(after, after + 6))) return false;
    const opened = stepFence(text.slice(after, lineEndAt(after)), null).open;
    if (opened === null) return false;
    fence = opened;
    fenceContainers = [];
    fenceInItem = false;
    declFence = j;
    return true;
  };
  // Whether a block marked would start at the head of the line at `j` interrupts no paragraph (the declaration rule below).
  const markedBlockOk = (): boolean => prevBefore !== 'other' && (prevBefore !== 'marker' || leftBare) && !prevDefinition;
  const markedLineHead = (j: number): boolean => startsLine(j) || j === markedRestartAt;
  const markedOpens = (j: number): boolean => markedLineHead(j) && markedBlockOk();
  // marked starts no CDATA or processing instruction block in a paragraph, so the scan's raw line there (kept: a declaration under it may
  // still open a block in marked, before an underline) is the paragraph's: `paraRaw`, and after it no such block starts either.
  let paraRaw = false;
  let prevParaRaw = false;
  const markedRestarts = (j: number): boolean => markedOpens(j) && !prevParaRaw;
  // Where the raw region of such a block at `j` ends: its line's end (`lineEnd`), but in marked, which reads the rest of a line after the
  // closer (ending at `after`) as new blocks, the closer, when more follows it on the line outside every container (inside one the line stays
  // raw, and leaves no paragraph open).
  const markedRawTo = (j: number, after: number, lineEnd: number): number =>
    (model === 'marked' && markedRestarts(j) && markedHead(j) && lineEndAt(j) === lineEnd && text.slice(after, lineEnd).trim() !== '' ? after : lineEnd);
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
      // A CRLF line is read without its `\r`, as every reader reads it.
      const line = text.slice(i, text[end - 1] === '\r' ? end - 1 : end);
      // Block quote markers do not change what is code inside them.
      const inner = line.replace(/^ {0,3}(?:> ?)+/, '');
      prevQuoted = quoted;
      quoted = inner.trim() !== '' && /^ {0,3}>/.test(line);
      let here = containersOf(line);
      const listed = here.list.some((c) => !c.quote);
      // A number other than 1 starts no list in the middle of a paragraph; it is an item only where a list is open already.
      if (listed && prev === 'other' && !inList && /^ {0,3}(?:> ?)*(?!0*1[.)])\d/.test(line)) here = { list: [], at: 0, item: -1, itemQuotes: 0, items: [] };
      if (here.list.some((c) => !c.quote)) inList = true;
      else if (line.trim() !== '' && prev === 'blank' && !/^[ \t]{2}/.test(line)) inList = false;
      const content = line.slice(here.at);
      const lineIndent = columnAfter((/^[ \t]*/.exec(line) as RegExpExecArray)[0]);
      // An item that starts with a blank line holds nothing; one with content ends at a line indented less (but a paragraph's lazy line).
      const bareBefore = bareCols.length;
      if (fence === null && line.trim() === '' && prev === 'marker') bareCols.pop();
      else if (fence === null && line.trim() !== '' && prev !== 'other') while (bareCols.length > 0 && lineIndent < bareCol()) bareCols.pop();
      leftBare = prev === 'marker' && line.trim() !== '' && bareCols.length < bareBefore && markerTight;
      const prevWasPara: boolean = prev === 'other';
      prevParaRaw = paraRaw;
      paraRaw = false;
      // A list marker indented into an item a bare marker opened (`-`, then `  - x`) opens an item inside it: the outer one stays open.
      const bareOuter = here.list.some((c) => !c.quote) && here.list[0].quote === false ? bareCols.filter((c) => c <= lineIndent) : [];
      if (here.list.some((c) => !c.quote)) bareCols.length = 0;
      // A fence lives in the containers of the line that opened it, and ends with them.
      let within = fence === null ? null : contentInside(line, fenceContainers);
      if (within !== null && fenceInItem && line.trim() !== '' && columnAfter((/^[ \t]*/.exec(line) as RegExpExecArray)[0]) < fenceItemCol) within = null;
      // #5211 — the fence ended because its containers did: marked reads the next line as markup, whatever its indent.
      const fenceCut = fence !== null && within === null;
      if (within === null) fence = null;
      const wasOpen = fence !== null;
      // marked closes a fence on the opening run followed by any backticks and tildes (`\\1[~`]* *`); kept to the declaration's fence.
      if (declFence !== -1 && fence !== null && markedCloser === null) markedCloser = new RegExp(`^ {0,3}${fence.ch.repeat(fence.len)}[\`~]* *$`);
      const markedClose: boolean = declFence !== -1 && fence !== null && (markedCloser as RegExp).test(line);
      const step: { open: OpenFence | null; fenceLine: boolean } = markedClose ? { open: null, fenceLine: true } : stepFence(within ?? content, fence);
      if (!wasOpen && step.open !== null) {
        fenceContainers = here.list;
        // A fence on a line indented into the open item (or under a bare marker) is the item's: it ends with it, before the anchor.
        const cols = columnAfter((/^[ \t]*/.exec(content) as RegExpExecArray)[0], columnAfter(line.slice(0, here.at))) - columnAfter(line.slice(0, here.at));
        // In nested items it is the innermost item it is indented into (`- - x`, then a fence at column 2: the outer one's).
        const itemCol = listCol > 0 ? Math.max(-1, ...listCols.filter((c) => c <= cols)) : -1;
        fenceInItem = here.list.length === 0 && (itemCol > 0 || (bareCol() > 0 && cols >= bareCol()));
        fenceItemCol = itemCol > 0 ? itemCol : bareCol();
      }
      fence = step.open;
      if (fence === null) { declFence = -1; markedCloser = null; }
      if (step.fenceLine || wasOpen) { prev = 'nonpara'; lrd = 0; inDefinition = false; i = end + 1; continue; }
      // An indented code block: a line of four spaces or a tab, after a blank line, the start of the text or another such line.
      const quotes = line.slice(0, line.length - inner.length);
      const from = columnAfter(quotes);
      // A tab right after a quote marker gives its first column to the marker in CommonMark; marked strips the whole tab with the marker (#5265).
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
      // #5265 — an item that holds a quote (`- > x`) has its content where the item's marker puts it, outside the quote it opens.
      if (listedHere) {
        // A marker indented into an open item outside every quote opens an item inside it: the outer ones stay open.
        const outer = here.list[0].quote === false ? [...bareOuter, ...(listCol > 0 && listDepth === 0 ? listCols.filter((c) => c <= lineIndent) : [])] : [];
        listCols = [...outer, ...here.items];
        listCol = here.item - from;
        listDepth = here.itemQuotes;
      }
      // A quote that opens inside the item continues it when its marker sits at the item's content; leaving the item's own quote ends it.
      else if (depth > listDepth && listCol > 0 && quoteColumns(line, listDepth + 1).marker - quoteColumns(line, listDepth).content < listCol) leaveItems(quoteColumns(line, listDepth + 1).marker - quoteColumns(line, listDepth).content);
      else if (depth < listDepth) listCol = -1;
      // A line that starts another block closes the item; only a paragraph line may continue it lazily.
      else if (depth === listDepth && inner.trim() !== '' && lineCols < listCol && (prev !== 'other' || (model === 'marked' ? LIST_CLOSING_LINE_MARKED : LIST_CLOSING_LINE).test(inner))) leaveItems(lineCols);
      // Inside a deeper quote the item's content is that quote's to measure from.
      const opensQuote = depth > prevDepth;
      // A line outside the quote or short of the list item the line before was in: lazy paragraph text, never a setext underline.
      // marked, unlike CommonMark, takes a lazy `=` or `--` line in a list item for its underline (a quote's lazy line is text to both).
      const quoteLazy = depth < prevDepth;
      const listLazy = listCol > 0 && !listedHere && depth === listDepth && lineCols < listCol;
      // #5265 — the same short of the content of a bare marker's item whose paragraph the line before was (CommonMark: a lone `-` there is
      // the list's next item, not an underline).
      const bareLazy: boolean = model === 'commonmark' && prevWasPara && bareCols.length > 0 && !listedHere && depth === 0 && lineIndent < bareCol();
      const depthBefore = prevDepth;
      prevDepth = depth;
      runContext = { quoted: depth > 0, listCol: depth === listDepth && model === 'commonmark' ? listCol : -1 };
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
        // #5265 — a line that opens a deeper quote starts a container with no paragraph in it: its `=`, `--` or `-` underlines nothing.
        const paraBefore: boolean = prev === 'other' && !opensQuote;
        const underlines: boolean = paraBefore && !(model === 'marked' && markedNoSetext);
        prev = inner.trim() === '' ? (prev === 'code' ? 'code' : 'blank') : label || /^ {0,3}(?:#{1,6}(?:[ \t]|$)|(?:-[ \t]*){3,}$|(?:\*[ \t]*){3,}$|(?:_[ \t]*){3,}$)/.test(inner) || (underlines && !quoteLazy && !bareLazy && (!listLazy || model === 'marked') && /^ {0,3}(?:=+|-{2,})[ \t]*$/.test(inner))
          || (underlines && !quoteLazy && !listLazy && !bareLazy && /^ {0,3}-[ \t]*$/.test(inner)) || /^ {0,3}#{1,6}(?:[ \t]|$)/.test(content) ? 'nonpara' : /^ {0,3}(?:[-+*]|\d{1,9}[.)])[ \t]*$/.test(inner)
          // After a paragraph line an empty item starts no list (it is text), but a lone `-` in a container the paragraph's line had is an item.
          ? (paraBefore && !(quoteLazy || listLazy || bareLazy) ? 'other' : 'marker')
          : prev === 'marker' && indent >= markerWidth + 4 ? 'marker' : 'other';
        markedNoSetext = prev === 'other' && ((quoteLazy && prevQuoted) || (paraBefore ? markedNoSetext : /^ {0,3}<[A-Za-z][A-Za-z0-9-]*\/(?!>)[^\n>]*>$/.test(inner)));
        // #5265 — a lazy line of a quote's paragraph is still in the quote (CommonMark): the line after it that has no marker leaves the quote,
        // so a lone `-` there opens an item rather than continuing the paragraph.
        if (model === 'commonmark' && quoteLazy && prevBefore === 'other' && prev === 'other') prevDepth = depthBefore;
        if (prev === 'marker' && indent < 4) markerWidth = inner.trim().length + 1;
        if (prev === 'marker') markerTight = !/[ \t]\r?$/.test(inner);
        // marked carries a quote on through the line after a quote line, a bare marker included: that item is the quote's (#5265).
        if (prev === 'marker' && indent < 4 && here.list.length === 0 && depth === 0 && !(model === 'marked' && depthBefore > 0)) bareCols.push(indent + markerWidth);
      }
    }
    const c = text[i];
    if (c === '\\' && i >= rawUntil) { i += isAsciiPunct(text[i + 1]) ? 2 : 1; continue; }
    if (c === '`' && i >= rawUntil) {
      let len = 1;
      while (text[i + len] === '`') len += 1;
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
        if (text[i + 2 + rawName.length] === '/') return { at: rawStart, topLevelFence: false, decl: -1 };
        const end = tagEndOf(text, i, i + 2);
        if (end === -1 || end > tagLimit(i, false)) return { at: rawStart, topLevelFence: false, decl: -1 };
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
      if (close === -1 || close + 3 > blockLimit(i)) return { at: i, topLevelFence: false, decl: -1 };
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
      if (first === -1 || closer === -1 || first !== closer + 2 || closer + 3 > blockLimit(i)) return { at: i, topLevelFence: false, decl: -1 };
      if (startsLine(i)) raw(markedRawTo(i, closer + 3, lineEndAt(closer)));
      if (model === 'marked' && startsLine(i) && !markedRestarts(i)) paraRaw = true;
      if (model === 'marked' && markedRestarts(i) && lineEndAt(i) === lineEndAt(closer) && markedHead(i)) {
        if (markedFenceAfter(i, closer + 3)) { i = lineEndAt(i) + 1; continue; }
        markedItemAfter(i, closer + 3);
        markedRestartAt = closer + 3;
      }
      i = first + 1;
      continue;
    }
    if (text.startsWith('<?', i)) {
      const first = text.indexOf('>', i + 2);
      // #5265 — marked's block needs a `?>` after the `<?` (`<?>` is no closer to it) and runs to the end of the text without one. A browser
      // ends the instruction at its first `>`, and reads as markup what follows: all of it raw to Markdown, so a tag there is judged as markup.
      if (model === 'marked' && first !== -1 && markedRestarts(i) && text.indexOf('?>', i + 2) === -1) { raw(n); i = first + 1; continue; }
      const closer = text.indexOf('?>', i + 1);
      if (first === -1 || closer === -1 || first !== closer + 1 || closer + 2 > blockLimit(i)) return { at: i, topLevelFence: false, decl: -1 };
      if (startsLine(i)) raw(markedRawTo(i, closer + 2, lineEndAt(closer)));
      if (model === 'marked' && startsLine(i) && !markedRestarts(i)) paraRaw = true;
      if (model === 'marked' && markedRestarts(i) && closer >= i + 2 && lineEndAt(i) === lineEndAt(closer) && markedHead(i)) {
        if (markedFenceAfter(i, closer + 2)) { i = lineEndAt(i) + 1; continue; }
        markedItemAfter(i, closer + 2);
        markedRestartAt = closer + 2;
      }
      i = first + 1;
      continue;
    }
    // #5211 — marked takes a declaration only when a blank follows its name; any other `<!` and a name is text to it, so what follows is read.
    // At the head of a line that interrupts no paragraph it starts an HTML block in marked too, and is complete there.
    if (model === 'marked' && /<![A-Za-z]+(?![A-Za-z\s])/y.test(text.slice(i, text.indexOf('\n', i) === -1 ? n : text.indexOf('\n', i) + 1)) && !markedOpens(i)) { i += 2; continue; }
    if (text.startsWith('<!', i)) {
      const close = text.indexOf('>', i + 2);
      if (close === -1 || close + 1 > blockLimit(i)) return { at: i, topLevelFence: false, decl: -1 };
      // marked ends such a block at the declaration's first `>` and reads the rest of the line as text (#5211); CommonMark keeps it raw.
      if (startsLine(i) && isLetter(text[i + 2]) && model === 'commonmark') raw(lineEndAt(close));
      if (model === 'marked' && isLetter(text[i + 2]) && markedLineHead(i)) {
        // #5265 — a declaration on one line at the top level (no quote or list marker before it), interrupting no paragraph: marked
        // starts the next block right after its `>`, so a fence there opens; only one that never closes swallows the rest of the document,
        // and that one is escaped. Elsewhere marked reads no fence there (or the escaped text would open the same one on the next line).
        const eol = text.indexOf('\n', close + 1);
        const oneLine = text.lastIndexOf('\n', close) < i;
        const opensBlock = markedBlockOk();
        // Escaped, the line is paragraph text, and that can change what follows it: a lone `-` under it becomes an underline (and the lines
        // indented under that bullet leave its item), and a type 7 tag under it no longer starts an HTML block. Where that leaves a fence open
        // to the end of the text in CommonMark, escaping would hand those readers the loss marked has as written, so it is not escaped
        // (firstUnterminated judges that for the declaration it would report, and reads the text again with it exempt).
        if (oneLine && opensBlock && markedHead(i) && markedFenceAfter(i, close + 1)) {
          i = eol === -1 ? n : eol + 1;
          continue;
        }
        // The item check reads where this declaration sits, so it runs before the restart point moves past it.
        if (oneLine && opensBlock) markedItemAfter(i, close + 1);
        blockAtTop = markedHead(i);
        markedBlockAt = close + 1;
      }
      i = close + 1;
      continue;
    }
    const isEnd = text[i + 1] === '/';
    if (isEnd && !isLetter(text[i + 2]) && text[i + 2] !== '>') {
      // `</` and anything but a letter or `>` is a bogus comment, which runs to the next `>`.
      const close = text.indexOf('>', i + 2);
      if (close === -1 || close + 1 > tagLimit(i, false)) return { at: i, topLevelFence: false, decl: -1 };
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
    // CommonMark starts a block of type 1 or 6 only where the name ends at a blank, `>`, `/>` or the line's end: `<div/x` is no block.
    const delimited = nameEnd >= n || /[ \t\r\n>]/.test(text[nameEnd]) || text.startsWith('/>', nameEnd);
    const opensBlock = delimited && (BLOCK6_NAMES.has(name) || (!isEnd && TYPE1_NAMES.has(name)));
    // A name that holds `=`, `<` or a quote is read as a name by a browser and fails in htmlparser2: ambiguous, so unterminated.
    if (/[=<"'`]/.test(name)) return { at: i, topLevelFence: false, decl: -1 };
    const tagEnd = tagEndOf(text, i, nameStart);
    if (tagEnd === -1 || tagEnd > tagLimit(i, opensBlock)) return { at: i, topLevelFence: false, decl: -1 };
    // An end tag takes attributes in a browser (a quote hides a `>`) but htmlparser2 ends it at the first `>`; where the two ends differ the
    // readers resume in different places, so the tag is left unterminated rather than guessed.
    if (isEnd && tagEnd !== text.indexOf('>', i) + 1) return { at: i, topLevelFence: false, decl: -1 };
    // #5211 — outside an HTML block, a tag CommonMark does not accept is text to Markdown, which reads what it holds: the scan goes on inside
    // it. A raw-text element, a template and a block opener at the head of a line keep the browser's reading, which is the stricter one.
    if (i >= rawUntil && !RAW_TEXT.has(name) && name !== 'template' && name !== 'plaintext' && !(startsLine(i) && opensBlock)
      && !(isEnd ? CM_CLOSE_TAG : CM_OPEN_TAG).test(text.slice(i, tagEnd))
      // Held back while no reader the tests can run shows the loss: linkedom does not model `template` (#5211, a parser waits on a ruling).
      && !/<template(?=[\s/>]|$)/i.test(text.slice(i + 1, tagEnd))) { i += 1; continue; }
    // A block-level tag at the head of a line (type 6), or a complete tag alone on its line that does not interrupt a paragraph (type 7),
    // starts an HTML block that runs to the next blank line.
    // #5265 — marked starts these blocks right after a CDATA or processing instruction block it ended on the line, too (where marked restarts, the line interrupts no paragraph).
    const restartHead = model === 'marked' && i === markedRestartAt;
    if (startsLine(i) || restartHead) {
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

    if (name === 'plaintext') return { at: i, topLevelFence: false, decl: -1 };
    const typeOneHead = startsLine(i) || restartHead;
    if (RAW_TEXT.has(name)) {
      if (typeOneHead && delimited && (name === 'script' || name === 'style' || name === 'textarea')) {
        // CommonMark type 1: the block runs raw to the first line that holds an end tag, code or not.
        // Markdown ends the block only at a line that holds `</name>` itself, so that literal end tag must exist. A browser ends the element
        // at the first `</name` followed by a blank, `/` or `>` (and that tag's own `>`), and reads as markup what comes after it, inside the
        // block: the scan resumes there.
        const literal = new RegExp(`</${name}>`, 'gi');
        literal.lastIndex = tagEnd;
        // The block is cut where its containers end, so an end tag beyond them is none of its own.
        if (!literal.test(text) || literal.lastIndex > containerEnd(i, false)) return { at: i, topLevelFence: false, decl: -1 };
        raw(lineEndAt(literal.lastIndex));
        const closer = new RegExp(`</${name}(?=[\\s/>])`, 'gi');
        closer.lastIndex = tagEnd;
        const m = closer.exec(text);
        if (!m) return { at: i, topLevelFence: false, decl: -1 };
        // `</name/`: a browser ends the element there, htmlparser2 and CommonMark do not. The readers disagree on where the markup resumes,
        // so the element is left unterminated rather than guessed.
        if (text[m.index + 2 + name.length] === '/') return { at: i, topLevelFence: false, decl: -1 };
        const end = tagEndOf(text, m.index, m.index + 2);
        if (end === -1 || (inQuote() && end > lineEndAt(m.index))) return { at: i, topLevelFence: false, decl: -1 };
        i = end;
      } else {
        rawStart = i;
        rawName = name;
        i = tagEnd;
      }
      continue;
    }
    if (name === 'pre' && delimited && typeOneHead) {
      // CommonMark type 1 ends at a line holding any one of these four end tags.
      const closer = /<\/(?:pre|script|style|textarea)>/gi;
      closer.lastIndex = i;
      if (!closer.test(text) || closer.lastIndex > containerEnd(i, false)) {
        // #5265 — a top-level one may be exempt (firstUnterminated): then it is the block it is as written, raw to the end of the text.
        if (lineContainers.length === 0 && exempt.has(i)) { raw(n); i = tagEnd; continue; }
        return { at: i, topLevelFence: false, decl: -1, pre: lineContainers.length === 0 ? (i === lineFirst ? 'line' : 'restart') : undefined };
      }
      raw(lineEndAt(closer.lastIndex));
    }
    i = tagEnd;
  }
  const open = [rawStart, ...templates.slice(0, 1), fence === null ? -1 : declFence].filter((x) => x !== -1);
  return { at: open.length === 0 ? -1 : Math.min(...open), topLevelFence: fence !== null && fenceContainers.length === 0 && !fenceInItem, decl: fence === null ? -1 : declFence };
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
  if (!text.includes('<')) return text;
  let cur = text;
  for (let k = 0; ; k += 1) {
    const cm = firstUnterminated(cur, 0, 'commonmark');
    const mk = firstUnterminated(cur, 0, 'marked');
    // #5265 — an escape only CommonMark asks for is pointless where a fence it leaves open to the end of the text takes the anchor whether
    // or not the construct is escaped, and it can cost marked the anchor: it is skipped (marked's own escapes still run).
    const cmUseless = cm !== -1 && (mk === -1 || cm < mk) && FENCE_LINE.test(cur.slice(cm))
      && endsInOpenFence(cur) && endsInOpenFence(`${cur.slice(0, cm)}&lt;${cur.slice(cm + 1)}`);
    const ats = (cmUseless ? [mk] : [cm, mk]).filter((x) => x !== -1);
    const at = ats.length === 0 ? -1 : Math.min(...ats);
    if (at === -1) return cur;
    // A text that keeps hiding another construct behind the one just escaped: close the question for every `<` it holds.
    if (k === MAX_RESTARTS) return cur.replace(/</g, '&lt;');
    cur = `${cur.slice(0, at)}&lt;${cur.slice(at + 1)}`;
  }
}

/** Test seam: {@link quoteColumns} (a one-column tab after a quote marker is not observable through the pass in any body found). */
export const quoteColumnsForTests = quoteColumns;
