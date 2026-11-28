/**
 * #5323 (cor:spc:030:02, option (b), Decided): a type 1 end tag alone at the head of a line (`</textarea>`, `</script>`, `</style>`, `</pre>`)
 * starts a type 7 HTML block in CommonMark and markdown-it, which runs to the next blank line, while marked starts no block there: it reads the
 * line as paragraph text, and a fence opener on a later line of that block opens a fenced code block in marked alone. When nothing closes it,
 * the fence takes the next part's anchor in marked. The opener is written as character references (as #5320 does after a declaration): inside
 * the other readers' HTML block a browser decodes them to the same characters, and marked reads paragraph text.
 * Each case is pinned on the scanner (`§` marks each escaped fence character) and through the readers: the authored body loses the anchor in
 * the named readers and the escaped body in none. The over-escape check: a body whose anchor already survives in every reader stays byte for byte.
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
const escaped = (template: string): string => template.replace(/§(.)/g, (_all, c: string) => (c === '~' ? '&#126;' : '&#96;'));

describe('#5323 a fence that only marked opens under a line-head type 1 end tag is escaped', () => {
  it.each([
    // The two bodies the issue filed (pinned as known losses in unterminatedHtml5211.test.ts before #5323).
    ['the filed body', '<!\n\n</textarea>\n§~§~§~'],
    ['the filed body, under a setext heading', '<!\n-\n</textarea>\n§~§~§~'],
    ['the end tag alone', '</textarea>\n§~§~§~'],
    ['an uppercase name', '</TEXTAREA>\n§~§~§~'],
    ['a blank before the `>`', '</textarea >\n§~§~§~'],
    ['a script end tag and a backtick fence', '</script>\n§`§`§`'],
    ['a style end tag and a longer fence', '</style>\n§~§~§~§~'],
    ['a pre end tag and an indented fence', '</pre>\n   §~§~§~'],
    // marked reads a later line of the other readers' block as markup too: the fence may follow a paragraph line, a heading or a list item.
    ['after a paragraph line', '</textarea>\nx\n§~§~§~'],
    ['after a heading', '</textarea>\n# h\n§~§~§~'],
    ['after a list item', '</textarea>\n- a\n§~§~§~'],
    ['after a heading above the end tag', '# h\n</textarea>\n§~§~§~'],
  ] as Array<[string, string]>)('%s', (_label, template) => {
    const body = template.replace(/§/g, '');
    const out = escapeUnterminatedHtml(body);
    expect(out).toBe(escaped(template));
    expect(escapeUnterminatedHtml(out)).toBe(out);
    expect(losers(body)).toEqual(['marked']);
    expect(losers(out)).toEqual([]);
  });

  it('over-escape check: a body whose anchor survives in every reader is left byte for byte', () => {
    for (const body of [
      // A fence that a later line closes, a fence line indented four columns, a backtick run with a backtick after it (no fence).
      '</textarea>\n~~~\n~~~', '</textarea>\n    ~~~', '</textarea>\n``` x`',
      // An HTML block in marked comes first; a quote; a raw-text name that is no type 1 name.
      '</textarea>\n<div>\n~~~', '> </textarea>\n> ~~~', '</xmp>\n~~~', '- </textarea>\n  ~~~',
      // A fence indented under a list item's marker line is the item's content (fuzz at 2c4cc253).
      '</textarea>\n- a\n  ~~~', '</textarea>\n* ~~~\n  ~~~',
    ]) {
      expect(losers(body), body).toEqual([]);
      expect(escapeUnterminatedHtml(body), body).toBe(body);
    }
  });

  it('a fence line that may close a fence opened above stays (fuzz at 2c4cc253)', () => {
    // A run of the fence character above the end tag, no longer than this one, may have opened a fence that this line closes: a line-head
    // fence a construct ran across, or one marked opens right after a declaration's `>` (#5320). Main keeps these anchors in every reader.
    for (const body of ['~~~</></pre>\r\n\n</textarea>\n~~~', '<?x?>  ~~~\n</style><b x=\'<!\n\n</style>\n~~~\n</', '</script>  ~~~\n<!\n  \n~~~\'<![CDATA[]]><!\n\n</pre>\n  ~~~\n']) {
      const out = escapeUnterminatedHtml(body);
      expect(out, body).not.toMatch(/&#126;/);
      expect(losers(out), body).toEqual([]);
    }
    // A run above that is longer than this line's closes nothing here: the rule still applies.
    expect(escapeUnterminatedHtml('~~~~\n~~~~\n</textarea>\n~~~')).toBe('~~~~\n~~~~\n</textarea>\n&#126;&#126;&#126;');
  });

  it('the fence every reader opens is not this rule: left as written', () => {
    // The end tag interrupts no paragraph, shares its line, is indented code, or a blank line ends the block: every reader opens the fence.
    // Behind a bare `<!` the same: text after the end tag on its line, or a paragraph line above it.
    for (const body of ['x\n</textarea>\n~~~', '</textarea> x\n~~~', '    </textarea>\n~~~', '</textarea>\n\n~~~', '<!\n\n</textarea> x\n~~~', '<!\nx\n</textarea>\n~~~']) {
      expect(losers(body), body).toEqual(['commonmark.js', 'markdown-it', 'marked']);
      expect(escapeUnterminatedHtml(body), body).toBe(body);
    }
  });
});
