import { describe, it, expect, beforeEach } from 'vitest';
import { SessionKeyCache } from './sessionKeyCache.js';
import { generateDataKey } from './crypto.js';

describe('SessionKeyCache', () => {
  let cache: SessionKeyCache;

  beforeEach(() => {
    cache = new SessionKeyCache();
  });

  it('returns null when no session is active', () => {
    expect(cache.getByMemoryId('mem-1')).toBeNull();
    expect(cache.hasMemory('mem-1')).toBe(false);
  });

  it('stores and retrieves a key for a memory', () => {
    const key = generateDataKey();
    cache.set('sess-1', 'mem-1', key);
    expect(cache.getByMemoryId('mem-1')).toBe(key);
    expect(cache.hasMemory('mem-1')).toBe(true);
    expect(cache.refCount('mem-1')).toBe(1);
  });

  it('evicts the key when the last session ends', () => {
    const key = generateDataKey();
    cache.set('sess-1', 'mem-1', key);
    cache.evict('sess-1');
    expect(cache.getByMemoryId('mem-1')).toBeNull();
    expect(cache.refCount('mem-1')).toBe(0);
  });

  it('keeps the key when a second session is still active', () => {
    const key = generateDataKey();
    cache.set('sess-1', 'mem-1', key);
    cache.set('sess-2', 'mem-1', key);
    expect(cache.refCount('mem-1')).toBe(2);
    cache.evict('sess-1');
    expect(cache.refCount('mem-1')).toBe(1);
    expect(cache.getByMemoryId('mem-1')).toBe(key);
    cache.evict('sess-2');
    expect(cache.refCount('mem-1')).toBe(0);
    expect(cache.getByMemoryId('mem-1')).toBeNull();
  });

  it('rejects mismatched keys for the same memory', () => {
    const k1 = generateDataKey();
    const k2 = generateDataKey();
    cache.set('sess-1', 'mem-1', k1);
    expect(() => cache.set('sess-2', 'mem-1', k2)).toThrow(/conflict/);
  });

  it('accepts the same key material from different sessions', () => {
    const k1 = generateDataKey();
    const k2 = { raw: Buffer.from(k1.raw) }; // same bytes, different Buffer
    cache.set('sess-1', 'mem-1', k1);
    expect(() => cache.set('sess-2', 'mem-1', k2)).not.toThrow();
    expect(cache.refCount('mem-1')).toBe(2);
  });

  it('handles evicting an unknown session without crashing', () => {
    expect(() => cache.evict('unknown')).not.toThrow();
  });
});
