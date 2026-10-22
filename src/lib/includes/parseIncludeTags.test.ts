import { describe, expect, it } from 'vitest';
import { splitNodeUrn } from '@hadron-memory/urn-lib-js';
import { IncludeSyntaxError, locateIncludeTags, parseIncludeTags } from './parseIncludeTags.js';

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
  it('treats a multi-line inline code span as literal', () => {
    expect(parseIncludeTags('`hello\n{{> a bogus}}\nworld` {{> ok}}').map(t => t.target)).toEqual(['ok']);
    expect(parseIncludeTags('`one` para\n\n{{> a bogus')).toEqual([]);
  });
  it('only a bare fence of sufficient length closes a fence', () => {
    const c = '```\ntext\n``` trailing text\n{{> a bogus}}\n```\n{{> real}}';
    expect(parseIncludeTags(c).map(t => t.target)).toEqual(['real']);
  });
  it('a code span does not run across a blank line', () => {
    expect(parseIncludeTags('a ` b\n\n{{> real}} c ` d').map(t => t.target)).toEqual(['real']);
  });
  it('refuses an unknown setting, a repeat, rev=0 and a missing target', () => {
    for (const bad of ['{{> a nope}}', '{{> a rev=1 rev=2}}', '{{> a rev=0}}', '{{> }}']) {
      expect(() => parseIncludeTags(bad)).toThrow(IncludeSyntaxError);
    }
  });
  it('refuses a malformed URN target', () => {
    expect(() => parseIncludeTags('{{> hrn:node:}}')).toThrow(IncludeSyntaxError);
  });

  it.each(['hrn:node:acme.com::mem::a:b', 'hrn:node:acme.com::mem'])('refuses v1 include syntax: %s (#2251, R78)', target => {
    expect(() => parseIncludeTags(`x {{> ${target} }} y`)).toThrow(IncludeSyntaxError);
  });

  it('keeps flat-v2 settings and exact offsets after literal v1 examples (#2251)', () => {
    const literal = '{{> hrn:node:acme.com::mem::a:b }}';
    const raw = '{{>hrn:node:acme.com:mem:a:b signed rev=2 approved }}';
    const content = [`\`${literal}\``, '', '```', literal, '```', '', `    ${literal}`, '', `😀 ${raw} tail {{> a:b}}`].join('\n');
    const tags = locateIncludeTags(content);
    expect(tags).toEqual([
      { kind: 'urn', target: 'hrn:node:acme.com:mem:a:b', settings: { signed: true, rev: 2, approved: true }, raw, index: content.indexOf(raw) },
      { kind: 'loc', target: 'a:b', settings: {}, raw: '{{> a:b}}', index: content.indexOf('{{> a:b}}') },
    ]);
    for (const tag of tags) expect(content.slice(tag.index, tag.index + tag.raw.length)).toBe(tag.raw);
  });

  it('does not remove global legacy node-URN acceptance (#2251)', () => {
    expect(splitNodeUrn('hrn:node:acme.com::mem::a:b')).toMatchObject({ memoryUrn: 'acme.com:mem', loc: 'a:b' });
  });
});
