import { describe, it, expect } from 'vitest';
import { normalizeHandle, normalizeHandleOrNull } from './userHandle.js';

describe('normalizeHandle (strict)', () => {
  it('lowercases and trims', () => {
    expect(normalizeHandle('Holger')).toBe('holger');
    expect(normalizeHandle('  HoLgEr  ')).toBe('holger');
  });

  it('passes a legal lowercase handle through', () => {
    expect(normalizeHandle('alice.dev_1-2')).toBe('alice.dev_1-2');
  });

  it('throws on illegal characters', () => {
    expect(() => normalizeHandle('has space')).toThrow();
    expect(() => normalizeHandle('has:colon')).toThrow();
    expect(() => normalizeHandle('-leading-hyphen')).toThrow();
  });

  it('throws on a reserved word', () => {
    expect(() => normalizeHandle('memory')).toThrow();
    expect(() => normalizeHandle('Agent')).toThrow(); // reserved, case-insensitive
  });
});

describe('normalizeHandleOrNull (lenient)', () => {
  it('normalizes a legal handle', () => {
    expect(normalizeHandleOrNull('Holger')).toBe('holger');
  });

  it('returns null for empty / nullish input', () => {
    expect(normalizeHandleOrNull(null)).toBeNull();
    expect(normalizeHandleOrNull(undefined)).toBeNull();
    expect(normalizeHandleOrNull('   ')).toBeNull();
  });

  it('returns null (not throw) for an illegal handle', () => {
    expect(normalizeHandleOrNull('has space')).toBeNull();
    expect(normalizeHandleOrNull('memory')).toBeNull();
  });
});
