/**
 * Smart-sniff classification — pure, no DB. Pins the precedence
 * (PK → URN → free-text) and the explicit-fields override.
 */

import { describe, it, expect } from 'vitest';
import { classifyQuery, looksLikeUrn, urnSearchTerm } from './classify.js';

describe('classifyQuery', () => {
  it('explicit fields override the sniff', () => {
    // A PK-shaped query, but explicit fields win.
    const r = classifyQuery('c0123456789abcdefghijklmn', ['name', 'description']);
    expect(r.sniff).toBe('explicit');
    expect(r.fields).toEqual(['name', 'description']);
  });

  it('dedupes explicit fields', () => {
    const r = classifyQuery('anything', ['name', 'name', 'urn']);
    expect(r.fields).toEqual(['name', 'urn']);
  });

  it('sniffs a cuid as PK', () => {
    const r = classifyQuery('c0123456789abcdefghijklmn'); // c + 24 = 25 chars
    expect(r.sniff).toBe('pk');
    expect(r.fields).toEqual(['pk']);
  });

  it('sniffs a 32-hex UUIDv7 as PK', () => {
    const r = classifyQuery('0190abcdef0123456789abcdef012345');
    expect(r.sniff).toBe('pk');
    expect(r.fields).toEqual(['pk']);
  });

  it('sniffs an hrn:-prefixed URN', () => {
    const r = classifyQuery('hrn:agent:acme.com::juno');
    expect(r.sniff).toBe('urn');
    expect(r.fields).toEqual(['urn']);
  });

  it('sniffs a canonical :: URN', () => {
    expect(classifyQuery('acme.com::mm-app').sniff).toBe('urn');
  });

  it('sniffs a bare colon URN with no whitespace', () => {
    expect(classifyQuery('acme.com:juno').sniff).toBe('urn');
  });

  it('treats colon-with-whitespace as free text, not URN', () => {
    const r = classifyQuery('note: follow up');
    expect(r.sniff).toBe('text');
    expect(r.fields).toEqual(['name', 'urn']);
  });

  it('sniffs plain free text as name + urn', () => {
    const r = classifyQuery('juno');
    expect(r.sniff).toBe('text');
    expect(r.fields).toEqual(['name', 'urn']);
  });
});

describe('looksLikeUrn', () => {
  it('is true for prefixed / canonical / bare-colon forms', () => {
    expect(looksLikeUrn('hrn:memory:acme.com::x')).toBe(true);
    expect(looksLikeUrn('urn:org:acme.com')).toBe(true);
    expect(looksLikeUrn('acme.com::x')).toBe(true);
    expect(looksLikeUrn('acme.com:x')).toBe(true);
  });
  it('is false for free text and empty', () => {
    expect(looksLikeUrn('hello world')).toBe(false);
    expect(looksLikeUrn('juno')).toBe(false);
    expect(looksLikeUrn('')).toBe(false);
  });
});

describe('urnSearchTerm', () => {
  it('strips a known scheme+type prefix', () => {
    expect(urnSearchTerm('hrn:agent:acme.com:juno')).toBe('acme.com:juno');
    expect(urnSearchTerm('urn:memory:acme.com:dev')).toBe('acme.com:dev');
  });
  it('passes bare URNs through unchanged', () => {
    expect(urnSearchTerm('acme.com:juno')).toBe('acme.com:juno');
    expect(urnSearchTerm('juno')).toBe('juno');
  });
});
