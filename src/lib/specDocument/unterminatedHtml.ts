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
 * #5265 — the escapes, the exemptions of firstUnterminated and the reads of endsInOpenFence nest, so the scans of one call are also
 * counted: past {@link MAX_SCANS} every `<` is escaped the same way, which keeps a call linear in the text.
 */
import { stepFence, type OpenFence } from './fences.js';

/** Elements whose content is text up to their own end tag. */
const RAW_TEXT = new Set(['script', 'style', 'textarea', 'title', 'xmp', 'iframe', 'noembed', 'noframes', 'noscript']);
const MAX_RESTARTS = 32;
/** The next blank line or raw-text element (or `plaintext`) start: which comes first decides whether a block holds such an element. */
const BLANK_OR_RAW_TEXT = /\n[ \t]*\r?(?=\n|$)|<(?:script|style|textarea|title|xmp|iframe|noembed|noframes|noscript|plaintext)(?=[\s/>]|$)/gi;
/**
 * The scans one call of escapeUnterminatedHtml may run (a body of the fuzz alphabets needs at most 70: the pre exemptions and the reads of
 * endsInOpenFence nest). Each escape costs at least two (both models), and more where a declaration's fence is judged: measured, 32
 * independent unterminated tags or comments are escaped one by one (MAX_RESTARTS binds there), and 31 top-level declarations whose fences
 * never close; past that every `<` is escaped (the safe side). `scansLeft` is set by escapeUnterminatedHtml, the only entry that reaches a scan.
 */
const MAX_SCANS = 128;
let scansLeft = 0;
const SCANS_SPENT = Symbol('scans spent');

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
    // #5265 — a backtick fence holds no backtick after its run (`\`\`\`<xmp>\`\`\``: paragraph text, so a code span from the line above closes there).
    '#{1,6}(?:[ \\t\\r]|$)', '`{3,}(?=[^`\\n]*$)', '~{3,}', '>', '[-+*][ \\t]+\\S', '1[.)][ \\t]+\\S', '(?:-[ \\t]*){3,}\\r?(?:\\n|$)', '(?:\\*[ \\t]*){3,}\\r?(?:\\n|$)', '(?:_[ \\t]*){3,}\\r?(?:\\n|$)', '(?:=+|-+)[ \\t]*\\r?(?:\\n|$)',
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
/** #5265 — marked takes no setext underline under a paragraph whose first line starts with a bullet and a space (`1. `, `- `, read as text). */
// #5265 — a line of ` {0,3}<[^\n>]+>` that starts no HTML block in marked (`< >`, `<b <>`, `<b?>`, `<!>`, `<div/x>`): paragraph text, under
// which marked's setext rule (its lheading's `html` lookahead) takes no underline. A comment, an instruction, a declaration, CDATA, a whole
// tag or a block name ending at a blank or `>` is a block (marked tries its blocks first).
const MARKED_BLOCK6_HEAD = new RegExp(`^ {0,3}</?(?:${BLOCK6})(?: |/?>|$)`, 'i');
const markedTextTagLine = (line: string): boolean => /^ {0,3}<[^\n>]+>$/.test(line) && !/^ {0,3}<(?:!--|\?|![A-Za-z]|!\[CDATA\[)/.test(line)
  && !CM_OPEN_TAG.test(line.trim()) && !CM_CLOSE_TAG.test(line.trim()) && !MARKED_BLOCK6_HEAD.test(line);
/** #5265 — an item's content line after which marked continues the item with no lazy line: blank, indented code, a fence, a heading, a rule. */
const MARKED_LAZY_STOP = /^(?:[ \t]*$| {4}| {0,3}(?:\`\`\`|~~~|#|(?:- *){3,}$|(?:_ *){3,}$|(?:\* *){3,}$))/;
/** #5265 — whether a quote line starts its content with a CDATA, instruction or declaration and a fence follows its closer: one pass. */
function fenceAfterQuotedCloser(line: string): boolean {
  const head = /^ {0,3}> ?</.exec(line);
  if (head === null) return false;
  const at = head[0].length - 1;
  const closer = line.startsWith('<![CDATA[', at) ? line.indexOf(']]>', at + 9) + 3
    : line.startsWith('<?', at) ? line.indexOf('?>', at + 2) + 2
      : /^<![A-Za-z]/.test(line.slice(at, at + 3)) ? line.indexOf('>', at + 2) + 1 : 0;
  return closer > 2 && /^ {0,3}(?:`{3,}|~{3,})/.test(line.slice(closer, closer + 9));
}
/**
 * #5265 — whether marked's quote on `line` holds text it carries on through the next line: something after the marker's `> ?`, in the
 * innermost quote (it strips a marker and one space or tab, so `>\t>` is an empty quote inside one: nothing carried, where `>\t` is).
 */
function markedQuoteText(line: string): boolean {
  let c = line.replace(/\r$/, '');
  for (let m = /^ {0,3}> ?/.exec(c); m !== null; m = /^ {0,3}> ?/.exec(c)) {
    if (c.length === m[0].length) return false;
    const inner = c.replace(/^ {0,3}>[ \t]?/, '');
    if (!/^ {0,3}>/.test(inner)) return true;
    c = inner;
  }
  return false;
}
/** What `line` holds past its first `col` columns (a tab's far side kept as spaces). */
function afterColumns(line: string, col: number): string {
  let c = 0;
  let k = 0;
  while (k < line.length && c < col) { c += line[k] === '\t' ? 4 - (c % 4) : 1; k += 1; }
  return ' '.repeat(Math.max(0, c - col)) + line.slice(k).replace(/\t/g, '    ');
}
const MARKED_BULLET_HEAD = /^(?:[*+-]|\d{1,9}[.)]) /;
/** #5265 — under a paragraph, marked starts a new paragraph at an ordered marker and one space with nothing after it (`a`, then `1. `). */
const MARKED_ORDERED_TEXT = /^ {0,3}\d{1,9}[.)] \r?$/;
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
  // #5265 — the heading may sit in a quote or a list item (`># a`, `- # a`): it is still one line.
  if (isHeadingUnderMarkers(text, lineStart, lineEnd)) return lineEnd;
  const end = blockEnd(text, i, ctx);
  // #5265 — marked ends a list item at a line indented short of its content (and three columns at most) that starts an HTML block to it
  // (`<` and a letter with a `>` later on the line, or `<!--`), even where CommonMark reads that line as lazy paragraph text. Searched
  // only up to the run's other end, so no run reads past its own text.
  if (ctx.markedListCol > 0) {
    // A fence's opening run ends it too, whatever follows the run (marked's fencesBeginRegex reads no info string: `- \``, then `\`\`\`<b>\``).
    const cut = new RegExp(`\\n {0,${Math.min(3, ctx.markedListCol - 1)}}(?:<(?:[a-z].*>|!--)|\`\`\`|~~~)`, 'i').exec(text.slice(i, end));
    if (cut) return i + cut.index;
  }
  return end;
}

