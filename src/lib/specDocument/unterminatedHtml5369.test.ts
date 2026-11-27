/**
 * #5369 (cor:spc:030:02, option (b)): #5332's rule escapes a raw-text start hidden behind a bare `<!` or `</` where Markdown emits it raw.
 * Where every reader has the spot inside an HTML block, Markdown passes the bogus comment through and the browser reads it, so the hidden tag is
 * inert and the escape was an over-escape (display only): the walk had read the spot as paragraph text, mostly because an earlier bogus comment
 * or construct had carried it past the line that opens the block. And (#5370's BLIND P2b) a later end tag of the same name suppressed the
 * escape even where a reader holds that end tag in code: now only an end tag every reader emits raw counts.
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
const ALL = NAMES;
const RAW_SELECTOR = 'textarea,script,style,title,xmp,iframe,noembed,noframes,noscript,plaintext,template';
const RAW = new Set(['textarea', 'script', 'style', 'title', 'xmp', 'iframe', 'noembed', 'noframes', 'noscript', 'plaintext']);

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


describe('#5369: a hidden tag inside an HTML block is left as written (main escaped each; every reader keeps it as written)', () => {
  it.each([
    // A column-0 type 6 opener the walk passed inside the bogus comment `<!- a\n<div>`, with no blank line after it.
    ['type 6, opener hidden from the walk', '<!- a\n<div>\n<!<style>'],
    // A bare CR ends a line for the readers: `<div>` opens a type 6 block.
    ['type 6 after a bare CR', '\r<div><!<style>'],
    // Types 1 to 5 at column 0, up to where every reader ends them.
    ['type 2, its closer on the opener line', '<!---><!<style>\n-'],
    ['type 4 on the line after a type 2', '<!--->\n<!x<!<title>'],
    ['type 3, held to its `?>`', '<![/<![CDATA[\n\n<?<textarea></div><!<style><!</xmp>-\n-\n'],
    ['type 4 after a type 3 that closed on its own line', '<!</ \n\n<?>`/<!DOCTYPE html>    <![<plaintext>'],
  ])('%s: %j', (_label, body) => {
    expect(escapeUnterminatedHtml(body)).toBe(body);
    expect(losers(body)).toEqual([]);
  });
});

describe('#5369: what keeps the escape (each body is escaped as on main, and lost as written)', () => {
  // [label, body with `§` at each `<` the pass escapes, the readers that lose the anchor as written].
  it.each([
    // The `<div>` line sits in a fence, so it opens no block (CommonMark loses the anchor if the escape goes).
    ['an opener inside a fence', '  ~~~\n<div>\n  ~~~\n<x y=  >\t\n</§noembed>', ALL],
    // The `<div>` line sits in a type 4 block that ends at its `>`, so the hidden tag is paragraph text.
    ['an opener inside a type 1 to 5 block', '<!x- a\n<div>\n<!§style>]]>', ALL],
    // `<?>` ends a type 3 block at once for CommonMark and markdown-it, which then read the hidden tag in a list item.
    ['a closer only some readers see', '<?>- a\n<!§style>', ['commonmark.js', 'markdown-it']],
    ['a blank line ends a type 6 block', '<div>\n\n<!§style>', ALL],
    // marked reads a paragraph line, an opener line holding more than its tag and a `-` line as one setext heading.
    ['an opener line after a paragraph line, under a setext underline', '<!DOCTYPE html>&lt;b y="\r<div>> <!§style>\n-', ['marked']],
    // Judged where the hidden tag stands, not where the bogus comment opens: `<div></ <iframe>` holds more than its tag.
    ['judged at the hidden tag', '<!<<script\\\r<div></ §iframe>* \r- ', ['marked']],
  ] as Array<[string, string, string[]]>)('%s: %j', (_label, marked_, lose) => {
    const body = marked_.replace(/§/g, '<');
    const out = escapeUnterminatedHtml(body);
    expect(out).toBe(marked_.replace(/§/g, '&lt;'));
    expect(escapeUnterminatedHtml(out)).toBe(out);
    expect(losers(body)).toEqual(lose);
    expect(losers(out)).toEqual([]);
  });
});

describe('#5369 (P2b): only an end tag every reader emits raw closes the hidden element', () => {
  // Main left each as written (the later `</script>` suppressed the escape) and lost the anchor in every reader.
  it.each([
    ['in indented code', 'x<!§script>\n\n    </script>'],
    ['in a fence', 'x<!§script>\n```\n</script>\n```'],
    ['in a tilde fence (no backtick run to pair)', 'x<!§script>\n~~~\n</script>\n~~~'],
    ['in a code span', 'x<!§script> `</script>`'],
    ['after a backslash', 'x<!§script> \\</script>'],
  ])('%s: %j', (_label, marked_) => {
    const body = marked_.replace(/§/g, '<');
    const out = escapeUnterminatedHtml(body);
    expect(out).toBe(marked_.replace(/§/g, '&lt;'));
    expect(losers(body)).toEqual(ALL);
    expect(losers(out)).toEqual([]);
  });

  it.each([
    'x<!<script>\n</script>',
    // A backtick run no run of its length after the end tag closes: no code span holds it.
    'x<!<script> ``a`</script>',
  ])('an end tag emitted raw still closes it: %j', (body) => {
    expect(escapeUnterminatedHtml(body)).toBe(body);
    expect(losers(body)).toEqual([]);
  });
});
