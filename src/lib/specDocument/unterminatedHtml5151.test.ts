/**
 * #5151 (cor:spc:030:02, option (b) as Proposed): follow-ups to #5033. Each input is judged on the scanner; the escape is exactly the
 * opening `<` of the open construct, and every other byte (container markers included) is the author's.
 */
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
