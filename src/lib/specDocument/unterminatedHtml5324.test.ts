/**
 * #5324 (cor:spc:030:02, option (b), Decided): a block name at the head of a line followed by `/` and no `>` (`<div/<xmp>`) starts no HTML
 * block in any Markdown reader, so the line is paragraph text: Markdown reads `<div/` as text and emits the raw-text start after it, while a
 * browser reading the raw string takes that start for an attribute of the `div`. The start is escaped, as behind a bogus comment (#5332).
 * Each case is pinned on the scanner (`§` marks each escaped `<`) and through the readers: the authored body loses the anchor in the named
 * readers and the escaped body in none. The over-escape check: a body whose anchor already survives in every reader stays byte for byte.
 */
import * as commonmark from 'commonmark';
import { parseHTML } from 'linkedom';
import MarkdownIt from 'markdown-it';
import { marked } from 'marked';
import { describe, expect, it } from 'vitest';
import { escapeUnterminatedHtml } from './unterminatedHtml.js';

const reader = new commonmark.Parser();
const writer = new commonmark.HtmlRenderer();
const markdownIt = new MarkdownIt({ html: true });
const RENDERERS: Record<string, (md: string) => string> = {
  'commonmark.js': (md) => writer.render(reader.parse(md)),
  'markdown-it': (md) => markdownIt.render(md),
  marked: (md) => marked.parse(md, { async: false }),
};
const lives = (body: string, renderer: string): boolean => {
  const html = RENDERERS[renderer](`${body}\n\n<a id="srv-a"></a>\n\n## Heading Z\nstate`);
  const { document } = parseHTML(`<!doctype html><html><body>${html}</body></html>`);
  const el = document.getElementById('srv-a');
  return el !== null && el.tagName === 'A' && [...el.attributes].length === 1
    && el.closest('textarea,script,style,title,xmp,iframe,noembed,noframes,noscript,plaintext,template') === null
    && (document.body.textContent ?? '').includes('Heading Z');
};
const losers = (body: string) => Object.keys(RENDERERS).filter((r) => !lives(body, r));
const ALL = ['commonmark.js', 'markdown-it', 'marked'];
const CM = ['commonmark.js', 'markdown-it'];

describe('#5324 a raw-text start behind a line-head `<div/` is escaped', () => {
  it.each([
    // The body #5291 pinned as a known loss (unterminatedHtml5211.test.ts): the `<pre>` that `<!` hides opens in Markdown, then the `<xmp>`.
    ['the filed body', '-<!<pre>\n<div/§xmp>', CM],
    ['the line alone', '<div/§xmp>', ALL],
    ['after a paragraph line', 'a\n<div/§xmp>', ALL],
    ['an end tag', '</div/§xmp>', ALL],
    ['a blank after the slash', '-<!<pre>\n<div/ §xmp>', CM],
    ['another block name and raw-text element', '<table/§script>', ALL],
    ['in a list item', '- <div/§xmp>', ALL],
    ['in a quote', '> <div/§xmp>', ALL],
    // Main escapes the `<pre>` and leaves the `<xmp>`, which then loses the anchor in every reader; the authored body loses it in none.
    ['behind an escaped line-head `<pre>`', '§pre>\n<div/§xmp>', []],
  ] as Array<[string, string, string[]]>)('%s', (_label, marked_, lose) => {
    const body = marked_.replace(/§/g, '<');
    const out = escapeUnterminatedHtml(body);
    expect(out).toBe(marked_.replace(/§/g, '&lt;'));
    expect(escapeUnterminatedHtml(out)).toBe(out);
    expect(losers(body)).toEqual(lose);
    expect(losers(out)).toEqual([]);
  });

  it('over-escape check: a line-head `<div/` whose anchor survives in every reader is left byte for byte', () => {
    for (const body of [
      // A lesser tag, a raw-text element closed on the next line, an attribute, a self-closing tag.
      '<div/<b>', '<div/<xmp>\n</xmp>', '<div/x>', '<div/>\nz', '<div/ x>',
      // Inside an open HTML block, in a code span, behind a backslash, as indented code, closed past a blank.
      '<div>\n<div/<xmp>', '<div/`<xmp>`', '<div/\\<xmp>', '    <div/<xmp>', '<div/<xmp>\n\n</xmp>',
      // The fuzz body a whole-line reclassification over-escaped (the inline comment rule is stricter than the readers here).
      '<div/<!--1.x<pre><!x></script>`',
    ]) {
      expect(losers(body), body).toEqual([]);
      expect(escapeUnterminatedHtml(body), body).toBe(body);
    }
  });
});
