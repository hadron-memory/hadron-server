import { describe, expect, it } from 'vitest';
import { MemoryDeletedError } from './errors.js';
import {
  assertMemoryReadable,
  whereDeleted,
  whereNotDeleted,
} from './readFilter.js';

describe('whereNotDeleted', () => {
  it('returns the Prisma fragment that excludes soft-deleted rows', () => {
    expect(whereNotDeleted()).toEqual({ deletedAt: null });
  });
});

describe('whereDeleted', () => {
  it('returns the Prisma fragment that selects only soft-deleted rows', () => {
    expect(whereDeleted()).toEqual({ deletedAt: { not: null } });
  });
});

describe('assertMemoryReadable', () => {
  it('passes silently for an active memory', () => {
    expect(() =>
      assertMemoryReadable({ id: 'mem_a', deletedAt: null }),
    ).not.toThrow();
  });

  it('throws MemoryDeletedError for a soft-deleted memory', () => {
    const deletedAt = new Date('2026-05-01T12:00:00.000Z');
    let caught: MemoryDeletedError | null = null;
    try {
      assertMemoryReadable({
        id: 'mem_b',
        deletedAt,
        deleterName: 'Alice',
      });
    } catch (e) {
      caught = e as MemoryDeletedError;
    }
    expect(caught).toBeInstanceOf(MemoryDeletedError);
    expect(caught?.code).toBe('MEMORY_DELETED');
    expect(caught?.memoryId).toBe('mem_b');
    expect(caught?.deletedAt).toBe(deletedAt);
    expect(caught?.deleterName).toBe('Alice');
  });

  it('preserves a null deleter name when one is not provided', () => {
    let caught: MemoryDeletedError | null = null;
    try {
      assertMemoryReadable({
        id: 'mem_c',
        deletedAt: new Date(),
      });
    } catch (e) {
      caught = e as MemoryDeletedError;
    }
    expect(caught?.deleterName).toBeNull();
  });
});
