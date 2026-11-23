/**
 * #4512 / cor:spc:030:02 "Authored ids": an authored `id` attribute equal to an anchor assigned in this document is
 * renamed `data-id` (Peter's approach ruling, chat 143451). Every review probe of #4991 (D5, E1-E5, F1-F5, G1-G5, QA and
 * local findings) is a pin here: it must end with no live assigned id and no byte changed but the attribute name.
 */
import { describe, expect, it } from 'vitest';
import { neutraliseAssignedIds, renderSpecDocument, type DocInput, type DocPart } from './render.js';

const A = new Set(['fx-110-a']);
const run = (t: string): string => neutraliseAssignedIds(t, A);
/** A live assigned id: an `id` attribute (not data-id, not a query key) whose value is the anchor. */
// An oracle written apart from the implementation: it ignores data-id first, decodes every numeric reference itself and
// uses word boundaries, so a rename that the implementation misjudges still reads as live here.
const decodeAll = (t: string): string => t.replace(/&#(?:x([0-9a-f]+)|([0-9]+));?/gi, (_a, h?: string, d?: string) => String.fromCodePoint(h ? parseInt(h, 16) : parseInt(d as string, 10)));
const live = (t: string): boolean => /\bid[\s>]*=[\s>]*["']?fx-110-a(?![\w-])/i.test(decodeAll(run(t)).replace(/data-id/gi, ''));
/** The probe input itself must read as live to the oracle, so a pin cannot pass by being inert. */
const liveBefore = (t: string): boolean => /\bid[\s>]*=[\s>]*["']?fx-110-a(?![\w-])/i.test(decodeAll(t));

const part = (loc: string, body: string | null, name = 'Rule: Entry'): DocPart => ({
  loc, name, body, isPlaceholder: false, superseded: false, supersededBy: [], approval: { state: 'NOT_APPROVED' }, minted: false,
});
const doc = (parts: DocPart[], feature: DocPart = part('fx:110', 'Feature body.', 'Feature: F')): DocInput =>
  ({ memory: 'synthetic:specs', renderedAt: new Date('2026-11-06T00:00:00Z'), feature, parts, links: new Map() });
const count = (s: string, needle: string): number => s.split(needle).length - 1;

describe('#4512 the renamed attribute, in a rendered document', () => {
  it('the colliding authored anchor-then-heading copy: exactly one id, on the server block', () => {
    const out = renderSpecDocument(doc([part('fx:110:a', '<a id="fx-110-a"></a>\n\n## Rule: Entry [fx:110:a]\n\nauthored text')]));
    expect(count(out, ' id="fx-110-a"')).toBe(1);
    expect(out).toContain('<a id="fx-110-a"></a>\n\n## Rule: Entry [fx:110:a]\nApproval: NOT_APPROVED');
    expect(out).toContain('<a data-id="fx-110-a"></a>');
    expect(out).toContain('authored text');
  });
  it('a suffixed assigned anchor is neutralised too, and the server block keeps it', () => {
    const out = renderSpecDocument(doc([part('fx:110:a-b', 'x'), part('fx:110:a:b', '<a id="fx-110-a-b-2"></a>')]));
    expect(count(out, ' id="fx-110-a-b-2"')).toBe(1);
    expect(out.indexOf(' id="fx-110-a-b-2"')).toBeLessThan(out.indexOf('## Rule: Entry [fx:110:a:b]'));
  });
  it('the Feature body and the Feature tail are neutralised, the tail after the Rules section', () => {
    const feature = part('fx:110', '<a id="fx-110-a"></a>head\n\n---\n\n<a id="fx-110-a"></a>tail', 'Feature: F');
    const out = renderSpecDocument(doc([part('fx:110:a', 'x')], feature));
    expect(count(out, ' id="fx-110-a"')).toBe(1);
    expect(out).toContain('head');
    expect(out.indexOf('head')).toBeLessThan(out.indexOf('# Rules'));
    expect(out.indexOf('tail')).toBeGreaterThan(out.indexOf('## Rule: Entry [fx:110:a]'));
    expect(out.endsWith('<a data-id="fx-110-a"></a>tail\n')).toBe(true);
  });
  it('a body with no collision renders byte for byte as before, HTML, code and CRLF included', () => {
    const rich = 'a <b>x</b>  <div  class = "c"\tdata-x=\'1\'>t</div>\r\n\r\n`code <a id="other">` ~ <br/> data-id="fx-110-a" ?id=fx-110-a';
    expect(renderSpecDocument(doc([part('fx:110:a', rich)]))).toContain(rich);
    expect(renderSpecDocument(doc([part('fx:110:a', 'Rule body.')]))).toBe('# Feature: F [fx:110]\n\nsynthetic:specs · rendered 2026-11-06T00:00Z\n\nReadiness: 2 specs · 0 approved · 0 minted · 0 superseded · no open questions\n\nFeature body.\n\n# Rules\n\n<a id="fx-110-a"></a>\n\n## Rule: Entry [fx:110:a]\nApproval: NOT_APPROVED · Mint: unminted\n\nRule body.\n');
  });
  it('a very long body (150k lines) renders', () => {
    const body = 'a\n'.repeat(150000) + '<a id="fx-110-a"></a>';
    expect(run(body).endsWith('<a data-id="fx-110-a"></a>')).toBe(true);
    expect(count(renderSpecDocument(doc([part('fx:110:a', body)])), ' id="fx-110-a"')).toBe(1);
  });
});

describe('#4512 what is renamed, and only that', () => {
  it.each([
    ['double quotes', '<a id="fx-110-a">', '<a data-id="fx-110-a">'],
    ['single quotes', "<a id='fx-110-a'>", "<a data-id='fx-110-a'>"],
    ['unquoted', '<span id=fx-110-a>s</span>', '<span data-id=fx-110-a>s</span>'],
    ['upper-case name', '<span ID="fx-110-a">s</span>', '<span data-id="fx-110-a">s</span>'],
    ['spaces around =', '<span id = "fx-110-a">s</span>', '<span data-id = "fx-110-a">s</span>'],
    ['tag over several lines', '<span\n  class="c"\n  id="fx-110-a">s</span>', '<span\n  class="c"\n  data-id="fx-110-a">s</span>'],
    ['no separator', '<div class="x"id="fx-110-a">', '<div class="x"data-id="fx-110-a">'],
    ['slash separator', '<div/id="fx-110-a">', '<div/data-id="fx-110-a">'],
    ['bare value before the closing slash (D5)', '<a href=/x id=fx-110-a/>', '<a href=/x data-id=fx-110-a/>'],
    ['numeric reference', '<a id="fx&#45;110-a">', '<a data-id="fx&#45;110-a">'],
    ['numeric reference without the semicolon', '<a id="fx-110&#45a">', '<a data-id="fx-110&#45a">'],
  ])('%s', (_n, body, expected) => {
    expect(run(body)).toBe(expected);
    expect(live(body)).toBe(false);
  });
  it.each([
    ['an unassigned id', '<a id="other"></a>'],
    ['an id in a longer name', '<a data-id="fx-110-a" xid="fx-110-a" my:id="fx-110-a" a.id="fx-110-a">'],
    ['a URL query key or fragment', 'see https://x.test/p?id=fx-110-a&id=fx-110-a#id=fx-110-a now'],
    ['a bare value that only starts like the anchor', '<a id=fx-110-ab>'],
    ['an id whose value is the anchor plus a slash path', '<a id=fx-110-a/b>'],
  ])('is untouched: %s', (_n, body) => {
    expect(run(body)).toBe(body);
  });
  it('the value of another attribute that mentions an id is renamed too, the rest of the tag stays', () => {
    expect(run('<a title="see id=fx-110-a here" id="fx-110-a" href="#x">l</a>'))
      .toBe('<a title="see data-id=fx-110-a here" data-id="fx-110-a" href="#x">l</a>');
  });
});

describe('#4512 review probes: no live assigned id', () => {
  it('F1/G1: nested cuts cannot join into a live id, at any depth', () => {
    expect(live('<a id="id=\'fx-110-a\'fx-110-a">')).toBe(false);
    for (const depth of [3, 64, 65, 200]) {
      let inner = 'fx-110-a';
      for (let i = 0; i < depth; i += 1) { const q = i % 2 ? '"' : "'"; inner = `id=${q}${inner}${q}fx-110-a`; }
      expect(live(`<a ${inner}>`)).toBe(false);
    }
  });
  it.each([
    ['G2: a quote in a comment', '<!-- \' --><a title="\'>" id="fx-110-a">'],
    ['G2: an apostrophe in an unquoted value', '<div title=a\'b><a title="\'>" id="fx-110-a">'],
    ['G2: backticks and quotes', '`<a "` <b title=\'">\' id="fx-110-a">'],
    ['G2: an apostrophe before the slash form', '<div title=it\'s /id="fx-110-a">'],
    ['G3: a tag over a blank line', '<pre\n\nid="fx-110-a">x</pre>'],
    ['G3: a tag in a pre block over a blank line', '<pre>\n<a\n\nid="fx-110-a">x</a></pre>'],
    ['G4: a very long tag name', `<x-${'a'.repeat(90)} id="fx-110-a">`],
    ['G4: an underscore tag name', '<div><x_y id="fx-110-a"></x_y></div>'],
    ['G4: a dotted tag name', '<div><x.y id="fx-110-a">'],
    ['G5: nested markers with two spaces', '> > <a\n>  >id="fx-110-a">x</a>'],
    ['G5: a marker in a list item', '10. > <a\n    >id="fx-110-a">x</a>'],
    ['F2/F11: slashes between attributes', '<a b="c"/id="fx-110-a"> <a b/id=fx-110-a> <a//id="fx-110-a"> <div hidden/id="fx-110-a"> <div a=b /id="fx-110-a">'],
    ['F3/F12: a marker directly before the name', '> <a\n>id="fx-110-a">x</a>'],
    ['F12: nested markers and a CR line break', '> > <a\n> >id="fx-110-a">x</a> <a\r>id="fx-110-a">'],
    ['E1/F9: an unassigned id= opens a quote first', '<a title="id=" id="fx-110-a"> say id=" then <b id="fx-110-a"> end"'],
    ['E5: a marker between = and the value', '> <a id=\n> "fx-110-a">x</a> <a id=\n> > "fx-110-a">'],
    ['E5: a break before the =', '> <a id\n> ="fx-110-a">'],
    ['QA P2: comment openers that never close', '<!--> <b id="fx-110-a"> <!---> <b id="fx-110-a"> <!-- a --!> <b id="fx-110-a"> <![CDATA[ <b id="fx-110-a"> <? <b id="fx-110-a">'],
    ['D6: a namespaced tag', '<o:p class="x" id="fx-110-a">'],
    ['F5: a marker after id= outside a quote', '<div id=\n>fx-110-a</div> <div id="fx-110-a"\n>'],
  ])('%s', (_n, body) => {
    expect(liveBefore(body)).toBe(true);
    expect(live(body)).toBe(false);
  });
  it('F1 (blind full): zero-padded character references still match', () => {
    expect(run('<a id="fx&#x000002d;110-a">')).toBe('<a data-id="fx&#x000002d;110-a">');
    expect(run('<a id="fx&#0000000045;110-a">')).toBe('<a data-id="fx&#0000000045;110-a">');
    expect(live('<a id="fx&#0000045;110-a"> <a id="fx&#x00002D;110-a">')).toBe(false);
  });
  it('F5 (blind full): an entity-encoded query separator is not an attribute', () => {
    expect(run('see https://x.test/p?a=1&amp;id=fx-110-a now')).toBe('see https://x.test/p?a=1&amp;id=fx-110-a now');
  });
  it('F2 (blind full): part and Feature names in headings are neutralised', () => {
    const feature = part('fx:110', 'Feature body.', 'Feature: F <a id="fx-110-a"></a>');
    const out = renderSpecDocument(doc([part('fx:110:a', 'x', 'Rule: R <span id=\'fx-110-a\'>')], feature));
    expect(count(out, ' id="fx-110-a"')).toBe(1);
    expect(out).toContain('# Feature: F <a data-id="fx-110-a"></a> [fx:110]');
    expect(out).toContain("## Rule: R <span data-id='fx-110-a'> [fx:110:a]");
  });
  it('the text outside the renamed attribute is byte for byte unchanged (F4/G7/G8: no line is cut, none is added)', () => {
    const body = '<a\n  id="fx-110-a"\n  class="c">x</a>\n> <a\n> id="fx-110-a"\n> class="c">\r\n<a id="fx-110-a" id="fx-110-a"\n  class="c">';
    const out = run(body);
    expect(out).toBe(body.replace(/\bid="fx-110-a"/g, 'data-id="fx-110-a"'));
    expect(out.length - body.length).toBe(5 * count(body, 'id="fx-110-a"'));
  });
});

describe('#4512 linear time on hostile input', () => {
  it('G10 and the older quadratic cases', () => {
    const t0 = Date.now();
    run(`id=\n${'>'.repeat(300000)}`);
    run(`id${' '.repeat(300000)}`);
    run('<a'.repeat(20000) + '\n\n' + '`'.repeat(20000) + '<a id="x" '.repeat(5000) + '"'.repeat(20000));
    run('<a x='.repeat(40000) + '>');
    run('id="'.repeat(40000));
    run(`id="${'id= '.repeat(60000)}"`);
    run('id="a" '.repeat(40000));
    run(' '.repeat(200000) + 'id');
    run('<!-- <b id="x"> '.repeat(20000) + '<![CDATA['.repeat(20000));
    run('<a x="<a x=\'<a x="'.repeat(8000));
    expect(Date.now() - t0).toBeLessThan(5000);
  });
});
