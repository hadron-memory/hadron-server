/**
 * #5320 (cor:spc:030:02, option (b)): marked ends a line-head declaration's block at its first `>` and starts the next block right there, so a
 * fence opener after the `>` that nothing closes takes the rest of the document, the server's next anchor included. The pass writes the opener's
 * first character as a character reference (a browser decodes it to the same character) and leaves the declaration as written: escaping the
 * declaration turns its line into paragraph text and moves how the lines after it read (#5291's first attempt regressed 2676 bodies).
 *
 * Each body goes through the pass, the server's own block follows it, a Markdown reader makes HTML of the whole string, and linkedom reads that.
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
const NAMES = Object.keys(RENDERERS);
const RAW_SELECTOR = 'textarea,script,style,title,xmp,iframe,noembed,noframes,noscript,plaintext,template';

function lives(body: string, renderer: string): boolean {
  const html = RENDERERS[renderer]!(`${body}\n\n<a id="srv-a"></a>\n\n## Heading Z\nstate`);
  const { document } = parseHTML(`<!doctype html><html><body>${html}</body></html>`);
  const el = document.getElementById('srv-a');
  return el !== null && el.tagName === 'A' && [...el.attributes].length === 1 && el.closest(RAW_SELECTOR) === null
    && (document.body.textContent ?? '').includes('Heading Z');
}
const losers = (body: string): string[] => NAMES.filter((r) => !lives(body, r));

describe('#5320: a fence opener after a line-head declaration that nothing closes', () => {
  // [body as authored, the pass's output]
  it.each([
    ['<!DOCTYPE html>```\n', '<!DOCTYPE html>&#96;&#96;&#96;\n'],
    ['<!DOCTYPE html>```', '<!DOCTYPE html>&#96;&#96;&#96;'],
    ['<!DOCTYPE html>~~~', '<!DOCTYPE html>&#126;&#126;&#126;'],
    ['<!DOCTYPE html>````js\n', '<!DOCTYPE html>&#96;&#96;&#96;&#96;js\n'],
    ['<!DOCTYPE html>   ```\nx\n', '<!DOCTYPE html>   &#96;&#96;&#96;\nx\n'],
    ['[a]: b\n<!DOCTYPE html>```\n', '[a]: b\n<!DOCTYPE html>&#96;&#96;&#96;\n'],
    ['<!x><!DOCTYPE html>```\n', '<!x><!DOCTYPE html>&#96;&#96;&#96;\n'],
    ['p\n=\n<!DOCTYPE>```\n', 'p\n=\n<!DOCTYPE>&#96;&#96;&#96;\n'],
    ['x\n\n<!x y>~~~~ t\n- a\n', 'x\n\n<!x y>&#126;&#126;&#126;&#126; t\n- a\n'],
    ['<!DOCTYPE html>```\r\ntext\r\n', '<!DOCTYPE html>&#96;&#96;&#96;\r\ntext\r\n'],
  ])('%j is written %j; marked lost the anchor as authored, none does now', (body, written) => {
    expect(losers(body)).toEqual(['marked']);
    expect(escapeUnterminatedHtml(body)).toBe(written);
    expect(losers(written)).toEqual([]);
    expect(escapeUnterminatedHtml(written)).toBe(written);
  });
});

describe('#5320: the whole opener run is written (no backticks left to pair as a code span)', () => {
  it('a four-backtick opener above an unterminated comment: the comment is escaped too and no reader loses', () => {
    const body = '<!X y>````\n\t<!--```';
    expect(escapeUnterminatedHtml(body)).toBe('<!X y>&#96;&#96;&#96;&#96;\n\t&lt;!--```');
    expect(losers(escapeUnterminatedHtml(body))).toEqual([]);
    expect(losers(body)).toContain('marked');
  });
  it('a four-space indented fence line is not a closer', () => {
    expect(escapeUnterminatedHtml('<!DOCTYPE html>```\n    ```\n')).toBe('<!DOCTYPE html>&#96;&#96;&#96;\n    ```\n');
  });
});

describe('#5320: bytes that stay as written (the over-escape check)', () => {
  it.each([
    ['a closer follows', '<!DOCTYPE html>```\nx\n```\n'],
    ['a longer closer follows', '<!DOCTYPE html>```\nx\n`````  \n'],
    ['a tilde closer for a tilde opener', '<!DOCTYPE html>~~~\nx\n~~~\n'],
    ['the declaration continues a paragraph (marked reads text)', 'a\n<!DOCTYPE html>```'],
    ['the opener is not at the end of the declaration line start', '<!DOCTYPE html> x ```'],
    ['a backtick in a backtick opener\'s info string (not a fence)', '<!DOCTYPE html>```a`b\n'],
    ['only two backticks', '<!DOCTYPE html>``\n'],
    ['four spaces before the opener (indented code)', '<!DOCTYPE html>    ```\n'],
    ['marked closes a fence with its run followed by other fence characters', '<!DOCTYPE>~~~[a]: b\n~~~```\n'],
    ['the declaration sits inside a type 6 block (no new block starts there)', '<div>\n<!DOCTYPE html>```\n'],
    ['the declaration sits after a bare list marker line', '-\n<!DOCTYPE html>```\n'],
    ['the declaration sits inside a type 1 block that is still open', '<pre>\n<!DOCTYPE html>```\n</pre>\n'],
    ['a line of a block quote (the quote ends at the blank line that follows)', '> <!DOCTYPE html>```\n'],
    ['a lone `=` line is paragraph text, so the declaration after it is no block start', '=\n<!DOCTYPE>```\n'],
    ['the first declaration continues a paragraph, so the one after its `>` starts no block either', 'p\n<!x><!DOCTYPE html>```\n'],
    ['a lone `=` line, then two declarations: neither starts a block', '=\n<!x><!DOCTYPE html>```\n'],
    ['no declaration', '```\nx\n'],
    ['a tag, not a declaration', '<div>```\n'],
  ])('%s', (_name, body) => {
    expect(escapeUnterminatedHtml(body)).toBe(body);
  });

  it('a shorter run does not close a longer opener (the closer needs at least as many characters)', () => {
    // The ``` line opens a fence of its own in CommonMark, so only the output is pinned here.
    expect(escapeUnterminatedHtml('<!DOCTYPE html>````\n```\n')).toBe('<!DOCTYPE html>&#96;&#96;&#96;&#96;\n```\n');
    expect(escapeUnterminatedHtml('<!DOCTYPE html>````\n````\n')).toBe('<!DOCTYPE html>````\n````\n');
  });

  it('a closer that is not one: a shorter run, another character, a trailing word', () => {
    for (const closer of ['``', '~~~', '``` x']) {
      const body = `<!DOCTYPE html>\`\`\`\nx\n${closer}\n`;
      expect(escapeUnterminatedHtml(body)).toBe(`<!DOCTYPE html>&#96;&#96;&#96;\nx\n${closer}\n`);
    }
  });
});

describe('#5320: an open type 1 block is escaped as before and its inside is left alone', () => {
  it('writes only the unclosed <pre>, not the fence in the declaration line that follows it', () => {
    // After the `<pre>` is escaped the declaration continues a paragraph line in marked, so no reader loses the anchor and the fence stays as written.
    const body = '</div>\n<pre>\n<!x>````';
    expect(escapeUnterminatedHtml(body)).toBe('</div>\n&lt;pre>\n<!x>````');
    expect(losers(escapeUnterminatedHtml(body))).toEqual([]);
  });
});
