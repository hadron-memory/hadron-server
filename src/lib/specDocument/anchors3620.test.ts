/**
 * #3620 (refs #3551, PR #3616): placeholder and superseded parts emit an anchor even though they show no body, so
 * they compete with ordinary parts for natural and suffixed anchors. Test-only coverage; expected IDs are literal
 * contract oracles, never produced by the assigner. No duplicate-loc policy is pinned here.
 */
import { describe, expect, it } from 'vitest';
import { renderSpecDocument, type DocInput, type DocPart, type LinkResolution } from './render.js';

type Kind = 'ordinary' | 'placeholder' | 'superseded';
interface Spec { loc: string; kind: Kind; name?: string }

const part = (loc: string, name: string, kind: Kind): DocPart => ({
  loc, name,
  body: kind === 'placeholder' ? null : 'Body.',
  isPlaceholder: kind === 'placeholder',
  superseded: kind === 'superseded',
  supersededBy: kind === 'superseded' ? ['fx:110:replacement'] : [],
  approval: { state: 'NOT_APPROVED' },
  minted: false,
});

/** The colliding parts carry no links; an ordinary `fx:110:zz-linker` part, the feature body and its tail link to each. */
function build(specs: Spec[]): { doc: DocInput; links: string } {
  const links = new Map<string, LinkResolution>(specs.map((s, i) => [s.loc, { kind: 'part', loc: s.loc, name: `entry${i}` }]));
  const linkText = specs.map((s, i) => `[[${s.loc}|link${i}]]`).join(' ');
  const linker = { ...part('fx:110:zz-linker', 'Rule: Linker', 'ordinary'), body: linkText };
  const doc: DocInput = {
    memory: 'synthetic:specs',
    renderedAt: new Date('2026-11-06T00:00:00Z'),
    feature: { ...part('fx:110', 'Feature: F', 'ordinary'), body: `${linkText}\n---\n${linkText}` },
    parts: [...specs.map(s => part(s.loc, s.name ?? 'Rule: Entry', s.kind)), linker],
    links,
  };
  return { doc, links: linkText };
}

/** `ids` are the expected declarations of `specs`, in document order, before the linker's own `fx-110-zz-linker`. */
function expectAnchors(specs: Spec[], ids: string[], order: string[] = specs.map(s => s.loc)) {
  const { doc } = build(specs);
  const rendered = renderSpecDocument(doc);
  const declared = [...rendered.matchAll(/<a id="([^"]+)"><\/a>/g)].map(m => m[1]);
  expect(declared.filter(id => id !== 'fx-110-zz-linker')).toEqual(ids);
  expect(new Set(declared).size).toBe(declared.length);
  // Each link resolves to its own part's declaration, in the feature body, the linker body and the feature tail.
  specs.forEach((s, i) => {
    const id = ids[order.indexOf(s.loc)];
    expect(rendered.split(`[link${i}](#${id})`).length - 1, `${s.loc} -> ${id}`).toBe(3);
  });
  expect(renderSpecDocument(doc)).toBe(rendered);
  return rendered;
}

describe.each<Kind>(['placeholder', 'superseded'])('#3620 %s part competing for anchors', (kind) => {
  it('claims the bare anchor when first; the ordinary colliding part takes -2', () => {
    const rendered = expectAnchors([{ loc: 'fx:110:a-b', kind }, { loc: 'fx:110:a:b', kind: 'ordinary' }], ['fx-110-a-b', 'fx-110-a-b-2']);
    expect(rendered).toContain('<a id="fx-110-a-b"></a>');
  });

  it('takes -2 when an ordinary part holds the bare anchor first', () => {
    expectAnchors([{ loc: 'fx:110:a-b', kind: 'ordinary' }, { loc: 'fx:110:a:b', kind }], ['fx-110-a-b', 'fx-110-a-b-2']);
  });

  it('its natural ID is reserved against a generated suffix even though it shows no body', () => {
    // fx-110-a-b-2 is the bodyless part's own natural anchor, so the second collider must skip to -3.
    expectAnchors(
      [{ loc: 'fx:110:a-b', kind: 'ordinary' }, { loc: 'fx:110:a:b', kind: 'ordinary' }, { loc: 'fx:110:a-b-2', kind }],
      ['fx-110-a-b', 'fx-110-a-b-3', 'fx-110-a-b-2'],
    );
  });

  it('reserves the natural ID when the bodyless part sorts before the colliders too', () => {
    expectAnchors(
      [{ loc: 'fx:110:a-b-2', kind }, { loc: 'fx:110:a-b', kind: 'ordinary' }, { loc: 'fx:110:a:b', kind: 'ordinary' }],
      ['fx-110-a-b-2', 'fx-110-a-b', 'fx-110-a-b-3'],
    );
  });

  it('competes across type groups in final document order, not citation order', () => {
    // Definition group renders before Rule, so the Definition-group part takes the bare anchor.
    const rendered = expectAnchors(
      [{ loc: 'fx:110:a-b', kind: 'ordinary', name: 'Rule: R' }, { loc: 'fx:110:a:b', kind, name: 'Definition: D' }],
      ['fx-110-a-b', 'fx-110-a-b-2'],
      ['fx:110:a:b', 'fx:110:a-b'],
    );
    expect(rendered.indexOf('## Definition: D')).toBeLessThan(rendered.indexOf('## Rule: R'));
  });
});

describe('#3620 placeholder and superseded parts together with an ordinary part', () => {
  it('three colliders of different kinds get distinct smallest suffixes in order', () => {
    expectAnchors(
      [{ loc: 'fx:110:a-b-c', kind: 'placeholder' }, { loc: 'fx:110:a:b-c', kind: 'superseded' }, { loc: 'fx:110:a-b:c', kind: 'ordinary' }],
      ['fx-110-a-b-c', 'fx-110-a-b-c-2', 'fx-110-a-b-c-3'],
    );
  });

  it('bodyless natural suffix IDs of both kinds are reserved against generated ones', () => {
    expectAnchors(
      [
        { loc: 'fx:110:a-b-c', kind: 'ordinary' }, { loc: 'fx:110:a:b-c', kind: 'ordinary' }, { loc: 'fx:110:a-b:c', kind: 'ordinary' },
        { loc: 'fx:110:a-b-c-2', kind: 'placeholder' }, { loc: 'fx:110:a-b-c-3', kind: 'superseded' },
      ],
      ['fx-110-a-b-c', 'fx-110-a-b-c-4', 'fx-110-a-b-c-5', 'fx-110-a-b-c-2', 'fx-110-a-b-c-3'],
    );
  });

  it('a superseded part still shows its anchor and state line; a placeholder shows Placeholder.', () => {
    const rendered = expectAnchors([{ loc: 'fx:110:a-b', kind: 'superseded' }, { loc: 'fx:110:a:b', kind: 'placeholder' }], ['fx-110-a-b', 'fx-110-a-b-2']);
    expect(rendered).toContain('<a id="fx-110-a-b"></a>\n\n## Rule: Entry [fx:110:a-b]\nApproval: NOT_APPROVED · Mint: unminted\n\nSuperseded by fx:110:replacement.');
    expect(rendered).toContain('<a id="fx-110-a-b-2"></a>\n\n## Rule: Entry [fx:110:a:b]\nApproval: NOT_APPROVED · Mint: unminted\n\nPlaceholder.');
  });
});
