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
 *    (CDATA and a processing instruction end for the browser at the first `>`, which is where the scan goes on).
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

/** The end of the paragraph that holds `i`: the next blank line, or the end of the text. */
function paragraphEnd(text: string, i: number): number {
  const re = /\n[ \t]*\n/g;
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

/** True when the `<` at `i` is the first non-space of its line, within three spaces of indent (where CommonMark starts an HTML block). */
function startsLine(text: string, i: number): boolean {
  const lineStart = text.lastIndexOf('\n', i - 1) + 1;
  return i - lineStart <= 3 && /^ *$/.test(text.slice(lineStart, i));
}

/** The index of the `<` that opens the first unterminated construct at or after `from`, or -1. */
function firstUnterminated(text: string, from: number): number {
  const n = text.length;
  let fence: OpenFence | null = null;
  let paraEnd = -1;
  // What the previous line was, for indented code: after a blank line (or at the start) a four-space line is code, after text it continues the paragraph.
  let prev: 'blank' | 'code' | 'other' = 'blank';
  // A raw-text element opened in the middle of a line is inline HTML: Markdown goes on parsing after it, so only an end tag
  // that Markdown also reads as HTML (outside code, a fence and a backslash escape) closes it. -1 when none is open.
  let rawStart = -1;
  let rawName = '';
  // Open `<template>` elements: their content is tokenized as usual, but the anchor of the next block would sit in the inert content.
  const templates: number[] = [];
  // A backtick run of length N that found no closer in its paragraph: no later run of N in the same paragraph has one either.
  const noCloser = new Map<number, number>();
  let i = from;
  while (i < n) {
    if (i === 0 || text[i - 1] === '\n') {
      const nl = text.indexOf('\n', i);
      const end = nl === -1 ? n : nl;
      const line = text.slice(i, end);
      // Block quote markers do not change what is code inside them.
      const inner = line.replace(/^ {0,3}(?:> ?)+/, '');
      const wasOpen = fence !== null;
      const step = stepFence(inner, fence);
      fence = step.open;
      if (step.fenceLine || wasOpen) { prev = 'other'; i = end + 1; continue; }
      // An indented code block: a line of four spaces or a tab, after a blank line, the start of the text or another such line.
      if (/^(?: {4}|\t)/.test(inner) && inner.trim() !== '' && prev !== 'other') { prev = 'code'; i = end + 1; continue; }
      prev = inner.trim() === '' ? (prev === 'code' ? 'code' : 'blank') : 'other';
    }
    const c = text[i];
    if (c === '\\') { i += isAsciiPunct(text[i + 1]) ? 2 : 1; continue; }
    if (c === '`') {
      let len = 1;
      while (text[i + len] === '`') len += 1;
      if (i >= paraEnd) paraEnd = paragraphEnd(text, i);
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
      if (text[i + 1] === '/' && text.slice(i + 2, i + 2 + rawName.length).toLowerCase() === rawName && /[\s>]/.test(text[i + 2 + rawName.length] ?? 'x')) {
        const end = tagEndOf(text, i, i + 2);
        if (end === -1) return rawStart;
        rawStart = -1;
        i = end;
      } else i += 1;
      continue;
    }
    if (text.startsWith('<!--', i)) {
      if (text.startsWith('<!-->', i)) { i += 5; continue; }
      if (text.startsWith('<!--->', i)) { i += 6; continue; }
      const close = text.indexOf('-->', i + 4);
      if (close === -1) return i;
      i = close + 3;
      continue;
    }
    // CDATA and a processing instruction: Markdown ends the block at `]]>` / `?>` (both must be there), but the browser reads
    // either as a bogus comment that ends at the FIRST `>`, so the scan goes on from there.
    if (text.startsWith('<![CDATA[', i)) {
      const first = text.indexOf('>', i + 2);
      if (first === -1 || text.indexOf(']]>', i + 9) === -1) return i;
      i = first + 1;
      continue;
    }
    if (text.startsWith('<?', i)) {
      const first = text.indexOf('>', i + 2);
      if (first === -1 || text.indexOf('?>', i + 1) === -1) return i;
      i = first + 1;
      continue;
    }
    if (text.startsWith('<!', i)) {
      const close = text.indexOf('>', i + 2);
      if (close === -1) return i;
      i = close + 1;
      continue;
    }
    const isEnd = text[i + 1] === '/';
    if (isEnd && !isLetter(text[i + 2]) && text[i + 2] !== '>') {
      // `</` and anything but a letter or `>` is a bogus comment, which runs to the next `>`.
      const close = text.indexOf('>', i + 2);
      if (close === -1) return i;
      i = close + 1;
      continue;
    }
    if (!isLetter(text[i + (isEnd ? 2 : 1)])) { i += 1; continue; }

    // A start or end tag: the name, then attributes up to the `>` outside a quoted value.
    const nameStart = i + (isEnd ? 2 : 1);
    const tagEnd = tagEndOf(text, i, nameStart);
    if (tagEnd === -1) return i;
    let nameEnd = nameStart;
    while (nameEnd < n && !isBlank(text[nameEnd]) && text[nameEnd] !== '/' && text[nameEnd] !== '>') nameEnd += 1;
    const name = text.slice(nameStart, nameEnd).toLowerCase();
    if (isEnd) {
      if (name === 'template') templates.pop();
      i = tagEnd;
      continue;
    }
    if (name === 'template') templates.push(i);

    if (name === 'plaintext') return i;
    if (RAW_TEXT.has(name)) {
      if (startsLine(text, i) && (name === 'script' || name === 'style' || name === 'textarea')) {
        // CommonMark type 1: the block runs raw to the first line that holds an end tag, code or not.
        const closer = new RegExp(`</${name}(?=[\\s>])`, 'gi');
        closer.lastIndex = tagEnd;
        const m = closer.exec(text);
        if (!m) return i;
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
    if (name === 'pre' && startsLine(text, i)) {
      // CommonMark type 1 ends at a line holding any one of these four end tags.
      const closer = /<\/(?:pre|script|style|textarea)>/gi;
      closer.lastIndex = i;
      if (!closer.test(text)) return i;
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
