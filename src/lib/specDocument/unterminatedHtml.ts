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
 * What counts as a construct (an approximation of the HTML5 tokenizer plus the CommonMark HTML blocks, strict where the two
 * differ so that neither reader is left open):
 *  - a start or end tag with no closing `>` (a quote opens a value only right after `=`; an unquoted value ends at a blank);
 *  - a raw-text element (`script style textarea title xmp iframe noembed noframes noscript`) with no end tag of its own, and
 *    `plaintext`, which has none;
 *  - a `pre` that opens a line (CommonMark type 1) with none of `</pre>`, `</script>`, `</style>`, `</textarea>` after it;
 *  - a comment with no `-->`, a CDATA section with no `]]>`, a processing instruction with no `?>`, a declaration with no `>`.
 * Not read: fenced code, indented code, inline code spans and a backslash-escaped `<` (Markdown shows those as text, and a
 * character reference is not decoded inside code, so escaping there would change what a code sample shows). A four-space
 * continuation of a list item is read as indented code, so an unterminated construct in one is left as written.
 *
 * Cost: one linear scan per escape. Each escape restarts the scan just after the `<` it escaped (a construct that was open
 * may have hidden a second one), at most {@link MAX_RESTARTS} times; a text that needs more has every remaining `<` escaped.
 */
import { stepFence, type OpenFence } from './fences.js';

/** Elements whose content is text up to their own end tag. */
const RAW_TEXT = new Set(['script', 'style', 'textarea', 'title', 'xmp', 'iframe', 'noembed', 'noframes', 'noscript']);
/** CommonMark HTML block type 1 ends at a line holding any one of these. */
const BLOCK_ONE_CLOSE = /<\/(?:pre|script|style|textarea)>/gi;
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

/** The index of the `<` that opens the first unterminated construct at or after `from`, or -1. */
function firstUnterminated(text: string, from: number): number {
  const n = text.length;
  let fence: OpenFence | null = null;
  let paraEnd = -1;
  // What the previous line was, for indented code: after a blank line (or at the start) a four-space line is code, after text it continues the paragraph.
  let prev: 'blank' | 'code' | 'other' = 'blank';
  // A backtick run of length N that found no closer in its paragraph: no later run of N in the same paragraph has one either.
  const noCloser = new Map<number, number>();
  let i = from;
  while (i < n) {
    if (i === 0 || text[i - 1] === '\n') {
      const nl = text.indexOf('\n', i);
      const end = nl === -1 ? n : nl;
      const line = text.slice(i, end);
      const wasOpen = fence !== null;
      const step = stepFence(line, fence);
      fence = step.open;
      if (step.fenceLine || wasOpen) { prev = 'other'; i = end + 1; continue; }
      // An indented code block: a line of four spaces or a tab, after a blank line, the start of the text or another such line.
      if (/^(?: {4}|\t)/.test(line) && line.trim() !== '' && prev !== 'other') { prev = 'code'; i = end + 1; continue; }
      prev = line.trim() === '' ? (prev === 'code' ? 'code' : 'blank') : 'other';
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

    if (text.startsWith('<!--', i)) {
      if (text.startsWith('<!-->', i)) { i += 5; continue; }
      if (text.startsWith('<!--->', i)) { i += 6; continue; }
      const close = text.indexOf('-->', i + 4);
      if (close === -1) return i;
      i = close + 3;
      continue;
    }
    if (text.startsWith('<![CDATA[', i)) {
      const close = text.indexOf(']]>', i + 9);
      if (close === -1) return i;
      i = close + 3;
      continue;
    }
    if (text.startsWith('<?', i)) {
      const close = text.indexOf('?>', i + 2);
      if (close === -1) return i;
      i = close + 2;
      continue;
    }
    if (text.startsWith('<!', i)) {
      const close = text.indexOf('>', i + 2);
      if (close === -1) return i;
      i = close + 1;
      continue;
    }
    const isEnd = text[i + 1] === '/';
    if (!isLetter(text[i + (isEnd ? 2 : 1)])) { i += 1; continue; }

    // A start or end tag: the name, then attributes up to the `>` outside a quoted value.
    let p = i + (isEnd ? 2 : 1);
    const nameStart = p;
    while (p < n && !isBlank(text[p]) && text[p] !== '/' && text[p] !== '>') p += 1;
    const name = text.slice(nameStart, p).toLowerCase();
    let tagEnd = -1;
    while (p < n) {
      const ch = text[p];
      if (ch === '>') { tagEnd = p + 1; break; }
      if (ch === '=') {
        p += 1;
        while (p < n && isBlank(text[p])) p += 1;
        const q = text[p];
        if (q === '"' || q === "'") {
          // An unclosed value takes the rest of the text, so no `>` ends the tag below.
          const close = text.indexOf(q, p + 1);
          p = close === -1 ? n : close + 1;
        } else {
          while (p < n && !isBlank(text[p]) && text[p] !== '>') p += 1;
        }
        continue;
      }
      p += 1;
    }
    if (tagEnd === -1) return i;
    if (isEnd) { i = tagEnd; continue; }

    if (name === 'plaintext') return i;
    if (RAW_TEXT.has(name)) {
      const closer = new RegExp(`</${name}(?=[\\s/>])`, 'gi');
      closer.lastIndex = tagEnd;
      const m = closer.exec(text);
      if (!m) return i;
      i = m.index;
      continue;
    }
    if (name === 'pre') {
      // CommonMark type 1 only starts a block at the head of a line (up to three spaces of indent).
      const lineStart = text.lastIndexOf('\n', i - 1) + 1;
      if (i - lineStart <= 3 && /^ *$/.test(text.slice(lineStart, i))) {
        BLOCK_ONE_CLOSE.lastIndex = i;
        if (!BLOCK_ONE_CLOSE.test(text)) return i;
      }
    }
    i = tagEnd;
  }
  return -1;
}

/** `text` with the opening `<` of every unterminated raw-HTML construct written as `&lt;`; the same string when there is none. */
export function escapeUnterminatedHtml(text: string): string {
  if (!text.includes('<')) return text;
  let out = '';
  let copied = 0;
  let from = 0;
  for (let k = 0; k <= MAX_RESTARTS; k += 1) {
    const at = firstUnterminated(text, from);
    if (at === -1) return copied === 0 ? text : out + text.slice(copied);
    if (k === MAX_RESTARTS) {
      // A text that keeps hiding another construct behind the one just escaped: close the question for all that is left.
      return `${out}${text.slice(copied, at)}${text.slice(at).replace(/</g, '&lt;')}`;
    }
    out += `${text.slice(copied, at)}&lt;`;
    copied = at + 1;
    from = at + 1;
  }
  return text;
}
