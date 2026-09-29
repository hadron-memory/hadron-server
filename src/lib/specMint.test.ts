/** #1448: the pure half of the mint report (ported lint, citation scope, open questions). */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  isCitationLoc,
  lintCorpusForMint,
  lintNodeForMint,
  parseOpenQuestions,
  type MintLintNode,
} from './specMint.js';

const fixtures = JSON.parse(readFileSync(new URL('./specMint.fixtures.json', import.meta.url), 'utf8')) as {
  cases: Array<{ name: string; node: Omit<MintLintNode, 'loc'>; expect: string[] }>;
};

describe('mint lint: the shared fixture (#1448)', () => {
  it.each(fixtures.cases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    expect(lintNodeForMint({ loc: 'pas:010:01', ...c.node }).map((f) => f.rule)).toEqual(c.expect);
  });
});

describe('isCitationLoc: the CLI ParseCitation scope', () => {
  it.each([
    ['pas', true], ['pas:010', true], ['pas:010:01', true], ['pas:010:01:02', true],
    ['cor:agt:020:01', true], ['cor:agt:020:01:03', true], ['cor:agt', true],
    ['specs-draft', false], ['pas:10', false], ['pas:010:1', false], ['Pas:010', false],
    ['cor:agt:020:01:03:04', false], ['findings:x', false], ['pas:0101', false],
  ])('%s → %s', (loc, want) => {
    expect(isCitationLoc(loc)).toBe(want);
  });

  it('skips non-citation nodes (a memory root) and reports duplicates once', () => {
    const base = { nodeType: 'info', tags: ['spec'], role: null, abstract: null, content: null };
    const findings = lintCorpusForMint([
      { ...base, loc: 'specs-draft', nodeType: 'data', tags: [] }, // the memory root: out of scope
      { ...base, loc: 'pas:010' },
      { ...base, loc: 'pas:010' },
      { ...base, loc: 'pas:010' },
    ]);
    expect(findings).toEqual([{ loc: 'pas:010', rule: 'duplicate-loc', message: expect.any(String) }]);
  });
});

describe('parseOpenQuestions (ruling (b))', () => {
  it('reads Micromentor\'s format: bold question, trailing "<Name> decides.", wrapped lines', () => {
    const body = [
      '## States', '', '- Not a question. Duygu decides.', '',
      '## Open Questions, Need Ruling', '',
      '- **What does Log out do: does it ask first?** The source leaves',
      '  both open. Duygu decides.',
      '- **Which help centre address?** The source leaves both open (its open question 4). Holger or Jane decides.',
      '- **Unowned one?** Nobody said.',
      '', '---', '', '- Not a question either. Duygu decides.',
    ].join('\n');
    expect(parseOpenQuestions(body)).toEqual([
      { question: 'What does Log out do: does it ask first?', decider: 'Duygu' },
      { question: 'Which help centre address?', decider: 'Holger or Jane' },
      { question: 'Unowned one?', decider: null },
    ]);
  });

  it('matches any heading level, case-insensitively, and ends at the next heading at the same or a higher level', () => {
    const body = [
      '### open questions', '- First. Ada decides.', '#### Sub-detail', '- Still in the section. Bo decides.',
      '### Next section', '- Out. Cy decides.',
    ].join('\n');
    expect(parseOpenQuestions(body).map((q) => q.decider)).toEqual(['Ada', 'Bo']);
  });

  it('ignores fenced code and bodies without the section', () => {
    expect(parseOpenQuestions('```\n## Open Questions\n- x. Ada decides.\n```')).toEqual([]);
    expect(parseOpenQuestions('Just prose.')).toEqual([]);
    expect(parseOpenQuestions(null)).toEqual([]);
  });
});
