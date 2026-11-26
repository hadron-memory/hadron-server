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
import { escapeUnterminatedHtml, quoteColumnsForTests } from './unterminatedHtml.js';

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

describe('#5265 Riana P2 (3fa46eef): an underline under the declaration escapes it, unless a lone `-` holds an indented line', () => {
  cases([
    ['`===`', '§!DOCTYPE html>```\n===', ['marked']],
    ['`---`', '§!DOCTYPE html>```\n---', ['marked']],
    ['a lone `-` with nothing indented under it', '§!DOCTYPE html>```\n-', ['marked']],
    ['`===` over an indented line (no bullet to leave)', '§!DOCTYPE html>```\n===\n  x', ['marked']],
  ]);
});

describe('#5265: a setext underline ends the run a code span may close in', () => {
  cases([
    ['`=` under the line', '&lt;!DOCTYPE html>```§script>\n=\nx<!-- c -->```', ALL],
    ['`-` under the line', 'a `§script>\n-\nx`', ALL],
    ['a longer run', 'a ```§script>\n=\nx```', ALL],
  ]);
});

describe('#5265 blind review at 3fa46eef', () => {
  it('a tab after a quote marker is measured once (a one-column tab ends at the next stop)', () => {
    // `> >\t> q`: the second marker sits at column 2, its tab starts at column 3 and is one column wide, so the third marker is at column 4.
    expect(quoteColumnsForTests('> >\t> q', 3)).toEqual({ marker: 4, content: 6 });
    expect(quoteColumnsForTests('> >\t> q', 2)).toEqual({ marker: 2, content: 4 });
    expect(quoteColumnsForTests('>\t> q', 2)).toEqual({ marker: 4, content: 6 });
  });

  // A mixed `-*-` line and a lazy underline in a quote are paragraph text: the code span runs on, and the `<` in it is code.
  it.each([
    'a `x\n-*-\n<b x=\'\ny` w',
    'a `x\n*-*\n<b x=\'\ny` w',
    '> a `x\n=\n<b x=\'\ny` w',
    '> a `x\n--\n<b x=\'\ny` w',
  ])('%j stays as written', (body) => {
    expect(escapeUnterminatedHtml(body)).toBe(body);
    expect(losers(body)).toEqual([]);
  });

  it('a lazy `=` in a list item is an underline to marked, so the span ends there and the tag is judged', () => {
    expect(escapeUnterminatedHtml('- a `x\n=\n<b x=\'\ny` w')).toBe('- a `x\n=\n&lt;b x=\'\ny` w');
  });

  cases([
    // A `-` or `--` underline ends the paragraph, so a type 7 tag under it starts an HTML block and the code span on the next line is raw.
    ['a `-` underline', 'a\n-\n<x>\n`§b x=\'`', ALL],
    ['a `--` underline', 'a\n--\n<x>\n`§b x=\'`', ALL],
    // The declaration's fence: a lone `-` over an indented line escapes where no fence is left open after it.
    ['a lone `-` over an indented line', '§!DOCTYPE html>```\n-\n  x', ['marked']],
    ['the item\'s fence closes later', '§!DOCTYPE html>```\n-\n  ~~~\n  y\n~~~', ALL],
    // The item ended (empty, then a blank line): the declaration is at the top level, where marked opens the fence.
    ['after an empty item', '- a\n-\n\n  §!DOCTYPE html>```', ['marked']],
    // `<div/x` is no type 6 block, so the line is paragraph text and the script in it is inline HTML.
    ['`<div/x` opens no block', '§!DOCTYPE html>```\n<x>\n<div/x§script>', ['marked']],
    // A lazy `=` in a quote is paragraph text, so the four-space line after it is too (no code): its script is judged.
    ['a lazy `=` in a quote', '> a\n=\n    §script>', ALL],
    // `<div/x` closes no list item, so the indented line after the blank line is the item's paragraph, not code.
    ['`<div/x` keeps the item open', '- a\n<div/x>\n\n    §script>', ['commonmark.js', 'markdown-it']],
  ]);

  it('a lone `-` ends a quote\'s paragraph in every reader (an empty item, never lazy text), so the span ends there', () => {
    expect(escapeUnterminatedHtml('> a `x\n-\n<b x=\'\ny` w')).toBe('> a `x\n-\n&lt;b x=\'\ny` w');
  });

  it('the declaration is left where escaping it would leave a fence open in CommonMark', () => {
    // Escaped, the line is a paragraph, `<x>` no longer starts an HTML block, and the fence after it runs to the end.
    const body = '<!x>~~~\n<x>\n```\n-*-\n';
    expect(escapeUnterminatedHtml(body)).toBe(body);
    expect(losers(body)).toEqual(['marked']);
    expect(losers(`&lt;${body.slice(1)}`)).toEqual(ALL);
    // The same with a lone `-` whose item holds the fence.
    const bullet = '<!x>~~~>\t    \n-\n  ```\n\n\n';
    expect(escapeUnterminatedHtml(bullet)).toBe(bullet);
    expect(losers(`&lt;${bullet.slice(1)}`)).toEqual(ALL);
  });

  it('a CRLF line is read as its LF form', () => {
    expect(escapeUnterminatedHtml('- a\r\n***\r\n    <script>')).toBe('- a\r\n***\r\n    <script>');
    expect(escapeUnterminatedHtml('- a\n***\n    <script>')).toBe('- a\n***\n    <script>');
  });
});

