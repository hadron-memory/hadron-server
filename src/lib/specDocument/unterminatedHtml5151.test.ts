/**
 * #5151 (cor:spc:030:02, option (b) as Proposed): follow-ups to #5033. Each input is judged on the scanner; the escape is exactly the
 * opening `<` of the open construct, and every other byte (container markers included) is the author's.
 */
import { parseHTML } from 'linkedom';
import { describe, expect, it } from 'vitest';
import { escapeUnterminatedHtml } from './unterminatedHtml.js';

/** `want` marks each escaped `<` as `§`, so a case reads as its own input. */
const cases = (list: Array<[string, string]>): void => {
  it.each(list)('%s', (_label, marked) => {
    const body = marked.replace(/§/g, '<');
    const out = escapeUnterminatedHtml(body);
    expect(out).toBe(marked.replace(/§/g, '&lt;'));
    expect(escapeUnterminatedHtml(out)).toBe(out);
  });
};

describe('#5151 item 1: the autolink exemption holds only outside an HTML block', () => {
  cases([
    ['inside a type 6 block an autolink shape is a tag with an ambiguous name', '<div>\n§mailto:a@b.c?s=1>\nx'],
    ['inside a type 7 block', '<b>\n§mailto:a@b.c?s=1>\nx'],
    ['on the rest of a comment block\'s last line', '<!-- c --> §mailto:a@b.c?s=1>'],
    ['after the block has ended it is an autolink again', '<div>\n\n<mailto:a@b.c?s=1>\nx'],
    ['in a paragraph it is an autolink', 'see <mailto:a@b.c?s=1>'],
  ]);
});

describe('#5151 item 4: a label alone, its destination and its title on three lines', () => {
  cases([['all three lines are the definition', '[a]:\nhttp://x\n"title"\n<span>\nuse `§pre x=` here']]);
});

describe('#5151 item 5: an HTML block inside a block quote or list item', () => {
  cases([
    ['a quote, type 6', '> <div>\n> use `§pre x=` here'],
    ['a list item, type 6', '- <div>\n  use `§pre x=` here'],
    ['an ordered item', '1. <div>\n   use `§pre x=` here'],
    ['a nested quote', '> > <div>\n> > use `§pre x=` here'],
    ['a list item in a quote', '> - <div>\n>   use `§pre x=` here'],
    ['a quote in a list item', '- > <div>\n  > use `§pre x=` here'],
    ['a type 7 tag in a quote', '> <span>\n> use `§pre x=` here'],
    ['a type 7 tag in a list item, after a paragraph line', 'a\n- <span>\n  use `§pre x=` here'],
    ['a type 7 tag in a sibling item', '1. a\n2. <span>\n   use `§pre x=` here'],
    ['a comment block: the rest of its closing line is raw', '> <!-- c --> `a §b x= b` c'],
    ['a type 1 block: the rest of its closing line is raw', '- <script>x</script> `a §b x= b` c'],
    ['a type 1 block whose end tag is outside the quote', '> §script>\n\n```\n</script>\n```'],
    ['a type 1 pre block whose end tag is outside the item', '- §pre>\n\nz `</pre>`'],
    ['a tab after the list marker', '-\t<div>\n\tuse `§pre x=` here'],
    ['a tab after a quote marker is two columns of indent, not code', '> \t§textarea>\n> x'],
    ['a tab right after a quote marker', '>\t§textarea>\n> x'],
    ['four columns after a quote marker are code', '>     <textarea>\n\nx'],
    // Where the block ends: the code span is a code span again.
    ['a quote ends at a line with no marker', '> <div>\nuse `<pre x=` here'],
    ['a quote block ends at a bare marker', '> <div>\n>\n> use `<pre x=` here'],
    ['a list item ends at an outdented line', '- <div>\n\nuse `<pre x=` here'],
    ['an outdented line with no blank line ends the block too', '- <div>\nuse `<pre x=` here'],
    ['the next item is another block', '- <div>\n- use `<pre x=` here'],
    ['the block ends at a blank line in the item', '- <div>\n\n  use `<pre x=` here'],
    // Not a block at all.
    ['a tag in a quoted paragraph does not start type 7', '> a\n> <span>\n> use `<pre x=` here'],
    ['a lazy continuation is a paragraph line', '> a\n<span>\nuse `<pre x=` here'],
    ['a tag in a list paragraph does not start type 7', '- a\n  <span>\n  use `<pre x=` here'],
    // A construct across quoted lines: a marker is a `>` to a reader of the raw text and nothing to Markdown, so it is never its closer.
    ['a tag across quoted lines is open', '> §div\n> class="x'],
    ['inside a quoted block too', '> <div>\n> §a\n> href="x'],
    ['an end tag across quoted lines does not end its element', '> §script>a§/script\n> b></script>'],
    ['a quote that opens after a paragraph line is a new container', 'a\n> <span>\n> use `§pre x=` here'],
    ['a tab right after a quote marker, and a blank: three columns', '>\t §textarea>\n> x'],
    ['content five columns past a list marker is code', '-      <div>\n       use `<pre x=` here'],
    // Complete blocks are the author's bytes.
    ['a complete quoted block', '> <div>\n> <b>x</b>\n> </div>'],
    ['a complete multi-line tag in a list item', '- <div>\n  <a\n    href="x">y</a>\n  </div>'],
    ['a complete script in a list item', '- <script>\n  x\n  </script>'],
    ['a complete script in a quote', '> <script>\n> x\n> </script>'],
    ['a complete script behind a `>` inside an unquoted HTML block', '<div>\n> <script>\nx\n</script>\n</div>'],
    ['a complete pre in a quote', '> <pre>\n> x\n> </pre>'],
  ]);
});

