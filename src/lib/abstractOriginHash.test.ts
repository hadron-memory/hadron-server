/** #4967 (BLIND F8): the abstractOriginHash partial-update matrix (spec 032), row by row, as a pure function. */
import { describe, it, expect } from 'vitest';
import { deriveAbstractOriginHash } from './abstractOriginHash.js';
import { computeContentHash } from './contentHash.js';

const H = (c: string) => computeContentHash(c);

describe('deriveAbstractOriginHash', () => {
  describe('abstract omitted (undefined)', () => {
    it('keeps the stored hash by default, so a content change arms staleness', () => {
      expect(deriveAbstractOriginHash(undefined, undefined, 'summary', 'NEW')).toBeUndefined();
      expect(deriveAbstractOriginHash(undefined, false, 'summary', 'NEW')).toBeUndefined();
    });
    it('abstractStillAccurate re-fingerprints the STORED abstract against the new content', () => {
      expect(deriveAbstractOriginHash(undefined, true, 'summary', 'NEW')).toBe(H('NEW'));
    });
    it('abstractStillAccurate on cleared content lands on "no content, no hash"', () => {
      expect(deriveAbstractOriginHash(undefined, true, 'summary', null)).toBeNull();
      expect(deriveAbstractOriginHash(undefined, true, 'summary', undefined)).toBeNull();
    });
    for (const stored of [null, '', '   ']) {
      it(`abstractStillAccurate with no abstract (${JSON.stringify(stored)}) mints no ghost hash`, () => {
        expect(deriveAbstractOriginHash(undefined, true, stored, 'NEW')).toBeUndefined();
      });
    }
  });
  describe('abstract null', () => {
    it('clears the hash, whatever else is passed', () => {
      expect(deriveAbstractOriginHash(null, undefined, 'summary', 'NEW')).toBeNull();
      expect(deriveAbstractOriginHash(null, true, 'summary', 'NEW')).toBeNull();
    });
  });
  describe('abstract supplied', () => {
    it('fingerprints it against the new content', () => {
      expect(deriveAbstractOriginHash('new summary', undefined, 'summary', 'NEW')).toBe(H('NEW'));
    });
    it('abstractStillAccurate is redundant and ignored', () => {
      expect(deriveAbstractOriginHash('new summary', true, null, 'NEW')).toBe(H('NEW'));
    });
    it('no content means no hash', () => {
      expect(deriveAbstractOriginHash('new summary', undefined, 'summary', null)).toBeNull();
    });
  });
});