describe('#5265 seats at 8652e68e (Bradley P1, Charles F1 and F2)', () => {
  it('many declaration fences escape in linear time: the CommonMark check runs only for the declaration the scan reports', () => {
    const body = Array(3000).fill("<!x>```\n<b x='\n```").join('\n');
    const t = performance.now();
    escapeUnterminatedHtml(body);
    expect(performance.now() - t).toBeLessThan(2000);
  });

  // A line that opens a deeper quote starts a container with no paragraph in it, so its `-`, `--` or `=` underlines nothing: the
  // four-space line after it is the quote's lazy text (or the empty item's), and the script in it is judged.
  it.each([
    'a\n>-\n    <script>', 'a\n>--\n    <script>', 'a\n>-\n    <textarea>', 'a\n>-\n\t<xmp>', 'a\r\n>-\r\n    <script>',
    '.\n>=\n\t<script>', '.\r\n>=\r\n\t<script>',
  ])('%j: the opener is escaped', (body) => {
    expect(escapeUnterminatedHtml(body)).not.toBe(body);
    expect(losers(body)).not.toEqual([]);
    expect(losers(escapeUnterminatedHtml(body))).toEqual([]);
  });

  // A fence inside a list item ends with the item: a non-blank line indented less than the item's content is markup again.
  it.each(['-\n  ~~~\n<xmp>', '-\r\n  ~~~\r\n<xmp>', '- a\n  ```\n<script>'])('%j: the tag after the item is escaped', (body) => {
    expect(escapeUnterminatedHtml(body)).not.toBe(body);
    expect(losers(escapeUnterminatedHtml(body))).toEqual([]);
  });
});

describe('#5265 fix head after 8652e68e: bodies 3fa46eef kept that 8652e68e lost (Braxton fuzz)', () => {
  // A bare marker opens an item whose content starts after the marker and its indent; a line indented to it is still in the item, so a
  // fence there ends with the item, and escaping the declaration above (which makes the `-` an underline) is what would leave it open.
  it.each(['<!l>```\n-\n  >\n  ~~~', '<!l>```\n-\n  -\n  ~~~'])('%j: the declaration is left as written', (body) => {
    expect(escapeUnterminatedHtml(body)).toBe(body);
    expect(losers(`&lt;${body.slice(1)}`)).toEqual(ALL);
  });

  it('a fence in a bare item after its paragraph ends with the item, so the tag after it is escaped', () => {
    const body = '-\n  x\n  ~~~\n<textarea';
    expect(losers(body)).toEqual(ALL);
    expect(losers(escapeUnterminatedHtml(body))).toEqual([]);
  });

  // marked reads no underline under a paragraph whose first line is a lone tag, nor under a quote's lazy lines: the indented line after
  // the `=` or `-` is its paragraph text there, so the raw-text tag in it is judged.
  it.each(['<div/x>\n=\n    <xmp>', '>-\n->\n-\n\t<xmp>'])('%j: the tag is escaped for marked', (body) => {
    expect(losers(body)).toEqual(['marked']);
    expect(escapeUnterminatedHtml(body)).not.toBe(body);
    expect(losers(escapeUnterminatedHtml(body))).toEqual([]);
  });
});

describe('#5265 fix head after 8652e68e: guards the fuzz and the mutants found', () => {
  // After an empty quote line marked carries nothing on lazily: the `=` or `-` there is CommonMark's underline in marked too, so the
  // declaration's fence opens and never closes, and the declaration is escaped as on 8652e68e.
  it.each(['>\n=\n=\n<!l>```', '>\n~\n-\n<!l>```', '>\na\n=\n<!l>```'])('%j: the declaration is escaped', (body) => {
    expect(losers(body)).toEqual(['marked']);
    expect(losers(escapeUnterminatedHtml(body))).toEqual([]);
  });

  // A declaration is an HTML block to marked, not a paragraph: the `-` under it underlines nothing there and the next declaration's fence opens.
  it.each(['<!l>\n-\n<!x>~~~', '<!-->\n-\n<!x>~~~', '<!x>\n-\n<!x>~~~'])('%j: the second declaration is escaped', (body) => {
    expect(losers(body)).toEqual(['marked']);
    expect(losers(escapeUnterminatedHtml(body))).toEqual([]);
  });

  it('a fence CommonMark leaves open as written is no reason to keep the declaration: marked keeps the anchor once it is escaped', () => {
    const body = '<!x>~~~  \n-\n<!DOCTYPE html>```\n\n  ```~~~';
    expect(losers(escapeUnterminatedHtml(body))).toEqual(['commonmark.js', 'markdown-it']);
  });

  it('marked reads a line after a bare item\'s fence as its fence\'s text, so the item does not end it there', () => {
    const body = '>\t\n-\n  ```\n\n```\n  > <xmp><!-->+ \n\n\n===';
    expect(losers(escapeUnterminatedHtml(body))).toEqual(['commonmark.js', 'markdown-it']);
  });
});

