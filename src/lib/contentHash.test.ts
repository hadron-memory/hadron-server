import { describe, it, expect } from 'vitest';
import { createHash } from 'crypto';
import { computeContentHash } from './contentHash.js';

describe('computeContentHash (spec 032 — abstractOriginHash helper)', () => {
  it('returns null for null input', () => {
    expect(computeContentHash(null)).toBeNull();
  });

  it('returns null for undefined input', () => {
    expect(computeContentHash(undefined)).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(computeContentHash('')).toBeNull();
  });

  it('returns 8-char hex string for non-empty input', () => {
    const hash = computeContentHash('hello world');
    expect(hash).toMatch(/^[0-9a-f]{8}$/);
  });

  it("matches first 8 hex chars of SHA-256 of UTF-8 bytes", () => {
    const inputs = ['hello', 'hello world', 'spec 032', 'Some unicode: 日本語', '\n\n\nlots of newlines\n\n\n'];
    for (const input of inputs) {
      const expected = createHash('sha256').update(input, 'utf8').digest('hex').slice(0, 8);
      expect(computeContentHash(input)).toBe(expected);
    }
  });

  it('is deterministic — same input yields same hash', () => {
    const h1 = computeContentHash('determinism check');
    const h2 = computeContentHash('determinism check');
    expect(h1).toBe(h2);
  });

  it('differs for different inputs (no obvious collision in fixtures)', () => {
    const a = computeContentHash('content A');
    const b = computeContentHash('content B');
    expect(a).not.toBe(b);
  });

  it('whitespace-only content hashes to a non-null value (not normalized here)', () => {
    // The helper does NOT trim. Normalization (trim-then-check) lives on the
    // abstract / content write path per spec 031's FR-009 conventions; this
    // helper takes whatever bytes it's given and hashes them. A caller that
    // passes "   " gets the SHA-256 of "   ", not null.
    expect(computeContentHash('   ')).toMatch(/^[0-9a-f]{8}$/);
  });
});
