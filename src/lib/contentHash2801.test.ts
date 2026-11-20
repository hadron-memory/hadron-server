import { describe, expect, it } from 'vitest';
import { computeContentHash, isAbstractUnverified } from './contentHash.js';

describe('#2801 named plaintext-presence evidence', () => {
  it.each([true, false])('uses named presence=%s only for a missing fingerprint', (contentPresent) => {
    expect(isAbstractUnverified({ abstract: 'Summary', content: null, abstractOriginHash: null }, { contentPresent })).toBe(contentPresent);
  });
  it.each([true, false])('never lets presence=%s override a known matching or stale fingerprint', (contentPresent) => {
    expect(isAbstractUnverified({ abstract: 'Summary', content: 'body', abstractOriginHash: computeContentHash('body') }, { contentPresent })).toBe(false);
    expect(isAbstractUnverified({ abstract: 'Summary', content: 'body', abstractOriginHash: computeContentHash('older') }, { contentPresent })).toBe(true);
  });
});