describe('#5265 fix head after 597e24ba: the residuals main kept and 597e24ba lost (Xan #151509)', () => {
  const CM = ['commonmark.js', 'markdown-it'];
  // Each body loses the anchor at 597e24ba in every reader; escaped as now, it loses it in no reader main keeps it in (a reader that main
  // loses too is listed: the construct there is code to it, or a fence that opens to the end takes the anchor whatever is escaped).
  it.each<[string, string[]]>([
    ['- >\n  ~~~\r\n<script', []],
    ['- >\n  ~~~\r\n<textarea', []],
    ['<!T>-\n  ~~~\r\n<xmp>', CM],
    ['<!T>+\n  ~~~\r\n<xmp>', CM],
    ['>=\na\n-\n  ~~~\r\n<script', ['marked']],
    ['>x\na\n-\n  ~~~\r\n<script', ['marked']],
    ['<?>\n~~~\r\n<p', CM],
    ['<div/\n<pre>\n~~~', []],
  ])('%j: the losers once escaped are %j', (body, after) => {
    expect(losers(escapeUnterminatedHtml(body))).toEqual(after);
  });
});

describe('#5265 fix head after 597e24ba: the readers\' rules the residuals needed', () => {
  const CM = ['commonmark.js', 'markdown-it'];
  it.each<[string, string[], string]>([
    // A fence in an item that opens with a quote, in a nested item, or in the item a marker opens right after a closer ends with the item.
    ['- >\n  ~~~\n<script', [], 'item that opens with a quote'],
    ['- - x\n  ~~~\n<xmp>', [], 'nested item'],
    ['<!T>-\n  ~~~\n<xmp>', CM, 'item after a declaration'],
    ['<![CDATA[]]>- a\n  ~~~\n<xmp>', CM, 'item after CDATA'],
    ['<!x><!l>+\n  ~~~\n<!--', CM, 'item after a second declaration on the line'],
    // CommonMark keeps a lazy quote line in the quote: the lone `-` after it opens an item.
    ['>x\na\n-\n  ~~~\n<script', ['marked'], 'lazy quote line'],
    // A lone marker short of a bare item's content after its paragraph is the next item, not an underline; `=` there is lazy text.
    ['-\n  u\n-\n\t<script', [], 'next bare item'],
    ['-\n  u\n=\n\t<script', [], 'lazy `=`'],
    // marked's processing instruction needs a `?>` after `<?`; a CDATA or PI closer restarts marked, so a fence, an HTML block there opens.
    ['<?>\n~~~\n<p', CM, '`<?>` has no closer'],
    ['<??>~~~', [], 'fence after a PI'],
    ['<![CDATA[]]>~~~', [], 'fence after CDATA'],
    ['<![CDATA[]]><n>\n~~~\n<textarea', CM, 'type 7 block after CDATA'],
    ['<??><div>\n~~~\n<textarea', CM, 'type 6 block after a PI'],
  ])('%j: the losers once escaped are %j (%s)', (body, after) => {
    expect(losers(escapeUnterminatedHtml(body))).toEqual(after);
  });

  // Left as written: escaping would hand a reader the loss it does not have.
  it.each<[string, string[], string]>([
    // A top-level `<pre>` with no closer runs raw to the end; escaped, the `~~~` under it would open a fence that never closes.
    ['<pre>\n~~~', [], 'line-head pre'],
    ['<!y><pre>\n~~~', CM, 'pre at marked\'s restart'],
    // That one is judged by marked's reading (CommonMark reads that `<pre>` as inline): escaped, it would hand marked the fence.
    ['<!y><pre>\n<x>\n~~~', [], 'pre at marked\'s restart, judged by marked'],
    // marked reads a textarea right after a CDATA closer as a type 1 block that its end tag closes; CommonMark's fence takes the anchor anyway.
    ['<![CDATA[]]><textarea>\n~~~\n</textarea>', CM, 'textarea after CDATA'],
    ['<![CDATA[]]><textarea>\n~~~\r\n</textarea>', CM, 'textarea after CDATA, CRLF'],
    // A declaration that follows another inside a quote opens its fence in the quote, which ends with it.
    ['><!y><!x>~~~\n-\n  ```', [], 'declarations in a quote'],
  ])('%j: kept as written, losers %j (%s)', (body, after) => {
    expect(escapeUnterminatedHtml(body)).toBe(body);
    expect(losers(body)).toEqual(after);
  });

  // After a closer, what the rest of the line is decides whether the next line continues a paragraph. Each one here leaves none open, so the
  // declaration on the next line starts a block whose fence never closes in marked, and is escaped; plain text there is continued.
  it.each([
    '><![CDATA[]]>```\n<!x>~~~',
    '<??>>\n<!l>```',
    '<??>>     z\n<!l>```',
    '<![CDATA[]]><!-->-\n<!l>```',
    '<??>    x\n<!l>```',
    '<!T>#\n<!l>```',
  ])('%j: the declaration on the next line is escaped', (body) => {
    expect(losers(body)).toEqual(['marked']);
    expect(losers(escapeUnterminatedHtml(body))).toEqual([]);
  });

  it('plain text after a declaration is a paragraph: an indented raw-text tag under it is inline, and escaped', () => {
    const body = '<!h>`\n    <textarea>';
    expect(losers(body)).toEqual(['marked']);
    expect(losers(escapeUnterminatedHtml(body))).toEqual([]);
  });
});

