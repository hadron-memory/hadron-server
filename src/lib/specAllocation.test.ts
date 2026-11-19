/** #1178: the pure numbering grammar of the server-side citation allocator. */
import { describe, expect, it } from 'vitest';
import { childKindOf, childNumberAt, formatSpecNumber, nextSpecNumber, specLevel } from './specAllocation.js';

const none = new Set<number>();

describe('childKindOf', () => {
  it('reads the level from the citation grammar, flat or product-rooted', () => {
    expect(childKindOf('msg')).toBe('feature');
    expect(childKindOf('cor:dmo')).toBe('feature');
    expect(childKindOf('cor:dmo:060')).toBe('rule');
    expect(childKindOf('msg:010')).toBe('rule');
    expect(childKindOf('cor:dmo:060:15')).toBe('flow');
  });
  it('refuses a flow, a malformed loc and a non-citation', () => {
    expect(childKindOf('cor:dmo:060:15:01')).toBeNull();
    expect(childKindOf('cor:dmo:6')).toBeNull();
    expect(childKindOf('Cor')).toBeNull();
    expect(childKindOf('notes:intro')).toBeNull();
  });
});

describe('nextSpecNumber', () => {
  const feature = specLevel('feature');
  const rule = specLevel('rule');
  it('goes in tens for features and by one for rules, from an empty parent', () => {
    expect(nextSpecNumber(feature, 0, none, null)).toBe(10);
    expect(nextSpecNumber(rule, 0, none, null)).toBe(1);
  });
  it('lands strictly above the ever-minted floor', () => {
    expect(nextSpecNumber(rule, 7, new Set([7]), null)).toBe(8);
    expect(nextSpecNumber(feature, 60, new Set([60]), null)).toBe(70);
    expect(nextSpecNumber(feature, 65, none, null)).toBe(70);
  });
  it('lands strictly above `after`', () => {
    expect(nextSpecNumber(rule, 0, none, 5)).toBe(6);
    expect(nextSpecNumber(feature, 0, none, 15)).toBe(20);
    expect(nextSpecNumber(feature, 0, none, 20)).toBe(30);
  });
  it('skips every taken number and never yields rule 00', () => {
    expect(nextSpecNumber(rule, 2, new Set([3, 4]), null)).toBe(5);
    expect(nextSpecNumber(rule, 0, new Set([0]), null)).toBe(1);
  });
  it('reports an exhausted space', () => {
    expect(nextSpecNumber(rule, 99, new Set([99]), null)).toBeNull();
    expect(nextSpecNumber(feature, 990, new Set([990]), null)).toBeNull();
    expect(nextSpecNumber(rule, 50, new Set(Array.from({ length: 49 }, (_, i) => 51 + i)), null)).toBeNull();
  });
});

describe('childNumberAt / formatSpecNumber', () => {
  const rule = specLevel('rule');
  it('reads a direct child, and an archived tombstone as its child', () => {
    expect(childNumberAt('cor:dmo:060', 'cor:dmo:060:07', rule)).toBe(7);
    expect(childNumberAt('cor:dmo:060', 'cor:dmo:060:07__deleted-abc', rule)).toBe(7);
  });
  it('ignores grandchildren, siblings and other shapes', () => {
    expect(childNumberAt('cor:dmo:060', 'cor:dmo:060:07:01', rule)).toBeNull();
    expect(childNumberAt('cor:dmo:060', 'cor:dmo:070:07', rule)).toBeNull();
    expect(childNumberAt('cor:dmo:060', 'cor:dmo:060:7', rule)).toBeNull();
  });
  it('pads to the level width', () => {
    expect(formatSpecNumber(rule, 7)).toBe('07');
    expect(formatSpecNumber(specLevel('feature'), 70)).toBe('070');
  });
});
