/** #4967 (BLIND F4): the join behind appendContent / prependContent, as a pure function. */
import { describe, it, expect } from 'vitest';
import { joinAppendedContent, DEFAULT_APPEND_SEPARATOR } from './appendContent.js';

describe('joinAppendedContent (#340)', () => {
  const cases: Array<[string, string | null, Parameters<typeof joinAppendedContent>[1], string | null]> = [
    ['append', 'B', { appendContent: 'T' }, 'B\n\nT'],
    ['prepend', 'B', { prependContent: 'H' }, 'H\n\nB'],
    ['both', 'B', { prependContent: 'H', appendContent: 'T' }, 'H\n\nB\n\nT'],
    ['custom separator', 'B', { prependContent: 'H', appendContent: 'T', separator: '|' }, 'H|B|T'],
    ['"" separator concatenates', 'B', { prependContent: 'H', appendContent: 'T', separator: '' }, 'HBT'],
    ['null body gets no stray separator', null, { appendContent: 'T' }, 'T'],
    ['"" body gets no stray separator', '', { prependContent: 'H' }, 'H'],
    ['null body, both sides', null, { prependContent: 'H', appendContent: 'T' }, 'H\n\nT'],
    ['whitespace-only body is content', '  ', { appendContent: 'T' }, '  \n\nT'],
    ['empty parts contribute nothing', 'B', { prependContent: '', appendContent: '' }, 'B'],
    ['every part empty: a null body stays null', null, { appendContent: '' }, null],
    ['every part empty: a "" body stays ""', '', {}, ''],
    ['separator with nothing to join is unused', 'B', { separator: '|' }, 'B'],
  ];
  for (const [label, existing, parts, expected] of cases) {
    it(label, () => expect(joinAppendedContent(existing, parts)).toBe(expected));
  }
  it('the default separator is a blank line', () => expect(DEFAULT_APPEND_SEPARATOR).toBe('\n\n'));
});
