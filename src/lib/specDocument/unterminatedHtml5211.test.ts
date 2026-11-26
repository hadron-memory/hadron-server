/**
 * #5211 (cor:spc:030:02, option (b), Decided): the follow-ups to #5151. Each escape is lawful only where a named reader loses the next
 * anchor without it, so every case is pinned twice: on the scanner (`§` marks each escaped `<`), and through the readers, where the
 * authored body loses the anchor in at least one and the escaped body in none.
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

const cases = (list: Array<[string, string, string[]]>): void => {
  it.each(list)('%s', (_label, marked_, lose) => {
    const body = marked_.replace(/§/g, '<');
    const out = escapeUnterminatedHtml(body);
    expect(out).toBe(marked_.replace(/§/g, '&lt;'));
    expect(escapeUnterminatedHtml(out)).toBe(out);
    // The readers that lose the anchor as authored (the lawful basis), and none once escaped.
    expect(losers(body)).toEqual(lose);
    expect(losers(out)).toEqual([]);
  });
};
const ALL = ['commonmark.js', 'markdown-it', 'marked'];

describe('#5211 item 1: a fence that ends with its containers', () => {
  cases([['the next line is not code in marked', '> 2. * ~~~\n    §textarea>', ['marked']]]);
});

describe('#5211 item 2: a line indented to an open list item continues it', () => {
  cases([
    ['a bullet', '- a\n\n    §script>', ALL],
    ['an ordered item', '1. a\n\n    §script>', ALL],
    ['a two-digit marker', '10. a\n\n     §script>', ALL],
    ['a tab', '1. a\n\n\t§script>', ALL],
    ['a nested item', '- a\n  - b\n\n    §script>', ALL],
    ['an item in a quote', '> - a\n>\n>     §script>', ALL],
    // A quote inside the item continues it (QA, #5257 delta).
    ['a quote inside the item', '- a\n  > q\n\n    §script>', ALL],
    ['an ordered item', '1. a\n   > q\n\n     §script>', ALL],
    ['a nested quote', '- a\n  > > q\n\n    §script>', ALL],
    ['the second item', '- a\n- b\n  > q\n\n    §script>', ALL],
    ['a quote in an item in a quote', '> - a\n>   > q\n>\n>     §script>', ALL],
    ['a blank line before the quote (BLIND delta)', '- a\n\n  > q\n\n    §script>', ALL],
    ['and ordered', '1. a\n\n   > q\n\n     §script>', ALL],
    ['and in a quote', '> - a\n>\n>   > q\n>\n>     §script>', ALL],
  ]);
  it('four columns past the item content is code in every reader, and stays as written', () => {
    for (const body of ['- a\n\n      <script>', '1. a\n\n       <script>', '- a\n\nb\n\n    <script>', '- a\n# H\n\n    <script>', '- a\n***\n\n    <script>', '- a\n> q\n\n    <script>', '> - a\n>\n>       <script>', '- a\n  >     <script>', '- a\n  > q\n  >\n  >     <script>', '- a\n  > q\n\n      <script>', '> - a\n\n    <script>', '> - a\n> > q\n>\n>     <script>', '> - a\n>  > q\n>\n>     <script>', '> - a\n\nb\n\n>     <script>', '> - a\n\n>     <script>']) {
      expect(escapeUnterminatedHtml(body), body).toBe(body);
      expect(losers(body), body).toEqual([]);
    }
  });
});

describe('#5211 item 3: a tag Markdown does not accept is text to it, so what it holds is read', () => {
  cases([
    ['an unquoted value holding a tag', 'a <b y= §textarea>', ALL],
    ['an attribute name holding a tag', 'a <b b§textarea> c', ALL],
    ['at the head of a line', '<x a b§textarea>', ALL],
  ]);
  cases([
    ['a name that only starts with template is read', '<b y= §templatex<§xmp>', ALL],
    ['and with a blank after it', 'a <b y= <templatex §xmp>', ALL],
  ]);
  it('the hold-back names the template element only', () => {
    expect(escapeUnterminatedHtml('a <b y= <templates><textarea>')).toBe('a <b y= <templates>&lt;textarea>');
    expect(losers('a <b y= <templates><textarea>')).toEqual(['commonmark.js', 'markdown-it', 'marked']);
  });
  it('inside an HTML block the browser grammar applies, and the tag is complete', () => {
    expect(escapeUnterminatedHtml('<div>\n<b y= <template>')).toBe('<div>\n<b y= <template>');
  });
});

describe('#5211 item 4: a type 1 end tag alone on a line starts a type 7 block', () => {
  cases([
    ['textarea', '</textarea>\n§!--\n\n<b>-->', ['commonmark.js', 'markdown-it']],
    ['script', '</script>\n§!--\n\n<b>-->', ['commonmark.js', 'markdown-it']],
  ]);
});

describe('#5211 item 5: `<!-->` at the head of a line makes the rest of it raw', () => {
  cases([
    ['a backslash hides nothing there', '<!--> \\§textarea>', ALL],
    ['the same for `<!--->`', '<!---> \\§textarea>', ALL],
  ]);
});

describe('#5211 item 6: a declaration whose name is followed by `<` is text to marked', () => {
  cases([
    ['inline', 'a <!X§xmp>', ['marked']],
    ['on a second line', 'x\n<!X§xmp>', ['marked']],
  ]);
  it('a declaration with a blank after its name, or one that starts a block (marked reads it as HTML there), is complete', () => {
    for (const body of ['<!DOCTYPE html>', 'a <!X y> b', '<!X<xmp>', '<!x<xmp>', '# h\n<!X<xmp>', 'a <!X\n<b>c</b>', `a <!${'X'.repeat(70)} <xmp> y>`]) {
      expect(escapeUnterminatedHtml(body), body).toBe(body);
      expect(losers(body), body).toEqual([]);
    }
  });
});

describe('#5211 a declaration at the head of a line ends at its first `>` in marked (#5257 delta, LOCAL and SECURITY)', () => {
  cases([
    ['a tag value holding a raw-text tag after it', '<!x><b y=§script>', ['marked']],
    ['a title', '<!x><b y=§title>', ['marked']],
    ['an attribute name holding one', '<!x><b §script>', ['marked']],
    ['text between', '<!x>a<b y=§script>', ['marked']],
    ['backticks in the value', '<!x><b y=```§textarea>', ['marked']],
    ['an xmp', '<!x><b §xmp>', ['marked']],
  ]);
});

describe('#5211 marked differential (#5257 delta)', () => {
  cases([
    ['a declaration after an empty item is text to marked', '1. \n<!X<pre x=   §textarea>§b b   ', ['marked']],
    ['and after a two-digit one', '10. \n<!X§textarea>> - \n***', ['marked']],
    ['a line-head `<!-->` with a line after it is inline in marked', '> - <!--><!x>\t\n    §textarea><div>', ['marked']],
    ['marked reads the rest of a line-head declaration\'s line as a new block', '<!x>§pre x=  > > \n  >        <script><textarea>    ', ['marked']],
    ['a declaration after a line marked does not take as a definition', '[a]: /u> - # h\n<!X§textarea>', ['marked']],
    ['a definition-shaped line after a paragraph is paragraph text (SECURITY delta)', 'a\n[a]: /u\n<!x§xmp>', ['marked']],
    ['with a script', 'a\n[a]: /u\n<!x§script>', ['marked']],
    ['with a tag before it', 'a\n[a]: /u\n<!x<b §script>', ['marked']],
    ['and so is what follows it', '  <!-->~~~`\n>   > # h<!X<b y= §script>', ['marked']],
  ]);
});

describe('#5211 item 7: content four columns past a bare marker', () => {
  it('a line between four and markerWidth + 4 columns in is the item paragraph, so the code span stays', () => {
    const body = '-\n     x\n  <span>\n  use `<pre x=` here';
    expect(escapeUnterminatedHtml(body)).toBe(body);
    expect(losers(body)).toEqual([]);
  });
});

it('#5211 stays linear on deep quotes inside list items', () => {
  for (const unit of [`- a\n${'  > '.repeat(300)}q\n`, `${'> '.repeat(300)}- a\n${'> '.repeat(300)}  > q\n`]) {
    const body = unit.repeat(Math.ceil(120_000 / unit.length));
    const t0 = Date.now();
    escapeUnterminatedHtml(body);
    expect({ unit: unit.slice(0, 20), fast: Date.now() - t0 < 5000 }).toEqual({ unit: unit.slice(0, 20), fast: true });
  }
}, 120_000);

describe('#5265 item 2: a list closed by an HTML block keeps its code', () => {
  it.each(['- a\n<div>\n\n    <script>', '> - a\n> <div>\n>\n>     <script>', '- a\nb\n<div>\n\n    <script>'])('%j stays as written', (body) => {
    expect(escapeUnterminatedHtml(body)).toBe(body);
    expect(losers(body)).toEqual([]);
  });
});

describe('#5265 item 4: a tab before a quote inside a list item', () => {
  cases([
    ['the quote continues the item', '> - a\n>\t> q\n>\n>     §script>', ['commonmark.js', 'markdown-it']],
    ['marked strips the whole tab after a quote marker', '1.        \n>\t  > > <b y= §script>\n\n  >   > ', ['marked']],
  ]);
});

describe('#5265 item 6: marked starts a fence right after a line-head declaration', () => {
  cases([
    ['with a final newline', '§!DOCTYPE html>```\n', ['marked']],
    ['without one', '§!DOCTYPE html>```', ['marked']],
    ['a tilde fence', '§!DOCTYPE html>~~~', ['marked']],
  ]);
});

describe('#5265 item 9: a line of mixed -, * and _ is no thematic break', () => {
  cases([
    ['-*- continues the item', '- a\n-*-\n\n    §script>', ALL],
    ['*-* too', '- a\n*-*\n\n    §script>', ALL],
  ]);
});

it('#5265 item 9: after a mixed line the paragraph is still open, so a lone tag starts no HTML block', () => {
  const body = 'a\n-*-\n<span>\nuse `<pre x=` here';
  expect(escapeUnterminatedHtml(body)).toBe(body);
  expect(losers(body)).toEqual([]);
});

describe('#5265 item 7 is not changed (Victor #151094: a raw-string reader counts under option (b))', () => {
  it('an open tag in the raw block after `</b>` stays escaped', () => {
    expect(escapeUnterminatedHtml('</b>\n```\n<b x=\n```\nz')).toBe('</b>\n```\n&lt;b x=\n```\nz');
  });
});

describe('#5265 QA F1 and F2 (Charles, 5d444777): bodies that main keeps stay as written', () => {
  it.each([
    // (a) the fence after the declaration closes, in marked also on a run followed by more backticks or tildes.
    '<!DOCTYPE html>```\n```',
    '<!DOCTYPE html>```\n\nx\n```',
    '<!x>~~~\n~~~',
    '<!DOCTYPE html>````\n`````',
    '<!x>\n\n<!DOCTYPE html>```\n```~~~\nx',
    // After the declaration's fence closes, a later fence left open is no declaration's: escaping the `<` would not close it.
    '<!DOCTYPE html>```\n```\n\n```\nx',
    // (b) marked closes a list item at no declaration, so the indented line stays in the item.
    '+ -*-\n<!DOCTYPE html>\n\n    1.    &lt;script>',
    '- a\n<!DOCTYPE html>\n\n    &lt;script>',
    // F2: inside a quote or a list item, or interrupting a paragraph, marked reads no fence after the declaration.
    '> <!DOCTYPE html>```',
    '- <!DOCTYPE html>```',
    '1. <!DOCTYPE html>```',
    '> > <!DOCTYPE html>```',
    'x\n<!DOCTYPE html>```',
    // Riana P2 (5d444777): a backtick in a backtick fence's info string opens no fence; a lone `=` with no paragraph above is no underline.
    '<!x>```*-*```',
    '<!DOCTYPE html>``` `` ',
    '\n=\n<!DOCTYPE html>~~~ ',
    // Escaped, the line would be a paragraph that the `-` below makes a heading, and the fence after it would leave the list item.
    '<!x>~~~>\t    \n-\n  ```\n\n\n',
    // A declaration closed on a later line: the escaped text would open the same fence on that line.
    '<!X1. # h    \n```<!x>~~~<!x>~~~<pre x=   > y z',
  ])('%j', (body) => {
    expect(escapeUnterminatedHtml(body)).toBe(body);
  });

  it('(b) the script in the item is still escaped where marked reads it', () => {
    const body = '+ -*-\n<!DOCTYPE html>\n\n    1.    <script>';
    expect(escapeUnterminatedHtml(body)).toBe('+ -*-\n<!DOCTYPE html>\n\n    1.    &lt;script>');
    expect(losers(body)).toEqual(['marked']);
    expect(losers(escapeUnterminatedHtml(body))).toEqual([]);
  });

  it.each(['<!DOCTYPE html>```\n```', '<!x>~~~\n~~~', '<!x>\n\n<!DOCTYPE html>```\n```~~~\nx'])('(a) %j keeps the anchor in marked as written', (body) => {
    expect(losers(body)).not.toContain('marked');
  });
});

describe('#5265: a setext underline ends the run a code span may close in', () => {
  cases([
    ['`=` under the line', '&lt;!DOCTYPE html>```§script>\n=\nx<!-- c -->```', ALL],
    ['`-` under the line', 'a `§script>\n-\nx`', ALL],
    ['a longer run', 'a ```§script>\n=\nx```', ALL],
  ]);
});
