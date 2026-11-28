/**
 * #5384 (cor:spc:030:02, option (b), Decided): a bare `<![` (not `<![CDATA[`) is paragraph text to every Markdown reader. It is no HTML block
 * start (type 5 needs `<![CDATA[`) and no inline HTML, so the readers write it escaped and read on, and a raw-text start after it opens as it
 * would without it (after a blank line, an HTML block; on a later paragraph line, inline HTML). The walk used to read the `<![` as a browser's
 * bogus comment up to its first `>`, the `>` of that raw-text start, and so left the start as written; the next part's anchor was lost.
 *
 * Each body goes through the pass, the server's own block follows it, a Markdown reader makes HTML of the whole string, and both linkedom and
 * parse5 read that: the anchor is lost in a reader when either finds no live `<a id>` with nothing but its id, or the heading's text is gone.
 */
import * as commonmark from 'commonmark';
import { parseHTML } from 'linkedom';
import MarkdownIt from 'markdown-it';
import { marked } from 'marked';
import { parse } from 'parse5';
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
const NAMES = Object.keys(RENDERERS);
const RAW = new Set(['textarea', 'script', 'style', 'title', 'xmp', 'iframe', 'noembed', 'noframes', 'noscript', 'plaintext']);
// linkedom has no template content of its own, so the anchor inside a `template` counts as not live there as it does in raw text.
const RAW_SELECTOR = [...RAW, 'template'].join(',');

interface TreeNode { nodeName: string; tagName?: string; value?: string; attrs?: { name: string; value: string }[]; childNodes?: TreeNode[]; content?: TreeNode }
/** The anchor in parse5's tree, and whether it is live (not in raw text, not in a template's content). */
function locate(node: TreeNode, inRaw: boolean, inTemplate: boolean): { el: TreeNode; live: boolean } | null {
  for (const child of [...(node.childNodes ?? []), ...(node.content ? [node.content] : [])]) {
    const intoTemplate = inTemplate || child === node.content;
    if (child.attrs?.some((a) => a.name === 'id' && a.value === 'srv-a')) return { el: child, live: !intoTemplate && !inRaw };
    const found = locate(child, inRaw || RAW.has(child.tagName ?? ''), intoTemplate);
    if (found) return found;
  }
  return null;
}
const shownText = (node: TreeNode): string => (node.childNodes ?? []).map((c) => (c.nodeName === '#text' ? c.value ?? '' : shownText(c))).join('');

function lives(body: string, renderer: string): boolean {
  const html = RENDERERS[renderer](`${body}\n\n<a id="srv-a"></a>\n\n## Heading Z\nstate`);
  const page = `<!doctype html><html><body>${html}</body></html>`;
  const { document } = parseHTML(page);
  const el = document.getElementById('srv-a');
  const linkedomLives = el !== null && el.tagName === 'A' && [...el.attributes].length === 1 && el.closest(RAW_SELECTOR) === null
    && (document.body.textContent ?? '').includes('Heading Z');
  const tree = parse(page) as unknown as TreeNode;
  const found = locate(tree, false, false);
  const parse5Lives = found !== null && found.live && found.el.tagName === 'a' && found.el.attrs?.length === 1 && shownText(tree).includes('Heading Z');
  return linkedomLives && parse5Lives;
}
const losers = (body: string): string[] => NAMES.filter((r) => !lives(body, r));

