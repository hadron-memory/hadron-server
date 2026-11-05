/** #1302 — the grammar pieces of cor:spc:030:02 that the integration golden does not reach. */
import { describe, expect, it } from 'vitest';
import {
  hasOpenQuestions, inDocumentOrder, renderSpecDocument, specGroupOf, splitAtClosingRule, wikilinkTargets, type DocPart,
} from './render.js';

const part = (loc: string, name: string, body: string | null, extra: Partial<DocPart> = {}): DocPart => ({
  loc, name, body, isPlaceholder: false, superseded: false, supersededBy: [], approval: { state: 'NOT_APPROVED' }, minted: false, ...extra,
});
const at = new Date('2026-11-04T10:12:00Z');

describe('type words', () => {
  it('the group comes from the name\'s first word followed by a colon, never from the body', () => {
    expect(specGroupOf('Rule: x')).toBe('Rule');
    expect(specGroupOf('Rule x')).toBe('Other');
    expect(specGroupOf('rule: x')).toBe('Other');
    expect(specGroupOf('Widget: x')).toBe('Other');
    expect(specGroupOf('cor:dmo:020:01 — Node ordering')).toBe('Other');
  });
  it('groups in the ruled order, stable inside a group', () => {
    const names = ['Module: m', 'Rule: b', 'Other thing', 'Definition: d', 'Rule: a', 'Format: f', 'Operation: o'];
    expect(inDocumentOrder(names.map((name) => ({ name }))).map((p) => p.name))
      .toEqual(['Definition: d', 'Rule: b', 'Rule: a', 'Operation: o', 'Format: f', 'Module: m', 'Other thing']);
  });
});

describe('the closing rule', () => {
  it('cuts at the first standalone --- outside fenced code; a body with none is all body', () => {
    expect(splitAtClosingRule('a\n---\nb\n---\nc')).toEqual({ body: 'a', tail: 'b\n---\nc' });
    expect(splitAtClosingRule('a\n```\n---\n```\nb')).toEqual({ body: 'a\n```\n---\n```\nb', tail: '' });
    expect(splitAtClosingRule('no rule here')).toEqual({ body: 'no rule here', tail: '' });
  });
});

describe('open questions and links', () => {
  it('an Open Questions section counts only with a bullet in it', () => {
    expect(hasOpenQuestions('## Open Questions\n\n- Who decides?')).toBe(true);
    expect(hasOpenQuestions('## Open Questions\n\nNone.\n\n## Next\n- a bullet elsewhere')).toBe(false);
    expect(hasOpenQuestions('## Notes\n- not a question')).toBe(false);
  });
  it('wikilink targets are read outside fenced code only', () => {
    expect(wikilinkTargets('[[a:b|x]] and [[c:d]]\n```\n[[e:f]]\n```')).toEqual(['a:b', 'c:d']);
  });
});

describe('the document', () => {
  const feature = part('x:1', 'Feature: F', '# Feature: F\n\nBody.\n\n---\n\n## Where This Came From\n\n- tail');
  it('a part with no closing --- shows its whole body, headings moved down one level', () => {
    const md = renderSpecDocument({ memory: 'o:m', renderedAt: at, feature, links: new Map(), parts: [part('x:1:1', 'Rule: R', '# Rule: R\n\n## Sub\n\ntext')] });
    expect(md).toContain('## Rule: R [x:1:1]\nApproval: NOT_APPROVED · Mint: unminted\n\n### Sub\n\ntext\n');
  });
  it('a retired part with no superseded-by edge shows only Superseded., and a nested pointer lists its targets', () => {
    const md = renderSpecDocument({
      memory: 'o:m', renderedAt: at, feature, links: new Map(),
      parts: [part('x:1:1', 'Rule: R', 'gone', { superseded: true }), part('x:1:2', 'Rule: S', 'gone', { superseded: true, supersededBy: ['x:1:3', 'x:1:4'] })],
    });
    expect(md).toContain('[x:1:1]\nApproval: NOT_APPROVED · Mint: unminted\nSuperseded.\n');
    expect(md).toContain('Superseded by x:1:3, x:1:4.\n');
    expect(md).not.toContain('gone');
  });
  it('the same input gives the same bytes, and the time is the only clock', () => {
    const input = { memory: 'o:m', feature, links: new Map(), parts: [] as DocPart[] };
    expect(renderSpecDocument({ ...input, renderedAt: at })).toBe(renderSpecDocument({ ...input, renderedAt: at }));
    expect(renderSpecDocument({ ...input, renderedAt: new Date(at.getTime() + 3_600_000) })).toContain('rendered 2026-11-04T11:12Z');
  });
});
