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
    expect(describeMoved('a:b', 1)).toBe('node "a:b"');
    expect(describeMoved('a:b', 1)).not.toContain('subtree');
  });

  it('two nodes name the root and ONE descendant, singular', () => {
    // Off-by-one in the plural is the kind of thing that makes a message read
    // as machine-generated and therefore not worth trusting.
    expect(describeMoved('a:b', 2)).toBe('"a:b" and its 1 descendant');
  });

  it('more than two pluralises', () => {
    expect(describeMoved('a:b', 5)).toBe('"a:b" and its 4 descendants');
  });

  it('always names the loc, so the reader knows WHICH node', () => {
    // A refusal that does not say what it refused is a refusal the reader has
    // to reproduce to understand.
    for (const size of [1, 2, 7]) expect(describeMoved('chats:team', size)).toContain('chats:team');
  });
});
