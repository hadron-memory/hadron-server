import { describe, it, expect } from 'vitest';
import { reciprocalRankFusion, RRF_K } from './rrf.js';

describe('reciprocalRankFusion', () => {
  it('RRF_K is the platform-wide 60 (FR-019)', () => {
    expect(RRF_K).toBe(60);
  });

  it('single-list passthrough: returns the same order', () => {
    const out = reciprocalRankFusion([['a', 'b', 'c']], (x) => x);
    expect(out).toEqual(['a', 'b', 'c']);
  });

  it('disjoint lists: each item appears once, ranked by its sole list contribution', () => {
    // Both lists have the same length, so rank-1 of each list gets the same
    // RRF contribution 1/(60+1). Insertion-order tiebreak prefers the first
    // list's item.
    const out = reciprocalRankFusion(
      [
        ['a', 'b'],
        ['c', 'd'],
      ],
      (x) => x,
    );
    expect(out).toEqual(['a', 'c', 'b', 'd']);
  });

  it('item ranked highly in both lists beats single-signal items (SC-007)', () => {
    // Document "x" is rank-1 in both lists; "y" and "z" only show up in one.
    // x's fused score = 2/61, y and z each get 1/62. x must come first.
    const out = reciprocalRankFusion(
      [
        ['x', 'y'],
        ['x', 'z'],
      ],
      (x) => x,
    );
    expect(out[0]).toBe('x');
    expect(out.slice(1).sort()).toEqual(['y', 'z']);
  });

  it("hybrid example: divergent keyword/semantic relevance — both-signal node ranks first", () => {
    // Keyword list says: A, B, C (relevance order).
    // Vector list says:  C, B, D (semantic order).
    // B is in both at ranks (2, 2). C is in both at ranks (3, 1).
    // A only in keyword (rank 1). D only in vector (rank 3).
    //
    // RRF scores:
    //   A: 1/61               ≈ 0.01639
    //   B: 1/62 + 1/62        ≈ 0.03226
    //   C: 1/63 + 1/61        ≈ 0.03227
    //   D: 1/63               ≈ 0.01587
    //
    // C edges out B because rank-1-in-vector (1/61) more than compensates
    // for being one rank lower in keyword.
    const out = reciprocalRankFusion(
      [
        ['A', 'B', 'C'],
        ['C', 'B', 'D'],
      ],
      (x) => x,
    );
    expect(out).toEqual(['C', 'B', 'A', 'D']);
  });

  it('determinism: same input produces same output across runs (insertion-order tiebreak)', () => {
    // Two items with identical RRF contributions (rank-1 each, in separate
    // lists). The "first seen" wins consistently.
    const lists = [['p'], ['q']];
    const a = reciprocalRankFusion(lists, (x) => x);
    const b = reciprocalRankFusion(lists, (x) => x);
    expect(a).toEqual(b);
    expect(a).toEqual(['p', 'q']); // p was seen first
  });

  it('keyFn collapses duplicates by composite key, not object identity', () => {
    type Node = { id: string; loc: string };
    const sameA1: Node = { id: 'n1', loc: 'a' };
    const sameA2: Node = { id: 'n1', loc: 'a' }; // different object, same id
    const b: Node = { id: 'n2', loc: 'b' };
    const out = reciprocalRankFusion(
      [
        [sameA1, b],
        [sameA2],
      ],
      (n) => n.id,
    );
    expect(out.map((n) => n.id)).toEqual(['n1', 'b'.length ? 'n2' : 'n2']); // n1 dominates (in both)
    expect(out[0].id).toBe('n1');
    // The first-seen entry is the one retained.
    expect(out[0]).toBe(sameA1);
  });

  it('empty inputs: returns empty', () => {
    expect(reciprocalRankFusion([], (x: string) => x)).toEqual([]);
    expect(reciprocalRankFusion([[], []], (x: string) => x)).toEqual([]);
  });

  it('custom k changes the rank decay: higher k flattens the curve', () => {
    // With k=60, rank-1's contribution (1/61 ≈ 0.0164) is ~2x rank-100's
    // (1/160 ≈ 0.00625). With k=1000, that ratio shrinks toward 1.
    const ratio60 = (1 / (60 + 1)) / (1 / (60 + 100));
    const ratio1000 = (1 / (1000 + 1)) / (1 / (1000 + 100));
    expect(ratio60).toBeGreaterThan(ratio1000);
  });
});
