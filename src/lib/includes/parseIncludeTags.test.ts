import { describe, expect, it } from 'vitest';
import { IncludeSyntaxError, parseIncludeTags } from './parseIncludeTags.js';

describe('parseIncludeTags (#2040)', () => {
  it('parses a loc, settings and keeps the raw text', () => {
    expect(parseIncludeTags('a {{> foo:bar rev=2 approved signed}} b')).toEqual([
      { kind: 'loc', target: 'foo:bar', settings: { rev: 2, approved: true, signed: true }, raw: '{{> foo:bar rev=2 approved signed}}' },
    ]);
  });
  it('parses a node URN target', () => {
    const t = parseIncludeTags('{{> hrn:node:acme:docs:intro approved}}');
    expect(t[0]).toMatchObject({ kind: 'urn', target: 'hrn:node:acme:docs:intro', settings: { approved: true } });
  });
  it('treats tags in code as literal text', () => {
    const c = ['`{{> a}}`', '', '```', '{{> b}}', '```', '', '    {{> c}}', '', '{{> d}}'].join('\n');
    expect(parseIncludeTags(c).map(t => t.target)).toEqual(['d']);
  });
  it('refuses an unknown setting, a repeat, rev=0 and a missing target', () => {
    for (const bad of ['{{> a nope}}', '{{> a rev=1 rev=2}}', '{{> a rev=0}}', '{{> }}']) {
      expect(() => parseIncludeTags(bad)).toThrow(IncludeSyntaxError);
    }
  });
  it('refuses a malformed URN target', () => {
    expect(() => parseIncludeTags('{{> hrn:node:}}')).toThrow(IncludeSyntaxError);
  });
});