/**
 * #5265 — whether the line from `from` to `to` is an ATX heading after any quote and list markers (`># a`, `- # a`, `1. > # a`). The
 * markers are read with a loop, one pass over the line: the regex this replaces could take a blank after a `>` either as the marker's
 * own blank or as the next marker's indent, so a line of nested markers that is no heading cost it 2^n paths (Beryl, d5f941ae).
 */
function isHeadingUnderMarkers(text: string, from: number, to: number): boolean {
  let p = from;
  for (;;) {
    let q = p;
    while (q < to && q - p < 3 && text[q] === ' ') q += 1;
    const c = text[q];
    if (c === '>') {
      p = q + 1;
      if (text[p] === ' ' || text[p] === '\t') p += 1;
      continue;
    }
    let m = q;
    if (c === '-' || c === '+' || c === '*') m = q + 1;
    else {
      while (m < to && m - q < 9 && text[m] >= '0' && text[m] <= '9') m += 1;
      m = m > q && (text[m] === '.' || text[m] === ')') ? m + 1 : q;
    }
    if (m > q && m < to && (text[m] === ' ' || text[m] === '\t')) {
      p = m;
      while (p < to && (text[p] === ' ' || text[p] === '\t')) p += 1;
      continue;
    }
    let h = q;
    while (h < to && h - q < 7 && text[h] === '#') h += 1;
    const n = h - q;
    return n >= 1 && n <= 6 && (h === to || text[h] === ' ' || text[h] === '\t' || text[h] === '\r');
  }
}