it('#5265 the exemptions and restarts after 597e24ba stay fast on thousands of lines', () => {
  for (const unit of ['<pre>\n~~~\n', '<div/\n<pre>\n~~~\n', '<!y><pre>\n~~~\n', '<![CDATA[]]><textarea>\n~~~\n</textarea>\n', '<??><n>\n~~~\n', '<!x><!l>+\n  ~~~\n', '-\n  u\n-\n\t<script\n']) {
    const body = unit.repeat(3000);
    const t = performance.now();
    escapeUnterminatedHtml(body);
    expect({ unit, fast: performance.now() - t < 2000 }).toEqual({ unit, fast: true });
  }
}, 60_000);

describe('#5265 fix head after 02250085: a long nested-marker line, and a bare item that a block line ends', () => {
  // P2-1: a line of nested markers was walked once per marker (02250085: 52 s at 200,000 levels), and its item columns were spread into Math.max.
  it('a line of many nested list markers before a fence is read in linear time', () => {
    const body = `${'- '.repeat(100_000)}x\n\`\`\`\n<xmp>`;
    const t = performance.now();
    escapeUnterminatedHtml(body);
    expect({ fast: performance.now() - t < 2000 }).toEqual({ fast: true });
  }, 60_000);

  // P2-2: a bare marker's item ends at a line that starts another block, even right after its paragraph: the fence below is top-level and
  // never closes, so what follows is code to every reader and nothing in it is rewritten.
  it.each(['-\n  x\n# h\n  ~~~\n<xmp>', '-\n  x\n> q\n  ~~~\n<xmp>', '-\n  x\n---\n  ~~~\n<xmp>'])('%j is kept as written', (body) => {
    expect(escapeUnterminatedHtml(body)).toBe(body);
  });

  it('a paragraph line still continues the item lazily, so the fence under it is the item\'s', () => {
    const body = '-\n  x\n  ~~~\n<xmp>';
    expect(losers(body)).toEqual(['commonmark.js', 'markdown-it', 'marked']);
    expect(losers(escapeUnterminatedHtml(body))).toEqual([]);
  });
});

describe('#5265 fix head after 02250085: bodies main kept that 02250085 lost', () => {
  // [body, escaped, readers that still lose the anchor]: each loses no reader main keeps, and the escape is a fixed point. The readers
  // left are those an unclosed fence takes the anchor from whether or not anything is escaped.
  const cm = ['commonmark.js', 'markdown-it'];
  it.each<[string, string, string[]]>([
    // `</` right after a declaration's fence: a bogus comment to a browser, text to Markdown, so the `<script>` it holds is markup.
    ['<!DOCTYPE html>~~~</<script>', '&lt;!DOCTYPE html>~~~&lt;/&lt;script>', []],
    ['<!DOCTYPE html>```</<script>', '&lt;!DOCTYPE html>```&lt;/&lt;script>', []],
    ['<!DOCTYPE html>~~~</<xmp>', '&lt;!DOCTYPE html>~~~&lt;/&lt;xmp>', []],
    ['<![CDATA[]]>~~~</<textarea><xmp>1.', '&lt;![CDATA[]]>~~~&lt;/&lt;textarea>&lt;xmp>1.', []],
    ['<!l>~~~</<script>', '&lt;!l>~~~&lt;/&lt;script>', []],
    // marked: a backtick run right after a `~` opens no code span.
    ['<div/<div/"~~~```<div/<div><script># h```', '<div/<div/"~~~```<div/<div>&lt;script># h```', []],
    ['a~```<script>```', 'a~```&lt;script>```', []],
    // marked: `<?>` is no processing instruction closer; its block runs to the next `?>` and the tags before it are markup to a browser.
    ['<?>\n~~~\r\n<template>?>', '<?>\n~~~\r\n&lt;template>?>', cm],
    ['<?>?><pre>\n```</\r', '<?>?><pre>\n```&lt;/\r', cm],
    ['- `\n-*-\n<xmp>`', '- `\n-*-\n&lt;xmp>`', []],
    ['+ >~~~\n  ~~~\r\n<script', '+ >~~~\n  ~~~\r\n&lt;script', []],
    // #5265 (fix head after d5f941ae): no reader loses the anchor as written (marked carries the line into the heading's quote), so nothing is escaped.
    ['># ```\n<!x<textarea>```', '># ```\n<!x<textarea>```', []],
    ['<!x>~~~\r\n~~~\r\n<xmp>', '<!x>~~~\r\n~~~\r\n&lt;xmp>', cm],
    ['>x\n>-\n    ><textarea', '>x\n>-\n    >&lt;textarea', []],
    // marked: a marker and one space is paragraph text, and a lone marker under it continues the paragraph.
    ['1. \n-\n<!X<textarea>', '1. \n-\n<!X&lt;textarea>', []],
    // marked: under a paragraph, an ordered marker and one space starts a new paragraph, which takes no underline.
    ['>\t\n=\n1. \n-\n<!X<textarea>', '>\t\n=\n1. \n-\n<!X&lt;textarea>', []],
    ['a\n1) \n-\n<!X<textarea>', 'a\n1) \n-\n<!X&lt;textarea>', []],
    ['>=\r\n+\n<x>\n~~~\n\n~~~\n<textarea', '>=\r\n+\n<x>\n~~~\n\n~~~\n&lt;textarea', cm],
    ['<div/\n <!---->\n\t<xmp>', '&lt;div/\n <!---->\n\t&lt;xmp>', []],
    // CommonMark: inside a bare marker's item, a line's indent counts from the item's content column (the `>` is a quote, not code).
    ['<div/xa\n-\n-\n  <!-- c --><!DOCTYPE html>```10. \n    >\t<xmp>[a]: /u\n<div>', '&lt;div/xa\n-\n-\n  <!-- c --><!DOCTYPE html>```10. \n    >\t&lt;xmp>[a]: /u\n<div>', []],
    ['-\n  <!X>\n    > <xmp>', '-\n  <!X>\n    > &lt;xmp>', []],
    // marked: under a paragraph, a line that is only a tag with a `-` line under it opens an HTML block (its setext rule stops there).
    ['-*-\n<x>\n  - \n-*-\n~~~\n<script><span><?x?>   \n    \r\n', '-*-\n<x>\n  - \n-*-\n~~~\n&lt;script><span><?x?>   \n    \r\n', cm],
    ['a\n<x>\n-\n~~~\n<script>', 'a\n<x>\n-\n~~~\n&lt;script>', cm],
    ['- a\n<x>\n-\n~~~\n<script>', '- a\n<x>\n-\n~~~\n&lt;script>', cm],
    // marked: a marker and two blanks is an empty item, so the `-` under it is an item and the declaration line opens a block.
    ['10. \t\n-\n<!DOCTYPE html>```>\tx', '10. \t\n-\n&lt;!DOCTYPE html>```>\tx', []],
  ])('%j', (body, escaped, lose) => {
    const out = escapeUnterminatedHtml(body);
    expect(out).toBe(escaped);
    expect(escapeUnterminatedHtml(out)).toBe(out);
    expect(losers(out)).toEqual(lose);
  });
});

