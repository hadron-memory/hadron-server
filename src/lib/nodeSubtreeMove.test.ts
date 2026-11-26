/**
 * #1099 — a cross-memory move refusal must name what is ACTUALLY moving.
 *
 * The refusals said "a subtree" whatever the shape. For a LEAF — the common
 * case — that is simply wrong, and it sends the reader looking for descendants
 * that do not exist, at exactly the moment they are already confused about why
 * the move was refused.
 *
 * `describeMoved` is unit-tested here rather than only through the resolver
 * paths: the boundary cases are all in the counting (1, 2, many), and reaching
 * each of them through a real cross-memory move would mean building three
 * subtrees to assert three strings.
 */
import { describe, it, expect } from 'vitest';
import { describeMoved } from './nodeSubtreeMove.js';

describe('describeMoved (#1099)', () => {
  it('a single node is a NODE, not a subtree', () => {
    // The whole point of the issue. "subtree" for a leaf is the wrong noun.
    expect(describeMoved(1)).toBe('the node');
    expect(describeMoved(1)).not.toContain('subtree');
  });

  it('two nodes name the root and ONE descendant, singular', () => {
    // Off-by-one in the plural is the kind of thing that makes a message read
    // as machine-generated and therefore not worth trusting.
    expect(describeMoved(2)).toBe('the node and its 1 descendant');
  });

  it('more than two pluralises', () => {
    expect(describeMoved(5)).toBe('the node and its 4 descendants');
  });

  it('never repeats the loc (#5225, cor:api:140:01): the moved node is the one the caller named', () => {
    // #1099 named the loc so the reader knew WHICH node. The caller already holds the reference it sent, and a
    // refusal does not repeat caller text back (#5168/#5225), so the message says "the node" instead.
    for (const size of [1, 2, 7]) expect(describeMoved(size)).not.toMatch(/"/);
  });
});
