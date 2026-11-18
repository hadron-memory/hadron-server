import { describe, expect, it } from 'vitest';
import { normalizeFindNodesPaging } from './findNodesPaging.js';

describe('#437 shared defensive pagination contract', () => {
  it.each([
    [undefined, 20], [null, 20], [NaN, 20], [Infinity, 20], [-Infinity, 20],
    [0, 1], [-1, 1], [1.9, 1], [2.9, 2], [200, 200], [201, 200], [500000, 200],
  ])('limit %s becomes %s', (limit, expected) => {
    expect(normalizeFindNodesPaging(limit).limit).toBe(expected);
  });
  it.each([
    [undefined, 0], [null, 0], [NaN, 0], [Infinity, 0], [-Infinity, 0],
    [-5, 0], [1.5, 1], [10000, 10000], [10001, 10001],
  ])('offset %s becomes %s without a new ceiling', (offset, expected) => {
    expect(normalizeFindNodesPaging(undefined, offset).offset).toBe(expected);
  });
});
