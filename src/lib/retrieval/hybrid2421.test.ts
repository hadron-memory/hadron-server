import { expect, it, vi } from 'vitest';
import { composeHybridRanking, hybridKeywordCandidates } from './hybrid.js';
import { reciprocalRankFusionScored } from '../rrf.js';
import { BooleanQueryError, literalQuery } from './tsquery.js';
it('preserves findNodes fusion scores, stable ties and widened candidate window', () => {
  const keyword = ['shared', 'keyword', 'tie'].map(nodeId=>({nodeId,score:99}));
  const vector = ['vector', 'shared', 'last', 'deep'].map(nodeId=>({nodeId,score:0.8}));
  const old = reciprocalRankFusionScored([keyword.map(h=>h.nodeId),vector.map(h=>h.nodeId)],id=>id).slice(0,4);
  const result=composeHybridRanking(keyword,vector,4);
  expect(result.map(h=>({item:h.nodeId,score:h.score}))).toEqual(old);
  expect(result.find(h=>h.nodeId==='shared')?.matchedBy).toBe('BOTH');
  expect(result.find(h=>h.nodeId==='vector')?.matchedBy).toBe('VECTOR');
  expect(result.find(h=>h.nodeId==='keyword')?.matchedBy).toBe('KEYWORD');
});

const oneHit = [{ nodeId: 'hit', score: 0.25 }];
it('hybrid keyword strict hits never relax, even when fallback relaxation is allowed', async () => {
  const search = vi.fn().mockResolvedValue(oneHit);
  expect(await hybridKeywordCandidates('alpha beta', search, true)).toEqual({ hits: oneHit, degraded: null });
  expect(search.mock.calls).toEqual([['alpha beta']]);
});
it('hybrid keyword relaxes an empty conjunction only when it finds candidates', async () => {
  const search = vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce(oneHit);
  expect(await hybridKeywordCandidates('alpha beta', search, true)).toEqual({ hits: oneHit, degraded: 'and_relaxed_to_or' });
  expect(search).toHaveBeenCalledTimes(2);
  expect(search.mock.calls[1][0]).not.toBe('alpha beta');
});
it('hybrid keyword keeps honest empty results when relaxation is also empty', async () => {
  const search = vi.fn().mockResolvedValue([]);
  expect(await hybridKeywordCandidates('alpha beta', search, true)).toEqual({ hits: [], degraded: null });
  expect(search).toHaveBeenCalledTimes(2);
});
it('true hybrid does not relax its empty keyword half', async () => {
  const search = vi.fn().mockResolvedValue([]);
  expect(await hybridKeywordCandidates('alpha beta', search, false)).toEqual({ hits: [], degraded: null });
  expect(search.mock.calls).toEqual([['alpha beta']]);
});
it('explicit boolean intent is not relaxed even in keyword-only fallback', async () => {
  const search = vi.fn().mockResolvedValue([]);
  expect(await hybridKeywordCandidates('alpha AND beta', search, true)).toEqual({ hits: [], degraded: null });
  expect(search).toHaveBeenCalledTimes(1);
});
it('malformed hybrid keyword syntax uses the same literal fallback and marker', async () => {
  const query = '(alpha OR';
  const search = vi.fn().mockRejectedValueOnce(new BooleanQueryError('malformed')).mockResolvedValueOnce(oneHit);
  expect(await hybridKeywordCandidates(query, search)).toEqual({ hits: oneHit, degraded: 'literal_fallback' });
  expect(search.mock.calls).toEqual([[query], [literalQuery(query)]]);
});
it('an empty literal fallback returns no candidates with literal_fallback', async () => {
  const search = vi.fn().mockRejectedValue(new BooleanQueryError('empty'));
  expect(await hybridKeywordCandidates('"', search)).toEqual({ hits: [], degraded: 'literal_fallback' });
  expect(search).toHaveBeenCalledTimes(2);
});
it.each([false, true])('infrastructure errors escape from the strict or literal search (literal=%s)', async literal => {
  const fault = new Error('database unavailable');
  const search = vi.fn();
  if (literal) search.mockRejectedValueOnce(new BooleanQueryError('malformed'));
  search.mockRejectedValueOnce(fault);
  await expect(hybridKeywordCandidates('(alpha OR', search)).rejects.toBe(fault);
});