/** Where the next line that starts another block (or a blank line) cuts the run at `i`, for {@link paragraphEnd}. */
function blockEnd(text: string, i: number, ctx: RunContext): number {
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
interface RunContext { quoted: boolean; listCol: number; markedListCol: number }
const NO_CONTAINER: RunContext = { quoted: false, listCol: -1, markedListCol: -1 };
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

/**
 * #5265 — whether a line is block quote markers alone to CommonMark, tabs counted as the columns they fill: a tab after a marker gives it
 * one column and leaves the rest as indent, so `>\t>` is an empty quote inside one (its second `>` two columns in), not a paragraph.
 */
function commonmarkQuoteOnly(line: string): boolean {
  let expanded = '';
  for (const ch of line) expanded += ch === '\t' ? ' '.repeat(4 - (columnAfter(expanded) % 4)) : ch;
  return /^ {0,3}>/.test(expanded) && expanded.replace(/^(?: {0,3}> ?)+/, '').trim() === '';
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
  // The quotes opened so far, counted as they open: a line of many nested markers is walked once (#5265).
  let quotes = 0;
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
      quotes += 1;
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
    itemQuotes = quotes;
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
  let heldAsWritten: boolean | null = null;
  for (let k = 0; ; k += 1) {
    const r = scan(text, from, model, exempt);
    if (r.at === -1 || k === MAX_RESTARTS) return r.at;
    const escaped = (): string => `${text.slice(0, r.at)}&lt;${text.slice(r.at + 1)}`;
    if (r.pre) {
      if (!FENCE_LINE.test(text.slice(r.at)) || !endsInOpenFence(escaped(), r.pre === 'line' ? 'commonmark' : 'marked')) return r.at;
    } else {
      if (model === 'commonmark' || r.at !== r.decl) return r.at;
      asWritten ??= endsInOpenFence(text);
      // #5265 — the same where escaping it makes CommonMark read, as markup, a tag that holds `<template` (`<!T>~~~<b`, then `<template>`),
      // which the scan holds back (#5211): escaped, that line is paragraph text, and the template it opens takes the anchor.
      heldAsWritten ??= holdsTemplate(text);
      if ((asWritten || !endsInOpenFence(escaped())) && (heldAsWritten || !holdsTemplate(escaped()))) return r.at;
    }
    exempt.add(r.at);
  }
}

/** A line that may open a fence: the cheap test before a CommonMark read. */
const FENCE_LINE = /\n[ \t]*(?:`{3,}|~{3,})/;

const NO_EXEMPT: ReadonlySet<number> = new Set();

/** A line that ends in exactly one space or tab after its last other character (`1. `, `-\t`). */
const ONE_BLANK_END = /[^ \t][ \t]\r?$/;

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

/** Whether CommonMark's reading of `text` (escaped as the pass would) reaches a tag the scan holds back for the `<template` it holds (#5211). */
function holdsTemplate(text: string): boolean {
  if (!/<template(?=[\s/>]|$)/i.test(text)) return false;
  let cur = text;
  for (let k = 0; k <= MAX_RESTARTS; k += 1) {
    const notes = { held: false };
    const r = scan(cur, 0, 'commonmark', NO_EXEMPT, notes);
    if (notes.held) return true;
    if (r.at === -1) return false;
    cur = `${cur.slice(0, r.at)}&lt;${cur.slice(r.at + 1)}`;
  }
  return false;
}

/** {@link firstUnterminated}, and whether a fence outside every container is open at the end (read only when nothing is unterminated). */
function scan(text: string, from: number, model: ReaderModel, exempt: ReadonlySet<number> = NO_EXEMPT, notes?: { held: boolean }): { at: number; topLevelFence: boolean; decl: number; pre?: 'line' | 'restart' } {
  scansLeft -= 1;
  if (scansLeft < 0) throw SCANS_SPENT;
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
  // #5265 — the end of the item marked carries the line being read in lazily (one outside the item's indent that starts no block of
  // marked's, after any line of the item, a fence line too), or -1. A type 1 block there is the item's, and ends with it.
  let markedLazyEnd = -1;
  let markedLazyAt = -1;
  // The last item end found, and the line end it was searched from: a later line end below it has the same end.
  let lazyFrom = -1;
  let lazyTo = -1;
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
  let prevQuoteText = false;
  // Whether the line (and the one before) starts with a quote marker; a quote line's carry is marked's (quoteText), not `quoted`'s.
  let quoteLine = false;
  let prevQuoteLine = false;
  // #5265 — the line before was quote markers alone only by CommonMark's tab columns (`>\t>`): an empty quote nested by a tab.
  let tabNested = false;
  let prevTabNested = false;
  // #5265 — this line ended, in marked, the list item whose paragraph the line before was (`- a`, then `<x>`): no paragraph is open here.
  let markedItemCut = false;
  // #5265 — whether the quote line being read (and the one before) ends its quote's content in code (a fence or indented code): marked
  // carries no line after such a quote into it (its blockquote rule stops when the last block it read is code).
  let quoteCode = false;
  let prevQuoteCode = false;
  let quoteText = false;
  let quoted = false;
  // #5265 — whether marked still carries a quote on through the line being read (a line with no marker under a quote line, or under such a
  // line): an HTML block it opens there is the quote's, and ends with it, at the next line that is no lazy text (a fence, for one).
  let markedCarry = false;
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
  // #5265 — where the item of a bare marker the line at `j` sits in (indented to its content `col`) ends before the blank line: before the
  // first line short of that indent (CommonMark ends the item there, and an HTML block in it with it) or, in marked, which carries such a
  // line on lazily, the first of those that starts one of its blocks or a list marker. Found once per item: a later line in it has the same end.
  let bareFrom = -1;
  let bareTo = -1;
  let bareAt = -1;
  const bareItemEnd = (j: number, col: number): number => {
    const bound = blankBound(j);
    if (col === bareAt && j >= bareFrom && j < bareTo) return bareTo;
    bareAt = col;
    bareFrom = j;
    bareTo = bound;
    for (let k = text.indexOf('\n', j); k !== -1 && k < bound; k = text.indexOf('\n', k + 1)) {
      const e = text.indexOf('\n', k + 1);
      const l = text.slice(k + 1, e === -1 ? n : e).replace(/\r$/, '');
      if (columnAfter((/^[ \t]*/.exec(l) as RegExpExecArray)[0]) >= col) continue;
      if (model === 'commonmark' || LIST_CLOSING_LINE_MARKED.test(l) || /^ {0,3}(?:[*+-]|\d{1,9}[.)])(?:[ \t]|$)/.test(l)) { bareTo = k; break; }
    }
    return bareTo;
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
  // #5265 — whether that marker had exactly one space or tab after it: marked reads such a line as paragraph text (two or more: an empty item).
  let markerText = false;
  // #5265 — the `<` of the top-level declaration whose fence (marked) is still open, or -1.
  let declFence = -1;
  // Whether the line before was taken for a link reference definition: marked's grammar for one is stricter, so it may be a paragraph there.
  let prevDefinition = false;
  let lineContent = -1;
  let lineContainers: Container[] = [];
  // #5265 — marked's block rules take up to three spaces before a block, so the next block after a closer it ended on the line may start
  // past them (`<!X> <n>`): `at` is where marked restarts, `j` the candidate.
  const atMarkedHead = (j: number, at: number): boolean => at !== -1 && j >= at && j - at <= 3 && /^ *$/.test(text.slice(at, j));
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
    return lineFirst === j || atMarkedHead(j, markedBlockAt);
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
  // Whether a raw-text element opens between `j` and the next blank line. The scan only moves forward, so the last answer stands for every
  // `j` short of the hit it found: one pass over the text per scan.
  let aheadHit = -1;
  let aheadRaw = false;
  const rawTextAhead = (j: number): boolean => {
    if (j > aheadHit) {
      BLANK_OR_RAW_TEXT.lastIndex = j;
      const m = BLANK_OR_RAW_TEXT.exec(text);
      aheadHit = m === null ? n : m.index;
      aheadRaw = m !== null && m[0][0] === '<';
    }
    return aheadRaw;
  };
  // Whether a type 7 tag at the head of the line at `j` would interrupt a paragraph. A line that opens a list item or a deeper quote starts afresh.
  const interrupts = (): boolean => {
    // #5265 — marked reads a marker with one blank after it (`+ `, ONE_BLANK_END) as paragraph text, so a tag line under it continues that paragraph.
    if (prevBefore !== 'other' && !(model === 'marked' && prevBefore === 'marker' && markerText)) return false;
    // #5265 — the tag line ended the item's paragraph in marked, so it opens a block there; taken only where that block holds a raw-text
    // element (live markup to marked, and code to CommonMark: `- a`, `<x>`, `>`, `    <script`). Elsewhere the reading stays the paragraph's,
    // which leaves CommonMark's code as written where no reader loses (`- a`, `<b>`, a fence holding `<i x=`).
    if (markedItemCut && rawTextAhead(lineFrom)) return false;
    // #5265 — marked's setext heading stops at a line that is only a tag (` {0,3}<[^\n>]+>`), and a `-` underline under it ends the paragraph
    // before that line: the tag opens an HTML block there (`a`, `<x>`, `-`). Not in a quote, whose paragraph takes both lines lazily.
    if (model === 'marked' && lineContainers.every((c) => !c.quote) && !inQuote() && /^ {0,3}<[^\n>]+>\r?$/.test(text.slice(lineFrom, lineTo))
      && /^ {0,3}-+ *\r?$/.test(text.slice(lineTo + 1, lineEndAt(Math.min(n, lineTo + 1))))) return false;
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
  // #5265 — whether the line at `j` (`startsLine(j)` was asked first) sits in the item of a bare marker: no container of its own, indented to the
  // item's content. A block that starts there ends with the item (bareItemEnd).
  const inBare = (j: number): boolean => lineContainers.length === 0 && bareCols.length > 0 && columnAfter((/^[ \t]*/.exec(text.slice(lineFrom, j)) as RegExpExecArray)[0]) >= bareCol();
  const headLimit = (j: number, blank: boolean): number => (inQuote() ? lineEndAt(j) : inBare(j) ? Math.min(bareItemEnd(j, bareCol()), containerEnd(j, blank)) : containerEnd(j, blank));
  // Inside an HTML block's raw region no Markdown block start applies: a construct there runs to the end of the region.
  const tagLimit = (j: number, opensBlock: boolean): number =>
    (j < rawUntil ? rawLimit(j) : opensBlock && startsLine(j) ? headLimit(j, true) : inlineBound(j));
  const blockLimit = (j: number): number => (j < rawUntil ? rawLimit(j) : startsLine(j) ? headLimit(j, false) : inlineBound(j));
  // #5265 — where marked ends the item a lazy line at `from` (a line end) is in: before the next line that is blank, starts one of its
  // blocks or a list marker at the top level. Ending early is the safe side (what follows is read as markup).
  const markedItemEnd = (from: number): number => {
    if (from >= lazyFrom && from <= lazyTo) return lazyTo;
    lazyFrom = from;
    lazyTo = n;
    for (let k = from; k < n; ) {
      const nl = text.indexOf('\n', k + 1);
      const e = nl === -1 ? n : nl;
      const l = text.slice(k + 1, text[e - 1] === '\r' ? e - 1 : e);
      if (l.trim() === '' || LIST_CLOSING_LINE_MARKED.test(l) || /^ {0,3}(?:[*+-]|\d{1,9}[.)])(?:[ \t]|$)/.test(l)) { lazyTo = k; break; }
      k = e;
    }
    return lazyTo;
  };
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
    // #5265 — an item whose content opens a fence (`<!x>- \`\`\``) leaves no paragraph open: marked continues it with no lazy line, so the
    // next line short of its indent starts a block, and one indented into it is the fence's.
    if (!bare && /^ {0,3}(?:\`\`\`|~~~)/.test(rest.slice(item[1].length + item[2].length + 1))) prev = 'nonpara';
    bareCols.length = 0;
    bareCols.push(item[1].length + item[2].length + (bare || item[3].length > 4 ? 1 : item[3].length));
    if (bare) { markerWidth = item[2].length + 1; prev = 'marker'; markerText = ONE_BLANK_END.test(rest); }
  };
  // #5265 — a fence that starts right after such a closer (`<!x>~~~`, `<??>~~~`) opens in marked, outside every container; it is the
  // construct's own (`declFence`), so a fence that never closes escapes the construct (firstUnterminated may exempt it). Whether it opened.
  const markedFenceAfter = (j: number, after: number): boolean => {
    if (exempt.has(j) || !/^ {0,3}(?:`{3,}|~{3,})/.test(text.slice(after, after + 6))) return false;
    // A CRLF line is read without its `\r`, as the scan reads every line (a `.` in the fence pattern does not take a `\r`).
    const opened = stepFence(text.slice(after, lineEndAt(after)).replace(/\r$/, ''), null).open;
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
      // The line before was the last raw line of an HTML block: nothing is open after it. #5265 — unless it was a paragraph's (`paraRaw`:
      // marked starts no such block in a paragraph, so the paragraph goes on, and a line indented four columns under it is lazy text, no code).
      if (i - 1 === rawUntil && !paraRaw) { prev = 'nonpara'; lrd = 0; inDefinition = false; }
      prevBefore = prev;
      const nl = text.indexOf('\n', i);
      const end = nl === -1 ? n : nl;
      // A CRLF line is read without its `\r`, as every reader reads it.
      const line = text.slice(i, text[end - 1] === '\r' ? end - 1 : end);
      // Block quote markers do not change what is code inside them.
      // #5265 — marked strips a marker and one space or tab, so a tab right before another marker is the marker's (`>\t>`: an empty quote
      // inside one). CommonMark gives a tab's first column to the marker and counts the rest as indent, which the lines below read.
      const inner = line.replace(model === 'marked' ? /^ {0,3}(?:>(?:\t(?=>)| ?))+/ : /^ {0,3}(?:> ?)+/, '');
      prevQuoted = quoted;
      prevQuoteText = quoteText;
      prevQuoteLine = quoteLine;
      prevTabNested = tabNested;
      markedItemCut = false;
      tabNested = model === 'commonmark' && inner.trim() !== '' && commonmarkQuoteOnly(line);
      quoteLine = /^ {0,3}>/.test(line);
      prevQuoteCode = quoteCode;
      // A fence right after a CDATA, instruction or declaration that starts the quote's line (`><![CDATA[]]>\`\`\``) is code in it too.
      quoteCode = model === 'marked' && fenceAfterQuotedCloser(line);
      // #5265 — marked's quote takes anything after `> ?` for its paragraph (`>\t` too, a bare `>` or `> ` not), and carries it on lazily.
      quoteText = markedQuoteText(line);
      // #5265 — marked ends a declaration block that starts the line at its `>`, so a quote right after it (`<!T>>a`) is a quote line too.
      quoted = inner.trim() !== '' && (/^ {0,3}>/.test(line) || (model === 'marked' && (prev as LineKind) !== 'other' && /^ {0,3}<![A-Za-z][^>]*>[ \t]*>[ \t]*\S/.test(line)));
      markedCarry = model === 'marked' && line.trim() !== '' && !/^ {0,3}(?:>|`{3,}|~{3,})/.test(line) && (prevQuoteText || (prevQuoted && !prevQuoteLine) || markedCarry) && !prevQuoteCode;
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
      // A paragraph line continues it lazily; a line that starts another block (a heading, a fence, a quote, a break) ends it as it ends any item.
      else if (fence === null && line.trim() !== '' && (prev !== 'other' || (model === 'marked' ? LIST_CLOSING_LINE_MARKED : LIST_CLOSING_LINE).test(line))) while (bareCols.length > 0 && lineIndent < bareCol()) bareCols.pop();
      leftBare = prev === 'marker' && line.trim() !== '' && bareCols.length < bareBefore && !markerText;
      const prevWasPara: boolean = prev === 'other';
      prevParaRaw = paraRaw;
      paraRaw = false;
      // A list marker indented into an item a bare marker opened (`-`, then `  - x`) opens an item inside it: the outer one stays open.
      const bareOuter = here.list.some((c) => !c.quote) && here.list[0].quote === false ? bareCols.filter((c) => c <= lineIndent) : [];
      // #5265 — a quote indented into that item (`-`, then `  > - x`) holds its list inside the item: the item stays open around it.
      if (here.list.some((c) => !c.quote)) {
        if (here.list[0].quote) while (bareCols.length > 0 && bareCol() > lineIndent) bareCols.pop();
        else bareCols.length = 0;
      }
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
        // A loop, not a spread: a line of many nested markers leaves one column per item (#5265).
        let itemCol = -1;
        if (listCol > 0) for (const c of listCols) if (c <= cols && c > itemCol) itemCol = c;
        fenceInItem = here.list.length === 0 && (itemCol > 0 || (bareCol() > 0 && cols >= bareCol()));
        fenceItemCol = itemCol > 0 ? itemCol : bareCol();
      }
      fence = step.open;
      if (fence === null) { declFence = -1; markedCloser = null; }
      // A marker indented into an open item outside every quote opens an item inside it: the outer ones stay open.
      const enterItems = (from: number): void => {
        const outer = here.list[0].quote === false ? [...bareOuter, ...(listCol > 0 && listDepth === 0 ? listCols.filter((c) => c <= lineIndent) : [])] : [];
        listCols = [...outer, ...here.items];
        listCol = here.item - from;
        listDepth = here.itemQuotes;
      };
      // #5265 — a fence line that a list marker opens (`+ >~~~`) is in that item, so a line under it indented to the item stays there.
      if (step.fenceLine && !wasOpen && here.list.some((c) => !c.quote)) enterItems(columnAfter(line.slice(0, line.length - inner.length)));
      if (step.fenceLine || wasOpen) { quoteCode = /^ {0,3}>/.test(line); prev = 'nonpara'; lrd = 0; inDefinition = false; i = end + 1; continue; }
      // An indented code block: a line of four spaces or a tab, after a blank line, the start of the text or another such line.
      const quotes = line.slice(0, line.length - inner.length);
      const from = columnAfter(quotes);
      // A tab right after a quote marker gives its first column to the marker in CommonMark; marked strips the whole tab with the marker (#5265).
      const tabAfterQuote = quotes.endsWith('>') && inner.startsWith('\t');
      // marked lexes a quote's content as a text of its own, so a line's indent inside quotes counts its tabs from column 0 (`> \t>`: code).
      const indent = model === 'marked' && tabAfterQuote
        ? columnAfter((/^[ \t]*/.exec(inner.slice(1)) as RegExpExecArray)[0])
        : model === 'marked' && from > 0
        ? columnAfter((/^[ \t]*/.exec(inner) as RegExpExecArray)[0])
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
      // #5265 — a line short of the item's indent that starts no block of marked's is the item's to marked (CommonMark may end the item
      // there: after a fence line in a quote, `- >\`\`\``), unless the item's content on the line before is blank, indented code, a fence, a
      // heading or a rule (marked's list rule, which reads that line, not a paragraph state).
      markedLazyEnd = model === 'marked' && listCol > 0 && depth === 0 && listDepth === 0 && !listedHere && inner.trim() !== '' && lineCols < listCol
        && prev !== 'blank' && !LIST_CLOSING_LINE_MARKED.test(inner) && !MARKED_LAZY_STOP.test(afterColumns(text.slice(text.lastIndexOf('\n', i - 2) + 1, i - 1).replace(/\r$/, ''), listCol))
        ? markedItemEnd(end) : -1;
      markedLazyAt = i;
      // #5265 — an item that holds a quote (`- > x`) has its content where the item's marker puts it, outside the quote it opens.
      if (listedHere) enterItems(from);
      // A quote that opens inside the item continues it when its marker sits at the item's content; leaving the item's own quote ends it.
      else if (depth > listDepth && listCol > 0 && quoteColumns(line, listDepth + 1).marker - quoteColumns(line, listDepth).content < listCol) leaveItems(quoteColumns(line, listDepth + 1).marker - quoteColumns(line, listDepth).content);
      else if (depth < listDepth) listCol = -1;
      // A line that starts another block closes the item; only a paragraph line may continue it lazily.
      else if (depth === listDepth && inner.trim() !== '' && lineCols < listCol && (prev !== 'other' || (model === 'marked' ? LIST_CLOSING_LINE_MARKED : LIST_CLOSING_LINE).test(inner))) {
        markedItemCut = model === 'marked' && prev === 'other' && depth === 0;
        leaveItems(lineCols);
      }
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
      runContext = {
        quoted: depth > 0,
        listCol: depth === listDepth && model === 'commonmark' ? listCol : -1,
        // #5265 — a bare marker's item ends at the same lines in marked (its list rule), so its content column counts here too.
        markedListCol: model !== 'marked' ? -1 : depth >= listDepth && listCol > 0 ? listCol : bareCols.length > 0 ? bareCol() : -1,
      };
      // #5265 — inside the item of a bare marker (`-`, then `  <!X>`), CommonMark counts a line's indent from the item's content column.
      const bareIn = model === 'commonmark' && listCol <= 0 && !listedHere && depth === 0 && bareCols.length > 0 && lineIndent >= bareCol();
      const codeIndent = listCol > 0 && !listedHere && depth === listDepth && lineCols >= listCol ? lineCols - listCol : bareIn ? lineIndent - bareCol() : indent;
      // #5265 — markdown-it takes a `>` indented four or more columns, right under a quote line, for that quote's marker: the line is no code to it.
      // The same under such a tab-nested empty quote (`>\t>`, then `>     >`): the indented `>` continues that quote to markdown-it.
      const miQuote = model === 'commonmark' && ((depthBefore > 0 && lineIndent >= 4 && /^[ \t]*>/.test(line)) || (prevTabNested && /^[ \t]{2,}>/.test(inner)));
      if (codeIndent >= 4 && inner.trim() !== '' && ((prev !== 'other' && prev !== 'marker') || opensQuote) && (!afterDefinition || (model === 'marked' && opensQuote)) && !(fenceCut && model === 'marked') && !miQuote) { quoteCode = depth > 0; prev = 'code'; lrd = 0; i = end + 1; continue; }
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
        prev = inner.trim() === '' || tabNested ? (prev === 'code' ? 'code' : 'blank') : label || /^ {0,3}(?:#{1,6}(?:[ \t]|$)|(?:-[ \t]*){3,}$|(?:\*[ \t]*){3,}$|(?:_[ \t]*){3,}$)/.test(inner) || (underlines && !quoteLazy && !bareLazy && (!listLazy || model === 'marked') && /^ {0,3}(?:=+|-{2,})[ \t]*$/.test(inner))
          || (underlines && !quoteLazy && !listLazy && !bareLazy && /^ {0,3}-[ \t]*$/.test(inner)) || /^ {0,3}#{1,6}(?:[ \t]|$)/.test(content) ? 'nonpara' : /^ {0,3}(?:[-+*]|\d{1,9}[.)])[ \t]*$/.test(inner)
          // After a paragraph line an empty item starts no list (it is text), but a lone `-` in a container the paragraph's line had is an item.
          ? (paraBefore && !(quoteLazy || listLazy || bareLazy) ? 'other' : 'marker')
          : prev === 'marker' && indent >= markerWidth + 4 ? 'marker' : 'other';
        // #5265 — marked's setext rule also refuses a paragraph any line of which is ` {0,3}<[^\n>]+>` (`< >`, `<b <>`, `<!>`: no HTML block to
        // marked, which tries its blocks first, so paragraph text; its lheading's `html` lookahead), and
        // the lazy lines it carries a quote on through, whose underlines it turns into text (its blockquoteSetextReplace).
        // #5265 — and a paragraph with a line indented four columns past its first one's (`x`, then `    x`): lheading's lines may not look
        // like indented code, so no `-` under it underlines (a lone `-` there is an item, and the line under it the item's).
        markedNoSetext = prev === 'other' && ((quoteLazy && prevQuoted) || (markedCarry && !quoted) || markedTextTagLine(inner) || (paraBefore && codeIndent >= 4)
          || (paraBefore && !MARKED_ORDERED_TEXT.test(inner) ? markedNoSetext : /^ {0,3}<[A-Za-z][A-Za-z0-9-]*\/(?!>)[^\n>]*>$/.test(inner) || MARKED_BULLET_HEAD.test(inner)));
        // #5265 — a lazy line of a quote's paragraph is still in the quote (CommonMark): the line after it that has no marker leaves the quote,
        // so a lone `-` there opens an item rather than continuing the paragraph.
        if (model === 'commonmark' && quoteLazy && prevBefore === 'other' && prev === 'other') prevDepth = depthBefore;
        // #5265 — an item whose first line is indented code (`-     >`: five or more spaces) records no container (containersOf), but its
        // content sits one column past the marker, as a bare marker's does: a line indented to it (`  ~~~`) is the item's, and ends with it.
        const codeItem = prev === 'other' && depth === 0 && here.list.length === 0 ? /^ {0,3}([-+*]|\d{1,9}[.)]) {5,}[^ \t\r]/.exec(inner) : null;
        if (codeItem) prev = 'marker';
        if (prev === 'marker' && indent < 4) markerWidth = codeItem ? codeItem[1].length + 1 : inner.trim().length + 1;
        // #5265 — under a marker marked reads as text (`1. `: one space or tab after it, ONE_BLANK_END), a lone marker continues that paragraph (marked takes no underline under a
        // bullet head), so it is text to marked too, whatever follows it.
        if (prev === 'marker') {
          const asText: boolean = model === 'marked' && prevBefore === 'marker' && markerText;
          markerText = asText || ONE_BLANK_END.test(inner);
        }
        // marked carries a quote on through the line after a quote line, a bare marker included: that item is the quote's (#5265).
        if (prev === 'marker' && indent < 4 && here.list.length === 0 && depth === 0 && !(model === 'marked' && depthBefore > 0 && prevQuoteText)) bareCols.push(indent + markerWidth);
      }
    }
    const c = text[i];
    if (c === '\\' && i >= rawUntil) { i += isAsciiPunct(text[i + 1]) ? 2 : 1; continue; }
    if (c === '`' && i >= rawUntil) {
      let len = 1;
      while (text[i + len] === '`') len += 1;
      // #5265 — marked's text rule takes a run of `~` and backticks as one piece of text, so a run right after a `~` opens no code span there.
      if (model === 'marked' && text[i - 1] === '~') { i += len; continue; }
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
      // #5265 — marked's paragraph is interrupted by a comment only at the line's first column: an indented one under a paragraph is inline.
      const markedInline = model === 'marked' && prevBefore === 'other' && i > 0 && text[i - 1] !== '\n';
      const wholeBlock = (): void => {
        if (!startsLine(i) || markedInline) return;
        const e = lineEndAt(i);
        if (model === 'commonmark' || e >= n || /^[ \t]*(?:\n|$)/.test(text.slice(e + 1))) raw(e);
      };
      if (text.startsWith('<!-->', i)) { wholeBlock(); i += 5; continue; }
      if (text.startsWith('<!--->', i)) { wholeBlock(); i += 6; continue; }
      const close = text.indexOf('-->', i + 4);
      if (close === -1 || close + 3 > blockLimit(i)) return { at: i, topLevelFence: false, decl: -1 };
      if (startsLine(i) && !markedInline) raw(lineEndAt(close));
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
      // #5265 — `<?>`: the browser's instruction ends at its own `>`, and marked's block at the next `?>`, which may sit lines further on.
      // Between the two everything is raw to marked and markup to a browser, so the region is raw and its tags are judged as markup.
      const markedOwn = model === 'marked' && first === i + 2 && markedRestarts(i);
      const closer = markedOwn ? text.indexOf('?>', i + 2) : text.indexOf('?>', i + 1);
      if (first === -1 || closer === -1 || (!markedOwn && (first !== closer + 1 || closer + 2 > blockLimit(i)))) return { at: i, topLevelFence: false, decl: -1 };
      if (startsLine(i) || markedOwn) raw(markedRawTo(i, closer + 2, lineEndAt(closer)));
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
    // #5265 — inside an HTML block's raw lines marked reads nothing, and a browser reads it as markup: judged below (a paragraph's raw line,
    // `paraRaw`, is marked's paragraph text, so read as above).
    if (model === 'marked' && /<![A-Za-z]+(?![A-Za-z\s])/y.test(text.slice(i, text.indexOf('\n', i) === -1 ? n : text.indexOf('\n', i) + 1)) && !markedOpens(i) && (i >= rawUntil || paraRaw)) { i += 2; continue; }
    if (text.startsWith('<!', i)) {
      const close = text.indexOf('>', i + 2);
      if (close === -1 || close + 1 > blockLimit(i)) return { at: i, topLevelFence: false, decl: -1 };
      // #5265 — a `<!` and no letter (`<!<style>`) is no declaration to Markdown, which outside an HTML block reads it as text and a `<` after
      // it as markup, where a raw reader reads comment text to the `>`: the readings disagree, so it is escaped, as `</<script>` is below.
      if (!isLetter(text[i + 2]) && i >= rawUntil && text.slice(i + 2, close).includes('<')) return { at: i, topLevelFence: false, decl: -1 };
      // marked ends such a block at the declaration's first `>` and reads the rest of the line as text (#5211); CommonMark keeps it raw.
      if (startsLine(i) && isLetter(text[i + 2]) && model === 'commonmark') raw(lineEndAt(close));
      // Inside an HTML block's raw lines (`-`, `  <b>`, then the item's lazy lines) it starts no block of its own.
      if (model === 'marked' && isLetter(text[i + 2]) && markedLineHead(i) && i >= rawUntil) {
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
        // A line marked carries a quote through (`>\t`, then `<!l>\`\`\``) is the quote's: a fence there ends with the quote, so none opens here.
        if (oneLine && opensBlock && markedHead(i) && !markedCarry && markedFenceAfter(i, close + 1)) {
          i = eol === -1 ? n : eol + 1;
          continue;
        }
        // The item check reads where this declaration sits, so it runs before the restart point moves past it.
        if (oneLine && opensBlock) markedItemAfter(i, close + 1);
        // #5265 — one that runs over lines is one block to marked up to its `>` (`<!X`, then `><n>`: no quote line), which restarts after it.
        if (!oneLine && opensBlock && markedHead(i)) raw(close + 1);
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
      // #5265 — outside an HTML block it is no tag to Markdown (an end tag needs a letter), which reads a `<` inside it as markup
      // (`</<script>`) where a raw reader reads comment text: the two readings disagree, so the `</` is escaped, after which both read the `<`.
      if (i >= rawUntil && text.slice(i + 2, close).includes('<')) return { at: i, topLevelFence: false, decl: -1 };
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
      && !(isEnd ? CM_CLOSE_TAG : CM_OPEN_TAG).test(text.slice(i, tagEnd))) {
      // Held back while no reader the tests can run shows the loss: linkedom does not model `template` (#5211, a parser waits on a ruling).
      if (!/<template(?=[\s/>]|$)/i.test(text.slice(i + 1, tagEnd))) { i += 1; continue; }
      if (notes) notes.held = true;
    }
    // A block-level tag at the head of a line (type 6), or a complete tag alone on its line that does not interrupt a paragraph (type 7),
    // starts an HTML block that runs to the next blank line.
    // #5265 — marked starts these blocks right after a CDATA or processing instruction block it ended on the line, too (where marked restarts, the line interrupts no paragraph).
    const restartHead = model === 'marked' && atMarkedHead(i, markedRestartAt);
    if (startsLine(i) || restartHead) {
      // Only its own line is taken for the block on a line marked carries a quote through: what follows is judged, the safe side.
      const blockEnd = (): number => (markedCarry && lineContainers.length === 0 ? lineEndAt(i) : inBare(i) ? bareItemEnd(i, bareCol()) : containerEnd(i, true));
      if (BLOCK6_NAMES.has(name)) raw(blockEnd());
      else if ((!TYPE1_NAMES.has(name) || (isEnd && model === 'commonmark')) && !text.slice(i, tagEnd).includes('\n') && text.slice(tagEnd, lineEndAt(tagEnd)).trim() === '' && !interrupts()) {
        raw(blockEnd());
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
      // CommonMark type 1 ends at a line holding any one of these four end tags. #5265 — marked's ends only at `</pre>` (its `</\1>`).
      const closer = model === 'marked' ? /<\/pre>/gi : /<\/(?:pre|script|style|textarea)>/gi;
      closer.lastIndex = i;
      if (!closer.test(text) || closer.lastIndex > containerEnd(i, false)) {
        // #5265 — where CommonMark finds one of its four closers and marked no `</pre>`, marked's block runs raw to the end of the text. That
        // loses no anchor (a `pre` is no raw-text element), so it is not reported: read as that block, its tags are judged as markup.
        const cmCloser = /<\/(?:pre|script|style|textarea)>/gi;
        cmCloser.lastIndex = i;
        const cmCloses = model === 'marked' && cmCloser.test(text) && cmCloser.lastIndex <= containerEnd(i, false);
        // #5265 — a top-level one may be exempt (firstUnterminated): then it is the block it is as written, raw to the end of the text.
        if (lineContainers.length === 0 && (exempt.has(i) || cmCloses)) {
          // #5265 — on a line marked carries into a list item lazily, the block is the item's and ends with it; a tag that runs past it
          // (`<pre`, then `<template>` on the next line) is cut there, and what follows the item is read.
          const itemEnd = model === 'marked' && markedLazyAt === lineFrom ? markedLazyEnd : -1;
          raw(itemEnd !== -1 ? itemEnd : n);
          i = itemEnd !== -1 && tagEnd > itemEnd ? itemEnd + 1 : tagEnd;
          continue;
        }
        // Inside a container marked's block ends with it, at or after CommonMark's closer: raw to that closer's line, the safe side.
        if (cmCloses) { raw(lineEndAt(cmCloser.lastIndex)); i = tagEnd; continue; }
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
  scansLeft = MAX_SCANS;
  try {
    return escapeWithinBudget(text);
  } catch (e) {
    if (e === SCANS_SPENT) return text.replace(/</g, '&lt;');
    throw e;
  }
}

function escapeWithinBudget(text: string): string {
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

/** Test seam: the scans the last call of escapeUnterminatedHtml ran (the one that found its budget spent counts too), so a pin bounds the work and not the wall clock. */
export const scansOfLastCallForTests = (): number => MAX_SCANS - scansLeft;