describe('#5384 a raw-text start behind a bare `<![` is escaped', () => {
  // [label, the body with `§` marking each `<` the pass escapes]. Main leaves each as written and loses the anchor in every reader.
  it.each([
    // The five bodies the issue filed.
    ['a style after a blank line', '<![\n\n§<style>'],
    ['a plaintext after a blank line', '<![\n\n§<plaintext>'],
    ['a script, the `<![` with text after it', '<![x\n\n§<script>'],
    ['a title on the next paragraph line, a tag after it', '\n<![\n§<title><p>'],
    ['an xmp after an indented line', '<![1.\n    x\n§<xmp>'],
    // The same reading with more between: a later paragraph line, a second `<![`, a textarea.
    ['a textarea two lines on', '<![\nx\n§<textarea>'],
    // #5473: a `template` after a blank line (the regex lists it; parse5 puts what follows into its content, so it is lost as raw text is).
    ['a template after a blank line', '<![\n\n§<template>'],
    ['a second bare `<![` on its own line', '<![\n<![\n\n§<style>'],
    // A `<![` within a line whose `>` lies past the paragraph is escaped as any such `<!` is (main's rule), with the start after it.
    ['a second bare `<![` within the line', '<![ §<![\n\n§<style>'],
  ] as Array<[string, string]>)('%s', (_label, template) => {
    const body = template.replace(/§/g, '');
    const out = escapeUnterminatedHtml(body);
    expect(out).toBe(template.replace(/§</g, '&lt;'));
    expect(escapeUnterminatedHtml(out)).toBe(out);
    expect(losers(body)).toEqual(NAMES);
    expect(losers(out)).toEqual([]);
  });

  it('the controls the issue filed escape as before', () => {
    for (const [body, out] of [
      ['x\n\n<style>', 'x\n\n&lt;style>'],
      ['<![CDATA[\n\n<style>', '&lt;![CDATA[\n\n&lt;style>'],
      ['<![\n<title>', '<![\n&lt;title>'],
    ]) {
      expect(losers(body), body).toEqual(NAMES);
      expect(escapeUnterminatedHtml(body), body).toBe(out);
      expect(losers(out), body).toEqual([]);
    }
  });

  it('a `<![` with no `>` in reach is still escaped: marked keeps the lines after a line-head `<?>` raw, where it is a bogus comment', () => {
    // marked reads `<?>` as a processing instruction with no `?>`, which holds the rest of the text as raw HTML; a browser then reads the `<![`
    // as a bogus comment up to the anchor's own `>`. Main escapes the `<![`, which keeps the anchor; reading past it would not (fuzz at f27a59aa).
    const body = '-\n<?>--- a\n<![CDATA<x\n\t\n<!';
    expect(losers(body)).toEqual(['marked']);
    const out = escapeUnterminatedHtml(body);
    expect(out).toBe('-\n<?>--- a\n&lt;![CDATA&lt;x\n\t\n&lt;!');
    expect(losers(out)).toEqual([]);
  });

  it('the walk reads past a `<![` only when the `>` it would jump to ends a raw-text start at a line head', () => {
    // Reading past any bare `<![` exposed what the jump used to hide, and the later constructs then met escapes of their own that lose the
    // anchor where main kept it (fuzz at f27a59aa: 87 regressing pairs). Each body below is left as main leaves it. With the `<![` replaced by
    // plain text, the body as written loses the same readers (and main's own escape of it loses more), so those losses belong to other classes,
    // not to this one.
    for (const [body, lost] of [
      // A `<?` on the next line (a processing instruction to CommonMark and markdown-it), and no raw-text start at a line head.
      ['<![\n<?<<!>\t> q\n</ ``<title>\n\n<script><b</script>', ['marked']],
      // A start indented four columns in a list item: not a line-head start.
      ['\n\n\n1.    --<![\n    <script></<\n\t- - -    <title>', ['commonmark.js']],
    ] as Array<[string, string[]]>) {
      expect(losers(body), body).toEqual(lost);
      expect(escapeUnterminatedHtml(body), body).toBe(body);
    }
  });

  it('over-escape check: a body whose anchor survives in every reader is left byte for byte', () => {
    for (const body of [
      // A `<![` whose `>` is its own; one with a `]]>` and no raw-text start after it.
      '<![>', '<![ a ]]>\n\n<b>',
      // Inside an HTML block's raw lines a browser reads the `<![` as a bogus comment: the raw-text start it holds is hidden there.
      '<div>\n<![<style>\n', '<div>\n<![\n<style>\n',
      // A declaration (`<!` and a letter) is an HTML block that its `>` ends, in Markdown and in a browser: the start it holds is hidden in both.
      '<!x\n<style>', '<!DOCTYPE x\n<style>\n',
    ]) {
      expect(losers(body), body).toEqual([]);
      expect(escapeUnterminatedHtml(body), body).toBe(body);
    }
  });
});