describe('#5151 a fence inside a block quote or list item', () => {
  cases([
    ['a fence on an item\'s marker line is closed by its closing line', '- ```html\n  <b>\n  ```\n\nThen §textarea> here'],
    ['an ordered item', '1. ```\n   c\n   ```\n\n§script>'],
    ['a fence in an item in a quote', '> - ```\n>   c\n>   ```\n\n§script>'],
    ['a fence ends where its quote ends', '> ```\n> c\n\nThen §textarea> here'],
    ['a fence ends where its item ends', '- ```\n  c\n\nThen §textarea> here'],
    ['the code in an item fence stays as written', '- ```html\n  <pre x=\n  ```\n\nmore'],
    ['the code in a quoted fence stays as written', '> ```html\n> <pre x=\n> ```\n\nmore'],
    ['a blank line in an item fence does not end it', '- ```\n  a\n\n  <pre x=\n  ```\n\nmore'],
    ['a heading in an item leaves no paragraph open', '- # h\n  <span>\n  use `§pre x=` here'],
  ]);
});

describe('#5151 a list number other than 1 does not interrupt a paragraph', () => {
  cases([
    ['so the backticks after it open no fence', 'a\n2. ```` §script>\nb'],
    ['a sibling item does open one', '1. a\n2. ```\n   <pre x=\n   ```\n\nthen §script>'],
  ]);
});

describe('#5151 items 7 to 15: link reference definitions and bare list markers', () => {
  cases([
    // 7: a raw, a code and a fence line each end a definition, so a title-shaped line after one is a paragraph and the tag interrupts nothing.
    ['7, a fence line resets it', '[a]:\n```\nc\n```\n"t\n<span>\nuse `<pre x=` here'],
    ['7, a code line resets it', '[a]: /u\n\n    c\n"t\n<span>\nuse `<pre x=` here'],
    ['7, a raw line resets it', '[a]: /u\n<!-- c\n-->\n"t\n<span>\nuse `<pre x=` here'],
    ['7, a raw line resets it when the block opened on the destination line', '[a]:\n<!-- c\n-->\n"t\n<span>\nuse `<pre x=` here'],
    ['13, a parenthesis title ends at its closer', '[a]: /u (ti\nmid\ntle)\npara\n<span>\nuse `<pre x=` here'],
    // 8 and 13: only the closer of the title's own opener ends it.
    ['8, a double quote does not close a parenthesis', '[a]: /u (ti\nx"\nz)\n<span>\nuse `§pre x=` here'],
    ['13, a single quote title', "[a]: /u 'ti\nx)\nz'\n<span>\nuse `§pre x=` here"],
    ['13, a destination line with a title left open', "[a]:\n/u 'ti\nx\"\nz'\n<span>\nuse `§pre x=` here"],
    ['13, a parenthesis title on a line of its own', '[a]:\n/u\n(ti\nx"\nz)\n<span>\nuse `§pre x=` here'],
    // 14: text after the closing delimiter still ends the title (a paragraph line may follow).
    ['14, text after the closer ends the title', '[a]: /u "ti\nz"junk\npara\n<span>\nuse `<pre x=` here'],
    // 9
    ['9, a bare marker after a paragraph line is the paragraph', 'para\n*\n<span>\nuse `<pre x=` here'],
    ['9, an ordered one', 'para\n2)\n<span>\nuse `<pre x=` here'],
    // 10
    ['10, a title line indented by a tab', '[a]: /u\n\t"ti\ntle"\n<span>\nuse `§pre x=` here'],
    ['10, a title line with a mixed indent', '[a]: /u\n  \t"ti\ntle"\n<span>\nuse `§pre x=` here'],
    // 11
    ['11, code in an empty item leaves no paragraph open', '-\n      x\n  <span>\n  use `§pre x=` here'],
    // 15
    ['15, a four-space line after a definition is no indented code', '[a]: /u\n    §script>\nx'],
    ['15, nor after a definition with its title', '[a]: /u "t"\n    §script>\nx'],
  ]);
});

describe('#5151 item 2: the ambiguous tag name, as a parser reads it', () => {
  it('linkedom loses the server anchor behind such a tag, and keeps it once the tag is escaped', () => {
    const anchor = (body: string) => parseHTML(`<!doctype html><html><body>${body}\n<a id="srv"></a>\n\n<p>after</p></body></html>`).document.getElementById('srv');
    const body = "<pre=</=='<plaintext>\n";
    expect(anchor(body)).toBeNull();
    expect(anchor(escapeUnterminatedHtml(body))?.tagName).toBe('A');
  });
});

it('#5151 stays linear on long containers and long marker lines', () => {
  for (const unit of ['> <!-- c -->\n', '> <div>\n', '> > <b>\n', '- <div>\n', '> ', '- ', '1. ', '> <script>x</script>\n', '> ```\n> c\n']) {
    const body = unit.repeat(120_000 / unit.length);
    const t0 = Date.now();
    escapeUnterminatedHtml(body);
    // A quadratic scan takes tens of seconds here.
    expect({ unit, fast: Date.now() - t0 < 5000 }).toEqual({ unit, fast: true });
  }
}, 120_000);