describe('#5265 fix head after 02250085: guards the mutants left alive at 02250085', () => {
  // marked reads the rest of a line after a CDATA or processing instruction it closed as new blocks (markedRawTo).
  it.each([
    ['<?x?>a\n=\n  <!DOCTYPE html>```', '<?x?>a\n=\n  &lt;!DOCTYPE html>```'],
    ['<![CDATA[x]]>- <b y= <script>', '<![CDATA[x]]>- <b y= &lt;script>'],
    // A line that closes a nested item leaves only that item: the fence under it is still the outer item's (leaveItems).
    ['- a\n  - b\n  # h\n  ~~~\n<xmp>', '- a\n  - b\n  # h\n  ~~~\n&lt;xmp>'],
    ['1. a\n   - b\n   # h\n   ~~~\n<xmp>', '1. a\n   - b\n   # h\n   ~~~\n&lt;xmp>'],
  ])('%j', (body, escaped) => {
    expect(losers(body)).not.toEqual([]);
    expect(escapeUnterminatedHtml(body)).toBe(escaped);
    expect(losers(escaped)).toEqual([]);
  });

  it('more exempt declarations than the scan budget covers: every `<` is escaped', () => {
    const body = Array(80).fill('<!T>```\n-\n  ~~~').join('\n');
    expect(escapeUnterminatedHtml(body)).toBe(body.replace(/</g, '&lt;'));
  });
});

describe('#5265 fix head after 02250085: one call is linear in the text', () => {
  // A top-level declaration whose fence never closes, exempt in marked, repeated, with open tags after it: the exemptions, the
  // fence reads and the escapes nested (36 s at 160 KB). Past its budget of scans the call escapes every `<`.
  it('160 KB of exempt declarations with 30 open tags after them', () => {
    const unit = '<!T>```\n-\n  ~~~';
    const body = `${Array(Math.ceil((160 * 1024) / (unit.length + 1))).fill(unit).join('\n')}${"\n<b x='".repeat(30)}`;
    const t = performance.now();
    const out = escapeUnterminatedHtml(body);
    expect({ fast: performance.now() - t < 8000 }).toEqual({ fast: true });
    expect(out).toBe(body.replace(/</g, '&lt;'));
  }, 60_000);
});

