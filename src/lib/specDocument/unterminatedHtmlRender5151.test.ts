/**
 * #5151 item 6 (cor:spc:030:02, option (b) as Proposed): the escape judged end to end. A body goes through the pass, the server's own block
 * follows it, a real Markdown renderer makes HTML of the whole string and an HTML5 parser reads that. The renderers are the portal's
 * (`marked`, at the portal's version), markdown-it and commonmark.js (the specification's reference); all pass raw HTML through. No sanitizer
 * runs: what the escape must hold for is the HTML a renderer emits.
 *
 * A body is judged only where the same body with no `<` in it keeps the anchor: an unterminated fence swallows the rest by itself, and no
 * HTML escape changes that.
 *
 * Not covered (older limits of the pass, pinned below so that a change shows): an attribute that is an attribute to a browser and none to
 * Markdown (`<b y= <textarea>`), an end tag of a type 1 element alone on a line (a type 7 block), `<!-->` at the head of a line (a type 2
 * block on that line), and a four-space continuation of a list item.
 */
import * as commonmark from 'commonmark';
import { parseHTML } from 'linkedom';
import MarkdownIt from 'markdown-it';
import { marked } from 'marked';
import { describe, expect, it } from 'vitest';
import { renderSpecDocument, type DocPart } from './render.js';
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

/** Whether the anchor `id` is the server's own `<a>`, live, with nothing but its id, and `heading` is visible text. */
function anchorLives(md: string, renderer: string, id: string, heading: string): boolean {
  const { document } = parseHTML(`<!doctype html><html><body>${RENDERERS[renderer](md)}</body></html>`);
  const el = document.getElementById(id);
  return el !== null && el.tagName === 'A' && [...el.attributes].length === 1
    && el.closest('textarea,script,style,title,xmp,iframe,noembed,noframes,noscript,plaintext,template') === null
    && (document.body.textContent ?? '').includes(heading);
}
const withServerBlock = (body: string): string => `${body}\n\n<a id="srv-a"></a>\n\n## Heading Z\nstate`;
const lives = (body: string, renderer: string): boolean => anchorLives(withServerBlock(body), renderer, 'srv-a', 'Heading Z');

const part = (loc: string, body: string, name: string): DocPart => ({
  loc, name, body, isPlaceholder: false, superseded: false, supersededBy: [], approval: { state: 'NOT_APPROVED' }, minted: false,
});

/** Each loses the anchor in at least one renderer when it is not escaped (checked below), so none is vacuous. `template` and `plaintext` are pinned on the scanner: linkedom models neither. */
const OPEN = [
  'text <textarea>', 'text <script>', '<script>\nx', '<!-- a note', '<?x', '<div>\nuse `<textarea>` here',
  '<b>\n```\n<textarea>\n```\nz', '[a]: /u\n"ti\ntle"\n\n<span>\nuse `<textarea>` here',
  '> <div>\n> use `<textarea>` here', '- <div>\n  use `<textarea>` here', '1. <div>\n   use `<textarea>` here', '> > <div>\n> > use `<textarea>` here',
  '> - <div>\n>   use `<textarea>` here', '- > <div>\n  > use `<textarea>` here', '> <span>\n> use `<textarea>` here', 'a\n- <span>\n  use `<textarea>` here',
  '1. a\n2. <span>\n   use `<textarea>` here', '> \t<textarea>\n> x', '- # h\n  <span>\n  use `<textarea>` here',
  '- ```html\n  <b>\n  ```\n\nThen <textarea> here', '1. ```\n   c\n   ```\n\n<script>', '> ```\n> c\n\nThen <textarea> here', '- ```\n  c\n\nThen <textarea> here',
  '-\n      x\n  <span>\n  use `<textarea>` here', '[a]: /u\n    <textarea>\nx',
];

describe('#5151 the escaped text through a Markdown renderer and an HTML parser', () => {
  it.each(OPEN)('%j loses the anchor as authored', (body) => {
    expect(NAMES.filter((renderer) => !lives(body, renderer))).not.toEqual([]);
  });

  describe.each(NAMES)('%s', (renderer) => {
    it.each(OPEN)('%j keeps the anchor escaped', (body) => {
      expect(lives(escapeUnterminatedHtml(body), renderer)).toBe(true);
    });

    it.each(OPEN)('%j in an assembled document keeps the next part\'s anchor', (body) => {
      const out = renderSpecDocument({
        memory: 'synthetic:specs', renderedAt: new Date('2026-11-06T00:00:00Z'), links: new Map(), feature: part('fx:110', 'Feature body.', 'Feature: F'),
        parts: [part('fx:110:a', body, 'Rule: First'), part('fx:110:b', 'second body', 'Rule: Second')],
      });
      expect(anchorLives(out, renderer, 'fx-110-b', 'Rule: Second [fx:110:b]')).toBe(true);
    });

    it.each([
      ['- ```html\n  <pre x=\n  ```', '<pre x='], ['> ```html\n> <pre x=\n> ```', '<pre x='], ['`<pre x=`', '<pre x='], ['    <pre x=', '<pre x='],
    ])('code sample %j still shows as written', (body, shown) => {
      const { document } = parseHTML(`<!doctype html><html><body>${RENDERERS[renderer](escapeUnterminatedHtml(body))}</body></html>`);
      expect(document.querySelector('code')?.textContent).toContain(shown);
    });

    it('seeded bodies of containers, fences, blocks and raw-text elements', () => {
      const FR = ['<div>', '<span>', '<script>', '<pre>', '<b>', '<textarea>', '<!-- c -->', '<!-- o', '`', '` ', '```', '~~~', '> ', '> > ', '- ', '1. ', '2. ', '  ', '\n', '\n', '\n', '\n\n', '# h', 'x', 'y z', '[a]: /u', '***', '===', '<mailto:a@b.c?s=1>', '\\', '</div>', '</b>'];
      let seed = 20261125;
      const rnd = (): number => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
      const bad: string[] = [];
      let judged = 0;
      let escaped = 0;
      for (let n = 0; n < 5000; n += 1) {
        let body = '';
        for (let k = 2 + Math.floor(rnd() * 10); k > 0; k -= 1) body += FR[Math.floor(rnd() * FR.length)];
        // A four-space line and an unfinished fence are the limits named above.
        if (/^[ >]*? {4}/m.test(body) || !lives(body.replace(/</g, 'L'), renderer)) continue;
        judged += 1;
        const out = escapeUnterminatedHtml(body);
        if (out !== body) escaped += 1;
        if (!lives(out, renderer)) bad.push(JSON.stringify(body));
      }
      expect(bad.slice(0, 10)).toEqual([]);
      expect(judged).toBeGreaterThan(2000);
      expect(escaped).toBeGreaterThan(500);
    }, 120_000);
  });

  it.each([
    'a <b y= <textarea>', '</textarea>\n<!-- \n\n<b>-->', '<!--> \\<textarea>', '1. a\n\n    <script>',
  ])('known limit, unescaped today: %j', (body) => {
    expect(escapeUnterminatedHtml(body)).toBe(body);
    expect(lives(body, 'commonmark.js')).toBe(false);
  });
});
