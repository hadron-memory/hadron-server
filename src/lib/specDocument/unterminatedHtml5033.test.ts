/**
 * #5033 / cor:spc:030:02 (ruling 0206, option (b) as Proposed): a part body that ends in an unterminated raw-HTML construct must
 * not absorb the NEXT block's server anchor. The pass escapes the opening `<` of such a construct as `&lt;`, so it shows as the
 * same text and never opens.
 *
 * The acceptance is judged by an HTML5 parser (linkedom, the repo's devDependency) reading the rendered document, apart from
 * the implementation: exactly one live element with the part's id, it is the server's own `<a>` (an `id` and nothing else), it
 * is not inside an authored raw-text element, and the heading after it is visible text.
 */
import { parseHTML } from 'linkedom';
import { describe, expect, it } from 'vitest';
import { escapeUnterminatedHtml } from './unterminatedHtml.js';
import { renderSpecDocument, type DocInput, type DocPart } from './render.js';

const part = (loc: string, body: string | null, name = 'Rule: Entry'): DocPart => ({
  loc, name, body, isPlaceholder: false, superseded: false, supersededBy: [], approval: { state: 'NOT_APPROVED' }, minted: false,
});
const doc = (parts: DocPart[], feature: DocPart = part('fx:110', 'Feature body.', 'Feature: F')): DocInput =>
  ({ memory: 'synthetic:specs', renderedAt: new Date('2026-11-06T00:00:00Z'), feature, parts, links: new Map() });
const RAW_TEXT_ANCESTORS = 'pre,textarea,script,style,title,xmp,iframe,noembed,noframes,noscript,plaintext';

/** What an HTML5 parser makes of the document, for the anchor of `loc`. */
function probe(html: string, id: string) {
  const { document } = parseHTML(`<!doctype html><html><body>${html}</body></html>`);
  const hits = document.querySelectorAll(`[id="${id}"]`);
  const el = document.getElementById(id);
  return {
    count: hits.length,
    tag: el?.tagName,
    attrs: el ? [...el.attributes].map((a: { name: string }) => a.name) : [],
    insideAuthored: el ? el.closest(RAW_TEXT_ANCESTORS) !== null : null,
    text: document.body.textContent ?? '',
  };
}

const THREE = (aBody: string, extra: Partial<DocPart> = {}): DocInput =>
  doc([part('fx:110:a', aBody, 'Rule: First'), part('fx:110:b', 'second body', 'Rule: Second'), part('fx:110:c', 'third body', 'Rule: Third')].map((p, i) => (i === 0 ? { ...p, ...extra } : p)));

function expectNextAnchorSurvives(out: string): void {
  for (const id of ['fx-110-b', 'fx-110-c']) {
    const r = probe(out, id);
    expect(r, id).toMatchObject({ count: 1, tag: 'A', attrs: ['id'], insideAuthored: false });
  }
  const b = probe(out, 'fx-110-b');
  expect(b.text).toContain('Rule: Second [fx:110:b]');
  expect(b.text).toContain('Rule: Third [fx:110:c]');
  // The server's own block, unchanged: the anchor on its own line before the heading (ruling 0206).
  expect(out).toContain('<a id="fx-110-b"></a>\n\n## Rule: Second [fx:110:b]\nApproval: NOT_APPROVED');
}

describe('#5033 the filing\'s three outcomes', () => {
  it('control: a body ending in plain text keeps one anchor', () => {
    expectNextAnchorSurvives(renderSpecDocument(THREE('authored text')));
  });
  it('`<pre x=` no longer absorbs the anchor as an attribute of the authored element', () => {
    expectNextAnchorSurvives(renderSpecDocument(THREE('authored <pre x=')));
  });
  it('`<pre x=\'` no longer swallows the anchor and the next heading', () => {
    expectNextAnchorSurvives(renderSpecDocument(THREE("authored <pre x='")));
  });
});

describe('#5033 the class, not two spellings', () => {
  const OPEN: Array<[string, string]> = [
    ['an open tag with no attributes', 'text <div'],
    ['an open tag, double-quoted value', 'text <a href="x'],
    ['an open tag after a closed one', '<b>bold</b> then <i class='],
    ['a quoted value that holds a `>`, then an open attribute', 'text <a title=">" x='],
    ['an unclosed quoted value that holds a `>`', 'text <a title="a > b'],
    ['a bare textarea', 'text <textarea>'],
    ['a bare script', 'text <script>'],
    ['a bare style', 'text <style>'],
    ['a bare title', 'text <title>'],
    ['a bare xmp', 'text <xmp>'],
    ['plaintext', 'text <plaintext>'],
    ['an uppercase raw-text tag', 'text <TEXTAREA rows="2">content'],
    ['an end tag left open', 'text </div'],
    ['a comment', 'text <!-- a note'],
    ['a declaration', 'text <!DOCTYPE html'],
    ['a CDATA section', 'text <![CDATA[ data'],
    ['a processing instruction', 'text <?xml version="1.0"'],
    ['a line-start pre block', '<pre>\ncode lines\nmore'],
    ['a line-start tag spanning lines', 'text <a\nhref="x"\nclass='],
    ['a tag that a blank-line paragraph does not close', 'one <b\n\ntwo'],
  ];
  it.each(OPEN)('%s at a body end keeps the next anchor', (_label, body) => {
    const out = renderSpecDocument(THREE(body));
    expectNextAnchorSurvives(out);
  });

  it('the Feature body ending open does not absorb the first group heading or the first anchor', () => {
    const out = renderSpecDocument(doc([part('fx:110:b', 'second body', 'Rule: Second')], part('fx:110', "Feature body <pre x='", 'Feature: F')));
    expect(probe(out, 'fx-110-b')).toMatchObject({ count: 1, tag: 'A', attrs: ['id'], insideAuthored: false });
    expect(probe(out, 'fx-110-b').text).toContain('Rule: Second [fx:110:b]');
  });

  it('a heading (a spec name) that ends open does not absorb its own state line, body or the next anchor', () => {
    const out = renderSpecDocument(doc([
      part('fx:110:a', 'a body', "Rule: First <pre x='"),
      part('fx:110:b', 'second body', 'Rule: Second'),
    ]));
    expect(probe(out, 'fx-110-b')).toMatchObject({ count: 1, tag: 'A', attrs: ['id'], insideAuthored: false });
    expect(probe(out, 'fx-110-b').text).toContain('Approval: NOT_APPROVED');
  });

  it('shows the same text: the escape is a character reference to the same `<`', () => {
    const out = renderSpecDocument(THREE('authored <pre x='));
    expect(out).toContain('authored &lt;pre x=');
    expect(probe(out, 'fx-110-a').text).toContain('authored <pre x=');
  });

  it('#4512 still holds: an authored id equal to an assigned anchor, inside the open construct, is not live', () => {
    const out = renderSpecDocument(THREE('<pre id="fx-110-b" x='));
    expect(probe(out, 'fx-110-b')).toMatchObject({ count: 1, tag: 'A', attrs: ['id'] });
  });
});

