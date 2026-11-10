/** #1449: finding and rewriting references into a draft spec corpus, as pure text operations. */
import { describe, expect, it } from 'vitest';
import {
  corpusReferencePattern,
  findCorpusReferences,
  findNodeUrnTokens,
  findTextCitations,
  renumberedLoc,
  rewriteCorpusReferences,
} from './specReferences.js';

const P = corpusReferencePattern(['micromentor.org:specs-draft']);
const locs = (t: string) => findCorpusReferences(t, P).map((r) => r.targetLoc);

describe('findCorpusReferences', () => {
  it('finds the URN inside a portal URL, on any host, and stops at the closing paren', () => {
    const t = '[Rule: vacation [pas:010:01]](https://hadronmemory.com/app/u/hrn:node:micromentor.org:specs-draft:pas:010:01) and '
      + '[x](https://portal.example.test/app/u/hrn:node:micromentor.org:specs-draft:pas:020).';
    expect(locs(t)).toEqual(['pas:010:01', 'pas:020']);
  });

  it('accepts every node-URN spelling: hrn/urn prefix in any case, no prefix, canonical :: separators', () => {
    expect(locs('hrn:node:micromentor.org:specs-draft:a:1')).toEqual(['a:1']);
    expect(locs('URN:NODE:micromentor.org:specs-draft:a:2')).toEqual(['a:2']);
    expect(locs('see micromentor.org::specs-draft::a:3 here')).toEqual(['a:3']);
    expect(locs('micromentor.org:specs-draft:a:4')).toEqual(['a:4']);
  });

  it('ignores other memories, a longer org or memory name, and a bare memory URN with no loc', () => {
    expect(locs('hrn:node:micromentor.org:specs:pas:010')).toEqual([]);
    expect(locs('hrn:node:micromentor.org:specs-draft-2:pas:010')).toEqual([]);
    expect(locs('hrn:node:xmicromentor.org:specs-draft:pas:010')).toEqual([]);
    expect(locs('hrn:mem:micromentor.org:specs-draft and nothing else')).toEqual([]);
  });

  it('does not match inside a canonical URN whose final :: leaf is a deeper loc (@codex P2 on #1453)', () => {
    // resolveNodeRef: memory `micromentor.org::specs-draft::pas:010`, loc `child`.
    expect(locs('hrn:node:micromentor.org::specs-draft::pas:010::child')).toEqual([]);
    expect(locs('micromentor.org:specs-draft:pas:010::child and micromentor.org::specs-draft::pas:020.')).toEqual(['pas:020']);
    expect(rewriteCorpusReferences('hrn:node:micromentor.org::specs-draft::pas:010::child', P, 'pas:010', 'pas:040'))
      .toEqual({ text: 'hrn:node:micromentor.org::specs-draft::pas:010::child', count: 0 });
  });

  it('rejects mixed separator styles, which the resolver rejects too (@codex P2 on #1453)', () => {
    expect(locs('hrn:node:micromentor.org::specs-draft:pas:010')).toEqual([]);
    expect(locs('hrn:node:micromentor.org:specs-draft::pas:010')).toEqual([]);
    expect(locs('micromentor.org::specs-draft:pas:010 then micromentor.org::specs-draft::pas:020')).toEqual(['pas:020']);
    expect(rewriteCorpusReferences('hrn:node:micromentor.org::specs-draft:pas:010', P, 'pas:010', 'pas:040'))
      .toEqual({ text: 'hrn:node:micromentor.org::specs-draft:pas:010', count: 0 });
  });

  it('does not swallow sentence punctuation, but keeps dots inside an atom', () => {
    expect(locs('Cite micromentor.org:specs-draft:pas:010:01.')).toEqual(['pas:010:01']);
    expect(locs('Cite micromentor.org:specs-draft:v1.2:intro, then')).toEqual(['v1.2:intro']);
    expect(locs('Cite micromentor.org:specs-draft:pas:010...')).toEqual(['pas:010']);
    expect(locs('Cite micromentor.org:specs-draft:pas:010.. next')).toEqual(['pas:010']);
  });

  it('does not report references with an atom longer than the 64-character loc limit (#1478)', () => {
    expect(locs(`hrn:node:micromentor.org:specs-draft:${'a'.repeat(64)}`)).toEqual(['a'.repeat(64)]);
    expect(locs(`hrn:node:micromentor.org:specs-draft:${'a'.repeat(65)}`)).toEqual([]);
    expect(locs(`hrn:node:micromentor.org:specs-draft:pas:${'b'.repeat(65)}`)).toEqual([]);
    const dotted = `hrn:node:micromentor.org:specs-draft:${'a'.repeat(64)}.x`;
    expect(locs(dotted)).toEqual([]);
    expect(rewriteCorpusReferences(dotted, P, 'a'.repeat(64), 'pas:040')).toEqual({ text: dotted, count: 0 });
    const repeatedDot = `hrn:node:micromentor.org:specs-draft:${'a'.repeat(64)}..x`;
    expect(locs(repeatedDot)).toEqual([]);
    expect(rewriteCorpusReferences(repeatedDot, P, 'a'.repeat(64), 'pas:040'))
      .toEqual({ text: repeatedDot, count: 0 });
  });

  it('also matches under a URN the corpus was published under before a rename', () => {
    const renamed = corpusReferencePattern(['micromentor.org:specs-draft', 'micromentor.org:specs-new']);
    expect(findCorpusReferences('hrn:node:micromentor.org:specs-new:pas:1 and hrn:node:micromentor.org:specs-draft:pas:2', renamed)
      .map((r) => r.targetLoc)).toEqual(['pas:1', 'pas:2']);
  });
});