describe('#5265 fix head after 02250085: the residuals vs main of fuzz seeds 13-16', () => {
  // [body, escaped]: each loses no reader, and the escape is a fixed point. 02250085 lost a reader main keeps on the first of each pair.
  it.each<[string, string]>([
    // marked: a marker with one blank after it (`+ `) is paragraph text, so the tag line under it continues that paragraph and opens no
    // HTML block; the declaration further down ends its own block, and the fence after it closes.
    ['+ \n<x>\n<b y= + <!x>~~~\r\n<!DOCTYPE html>```\n-\n```\n</b>', '+ \n<x>\n<b y= + <!x>~~~\r\n<!DOCTYPE html>```\n-\n```\n</b>'],
    ['+ \n<x>\nb\n<!D x>```\n-\n```\n', '+ \n<x>\nb\n<!D x>```\n-\n```\n'],
    // marked: a list item inside a quote ends at a lazy line that starts an HTML block to it, so a code span opened in the item ends there.
    ['> - > a `x\n--\n<xmp>\n-*-\ny z> a `x\n>=\n\n-\n---<span>', '> - > a `x\n--\n&lt;xmp>\n-*-\ny z> a `x\n>=\n\n-\n---<span>'],
    ['> - a `x\n<xmp>\nb`', '> - a `x\n&lt;xmp>\nb`'],
    // A quote indented into a bare marker's item holds its list inside that item: a fence under it is the item's, and ends with it.
    ['*-*  ~~~\n\n-\n  > - <pre x=\t-*-`\n\n  ~~~\r\n<xmp>', '*-*  ~~~\n\n-\n  > - &lt;pre x=\t-*-`\n\n  ~~~\r\n&lt;xmp>'],
    ['-\n  > - a\n  ~~~\n<xmp>', '-\n  > - a\n  ~~~\n&lt;xmp>'],
  ])('%j', (body, escaped) => {
    const out = escapeUnterminatedHtml(body);
    expect(out).toBe(escaped);
    expect(escapeUnterminatedHtml(out)).toBe(out);
    expect(losers(out)).toEqual([]);
  });
});

describe('#5265 fix head after 02250085: guards left unpinned at 02250085', () => {
  // A `<pre>` with no fence line after it is never exempt: escaping it cannot open a fence that takes the anchor, so it is escaped (the
  // fence that is open above it is the item's, and ends with it).
  it.each<[string, string]>([
    ['-\n<pre>\n  ~~~\n<pre>', '-\n<pre>\n  ~~~\n&lt;pre>'],
    ['\n-\n<pre x=<!-->\n  ~~~\r\n<pre x=<span>\n', '\n-\n<pre x=<!-->\n  ~~~\r\n&lt;pre x=<span>\n'],
    // marked starts no CDATA block right after a line its paragraph took raw, so the `<xmp>` after that CDATA is markup and is escaped.
    ['\r\n>=\r\n\n\n-*-\n<?x?>\n<![CDATA[x]]><!X<xmp>*-*   # h', '\r\n>=\r\n\n\n-*-\n<?x?>\n<![CDATA[x]]><!X&lt;xmp>*-*   # h'],
  ])('%j', (body, escaped) => {
    const out = escapeUnterminatedHtml(body);
    expect(out).toBe(escaped);
    expect(escapeUnterminatedHtml(out)).toBe(out);
    expect(losers(out)).toEqual([]);
  });
});

describe('#5265 fix head after d5f941ae: the heading test under markers is linear', () => {
  // Beryl (blind, d5f941ae): the regex that read a heading after quote and list markers took 2^n paths on a line of n markers that is
  // no heading. At 40 markers that never ends, so the test's own timeout is the bound; the result is pinned as well.
  it.each<[string, string]>([
    ['> ', 'x <span a=`'],
    ['>  ', 'x <span a=`'],
    ['-  ', 'x <span a=`'],
    ['1.  ', 'x <span a=`'],
    ['> ', '# x <span a=`'],
  ])('%j x 40 then %j', (marker, rest) => {
    const body = `p\n\n${marker.repeat(40)}${rest}`;
    const out = escapeUnterminatedHtml(body);
    expect(out).toBe(body.replace('<span', '&lt;span'));
    expect(escapeUnterminatedHtml(out)).toBe(out);
    expect(losers(out)).toEqual([]);
  }, 3000);
});

describe('#5265 fix head after d5f941ae: the bodies the seats found at d5f941ae', () => {
  it.each<[string, string]>([
    // QA F1 (Charles): `<!` and no letter is no declaration to Markdown, which reads the `<` after it as markup; a raw reader reads comment text.
    ['<?><!<style>?>~~~', '&lt;?>&lt;!&lt;style>?>~~~'],
    ['<?><!<xmp>?>~~~', '&lt;?>&lt;!&lt;xmp>?>~~~'],
    ['<?><style>?>~~~', '&lt;?>&lt;style>?>~~~'],
    ['<?>x<style>?>~~~', '&lt;?>x&lt;style>?>~~~'],
    ['a <!<style>', 'a &lt;!&lt;style>'],
    // LOCAL P2 (Bradley): marked starts no instruction block in a paragraph, so the paragraph goes on and the line indented under it is lazy text.
    ["<div/\n<?>\n    <pre><b x='", "&lt;div/\n<?>\n    <pre>&lt;b x='"],
    // LOCAL P2 (Bradley): escaping the declaration for marked makes CommonMark read the held-back `<b` and `<template>` as markup (#5211).
    ['<!T>```<pre><b\n<template>', '&lt;!T>```<pre>&lt;b\n&lt;template>'],
    // Where the text as written already reaches a held-back template, escaping the declaration changes nothing there, and marked needs it.
    ['<!T>~~~<b y= x\n\n<ba <template>\n\n', '&lt;!T>~~~&lt;b y= x\n\n<ba <template>\n\n'],
    // A heading after a quote marker and a tab is one line, so a tag in it cannot run on to the next.
    ['>\t>\t # <b x="#"\n<b>', '>\t>\t # &lt;b x="#"\n<b>'],
  ])('%j', (body, escaped) => {
    const out = escapeUnterminatedHtml(body);
    expect(out).toBe(escaped);
    expect(escapeUnterminatedHtml(out)).toBe(out);
    expect(losers(out)).toEqual([]);
  });
});

