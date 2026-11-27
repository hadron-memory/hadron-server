/**
 * #5332 (cor:spc:030:02, option (b)): a raw-text start hidden behind a bare `<!` or `</`, and marked's tab after a quote marker. Markdown reads
 * a `<!` or `</` with no letter after it as text and emits the tag before the `>` raw (`<!<script>` emits `<script>`); a browser reading the raw
 * string ends a bogus comment at that `>`. marked strips the whole tab after a quote marker, where CommonMark gives the marker one column of it.
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

describe('#5332: the bodies it fixes', () => {
  // [label, the body with `§` marking each `<` the pass escapes, the readers that lose the anchor as authored]. Main leaves each as written
  // (or, for the `<pre=` one, escapes only its first `<`), and loses the anchor in the same readers.
  it.each([
    ['a raw-text element behind `<!`', '> x<!§script>', ALL],
    ['behind `</`, twice', '>>r</§script>\n</§script>', ['commonmark.js', 'markdown-it']],
    ['on the next line', '>></§script><!\n    §script>', ['commonmark.js', 'markdown-it']],
    ['marked strips the whole tab after a quote marker', '1.        \n>\t  > > <b y= §script>\n\n  >   > ', ['marked']],
    ['#5033\'s pin: `</==\'<plaintext>` is a bogus comment to a browser, text to Markdown', "§pre=</=='§plaintext>\n", ALL],
    ['a plaintext element is never closed by a later end tag', 'x<!§plaintext>\n</plaintext>', ALL],
  ] as Array<[string, string, string[]]>)('%s', (_label, marked_, lose) => {
    const body = marked_.replace(/§/g, '<');
    const out = escapeUnterminatedHtml(body);
    expect(out).toBe(marked_.replace(/§/g, '&lt;'));
    expect(escapeUnterminatedHtml(out)).toBe(out);
    expect(losers(body)).toEqual(lose);
    expect(losers(out)).toEqual([]);
  });
});

describe('#5332: bodies left as written, kept by every reader', () => {
  it.each([
    // The keep body of the issue: CommonMark's tab model reads `<pre>` as a type 1 block that ends with the quote, which holds the `<!<script>`.
    '   >\t <pre><!<script>',
    // An unterminated `<pre>` in a quote that ends at a blank line or the end of the text ends with the quote (main escapes it; the second
    // loses the anchor on main in every reader, since the escaped `<pre>` lets Markdown emit the `<script>`).
    '> <pre>', '> <pre><!<script>\n\nb', '> a <pre>\n',
    // A hidden tag closed later by its own end tag, one Markdown does not accept as a tag, and a `<!` with a letter after it (a declaration).
    'x<!<script>\n</script>', 'x<!<script x=`>', '<!x <script>',
    // Inside an HTML block a browser's bogus comment is the only reading (Bradley, LOCAL at 8dd599df on #5291).
    '<x>\n```</<xmp>', '<div>\n</<script>',
  ])('%j', (body) => {
    expect(escapeUnterminatedHtml(body)).toBe(body);
    expect(losers(body)).toEqual([]);
  });
});

describe('#5332: what the rule leaves to main', () => {
  // [body, the pass's output (main's too), the readers that lose the anchor with it, which are the same on main].
  it.each([
    // In a list item an unterminated `<pre>` is escaped as on main: marked ends a list's HTML block elsewhere.
    ['- <pre>', '- &lt;pre>', []],
    // markdown-it carries the quote on through the lazy indented line, so the `<pre>` block would hold the `<textarea>`.
    ['> <pre>\n    ><textarea>', '> &lt;pre>\n    >&lt;textarea>', []],
    // Every reader breaks a line at a bare CR, which the walk does not: the quote ends at the CR.
    ['> <pre>\n> x\r<textarea>', '> &lt;pre>\n> x\r&lt;textarea>', []],
    ['\r<!--\r- \n><pre><![CDATA[x\r    ]]><scr# h\n', '\r&lt;!--\r- \n>&lt;pre><![CDATA[x\r    ]]>&lt;scr# h\n', []],
    // A hidden tag at the head of a line with a tag after it: markdown-it reads the line as an HTML block start where CommonMark reads it as
    // paragraph text (or code), so escaping it would move the later tag into another block (both lost the anchor where escaped).
    ['\n\n\n1.    --<![\n    <script></<\n\t- - -    <title>', '\n\n\n1.    --<![\n    <script></<\n\t- - -    <title>', ['commonmark.js']],
    ['\n   >\t> </ \n    <textarea><!</<plaintext>', '\n   >\t> </ \n    <textarea><!</<plaintext>', ['commonmark.js', 'marked']],
    ['<!x\r<script>- - -<!\r<script><?<\r```<p- ', '<!x\r<script>- - -<!\r<script>&lt;?<\r```&lt;p- ', ['marked']],
    ['<!x- a\n\n<!T><!\r<plaintext>\r<script><!<<style>', '<!x- a\n\n<!T><!\r<plaintext>\r&lt;script><!<<style>', ['marked']],
    // Before the tag, something Markdown could read another way (a backtick, a backslash), or more than one line break.
    ['x<!` <script>', 'x<!` <script>', ALL], ['x<!\\ <script>', 'x<!\\ <script>', ALL], ['x<! a\nb\nc <script>', 'x<! a\nb\nc <script>', ALL],
    // A tag broken across lines (escaping it measured more bodies over-escaped than fixed, #5332's harness).
    ['x<!<script\na>', 'x<!<script\na>', ALL],
  ] as Array<[string, string, string[]]>)('%j', (body, out, lose) => {
    expect(escapeUnterminatedHtml(body)).toBe(out);
    expect(losers(out)).toEqual(lose);
  });
});

describe('#5332: the acceptance set keeps every reader main keeps', () => {
  // [body, the pass's output, the readers that lose the anchor with it, the readers that lose it with main's output]: Charles's repros and
  // the bodies variant A of #5291 regressed. No reader that keeps the anchor on main loses it here.
  it.each([
    ['-*-\n    <xmp>\n<!</xmp>', '-*-\n    <xmp>\n<!</xmp>', [], []],
    ['<??><!<xmp>\n<!</xmp>', '<??><!<xmp>\n<!</xmp>', [], []],
    ['<!<xmp><pre></xmp></<template>', '<!<xmp><pre></xmp></<template>', ['commonmark.js', 'markdown-it'], ['commonmark.js', 'markdown-it']],
    ['</<noembed><pre></<template>', '</&lt;noembed><pre></<template>', ['commonmark.js', 'markdown-it'], ALL],
    ['<!<iframE><h1></<template>', '<!&lt;iframE><h1></<template>', ALL, ALL],
    ['</<noscript><div></<template>', '</&lt;noscript><div></<template>', ALL, ALL],
    // #5324: the `<noscript>` behind the line-head `<div/` is escaped too, and no reader loses the anchor (main's output loses it in all).
    ['<b&lt;\t<![<iframe>`<div>\n<div/<noscript><?>', '<b&lt;\t<![&lt;iframe>`<div>\n<div/&lt;noscript><?>', [], ALL],
    ['<!</xmp><![CDATA[x<!<plaintext><!T>--<div></ <template><b', '<!</xmp>&lt;![CDATA[x<!&lt;plaintext><!T>--<div></ <template>&lt;b', ALL, ALL],
    ['<ba</ <noembed><pre><div/<template>', '&lt;ba</ &lt;noembed><pre><div/&lt;template>', [], ALL],
    ['--><!<plaintext>a<pre><x*-*- <template># h', '--><!&lt;plaintext>a<pre><x*-*- &lt;template># h', [], ALL],
    // #5388 (QA): the line-head `<noscript>` has more on its line, so no reader opens a block there and it is escaped too; losses unchanged.
    ['- - -<![\n<noscript><noscript><![\n    <!--<![CDATA[]]>\r\n`', '- - -<![\n&lt;noscript>&lt;noscript><![\n    <!--<![CDATA[]]>\r\n`', ALL, ALL],
    ['<!--<!<noembed><![CDATA[]]>\n<!DOCTYPE html><h1></<<template>>\n', '&lt;!--<!&lt;noembed><![CDATA[]]>\n<!DOCTYPE html><h1></<<template>>\n', ['marked'], ALL],
    ['<title></ <noembed><div/> - \n  </div><a<![<![CDATA[x<noembed>', '&lt;title></ &lt;noembed><div/> - \n  </div>&lt;a<![<![CDATA[x<noembed>', ['marked'], ALL],
  ] as Array<[string, string, string[], string[]]>)('%j', (body, out, lose, mainLose) => {
    expect(escapeUnterminatedHtml(body)).toBe(out);
    expect(losers(out)).toEqual(lose);
    expect(lose.every((r) => mainLose.includes(r))).toBe(true);
  });
});
