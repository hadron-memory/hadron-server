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
    ['a comment that holds a `>`', 'text <!-- a > b'],
    ['a declaration', 'text <!DOCTYPE html'],
    ['a CDATA section', 'text <![CDATA[ data'],
    ['a processing instruction', 'text <?xml version="1.0"'],
    ['a line-start pre block', '<pre>\ncode lines\nmore'],
    ['a line-start tag spanning lines', 'text <a\nhref="x"\nclass='],
    ['a tag that a blank-line paragraph does not close', 'one <b\n\ntwo'],
    // BLIND P1-1: a partial end tag matches the closer lookahead but never reaches `>`.
    ['a raw-text element whose end tag has no `>`', 'a <script>b</script c'],
    ['a textarea whose end tag stops at an attribute', 'a <textarea>b</textarea attr='],
    // BLIND P1-2 (a closer inside a code span, a fence or after a backslash is no closer) is a Markdown-level reading; the
    // harness here parses the raw string, where it would pass vacuously, so it is pinned on the scanner below.
    // LOCAL P2-1: `</` and a non-letter is a bogus comment up to the next `>`.
    ['`</` at the end', 'a </'],
    ['`</` and a blank', 'a </ b'],
    ['`</` and a digit', 'x </3'],
    ['`</` and a quote', 'x </"'],
    ['`</` and a bang', 'a </!'],
    ['`<//`', 'a <//'],
    ['`</` and a question mark', 'a </? b'],
    // LOCAL P3-2: an unclosed template holds the anchor in its inert content.
    ['an unclosed template', 'a <template>'],
    // LOCAL delta P2-2: an unclosed template that comes BEFORE another escaped construct must not be forgotten by the restart.
    ['an unclosed template, then an unterminated PI', '<template><?x>'],
    ['an unclosed template, then an unterminated comment', '<template><!--'],
    ['an unclosed template, then an open tag', '<template> a <b'],
    ['an unclosed template, then an unterminated CDATA', '<template><![CDATA[x'],
    ['an unclosed template, then an open tag (BLIND delta P1)', 'a <template>x <b y='],
    ['an unclosed template, then an open tag, at the head of the line', '<template><div class='],
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
    'a </> stays',
    'a </b> and </i> stay',
    'a <script>b</script> and <style>c</style>',
    'a <script>b</SCRIPT >c',
    'a <template>x</template>',
    'text\n    <pre>\nx (a four-space continuation line is not a pre block)',
    '> quoted\n>\n>     <pre x= (a code sample in a blockquote)',
    '>     <pre x= (a code sample in a blockquote)',
    '<!-- closed -->',
    '<!-- a > b -->',
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
  it('a partial end tag leaves the element open, so BOTH the element and the end tag are escaped', () => {
    expect(escapeUnterminatedHtml('a <script>b</script c')).toBe('a &lt;script>b&lt;/script c');
    expect(escapeUnterminatedHtml('<textarea>x</textarea attr=')).toBe('&lt;textarea>x&lt;/textarea attr=');
  });
  it('an inline raw-text element is closed only by an end tag outside code and not escaped by a backslash', () => {
    expect(escapeUnterminatedHtml('a <script>b `</script>` c')).toBe('a &lt;script>b `</script>` c');
    expect(escapeUnterminatedHtml('a <script>b ``</script>`` c</script>')).toBe('a <script>b ``</script>`` c</script>');
    expect(escapeUnterminatedHtml('a <script>b \\</script>')).toBe('a &lt;script>b \\</script>');
    expect(escapeUnterminatedHtml('a <script>b</script>')).toBe('a <script>b</script>');
  });
  it('a line-start raw-text block is closed by a closer anywhere after it (CommonMark type 1)', () => {
    expect(escapeUnterminatedHtml('<script>\nx `</script>` y')).toBe('<script>\nx `</script>` y');
  });
  it('`</` and a non-letter is closed by a later `>`; `</>` is complete', () => {
    expect(escapeUnterminatedHtml('a </ b >c')).toBe('a </ b >c');
    expect(escapeUnterminatedHtml('a </ b')).toBe('a &lt;/ b');
    expect(escapeUnterminatedHtml('a </>')).toBe('a </>');
  });
  it('the restart cap: a later complete tag survives up to the cap, and the bulk escape past it covers every `<` left', () => {
    expect(escapeUnterminatedHtml('<a x=\'1 <b x="2 <i>ok</i> <c')).toBe('&lt;a x=\'1 &lt;b x="2 <i>ok</i> &lt;c');
    for (const n of [31, 32, 33, 40]) expect(escapeUnterminatedHtml('<a '.repeat(n))).toBe('&lt;a '.repeat(n));
  });
  it('a line-start pre block starts within three spaces of indent, not four', () => {
    expect(escapeUnterminatedHtml('   <pre>\nx')).toBe('   &lt;pre>\nx');
    expect(escapeUnterminatedHtml('text\n    <pre>\nx')).toBe('text\n    <pre>\nx');
  });
  it('a CDATA section is closed by `]]>`, not by `]>`', () => {
    expect(escapeUnterminatedHtml('<![CDATA[ x ]> y')).toBe('&lt;![CDATA[ x ]> y');
    expect(escapeUnterminatedHtml('<![CDATA[ x ]]> y')).toBe('<![CDATA[ x ]]> y');
  });
  it('CDATA and a processing instruction end for the browser at the first `>`, so what follows them is still read', () => {
    expect(escapeUnterminatedHtml('<?><style>?>')).toBe('<?>&lt;style>?>');
    expect(escapeUnterminatedHtml('<![CDATA[ a > b <style> ]]>')).toBe('<![CDATA[ a > b &lt;style> ]]>');
    expect(escapeUnterminatedHtml('<?xml version="1.0"?> <b>x</b>')).toBe('<?xml version="1.0"?> <b>x</b>');
  });
  it('a template is open until its own end tag, and its content is read as usual', () => {
    expect(escapeUnterminatedHtml('a <template>x</template>')).toBe('a <template>x</template>');
    expect(escapeUnterminatedHtml('a <template><template>x</template>')).toBe('a &lt;template><template>x</template>');
    expect(escapeUnterminatedHtml('a <template><style></template>')).toBe('a &lt;template>&lt;style></template>');
  });
  it('an end tag is `</name` and a blank or `>`: `</name/` closes nothing', () => {
    expect(escapeUnterminatedHtml('a <textarea>x</textarea/>')).toBe('a &lt;textarea>x</textarea/>');
    expect(escapeUnterminatedHtml('a <textarea>x</textarea >')).toBe('a <textarea>x</textarea >');
  });
  it('an unclosed template before another escaped construct is escaped too, and the result is a fixed point', () => {
    for (const body of ['<template><?x>', '<template><!--', '<template> a <b', '<template><![CDATA[x']) {
      const once = escapeUnterminatedHtml(body);
      expect(once, body).toMatch(/^&lt;template>/);
      expect(escapeUnterminatedHtml(once), body).toBe(once);
    }
  });
  it('a code span never crosses a block boundary: a heading, a fence or a quote ends the paragraph (BLIND delta P2)', () => {
    const cases: Array<[string, string]> = [
      ['a heading', 'a `x\n## H\n<b x=\'\ny`'],
      ['a fence', 'a `x\n```\nc\n```\n<b x=\'\ny`'],
      ['a quote', 'a `x\n> q\n<b x=\'\ny`'],
      ['a list item', 'a `x\n- item\n<b x=\'\ny`'],
      ['a thematic break', 'a `x\n***\n<b x=\'\ny`'],
      ['a CRLF blank line', 'a `x\r\n\r\n<b x=\'\r\ny`'],
    ];
    for (const [label, body] of cases) expect(escapeUnterminatedHtml(body), label).toBe(body.replace('<b x=', '&lt;b x='));
    // One paragraph with no interrupting line is still one span: the construct inside it is code.
    expect(escapeUnterminatedHtml("a `x\n<b x='\ny` w")).toBe("a `x\n<b x='\ny` w");
  });
  it('stays linear on a body of thousands of stray `<a`', () => {
    const body = '<a '.repeat(40000);
    const t0 = Date.now();
    const out = escapeUnterminatedHtml(body);
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(out).not.toMatch(/<a /);
    expect(out.length).toBe(body.length + 3 * 40000);
  }, 60_000);
  it('stays linear on thousands of unmatched backtick runs', () => {
    const body = '` ``'.repeat(30000) + ' <pre x=';
    const t0 = Date.now();
    const out = escapeUnterminatedHtml(body);
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(out.endsWith(' &lt;pre x=')).toBe(true);
  }, 60_000);
});