describe('#5265 fix head after d5f941ae: the extended-alphabet fuzz bodies main keeps for marked', () => {
  // Each is red at d5f941ae (marked loses the anchor there) and kept by main. The bodies whose fence opens in CommonMark as written keep
  // that loss: the `~~~` line opens a fence there that never closes, and no escaped `<` closes it, so only marked's loss is the pass's.
  const CM = ['commonmark.js', 'markdown-it'];
  it.each<[string, string, string[]]>([
    // A lone tag line marked reads as text: the `-` under it is an underline, and the line under that is a paragraph's, no code.
    ['< >\n-\n    <script>', '< >\n-\n    &lt;script>', []],
    // A quote right after a declaration marked ended: its lazy lines carry the quote's paragraph, so their `-` underlines nothing.
    ['<!T>>a\ni\n-\n    <textarea>', '<!T>>a\ni\n-\n    &lt;textarea>', []],
    ['>X\n-\na\n-\n    <xmp>', '>X\n-\na\n-\n    &lt;xmp>', []],
    // marked ends a `<pre` block only at `</pre>`, so a `</textarea>` on its line leaves it open, and the `~~~` under it raw.
    ['<pre </textarea>\n~~~\r\n<b', '<pre </textarea>\n~~~\r\n&lt;b', CM],
    // A marker with two spaces is an empty item to marked, which then starts the instruction block on the next line.
    ['-  \n<?>\n~~~\r\n<b', '-  \n<?>\n~~~\r\n&lt;b', CM],
    // An empty quote leaves no paragraph for the `-` to underline: a rule, then the instruction block.
    ['>\n-\n<?>\n~~~\r\n<p', '>\n-\n<?>\n~~~\r\n&lt;p', CM],
    ['>\n-\n<?>\n~~~\n<p', '>\n-\n<?>\n~~~\n&lt;p', CM],
    // marked restarts after the declaration (or instruction) it ended on the line, and its block rules take up to three spaces: ` <n>` is
    // a type 7 block that runs raw to the blank line, so no fence opens under it and the `<script` is markup.
    ['<!X> <n>\n~~~\n<script', '<!X> <n>\n~~~\n&lt;script', CM],
    ['<!X> <n>\n~~~\r\n<script', '<!X> <n>\n~~~\r\n&lt;script', CM],
    ['<?a?> <n>\n~~~\n<script', '<?a?> <n>\n~~~\n&lt;script', CM],
    // marked carries the `<pre` line into the item lazily (CommonMark ends the item at the fence), so its block ends with the item and the
    // `<template>` line, which ends the item, starts a block at the top level. Escaping only that keeps the `<pre` CommonMark needs.
    ['- >```\n<pre\n<template>\n  ~~~', '- >```\n<pre\n&lt;template>\n  ~~~', []],
    ['- >```\n<pre\nx\n<template>\n  ~~~', '- >```\n<pre\nx\n&lt;template>\n  ~~~', []],
  ])('%j', (body, escaped, lose) => {
    const out = escapeUnterminatedHtml(body);
    expect(out).toBe(escaped);
    expect(escapeUnterminatedHtml(out)).toBe(out);
    expect(losers(out)).toEqual(lose);
  });
});

