/**
 * Tests for the #1722 SDL spec-citation gate. Synthetic strings, so a schema
 * edit never turns one red; what they pin is the classifier (the portal gate's
 * own) and the ratchet.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { compareWithBaseline, findBareCitations, parseBaseline } from './check-sdl-spec-citations.mjs';

describe('#1722 — findBareCitations', () => {
  it('finds a bare citation, at any depth, and its line', () => {
    expect(findBareCitations('a\n  Readers: (cor:agt:050:21).\nx cor:agt:050 and cor:acl:010:01:02')).toEqual([
      { line: 2, citation: 'cor:agt:050:21' },
      { line: 3, citation: 'cor:agt:050' },
      { line: 3, citation: 'cor:acl:010:01:02' },
    ]);
  });

  it('accepts a fully qualified one, and the legacy urn:node: scheme', () => {
    expect(findBareCitations('(hrn:node:hadronmemory.com:specs:cor:agt:050:21) urn:node:x:specs:cor:agt:050:01')).toEqual([]);
  });

  it('a memory slug without hrn:node: is still bare (the token decides, not the character before)', () => {
    expect(findBareCitations('hadronmemory.com:specs:cor:agt:050:21')).toEqual([{ line: 1, citation: 'cor:agt:050:21' }]);
  });

  it('a range cites its head: hrn:node:…:cor:agt:050:14–:17 is clean, the bare form is one finding', () => {
    expect(findBareCitations('(hrn:node:hadronmemory.com:specs:cor:agt:050:14–:17)')).toEqual([]);
    expect(findBareCitations('(cor:agt:050:14–:17)')).toHaveLength(1);
  });

  it('prose with colons is not a citation (three letters, three digits, then pairs)', () => {
    expect(findBareCitations('cor:agents:050 or cor:agt:50:01 or core:agt:050')).toEqual([]);
  });

  it('an identifier that merely starts like a citation is not one; a sentence colon after one is', () => {
    expect(findBareCitations('cor:dmo:060:12abc cor:dmo:060:12-x')).toEqual([]);
    expect(findBareCitations('per cor:api:090: the rule')).toEqual([{ line: 1, citation: 'cor:api:090' }]);
  });
});

describe('#1722 — the baseline ratchet', () => {
  const baseline = parseBaseline('# note\ncor:agt:020:03 2\n\ncor:acl:040:02 1\n');
  const at = (citation: string, line = 1) => ({ citation, line });

  it('within the baseline passes; a qualified old one makes the baseline lowerable', () => {
    expect(compareWithBaseline([at('cor:agt:020:03'), at('cor:agt:020:03')], baseline)).toEqual({
      over: [], lowerable: [{ citation: 'cor:acl:040:02', count: 0, allowed: 1 }],
    });
  });

  it('one more than the baseline fails, and so does a citation with no entry', () => {
    const { over } = compareWithBaseline([at('cor:acl:040:02', 3), at('cor:acl:040:02', 9), at('cor:agt:050:21', 7)], baseline);
    expect(over).toEqual([
      { citation: 'cor:acl:040:02', count: 2, allowed: 1, lines: [3, 9] },
      { citation: 'cor:agt:050:21', count: 1, allowed: 0, lines: [7] },
    ]);
  });

  it('the real SDL is within the real baseline', () => {
    const found = findBareCitations(readFileSync(new URL('../src/api/graphql/schema/typeDefs.ts', import.meta.url), 'utf8'));
    const base = parseBaseline(readFileSync(new URL('./sdl-spec-citations-baseline.txt', import.meta.url), 'utf8'));
    expect(compareWithBaseline(found, base).over).toEqual([]);
  });
});
