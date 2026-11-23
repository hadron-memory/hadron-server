/** #4512 / cor:spc:030:02 "Authored ids": an authored id equal to an assigned anchor is removed; any other authored text stays. */
import { describe, expect, it } from 'vitest';
import { renderSpecDocument, type DocInput, type DocPart } from './render.js';

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
  it('the Feature body and the Feature tail are neutralised as well', () => {
    const feature = part('fx:110', '<a id="fx-110-a"></a>head\n---\n<a id="fx-110-a"></a>tail', 'Feature: F');
    const out = renderSpecDocument(doc([part('fx:110:a', 'x')], feature));
    expect(count(out, 'id="fx-110-a"')).toBe(1);
    expect(out).toContain('head');
    expect(out).toContain('tail');
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
  it('an attribute VALUE that mentions an id is not an id', () => {
    const out = renderSpecDocument(doc([part('fx:110:a', '<a title=\'id="fx-110-a"\' href="#x">l</a>')]));
    expect(out).toContain('<a title=\'id="fx-110-a"\' href="#x">l</a>');
  });
  it('a body with no colliding id renders byte-for-byte as before', () => {
    const out = renderSpecDocument(doc([part('fx:110:a', 'Rule body.')]));
    expect(out).toBe('# Feature: F [fx:110]\n\nsynthetic:specs · rendered 2026-11-06T00:00Z\n\nReadiness: 2 specs · 0 approved · 0 minted · 0 superseded · no open questions\n\nFeature body.\n\n# Rules\n\n<a id="fx-110-a"></a>\n\n## Rule: Entry [fx:110:a]\nApproval: NOT_APPROVED · Mint: unminted\n\nRule body.\n');
  });
});
