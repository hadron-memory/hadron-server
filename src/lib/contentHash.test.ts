import { describe, it, expect } from 'vitest';
import { createHash } from 'crypto';
import { computeContentHash, isAbstractUnverified } from './contentHash.js';

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

describe('isAbstractUnverified (#1128)', () => {
  const node = (over: Partial<Parameters<typeof isAbstractUnverified>[0]> = {}) => ({
    abstract: 'a summary',
    content: 'the body',
    abstractOriginHash: computeContentHash('the body'),
    ...over,
  });

  it('false when the fingerprint matches the current content', () => {
    expect(isAbstractUnverified(node())).toBe(false);
  });

  it('true when the fingerprint disagrees — the classic stale case', () => {
    expect(isAbstractUnverified(node({ content: 'a rewritten body' }))).toBe(true);
  });

  it('TRUE when there is no fingerprint at all — the #1128 change', () => {
    // Previously false, via an `abstractOriginHash != null` short-circuit. A
    // null hash on a node that HAS both an abstract and content does not mean
    // "nothing to check"; it means "never checked", which is the one thing
    // this signal exists to say.
    expect(isAbstractUnverified(node({ abstractOriginHash: null }))).toBe(true);
  });

  it('false with no abstract — nothing to be unverified about', () => {
    expect(isAbstractUnverified(node({ abstract: null, abstractOriginHash: null }))).toBe(false);
    expect(isAbstractUnverified(node({ abstract: '', abstractOriginHash: null }))).toBe(false);
  });

  it('false with no content — FR-007, an abstract IS the node here', () => {
    // The abstract-fallback shape. There is no body to disagree with, so a
    // null hash is correct rather than unverified — and arming here would put
    // a warning on every content-less node in the graph.
    expect(isAbstractUnverified(node({ content: null, abstractOriginHash: null }))).toBe(false);
    expect(isAbstractUnverified(node({ content: '', abstractOriginHash: null }))).toBe(false);
  });
});

describe('presence-only abstract verification', () => {
  it('uses presence only for an absent origin fingerprint, never instead of a real hash comparison', () => {
    expect(isAbstractUnverified({ abstract: 'Summary', content: null, abstractOriginHash: null }, true)).toBe(true);
    expect(isAbstractUnverified({ abstract: 'Summary', content: null, abstractOriginHash: null }, false)).toBe(false);
    expect(isAbstractUnverified({ abstract: 'Summary', content: 'body', abstractOriginHash: computeContentHash('body') }, true)).toBe(false);
    expect(isAbstractUnverified({ abstract: 'Summary', content: 'body', abstractOriginHash: computeContentHash('older') }, false)).toBe(true);
  });
});
