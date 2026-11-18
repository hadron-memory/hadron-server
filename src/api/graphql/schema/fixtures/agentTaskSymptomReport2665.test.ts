import { afterEach, expect, it, vi } from 'vitest';
import { reportSymptomRanking, type SymptomResult } from './agentTaskSymptomReport2665.js';

afterEach(() => vi.restoreAllMocks());
const hit = (loc: string, matchedBy: string) => ({ node: { loc }, matchedBy });
const rows: SymptomResult[] = [
  { symptom: 'first', expectedLoc: 'tasks:z', hits: [hit('tasks:z', 'BOTH'), hit('tasks:a', 'VECTOR'), hit('tasks:m', 'KEYWORD')] },
  { symptom: 'second', expectedLoc: 'tasks:a', hits: [hit('tasks:z', 'VECTOR'), hit('tasks:a', 'KEYWORD')] },
  { symptom: 'third', expectedLoc: 'tasks:m', hits: [hit('tasks:z', 'KEYWORD'), hit('tasks:a', 'VECTOR'), hit('tasks:m', 'BOTH')] },
  { symptom: 'miss', expectedLoc: 'tasks:absent', hits: [hit('tasks:z', 'VECTOR')] },
  { symptom: 'empty', expectedLoc: 'tasks:absent', hits: [] },
];

it('emits ordered candidates with their own reasons, one-based ranks, empty slots and a total', () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(reportSymptomRanking(rows)).toBe(3);
  expect(log.mock.calls.map(call => call[0])).toEqual([
    'Fixed synthetic/provisional symptom benchmark (hermetic keyword/fallback; not live-vector or real-world recall)',
    'Symptom | Expected loc | Top 3 (ranked loc [matchedBy]) | Expected rank',
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
  expect(reportSymptomRanking(changed)).toBe(2);
  expect(log.mock.calls.map(call => call[0])).toContain('second | tasks:a | — | miss');
  expect(log.mock.calls.at(-1)).toEqual(['Total hits: 2/5']);
});

it('never counts or prints an expected task beyond the returned top three', () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(reportSymptomRanking([{ symptom: 'capped', expectedLoc: 'tasks:fourth', hits: [
    hit('tasks:z', 'VECTOR'), hit('tasks:a', 'KEYWORD'), hit('tasks:m', 'BOTH'), hit('tasks:fourth', 'KEYWORD'),
  ] }])).toBe(0);
  expect(log.mock.calls.map(call => call[0])).toContain('capped | tasks:fourth | tasks:z [VECTOR]; tasks:a [KEYWORD]; tasks:m [BOTH] | miss');
});