describe('#5033 refusals: nothing else changes', () => {
  const UNCHANGED = [
    'plain text',
    '<b>bold</b> and <i>italic</i>',
    '<pre>done</pre>',
    'x <pre>unclosed inline pre is harmless in an HTML5 reader',
    '<div class="x">y</div>',
    '<a title="a > b">link</a>',
    '<!-- closed -->',
    '<!---->',
    '<!-->',
    '<![CDATA[ x ]]>',
    '<?php echo 1 ?>',
    '<textarea>x</textarea>',
    '<SCRIPT>alert(1)</SCRIPT>',
    'a < b and c > d',
    'if x <= y then',
    'ends with a lone <',
    'inline code `<pre x=` stays as written',
    'double backticks `` <pre x= `` stay as written',
    'escaped \\<pre x= stays as written',
    '```html\n<pre x=\n```',
    '~~~\n<textarea>\n~~~',
    '    <pre x= (an indented code sample is left alone)',
    'text\n\n```html\n<div\n```\n\nmore',
  ];
  it.each(UNCHANGED)('left byte-for-byte: %j', (body) => {
    expect(escapeUnterminatedHtml(body)).toBe(body);
    const out = renderSpecDocument(THREE(body));
    expect(out).toContain(body.replace(/\n+$/, ''));
  });

  it('a document with no unterminated construct renders as the plain-text control does, per part', () => {
    const base = renderSpecDocument(THREE('authored text'));
    expect(base).not.toContain('&lt;');
  });
});

describe('escapeUnterminatedHtml', () => {
  it('escapes only the opening `<` of the open construct', () => {
    expect(escapeUnterminatedHtml("a <b>ok</b> then <pre x='")).toBe("a <b>ok</b> then &lt;pre x='");
  });
  it('a construct after an escaped one is judged on its own', () => {
    expect(escapeUnterminatedHtml('<a <b <c')).toBe('&lt;a &lt;b &lt;c');
    expect(escapeUnterminatedHtml("<a x='1 <b>ok</b> <c")).toBe("&lt;a x='1 <b>ok</b> &lt;c");
  });
  it('is idempotent', () => {
    for (const s of ["x <pre x='", 'a <!-- b', '<a <b', 'y <textarea>z', 'plain']) {
      const once = escapeUnterminatedHtml(s);
      expect(escapeUnterminatedHtml(once)).toBe(once);
    }
  });
  it('a raw-text element closed by its own end tag is complete; another element\'s end tag does not close it', () => {
    expect(escapeUnterminatedHtml('<textarea>x</textarea>')).toBe('<textarea>x</textarea>');
    expect(escapeUnterminatedHtml('<textarea>x</script>')).toBe('&lt;textarea>x</script>');
    expect(escapeUnterminatedHtml('<script>x</scriptx>')).toBe('&lt;script>x</scriptx>');
  });
  it('the block rule: a line-start pre needs one of the four closers; an inline pre needs none', () => {
    expect(escapeUnterminatedHtml('<pre>\nx')).toBe('&lt;pre>\nx');
    expect(escapeUnterminatedHtml('<pre>\nx\n</pre>')).toBe('<pre>\nx\n</pre>');
    expect(escapeUnterminatedHtml('  <pre>\nx')).toBe('  &lt;pre>\nx');
    expect(escapeUnterminatedHtml('word <pre>\nx')).toBe('word <pre>\nx');
  });
  it('stays linear on a body of thousands of stray `<a`', () => {
    const body = '<a '.repeat(20000);
    const t0 = Date.now();
    const out = escapeUnterminatedHtml(body);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(out).not.toMatch(/<a /);
    expect(out.length).toBe(body.length + 3 * 20000);
  });
  it('stays linear on thousands of unmatched backtick runs', () => {
    const body = '` ``'.repeat(15000) + ' <pre x=';
    const t0 = Date.now();
    const out = escapeUnterminatedHtml(body);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(out.endsWith(' &lt;pre x=')).toBe(true);
  });
});