describe('renumber rewrite', () => {
  it('maps the spec and its descendants only', () => {
    expect(renumberedLoc('pas:010', 'pas:010', 'pas:020')).toBe('pas:020');
    expect(renumberedLoc('pas:010:01', 'pas:010', 'pas:020')).toBe('pas:020:01');
    expect(renumberedLoc('pas:0101', 'pas:010', 'pas:020')).toBeNull();
    expect(renumberedLoc('pas:011', 'pas:010', 'pas:020')).toBeNull();
  });

  it('rewrites only the loc of each matching URN and keeps its spelling', () => {
    const t = '[a [pas:010:01]](https://h/app/u/hrn:node:micromentor.org:specs-draft:pas:010:01), '
      + 'micromentor.org::specs-draft::pas:010, hrn:node:micromentor.org:specs-draft:pas:011';
    const { text, count } = rewriteCorpusReferences(t, P, 'pas:010', 'pas:020');
    expect(count).toBe(2);
    expect(text).toBe('[a [pas:010:01]](https://h/app/u/hrn:node:micromentor.org:specs-draft:pas:020:01), '
      + 'micromentor.org::specs-draft::pas:020, hrn:node:micromentor.org:specs-draft:pas:011');
  });

  it('uses the current memory name for former URNs while keeping their separator style and URL', () => {
    const pattern = corpusReferencePattern(['micromentor.org:specs-old', 'micromentor.org:specs-new']);
    const text = '[x](https://h/app/u/URN:NODE:micromentor.org::specs-old::pas:010) '
      + 'hrn:node:micromentor.org:specs-old:pas:010';
    expect(rewriteCorpusReferences(text, pattern, 'pas:010', 'pas:040', () => true, 'micromentor.org:specs-new'))
      .toEqual({
        text: '[x](https://h/app/u/URN:NODE:micromentor.org::specs-new::pas:040) '
          + 'hrn:node:micromentor.org:specs-new:pas:040',
        count: 2,
      });
  });

  it('returns the text unchanged when nothing matches', () => {
    expect(rewriteCorpusReferences('no refs here', P, 'pas:010', 'pas:020')).toEqual({ text: 'no refs here', count: 0 });
  });
});

describe('findTextCitations', () => {
  it('reports bare citations (labels, names, prose) outside URNs, including descendants', () => {
    const t = 'Feature: Vacation mode [pas:010] — see [Rule [pas:010:01]](https://h/app/u/hrn:node:micromentor.org:specs-draft:pas:010:01).';
    expect(findTextCitations(t, P, 'pas:010').map((c) => c.citation)).toEqual(['pas:010', 'pas:010:01']);
  });

  it('does not report a longer or unrelated citation', () => {
    expect(findTextCitations('pas:0101 and xpas:010 and pas:011', P, 'pas:010')).toEqual([]);
  });

  it('treats a dotted continuation as a different citation, but not sentence punctuation (@codex P2)', () => {
    expect(findTextCitations('Versioned pas:010.v2 stays.', P, 'pas:010')).toEqual([]);
    expect(findTextCitations('See pas:010. Then more.', P, 'pas:010').map((c) => c.citation)).toEqual(['pas:010']);
    expect(findTextCitations('See pas:010:01.v2 too', P, 'pas:010').map((c) => c.citation)).toEqual(['pas:010:01.v2']);
    expect(findTextCitations('See pas:010._v2 too', P, 'pas:010')).toEqual([]);
    expect(findTextCitations('See pas:010..v2 too', P, 'pas:010')).toEqual([]);
    expect(findTextCitations('See pas:010... Then more.', P, 'pas:010').map((c) => c.citation)).toEqual(['pas:010']);
    expect(findTextCitations('See pas:010.. next', P, 'pas:010').map((c) => c.citation)).toEqual(['pas:010']);
  });
});

describe('findNodeUrnTokens (#1594)', () => {
  it('finds prefixed node URNs in either style and case, inside a portal URL, without trailing punctuation', () => {
    expect(findNodeUrnTokens(
      'See hrn:node:a.org:m:cor:010, (urn:NODE:a.org::m::cor:020). [x](https://p.test/app/u/hrn:node:b.org:n:pas:1.5) end.',
    )).toEqual(['hrn:node:a.org:m:cor:010', 'urn:NODE:a.org::m::cor:020', 'hrn:node:b.org:n:pas:1.5']);
  });
  it('ignores unprefixed addresses, longer prefixes and a missing loc, and deduplicates', () => {
    expect(findNodeUrnTokens('a.org:m:cor:010 xhrn:node:a.org:m:cor:1 hrn:node:a.org hrn:memory:a.org:m')).toEqual([]);
    expect(findNodeUrnTokens('hrn:node:a.org:m:l hrn:node:a.org:m:l')).toEqual(['hrn:node:a.org:m:l']);
    expect(findNodeUrnTokens(null)).toEqual([]);
  });
});
