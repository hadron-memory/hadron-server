/** #4512 / cor:spc:030:02 "Authored ids": an authored id equal to an assigned anchor is removed; any other authored text stays. */
import { describe, expect, it } from 'vitest';
import { neutraliseAssignedIds, renderSpecDocument, type DocInput, type DocPart } from './render.js';

const part = (loc: string, body: string | null, name = 'Rule: Entry'): DocPart => ({
  loc, name, body, isPlaceholder: false, superseded: false, supersededBy: [], approval: { state: 'NOT_APPROVED' }, minted: false,
});
function doc(parts: DocPart[], feature: DocPart = part('fx:110', 'Feature body.', 'Feature: F')): DocInput {
  return { memory: 'synthetic:specs', renderedAt: new Date('2026-11-06T00:00:00Z'), feature, parts, links: new Map() };
}
const count = (s: string, needle: string) => s.split(needle).length - 1;
const COLLIDING = '<a id="fx-110-a"></a>\n\n## Rule: Entry [fx:110:a]\n\nauthored text';

describe('#4512 authored ids equal to an assigned anchor', () => {
  it('the colliding authored anchor-then-heading copy is neutralised: exactly one id, on the server block', () => {
    const out = renderSpecDocument(doc([part('fx:110:a', COLLIDING)]));
    expect(count(out, 'id="fx-110-a"')).toBe(1);
    expect(out).toContain('<a id="fx-110-a"></a>\n\n## Rule: Entry [fx:110:a]\nApproval: NOT_APPROVED');
    expect(out).toContain('authored text');
    expect(out).toContain('### Rule: Entry [fx:110:a]');
  });
  it('removes only the id attribute, leaving the other attributes and text', () => {
    const out = renderSpecDocument(doc([part('fx:110:a', '<div class="x" id=\'fx-110-a\' title="t">hi</div>')]));
    expect(out).toContain('<div class="x" title="t">hi</div>');
    expect(count(out, 'fx-110-a"')).toBe(1);
  });
  it.each([
    ['unquoted', '<span id=fx-110-a>s</span>', '<span>s</span>'],
    ['upper-case attribute name', '<span ID="fx-110-a">s</span>', '<span>s</span>'],
    ['spaces around =', '<span id = "fx-110-a">s</span>', '<span>s</span>'],
    ['tag spread over lines', '<span\n  class="c"\n  id="fx-110-a">s</span>', '<span\n  class="c">s</span>'],
  ])('%s', (_n, body, kept) => {
    const out = renderSpecDocument(doc([part('fx:110:a', body)]));
    expect(out).toContain(kept);
    expect(out).not.toMatch(/id\s*=\s*["']?fx-110-a(?!["']?><\/a>\n\n## Rule)/i);
  });
  it('an authored id equal to a SUFFIXED assigned anchor is neutralised too', () => {
    const out = renderSpecDocument(doc([part('fx:110:a-b', 'x'), part('fx:110:a:b', '<a id="fx-110-a-b-2"></a>')]));
    expect(count(out, 'id="fx-110-a-b-2"')).toBe(1);
    expect(out.indexOf('id="fx-110-a-b-2"')).toBeLessThan(out.indexOf('## Rule: Entry [fx:110:a:b]'));
  });
  it('the Feature body and the Feature tail are neutralised as well, the tail after the Rules section', () => {
    const feature = part('fx:110', '<a id="fx-110-a"></a>head\n\n---\n\n<a id="fx-110-a"></a>tail', 'Feature: F');
    const out = renderSpecDocument(doc([part('fx:110:a', 'x')], feature));
    expect(count(out, 'id="fx-110-a"')).toBe(1);
    expect(out.indexOf('head')).toBeLessThan(out.indexOf('# Rules'));
    expect(out.indexOf('tail')).toBeGreaterThan(out.indexOf('## Rule: Entry [fx:110:a]'));
    expect(out.endsWith('<a></a>tail\n')).toBe(true);
  });
  it('an unassigned authored id is untouched', () => {
    const body = '<a id="my-own-anchor"></a>\n\ntext <span id="fx-110-zzz">z</span>';
    const out = renderSpecDocument(doc([part('fx:110:a', body)]));
    expect(out).toContain('<a id="my-own-anchor"></a>');
    expect(out).toContain('<span id="fx-110-zzz">z</span>');
  });
  it('fenced code and inline code that show an id are untouched', () => {
    const body = 'Write `<a id="fx-110-a"></a>` like so:\n\n```html\n<a id="fx-110-a"></a>\n```\n\n~~~\n<a id="fx-110-a"></a>\n~~~';
    const out = renderSpecDocument(doc([part('fx:110:a', body)]));
    expect(count(out, 'id="fx-110-a"')).toBe(4);
  });
  it('an attribute VALUE that mentions an id is not an id, and the real id beside it still goes', () => {
    const out = renderSpecDocument(doc([part('fx:110:a', '<a title="see id=fx-110-a here" id="fx-110-a" href="#x">l</a>')]));
    expect(out).toContain('<a title="see id=fx-110-a here" href="#x">l</a>');
    expect(count(out, 'id="fx-110-a"')).toBe(1);
  });
  it('a body with no colliding id renders byte-for-byte as before', () => {
    const out = renderSpecDocument(doc([part('fx:110:a', 'Rule body.')]));
    const rich = 'a <b>x</b>  <div  class = "c"\tdata-x=\'1\'>t</div>\r\n\r\n`code <a id="other">` ~ <br/>';
    const same = renderSpecDocument(doc([part('fx:110:a', rich)]));
    expect(same).toBe(renderSpecDocument(doc([part('fx:110:a', rich)])));
    expect(same).toContain(rich.replace(/\r\n/g, '\r\n'));
    expect(out).toBe('# Feature: F [fx:110]\n\nsynthetic:specs · rendered 2026-11-06T00:00Z\n\nReadiness: 2 specs · 0 approved · 0 minted · 0 superseded · no open questions\n\nFeature body.\n\n# Rules\n\n<a id="fx-110-a"></a>\n\n## Rule: Entry [fx:110:a]\nApproval: NOT_APPROVED · Mint: unminted\n\nRule body.\n');
  });
});

describe('#4512 the scanner on its own (review findings)', () => {
  const A = new Set(['fx-110-a']);
  const run = (t: string) => neutraliseAssignedIds(t, A);
  it('a stray backtick in an earlier paragraph does not hide an id in a later one', () => {
    expect(run('it`s odd\n\n<a id="fx-110-a"></a> and `code` x')).toBe('it`s odd\n\n<a></a> and `code` x');
  });
  it('a stray backtick does not eat the opener of a real code span', () => {
    expect(run('a ` b\n\n`<a id="fx-110-a"></a>`')).toBe('a ` b\n\n`<a id="fx-110-a"></a>`');
  });
  it('backtick runs of different lengths are not a code span', () => {
    expect(run('``<a id="fx-110-a"></a>`')).toBe('``<a></a>`');
    expect(run('``<a id="fx-110-a"></a>``')).toBe('``<a id="fx-110-a"></a>``');
  });
  it('an escaped backtick does not open a span', () => {
    expect(run('\\`<a id="fx-110-a"></a>`')).toBe('\\`<a></a>`');
  });
  it('a backtick inside an attribute value does not hide a real id', () => {
    expect(run('<a title="`" id="fx-110-a"></a> `')).toBe('<a title="`"></a> `');
  });
  it('no separator or a slash before the attribute', () => {
    expect(run('<div class="x"id="fx-110-a">')).toBe('<div class="x">');
    expect(run('<div/id="fx-110-a">')).toBe('<div/>');
  });
  it('text inside another attribute value is never cut', () => {
    expect(run('<div class="x"title="see id=fx-110-a">')).toBe('<div class="x"title="see id=fx-110-a">');
  });
  it('prose with < and apostrophes does not hide a real tag', () => {
    expect(run('a <b, don\'t <a id="fx-110-a"></a> it\'s fine <br>')).toBe('a <b, don\'t <a></a> it\'s fine <br>');
  });
  it('an escaped tag is shown text and stays', () => {
    expect(run('\\<a id="fx-110-a">')).toBe('\\<a id="fx-110-a">');
  });
  it('a numeric character reference in the id is decoded before comparing', () => {
    expect(run('<a id="fx&#45;110-a"></a>')).toBe('<a></a>');
    expect(run('<a id="fx&#x2d;110-zz"></a>')).toBe('<a id="fx&#x2d;110-zz"></a>');
  });
  it('is linear on hostile input', () => {
    const t0 = Date.now();
    run('<a'.repeat(20000) + '\n\n' + '`'.repeat(20000) + '<a id="x" '.repeat(5000) + '"'.repeat(20000));
    run('`a '.repeat(20000));
    expect(Date.now() - t0).toBeLessThan(1500);
  });
});
