import { describe, it, expect } from 'vitest';
import {
  normalizeHandle,
  normalizeHandleOrNull,
  sanitizeHandleSeed,
  generateUniqueHandle,
  isHandleTaken,
} from './userHandle.js';

/**
 * Minimal stand-in for the Prisma client's principal-pool probe (#692):
 * isHandleTaken → checkRootAvailable queries `principal.findFirst` on the
 * lowercase root name across ALL kinds (user + org).
 */
function mockDb(taken: string[] = []) {
  const set = new Set(taken.map((h) => h.toLowerCase()));
  return {
    principal: {
      findUnique: async (args: { where: { name: string } }) =>
        set.has(args.where.name.toLowerCase()) ? { id: 'x' } : null,
    },
  } as any;
}

describe('normalizeHandle (strict)', () => {
  it('lowercases and trims', () => {
    expect(normalizeHandle('Holger')).toBe('holger');
    expect(normalizeHandle('  HoLgEr  ')).toBe('holger');
  });

  it('passes a legal lowercase handle through', () => {
    expect(normalizeHandle('alice-dev_1-2')).toBe('alice-dev_1-2');
  });

  it('throws on illegal characters', () => {
    expect(() => normalizeHandle('has space')).toThrow();
    expect(() => normalizeHandle('has:colon')).toThrow();
    expect(() => normalizeHandle('-leading-hyphen')).toThrow();
  });

  it('#692: throws on a dotted handle (handles are dot-free)', () => {
    expect(() => normalizeHandle('first.last')).toThrow();
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
    expect(sanitizeHandleSeed('z'.repeat(50))).toHaveLength(32);
  });
});

describe('generateUniqueHandle', () => {
  it.each(['hrn', 'urn', 'cabcdefghijklmnopqrstuvwx', '0193a1b2c3d4e5f60718293a4b5c6d7e'])('skips a new forbidden registration seed %s', async (seed) => {
    expect(await generateUniqueHandle(mockDb(), { seeds: [seed, 'Alice'] })).toBe('alice');
    const fallback = await generateUniqueHandle(mockDb(), { seeds: [seed] });
    expect(fallback).not.toBe(seed);
    expect(() => normalizeHandle(fallback)).not.toThrow();
    // Stored handles keep their read/cascade normalization.
    expect(normalizeHandleOrNull(seed)).toBe(seed);
  });

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

  it('treats a legacy mixed-case handle as taken (case-insensitive probe)', async () => {
    // The generator only emits lowercase, so a legacy `Holger` row must still
    // block `holger` — otherwise the insert would 500 on the lower() index.
    const h = await generateUniqueHandle(mockDb(['Holger']), { seeds: ['Holger'] });
    expect(h).toMatch(/^holger-[0-9a-f]{8}$/);
  });
});

describe('isHandleTaken', () => {
  it('matches case-insensitively', async () => {
    expect(await isHandleTaken(mockDb(['Holger']), 'holger')).toBe(true);
    expect(await isHandleTaken(mockDb(['holger']), 'HOLGER')).toBe(true);
    expect(await isHandleTaken(mockDb([]), 'holger')).toBe(false);
  });
});


it('S3 keeps dot policy but types reserved team. handles only when enabled', () => {
  const old = process.env.TEAM_TAGS_ENABLED;
  try {
    process.env.TEAM_TAGS_ENABLED = 'false';
    expect(() => normalizeHandle('team.head')).toThrow();
    process.env.TEAM_TAGS_ENABLED = 'true';
    try { normalizeHandle('TEAM.Head'); throw new Error('accepted reserved handle'); }
    catch (error) { expect(error).toMatchObject({extensions:{code:'USER_HANDLE_RESERVED_TEAM_PREFIX'}}); }
    expect(normalizeHandle('teamster')).toBe('teamster');
  } finally { if (old === undefined) delete process.env.TEAM_TAGS_ENABLED; else process.env.TEAM_TAGS_ENABLED = old; }
});