describe('#5265 fix head after d5f941ae: the fuzz bodies of seeds 109-116 and the guards of the rules they took', () => {
  const CM = ['commonmark.js', 'markdown-it'];
  it.each<[string, string, string[]]>([
    // Red at d5f941ae: marked's setext rule takes no underline under ` {0,3}<[^\n>]+>` that starts no HTML block in marked.
    ['<b <>\n-\n    <script>', '<b <>\n-\n    &lt;script>', []],
    ['<b?>\n-\n    <script>', '<b?>\n-\n    &lt;script>', []],
    ['<!>\n-\n<!X<script>', '<!>\n-\n<!X&lt;script>', []],
    // Red at d5f941ae: an HTML block in a bare marker's item ends with the item (CommonMark at the `~` line), so the declaration is read.
    ['-\n  <b>\n~\n<!l>```</<script>', '-\n  <b>\n~\n<!l>```</<script>', []],
    ['<!-->\n-\n  <!X`\n<script>', '<!-->\n-\n  &lt;!X`\n&lt;script>', []],
    // Red at d5f941ae: inside marked's raw instruction block a browser reads `<!X` as a comment that runs to the end.
    ['<?>\n~~~\nh<!X', '<?>\n~~~\nh&lt;!X', CM],
    // Red at d5f941ae: a declaration over two lines is one block to marked, which restarts after its `>` (` <n>` there is a type 7 block).
    ['<!X\n><n>\n~~~\n<script', '<!X\n><n>\n~~~\n&lt;script', CM],
    // Red at d5f941ae: a backtick fence holds no backtick in its info string, so the code span from the line above closes on that line.
    ['<!l>```\n```<xmp>```', '&lt;!l>```\n```&lt;xmp>```', []],
    // Red at d5f941ae: `> ` holds nothing for marked (the space is the marker's) and `>\t>` is an empty quote inside one.
    ['> \n-\n<?>\n~~~\r\n<p', '> \n-\n<?>\n~~~\r\n&lt;p', CM],
    ['>\t>\n<?>\n~~~\n<p', '>\t>\n<?>\n~~~\n&lt;p', CM],
    // Red at d5f941ae: an item whose first line is indented code has its content one column past the marker; the fence there is the item's.
    ['-     >\n  ~~~\n<!X', '-     >\n  ~~~\n&lt;!X', []],
    // Red at d5f941ae: an item that opens a fence right after a declaration leaves no paragraph open, so the instruction starts a block.
    ['<!x>- ```\n<?>\n~~~\n<b', '<!x>- ```\n<?>\n~~~\n&lt;b', CM],
    // Red at d5f941ae: marked carries a quote that holds a tab on through the next line, so the declaration's fence is the quote's.
    ['>\t\n<!l>```\n>=\n<!x>~~~\n~~~', '>\t\n<!l>```\n>=\n<!x>~~~\n~~~', CM],
    // Red at d5f941ae: this body needs 70 scans, past the old budget of 64 (every `<` was escaped, and the fence then took the anchor).
    ['<pre><textarea\n<div/\n<pre><b<!<b\n~~~', '<pre>&lt;textarea\n<div/\n<pre>&lt;b&lt;!&lt;b\n~~~', []],
    // Guards (green at d5f941ae, lost by a first cut of these rules): where CommonMark finds a closer for `<pre` and marked no `</pre>`,
    // marked's block runs raw and loses nothing, so it is not escaped; marked ends an item at a backtick run whatever follows it; and an
    // item whose content is a rule leaves the line indented into it the item's HTML.
    ['<pre\n<div></textarea></<script>\n-', '<pre\n<div></textarea></<script>\n-', []],
    ['- <pre </textarea>\n<x>\n~~~', '- <pre </textarea>\n<x>\n~~~', []],
    ['- `\n```<script>`', '- `\n```&lt;script>`', []],
    ['<!y>- ***\n    <script>', '<!y>- ***\n    &lt;script>', []],
    // Red at d5f941ae: the `<div>` block ends with the bare marker's item, so CommonMark reads `<!<style>` under it as text and markup.
    ['-\n  <div>\n<!<style>', '-\n  <div>\n&lt;!&lt;style>', []],
    // Guards (green at d5f941ae): after an item line that is a heading or a fence marked takes no lazy line, so the `<pre` line starts its
    // own block and the `<template>` is inside it; nothing is lost, and nothing is escaped.
    ['- # h\n<pre\n<template>\n  ~~~', '- # h\n<pre\n<template>\n  ~~~', []],
    ['- ```\n<pre\n<template>\n  ~~~', '- ```\n<pre\n<template>\n  ~~~', []],
    // Guards (green at d5f941ae): marked ends a bare marker's item at a backtick run too, so the code span cannot reach the next line; and
    // only marked takes a tab right before another quote marker for the marker's (CommonMark counts the rest of the tab as indent).
    ['-\n  `\n```<script>`', '-\n  `\n```&lt;script>`', []],
    ['-\n  >`\n```<script>`', '-\n  >`\n```&lt;script>`', []],
    ['>><\n>-\n>\t>     <script>', '>><\n>-\n>\t>     &lt;script>', []],
    ['>\t>\n>     ><xmp>', '>\t>\n>     >&lt;xmp>', []],
  ])('%j', (body, escaped, lose) => {
    const out = escapeUnterminatedHtml(body);
    expect(out).toBe(escaped);
    expect(escapeUnterminatedHtml(out)).toBe(out);
    expect(losers(out)).toEqual(lose);
  });
});

describe('#5265 fix head after d5f941ae: a tab-nested empty quote holds nothing to CommonMark', () => {
  it.each<[string, string, string[]]>([
    // Red at a55565f2 (the last residual of fuzz seeds 13/14): `>\t>` is an empty quote inside one to CommonMark (the tab gives the
    // marker one column and leaves two of indent), so no paragraph is open under it and the declaration's fence is no reason to escape it.
    // main keeps the body as written, which only marked loses; so does this head.
    ['>\t>\n<!l>```\n-\n  ~~~', '>\t>\n<!l>```\n-\n  ~~~', ['marked']],
    ['> \t>\n<!l>```\n-\n  ~~~', '> \t>\n<!l>```\n-\n  ~~~', ['marked']],
  ])('%j', (body, escaped, lose) => {
    const out = escapeUnterminatedHtml(body);
    expect(out).toBe(escaped);
    expect(escapeUnterminatedHtml(out)).toBe(out);
    expect(losers(out)).toEqual(lose);
  });
});
