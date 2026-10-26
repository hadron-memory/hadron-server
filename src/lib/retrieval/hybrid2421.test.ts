import { expect, it } from 'vitest';
import { composeHybridRanking } from './hybrid.js';
import { reciprocalRankFusionScored } from '../rrf.js';
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
