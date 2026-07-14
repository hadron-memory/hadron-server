import { describe, it, expect } from 'vitest';
import {
  normalizeHandle,
  normalizeHandleOrNull,
  sanitizeHandleSeed,
  generateUniqueHandle,
} from './userHandle.js';

/** Minimal stand-in for the Prisma client's `user.findFirst` handle probe. */
function mockDb(taken: string[] = []) {
  const set = new Set(taken.map((h) => h.toLowerCase()));
  return {
    user: {
      findFirst: async (args: { where: { handle: string } }) =>
        set.has(args.where.handle) ? { id: 'x' } : null,
    },
  } as any;
}

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

describe('sanitizeHandleSeed', () => {
  it('slugifies a display name to a legal atom', () => {
    expect(sanitizeHandleSeed('Holger Selover-Stephan')).toBe('holger-selover-stephan');
    expect(sanitizeHandleSeed('holger+claude')).toBe('holger-claude');
  });

  it('strips leading/trailing non-alnum', () => {
    expect(sanitizeHandleSeed('  __Bob!!  ')).toBe('bob');
  });

  it('returns null for empty, nullish, or fully-illegal input', () => {
    expect(sanitizeHandleSeed(null)).toBeNull();
    expect(sanitizeHandleSeed('   ')).toBeNull();
    expect(sanitizeHandleSeed('!!!')).toBeNull();
  });

  it('returns null when the base lands on a reserved word', () => {
    expect(sanitizeHandleSeed('System')).toBeNull();
  });

  it('truncates to the 32-char suffix-safe cap', () => {
    expect(sanitizeHandleSeed('a'.repeat(50))).toHaveLength(32);
  });
});

describe('generateUniqueHandle', () => {
  it('returns the first legal seed when free', async () => {
    expect(await generateUniqueHandle(mockDb(), { seeds: ['Holger Selover'] })).toBe(
      'holger-selover',
    );
  });

  it('appends a random token on collision (never sequential)', async () => {
    const h = await generateUniqueHandle(mockDb(['holger']), { seeds: ['Holger'] });
    expect(h).toMatch(/^holger-[0-9a-f]{8}$/);
  });

  it('falls through a reserved seed to the next', async () => {
    expect(await generateUniqueHandle(mockDb(), { seeds: ['system', 'Bob'] })).toBe('bob');
  });

  it('prefers a free later seed over randomizing an earlier collision', async () => {
    expect(await generateUniqueHandle(mockDb(['holger']), { seeds: ['holger', 'alice'] })).toBe(
      'alice',
    );
  });

  it('emits a bare random handle when every seed is illegal', async () => {
    const h = await generateUniqueHandle(mockDb(), { seeds: [null, '!!!'] });
    expect(h).toMatch(/^[0-9a-f]{12}$/);
  });

  it('honors a custom fallback with no seeds', async () => {
    expect(await generateUniqueHandle(mockDb(), { fallback: 'guest' })).toBe('guest');
  });
});
