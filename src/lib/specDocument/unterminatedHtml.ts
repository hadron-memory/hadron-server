/**
 * #5033 (cor:spc:030:02, ruling 0206; option (b), Proposed): authored text that ends in an UNTERMINATED raw-HTML construct
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

/** CommonMark HTML block type 6 (spec 0.31): the tag names that start a block (the name may be an opening or a closing tag). */
const BLOCK6 = 'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h1|h2|h3|h4|h5|h6|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';
const BLOCK6_NAMES: ReadonlySet<string> = new Set(BLOCK6.split('|'));
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

/** What a line of the text was, for the rules that depend on whether a paragraph is open. */
type LineKind = 'blank' | 'code' | 'nonpara' | 'other';

/** The index of the `<` that opens the first unterminated construct at or after `from`, or -1. */
function firstUnterminated(text: string, from: number): number {
  const n = text.length;
  let fence: OpenFence | null = null;
  let paraEnd = -1;
  // What the previous line was. 'other' is a line of a paragraph (or anything that a following line can continue); every other kind leaves
  // no paragraph open: after it a four-space line is indented code and a type 7 tag may start an HTML block. 'nonpara' is a heading (ATX, or a setext underline), a
  // thematic break, a link reference definition, a fence line or the last line of an HTML block. A line that only looks like one of these
  // is taken for it: an extra raw region means extra escaping, the safe side.
  let prev: LineKind = 'blank';
  // The kind of the line before the one being read (`prev` is already the current line's kind once its head is handled).
  let prevBefore: LineKind = 'blank';
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
  // Whether the `<` at `j` is the first non-space of its line, within three spaces of indent (where CommonMark starts an HTML block). The
  // facts of a line are found once, so a line of many constructs costs its length once, not once per construct.
  let lineFrom = -1;
  let lineTo = -2;
  let lineFirst = -1;
  const startsLine = (j: number): boolean => {
    if (j < lineFrom || j > lineTo) {
      lineFrom = text.lastIndexOf('\n', j - 1) + 1;
      const nl = text.indexOf('\n', j);
      lineTo = nl === -1 ? n : nl;
      let f = lineFrom;
      while (f < lineTo && text[f] === ' ') f += 1;
      lineFirst = f;
    }
    return j - lineFrom <= 3 && lineFirst === j;
  };
  // A tag runs to the next blank line only where it opens an HTML block (a type 6 name, or a type 1 start tag); anywhere else it is inline
  // HTML, which no block boundary lets through, even at the head of a line.
  // Inside an HTML block (types 1 to 7) Markdown reads no fence, code span, backslash escape or indented code: the lines are raw HTML, and
  // a browser reads them as markup. `rawUntil` is the end of the last such line; the scan skips the Markdown rules below it.
  let rawUntil = -1;
  // Inside an HTML block's raw region no Markdown block start applies: a construct there runs to the end of the region.
  const tagLimit = (j: number, opensBlock: boolean): number =>
    (j < rawUntil ? rawUntil : opensBlock && startsLine(j) ? blankBound(j) : inlineBound(j));
  const blockLimit = (j: number): number => (j < rawUntil ? rawUntil : startsLine(j) ? n : inlineBound(j));
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
    } else if (i === 0 || text[i - 1] === '\n') {
      // The line before was the last raw line of an HTML block: nothing is open after it.
      if (i - 1 === rawUntil) prev = 'nonpara';
      prevBefore = prev;
      const nl = text.indexOf('\n', i);
      const end = nl === -1 ? n : nl;
      const line = text.slice(i, end);
      // Block quote markers do not change what is code inside them.
      const inner = line.replace(/^ {0,3}(?:> ?)+/, '');
      const wasOpen = fence !== null;
      const step = stepFence(inner, fence);
      fence = step.open;
      if (step.fenceLine || wasOpen) { prev = 'nonpara'; i = end + 1; continue; }
      // An indented code block: a line of four spaces or a tab, after a blank line, the start of the text or another such line.
      if (/^(?: {4}|\t)/.test(inner) && inner.trim() !== '' && prev !== 'other') { prev = 'code'; i = end + 1; continue; }
      prev = inner.trim() === '' ? (prev === 'code' ? 'code' : 'blank') : /^ {0,3}(?:#{1,6}(?:[ \t]|$)|(?:[-*_][ \t]*){3,}$|=+[ \t]*$|\[[^\]]+\]:)/.test(inner) ? 'nonpara' : 'other';
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
        if (text[i + 2 + rawName.length] === '/') return rawStart;
        const end = tagEndOf(text, i, i + 2);
        if (end === -1 || end > tagLimit(i, false)) return rawStart;
        rawStart = -1;
        i = end;
      } else i += 1;
      continue;
    }
    if (text.startsWith('<!--', i)) {
      if (text.startsWith('<!-->', i)) { i += 5; continue; }
      if (text.startsWith('<!--->', i)) { i += 6; continue; }
      const close = text.indexOf('-->', i + 4);
      if (close === -1 || close + 3 > blockLimit(i)) return i;
      if (startsLine(i)) rawUntil = Math.max(rawUntil, lineEndAt(close));
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
      if (startsLine(i)) rawUntil = Math.max(rawUntil, lineEndAt(closer));
      i = first + 1;
      continue;
    }
    if (text.startsWith('<?', i)) {
      const first = text.indexOf('>', i + 2);
      const closer = text.indexOf('?>', i + 1);
      if (first === -1 || closer === -1 || first !== closer + 1 || closer + 2 > blockLimit(i)) return i;
      if (startsLine(i)) rawUntil = Math.max(rawUntil, lineEndAt(closer));
      i = first + 1;
      continue;
    }
    if (text.startsWith('<!', i)) {
      const close = text.indexOf('>', i + 2);
      if (close === -1 || close + 1 > blockLimit(i)) return i;
      if (startsLine(i) && isLetter(text[i + 2])) rawUntil = Math.max(rawUntil, lineEndAt(close));
      i = close + 1;
      continue;
    }
    const isEnd = text[i + 1] === '/';
    if (isEnd && !isLetter(text[i + 2]) && text[i + 2] !== '>') {
      // `</` and anything but a letter or `>` is a bogus comment, which runs to the next `>`.
      const close = text.indexOf('>', i + 2);
      if (close === -1 || close + 1 > tagLimit(i, false)) return i;
      i = close + 1;
      continue;
    }
    if (!isLetter(text[i + (isEnd ? 2 : 1)])) { i += 1; continue; }

    // A complete autolink is not a tag: it is inert as written.
    if (!isEnd) {
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
    // A block-level tag at the head of a line (type 6), or a complete tag alone on its line that does not interrupt a paragraph (type 7),
    // starts an HTML block that runs to the next blank line.
    if (startsLine(i)) {
      if (BLOCK6_NAMES.has(name)) rawUntil = Math.max(rawUntil, blankBound(i));
      else if (!TYPE1_NAMES.has(name) && !text.slice(i, tagEnd).includes('\n') && text.slice(tagEnd, lineEndAt(tagEnd)).trim() === '' && prevBefore !== 'other') {
        rawUntil = Math.max(rawUntil, blankBound(i));
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
        if (!literal.test(text)) return i;
        rawUntil = Math.max(rawUntil, lineEndAt(literal.lastIndex));
        const closer = new RegExp(`</${name}(?=[\\s/>])`, 'gi');
        closer.lastIndex = tagEnd;
        const m = closer.exec(text);
        if (!m) return i;
        // `</name/`: a browser ends the element there, htmlparser2 and CommonMark do not. The readers disagree on where the markup resumes,
        // so the element is left unterminated rather than guessed.
        if (text[m.index + 2 + name.length] === '/') return i;
        const end = tagEndOf(text, m.index, m.index + 2);
        if (end === -1) return i;
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
      if (!closer.test(text)) return i;
      rawUntil = Math.max(rawUntil, lineEndAt(closer.lastIndex));
    }
    i = tagEnd;
  }
  const open = [rawStart, ...templates.slice(0, 1)].filter((x) => x !== -1);
  return open.length === 0 ? -1 : Math.min(...open);
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
    const at = firstUnterminated(cur, 0);
    if (at === -1) return cur;
    // A text that keeps hiding another construct behind the one just escaped: close the question for every `<` it holds.
    if (k === MAX_RESTARTS) return cur.replace(/</g, '&lt;');
    cur = `${cur.slice(0, at)}&lt;${cur.slice(at + 1)}`;
  }
}
