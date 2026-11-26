import { afterEach, expect, it, vi } from 'vitest';
import { reportPhraseRanking, type PhraseResult } from './agentTaskPhraseReport2665.js';

afterEach(() => vi.restoreAllMocks());
const hit = (loc: string, matchedBy: string) => ({ node: { loc }, matchedBy });
const rows: PhraseResult[] = [
  { phrase: 'first', expectedLoc: 'tasks:z', hits: [hit('tasks:z', 'BOTH'), hit('tasks:a', 'VECTOR'), hit('tasks:m', 'KEYWORD')] },
  { phrase: 'second', expectedLoc: 'tasks:a', hits: [hit('tasks:z', 'VECTOR'), hit('tasks:a', 'KEYWORD')] },
  { phrase: 'third', expectedLoc: 'tasks:m', hits: [hit('tasks:z', 'KEYWORD'), hit('tasks:a', 'VECTOR'), hit('tasks:m', 'BOTH')] },
  { phrase: 'miss', expectedLoc: 'tasks:absent', hits: [hit('tasks:z', 'VECTOR')] },
  { phrase: 'empty', expectedLoc: 'tasks:absent', hits: [] },
];

it('emits ordered candidates with their own reasons, one-based ranks, empty slots and a total', () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(reportPhraseRanking(rows)).toBe(3);
  expect(log.mock.calls.map(call => call[0])).toEqual([
    'Fixed synthetic/provisional phrase benchmark (hermetic keyword/fallback; not live-vector or real-world recall)',
    'Phrase | Expected loc | Top 3 (ranked loc [matchedBy]) | Expected rank',
    'first | tasks:z | tasks:z [BOTH]; tasks:a [VECTOR]; tasks:m [KEYWORD] | 1',
    'second | tasks:a | tasks:z [VECTOR]; tasks:a [KEYWORD] | 2',
    'third | tasks:m | tasks:z [KEYWORD]; tasks:a [VECTOR]; tasks:m [BOTH] | 3',
    'miss | tasks:absent | tasks:z [VECTOR] | miss',
    'empty | tasks:absent | — | miss',
    'Total hits: 3/5',
  ]);
});

it('reports a lost hit as miss and lowers the total without changing the threshold', () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const changed = rows.map((row, i) => i === 1 ? { ...row, hits: [] } : row);
  expect(reportPhraseRanking(changed)).toBe(2);
  expect(log.mock.calls.map(call => call[0])).toContain('second | tasks:a | — | miss');
  expect(log.mock.calls.at(-1)).toEqual(['Total hits: 2/5']);
});

it('never counts or prints an expected task beyond the returned top three', () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(reportPhraseRanking([{ phrase: 'capped', expectedLoc: 'tasks:fourth', hits: [
    hit('tasks:z', 'VECTOR'), hit('tasks:a', 'KEYWORD'), hit('tasks:m', 'BOTH'), hit('tasks:fourth', 'KEYWORD'),
  ] }])).toBe(0);
  expect(log.mock.calls.map(call => call[0])).toContain('capped | tasks:fourth | tasks:z [VECTOR]; tasks:a [KEYWORD]; tasks:m [BOTH] | miss');
});
