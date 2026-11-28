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
import { escapeUnterminatedHtml, scansOfLastCallForTests } from './unterminatedHtml.js';

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
    // #5388 BLIND P2-2: a link destination, a link title and a reference definition hold it as text.
    ['in a link destination', 'x<!§script> [a](</script>)'],
    ['in a link title', 'x<!§script> [a](x "</script>")'],
    ['in a reference definition', 'x<!§script>\n\n[r]: </script>'],
    // #5388 BLIND P2-3: four columns past stacked list and quote markers make the line code.
    ['indented code after a list and a quote marker', 'x<!§script>\n\n- >     </script>'],
    ['indented code after two list markers', 'x<!§script>\n\n- -     </script>'],
  ])('%s: %j', (_label, marked_) => {
    const body = marked_.replace(/§/g, '<');
    const out = escapeUnterminatedHtml(body);
    expect(out).toBe(marked_.replace(/§/g, '&lt;'));
    expect(losers(body)).toEqual(ALL);
    expect(losers(out)).toEqual([]);
  });

  // #5388 BLIND P2-1: a line end before the `>` is not a tag Markdown accepts (the `>` line opens a quote), so it is not counted. Already
  // escaped at 03b8073f, where the rule for a tag that crosses into a quote line escaped the end tag itself and the rescan then the hidden one.
  it.each([
    ['a line end before its `>`', 'x<!§script>\n§/script\n>'],
    ['a CRLF before its `>`', 'x<!§script>\r\n§/script\r\n>'],
    // BLIND P2-1 at a6d5bdfb: the only end tag in the text, on the hidden tag's own line.
    ['the only candidate, a line end before its `>`', 'x<!§script>a§/script\n>'],
    ['the only candidate, a CRLF before its `>`', 'x<!§style>§/style\r\n>'],
  ])('an end tag that crosses a line does not close it, %s: %j', (_label, marked_) => {
    const body = marked_.replace(/§/g, '<');
    expect(escapeUnterminatedHtml(body)).toBe(marked_.replace(/§/g, '&lt;'));
    expect(losers(body)).toEqual(ALL);
    expect(losers(escapeUnterminatedHtml(body))).toEqual([]);
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

describe('#5369 (#5388 LOCAL P3): a type 1 to 5 block counts only when it opens at column 0 after no paragraph line', () => {
  // Each line that looks like an opener sits where some reader holds it as text (after a paragraph line, or as a list item's content).
  it.each([
    ['after a paragraph line ending in a bare CR', '\\\r<!x<!§style>', ['marked']],
    ['after a type 1 opener line', '§script>\n<!x<!§style>', ALL],
    ['in a list item', '* \n<!x* \n</§title>', ['marked']],
  ] as Array<[string, string, string[]]>)('%s: %j', (_label, marked_, lose) => {
    const body = marked_.replace(/§/g, '<');
    const out = escapeUnterminatedHtml(body);
    expect(out).toBe(marked_.replace(/§/g, '&lt;'));
    expect(losers(body)).toEqual(lose);
    expect(losers(out)).toEqual([]);
  });
});

describe('#5369 (#5388 LOCAL P1): the work grows with the text, not with its power', () => {
  // At the frozen head a 40 KB body of this shape took 18 s (main 16 ms): each hidden tag rescanned the text for every later end tag.
  // #5476: the guard measures the growth EXPONENT (the slope of log time against log size over four doubling sizes), not a ratio of two times
  // behind a 50 ms floor: the floor switched the check on and off with the runner's speed, and the bound of 9 (linear is 4 for 4x the text)
  // was wrong for a shape whose walk was in fact near-quadratic (the `<!x` shape and the backtick shape scaled as n^1.9 past 16000 repeats:
  // a newline search that ran back to the start of a text with no line break, once per bogus comment). Linear is an exponent of 1, quadratic
  // 2, cubic 3; the bound is 1.5 and the measured fits are 0.8 to 1.2 for every shape below. The first size is per shape, and the two fast
  // shapes start past the knee where the old walk turned quadratic (16000), so a walk that is quadratic only past that point still fits
  // high. The two slower shapes (about 60 microseconds per repeat, and linear) start at 1000, so that their largest size, 8000, takes about half
  // a second and a runner five times slower still clears the cap. A uniform slowdown moves no slope, so each shape also has an absolute cap of
  // 5 seconds at its largest size (the fast shapes take about 0.3 s there, the old walk 11 to 25 s).
  it.each([
    // [label, body, the first size]
    ['backtick runs between hidden tags and end tags', (n: number) => 'x<!<style> `'.repeat(n) + '</style>'.repeat(n), 16000],
    ['end tags in indented code', (n: number) => 'x<!<style> `'.repeat(n) + '\n    </style>'.repeat(n), 1000],
    ['fences between hidden tags', (n: number) => 'x<!<style>\n```\n'.repeat(n) + '</style>\n'.repeat(n), 1000],
    // #5388 (QA F1): each `<!x` hides the next hidden start from the raw reader's first pass, so each is read by a walk of its own. The text
    // has no line break, so any search for one that is not bounded by the construct costs the whole text (#5476).
    ['declarations hiding the next hidden tag', (n: number) => 'x<!<style><!x'.repeat(n) + '</style>'.repeat(n), 16000],
  ] as Array<[string, (n: number) => string, number]>)('%s', (_label, body, first) => {
    const sizes = [first, first * 2, first * 4, first * 8];
    const fastest = (text: string): number => {
      let best = Infinity;
      for (let k = 0; k < 5; k += 1) { const started = performance.now(); escapeUnterminatedHtml(text); best = Math.min(best, performance.now() - started); }
      return best;
    };
    fastest(body(1000)); // warm the code before the first measured size
    const times = sizes.map((n) => fastest(body(n)));
    expect(times[3]).toBeLessThan(5000);
    const xs = sizes.map((n) => Math.log(n));
    const ys = times.map((t) => Math.log(t));
    const mean = (v: number[]): number => v.reduce((a, b) => a + b, 0) / v.length;
    const mx = mean(xs);
    const my = mean(ys);
    const slope = xs.reduce((sum, x, k) => sum + (x - mx) * (ys[k]! - my), 0) / xs.reduce((sum, x) => sum + (x - mx) ** 2, 0);
    expect(slope).toBeLessThan(1.5);
    expect(slope).toBeGreaterThan(0.5); // a text that took no longer for more text would mean the measurement, not the walk, is broken
  }, 90_000);

  // #5476 (BLIND P3-4): the two bounded searches answer as the unbounded ones did. [body, the output main gave].
  it.each([
    ['<!x', '&lt;!x'],
    ['<!x\n<style>', '<!x\n<style>'],
    ['<!x <style>x', '<!x <style>x'],
    ['<!xy<style>', '<!xy<style>'],
    ['<!x<style>x', '<!x<style>x'],
    ['a\n<!x', 'a\n&lt;!x'],
    ['<!</style>', '<!</style>'],
    ['\n\n<!</style>\n```\n', '\n\n<!</style>\n```\n'],
    // The comment starts at the `<!` and its end tag follows at once: no line break inside it, though the line above would read as a heading.
    ['# <!</style>\n```\nx', '# <!</style>\n```\nx'],
    ['p\n\n<!\n</style>\n\n```\nx', 'p\n\n<!\n</style>\n\n```\nx'],
    ['<!x\n</style>', '<!x\n</style>'],
    ['<!\n</style>\n\n```\n<xmp>', '<!\n</style>\n\n```\n<xmp>'],
  ])('%j', (body, out) => {
    expect(escapeUnterminatedHtml(body)).toBe(out);
  });
});

describe('#5369 (#5388 BLIND P2 at dabc70c5): a bare CR is not a line break to the F2 rule (stated limit, #5401)', () => {
  // [body, the pass's output, readers that lose the anchor with that output]. The walk reads a bare CR as part of its line, so the F2 rule
  // does too; reading it as a break in that rule alone lost anchors main keeps on two fuzzed bodies. The first loses where main keeps it.
  it.each([
    ['<!<style>\r<!\r<!--\\</style>', '<!&lt;style>\r<!\r<!--\\</style>', ALL],
    ['<!\r<!--\\</style>', '<!\r<!--\\</style>', ALL],
    ['<!<textarea><!\r<![CDATA[</textarea>', '<!<textarea><!\r<![CDATA[</textarea>', []],
    // The two fuzzed bodies that reading a bare CR as a break in the F2 rule alone lost where main keeps them (harness r16). As written
    // here they keep what main keeps: the first loses in marked on main too, the second keeps in every reader.
    ['<!DOCTYPE html></><!\r<!--\r<script>\\\r```<xmp>\r\n\t-*-', '<!DOCTYPE html></><!\r<!--\r<script>\\\r```&lt;xmp>\r\n\t-*-', ['marked']],
    ['\n<div>\n\n<!\r<!--<!--x\n<!<x y=\n1.<title>\n>-->', '\n<div>\n\n<!\r<!--<!--x\n<!<x y=\n1.<title>\n>-->', []],
  ])('%j', (body, out, lose) => {
    expect(escapeUnterminatedHtml(body)).toBe(out);
    expect(losers(out)).toEqual(lose);
  });

  // BLIND P2-3 at a6d5bdfb: a CRLF is a line end to the F2 rule and to a line-head hidden tag, as an LF is.
  it.each([
    ['<!<textarea><!\r\n<![CDATA[</textarea>', '<!<textarea>&lt;!\r\n&lt;![CDATA[</textarea>'],
    ['<!\r\n<!--\\</style>', '&lt;!\r\n&lt;!--\\</style>'],
    ['<!<style>\r\n<!\r\n<!--\\</style>', '<!&lt;style>\r\n&lt;!\r\n&lt;!--\\</style>'],
    ['<!<textarea><!\r\n<xmp>', '<!&lt;textarea><!\r\n&lt;xmp>'],
  ])('CRLF %j', (body, out) => {
    expect(escapeUnterminatedHtml(body)).toBe(out);
    expect(losers(out)).toEqual([]);
  });
});

describe('#5369 (#5388 BLIND P2-4 at a6d5bdfb): the rescans after escapes are bounded', () => {
  // Each escape rescans the text once per model, at most MAX_RESTARTS (32) times; past that every `<` is escaped (#5211). So a text that
  // needs many escapes costs at most 33 scans per model, whatever its hidden tags: 66 in all.
  it.each([
    ['hidden tags, each behind a declaration', 'x<!<style><!x'.repeat(40)],
    ['hidden tags with no end tag', 'x<!<script> '.repeat(60)],
    ['nested hidden starts', '<!<textarea><!<style><!<title>'.repeat(20)],
  ])('%s', (_label, body) => {
    const out = escapeUnterminatedHtml(body);
    expect(scansOfLastCallForTests()).toBeLessThanOrEqual(66);
    expect(losers(out)).toEqual([]);
  });
});

describe('#5369 (#5388 BLIND P3 at a6d5bdfb): the raw reader ends each comment boundary form where a browser does', () => {
  // `<!-->` and `<!--->` end at once and `<!---->` at its own `-->`, so the `</textarea>` after each is in data and closes the hidden one.
  it.each([
    ['<!<script><!<textarea><!--></textarea>]:<xmp>--></script>', '<!&lt;script><!<textarea><!--></textarea>]:&lt;xmp>--></script>'],
    ['<!<script><!<textarea><!---></textarea>]:<xmp>--></script>', '<!&lt;script><!<textarea><!---></textarea>]:&lt;xmp>--></script>'],
    ['<!<script><!<textarea><!----></textarea>]:<xmp>--></script>', '<!&lt;script><!<textarea><!----></textarea>]:&lt;xmp>--></script>'],
  ])('%j', (body, out) => {
    expect(escapeUnterminatedHtml(body)).toBe(out);
    expect(losers(out)).toEqual([]);
  });
});

describe('#5369 (#5388 QA at 722ea31f): an escape never uncovers what a hidden tag had masked', () => {
  // [body, the pass's output]: every reader keeps the anchor with the output. QA's F1 kept it on main and lost it at 722ea31f in all three
  // readers (the hidden `<textarea>`'s end tag sat in a comment the raw reader had opened, so the escaped `<script>` uncovered it); QA's F2 and
  // the nested shapes behind it lost it on main as written, where they stood alone, or once an outer hidden tag was escaped.
  it.each([
    // F1: an end tag counts only where a raw reader of the string is back in data (every `<` before it starts a simple tag).
    ['<!<script><!<textarea><!--</textarea>]:<xmp>--></script>', '<!&lt;script><!&lt;textarea><!--</textarea>]:<xmp>--></script>'],
    // The same with `<!---`: a comment that only starts with three dashes still runs to its `-->` (BLIND P2 at dabc70c5).
    ['<!<script><!<textarea><!---</textarea>]:<xmp>--></script>', '<!&lt;script><!&lt;textarea><!---</textarea>]:<xmp>--></script>'],
    // F2: a bare `<!` that runs over a line of its paragraph opening a comment or CDATA block that does not end before its `>`.
    ['<!<style>\n<!\n<!--\\</style>', '<!&lt;style>\n&lt;!\n&lt;!--\\</style>'],
    ['<!\n<!--\\</style>', '&lt;!\n&lt;!--\\</style>'],
    // Not past a blank line or a line opening another HTML block: the `<!--` there is that block's (here the `<?` block's raw HTML).
    ['<!* \n\n<?\n<!--<!# h<template><b<?', '<!* \n\n<?\n<!--<!# h<template>&lt;b&lt;?'],
    ['<!<textarea><!\n<![CDATA[</textarea>', '<!<textarea>&lt;!\n&lt;![CDATA[</textarea>'],
    // Before the hidden tag, text to every reader: `<` before `<`, `</`, `<!<`, a name followed by `<`, `<![` that is not CDATA, a CDATA
    // start with no `]]>` after it, a backtick with none after the tag. Behind an outer hidden tag with no end tag (always escaped).
    ['<!<textarea><!<<title>', '<!&lt;textarea><!<&lt;title>'],
    ['<!<style><!</<iframe>', '<!&lt;style><!</&lt;iframe>'],
    ['<!<style><!<!<script>', '<!&lt;style><!<!&lt;script>'],
    ['<!<style><!<c<script>', '<!&lt;style><!<c&lt;script>'],
    ['<!<textarea><!<![CDATA[<iframe>', '<!&lt;textarea><!<![CDATA[&lt;iframe>'],
    ['<!<style><!``<xmp>`', '<!&lt;style><!``&lt;xmp>`'],
    // A line-head hidden tag with more on its line: no reader opens a block there (#5332's line-head caution is for type 1, 6 and 7 only).
    ['<!<textarea><!\n<xmp>', '<!&lt;textarea><!\n&lt;xmp>'], ['<!\n<xmp></b>', '<!\n&lt;xmp></b>'],
    ['<!<textarea><!\n<xmp></textarea>', '<!<textarea><!\n&lt;xmp></textarea>'],
    // marked opens no code span with a run right after `~`, so it emits the tag raw; commonmark.js and markdown-it show the `&lt;` in their
    // code span, which is the price of keeping marked's anchor.
    ['x~`<title>`', 'x~`&lt;title>`'],
  ])('%j', (body, out) => {
    expect(escapeUnterminatedHtml(body)).toBe(out);
    expect(losers(out)).toEqual([]);
  });

  // Controls left as written: a construct Markdown closes around the tag hides it; simple tags, a closed comment or declaration, or a raw
  // element of the same name do not stop an end tag or a bare `<!` from counting, nor does a bogus comment that ends at the end tag's `>`.
  it.each([
    '<!<!--x<title>-->', '<!<![CDATA[x<title>]]>', '<!<?x<title>?>', '<!<a b="<title>">', '<!<textarea>a <b>x</b> <i x="1"></textarea>',
    '<!\n<!-- c -->\n</style>', '<!<script> <!T> <!-- c --> <+ x<script></script>',
    '<!<textarea><!<<title></textarea>', '<!<style><!</<iframe></style>', '<!<style><!<!<script></style>', '<!<style><!<c<script></style>',
    '<!<textarea><!<![CDATA[<iframe></textarea>', '<!<style><!``<xmp>`</style>',
  ])('%j', (body) => {
    expect(escapeUnterminatedHtml(body)).toBe(body);
    expect(losers(body)).toEqual([]);
  });
});
