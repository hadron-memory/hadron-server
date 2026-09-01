/**
 * #1114 — the key cache's OWN eviction policy.
 *
 * Before this, a memory's data key was released when the last session holding
 * it ENDED, and for an abandoned session that meant when the reaper's
 * inactivity rule ended it. So the eviction policy for process-held key
 * material was a side effect of a durable record's lifecycle. Removing that
 * rule would have made these keys immortal — which is why the finding stands
 * on its own: the dependence was a defect while it worked, and was invisible
 * precisely because something else happened to end sessions.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  SessionKeyCache,
  DEFAULT_SESSION_KEY_TTL_MS,
  startSessionKeySweepLoop,
  sessionKeyCache as globalCache,
} from './sessionKeyCache.js';
import type { EncryptionKey } from './crypto.js';

const key = (byte: number): EncryptionKey =>
  ({ raw: Buffer.alloc(32, byte) }) as unknown as EncryptionKey;

const HOUR = 60 * 60 * 1000;
const T0 = new Date('2026-09-01T00:00:00.000Z');
let cache: SessionKeyCache;

/**
 * ONE clock for the whole cache, not just for `sweepExpired`.
 *
 * The first draft of this suite passed a fake instant to `sweepExpired` while
 * `set` and `getByMemoryId` stamped the REAL `Date.now()` — so "advancing
 * time" moved the sweep and nothing else, and two tests failed for a reason
 * that had nothing to do with the cache. A ruler that measures only half the
 * subject reports on neither.
 */
const advance = (ms: number) => vi.setSystemTime(new Date(Date.now() + ms));

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  cache = new SessionKeyCache();
});
afterEach(() => {
  vi.useRealTimers();
  delete process.env.SESSION_KEY_CACHE_TTL_MS;
});

describe('sessionKeyCache TTL (#1114)', () => {
  it('evicts a key untouched for longer than the TTL', () => {
    cache.set('s1', 'mem1', key(1));
    expect(cache.getByMemoryId('mem1')).not.toBeNull();

    advance(DEFAULT_SESSION_KEY_TTL_MS + 1000);
    expect(cache.sweepExpired()).toBe(1);
    expect(cache.getByMemoryId('mem1')).toBeNull();
    expect(cache.refCount('mem1')).toBe(0);
  });

  it('does NOT evict a key that is still inside the window', () => {
    cache.set('s1', 'mem1', key(1));
    advance(HOUR);
    expect(cache.sweepExpired()).toBe(0);
    expect(cache.getByMemoryId('mem1')).not.toBeNull();
  });

  it('a READ refreshes the clock, so an actively-used key never expires under its own session', () => {
    // The failure this prevents is worse than a leak: evicting a key mid-work
    // breaks decryption for a session that is demonstrably being driven.
    cache.set('s1', 'mem1', key(1));

    // Just inside the window, then used — the use must reset the timer.
    advance(DEFAULT_SESSION_KEY_TTL_MS - 1000);
    expect(cache.sweepExpired()).toBe(0);
    expect(cache.getByMemoryId('mem1')).not.toBeNull(); // touches it

    // Past where the ORIGINAL stamp would have expired; the touch moved it.
    advance(2000);
    expect(cache.sweepExpired()).toBe(0);
    expect(cache.getByMemoryId('mem1')).not.toBeNull();

    // ...but it is not immortal: stop using it and it goes.
    advance(DEFAULT_SESSION_KEY_TTL_MS + 1000);
    expect(cache.sweepExpired()).toBe(1);
  });

  it('expiry does not depend on any session having ended — the whole point', () => {
    // No end, no reap, no lifecycle event of any kind: the cache expires it on
    // its own clock, which is what makes it independent of #1114's removal.
    cache.set('live-session', 'mem1', key(1));
    advance(DEFAULT_SESSION_KEY_TTL_MS + 1);
    expect(cache.sweepExpired()).toBe(1);
    expect(cache.hasMemory('mem1')).toBe(false);
  });

  it('releases the session references too, not just the key', () => {
    // A stale sessionToMemories entry would leak unboundedly even after the
    // key itself was dropped — the same shape of leak, one map over.
    cache.set('s1', 'mem1', key(1));
    advance(DEFAULT_SESSION_KEY_TTL_MS + 1);
    cache.sweepExpired();
    // evict() on the swept session must be a clean no-op, which it can only be
    // if the reverse index was cleaned.
    cache.evict('s1');
    expect(cache.refCount('mem1')).toBe(0);
  });

  it('evicts one memory without touching another that is still in use', () => {
    cache.set('s1', 'stale', key(1));
    advance(DEFAULT_SESSION_KEY_TTL_MS - 1000);
    cache.set('s2', 'fresh', key(2));
    // Now past `stale`'s window but well inside `fresh`'s.
    advance(2000);
    expect(cache.sweepExpired()).toBe(1);
    expect(cache.hasMemory('stale')).toBe(false);
    expect(cache.hasMemory('fresh')).toBe(true);
  });

  it('honours a configured TTL', () => {
    process.env.SESSION_KEY_CACHE_TTL_MS = String(HOUR);
    cache.set('s1', 'mem1', key(1));
    advance(30 * 60_000);
    expect(cache.sweepExpired()).toBe(0);
    advance(HOUR);
    expect(cache.sweepExpired()).toBe(1);
  });

  it('a shared memory survives until the whole ENTRY goes idle, not per session', () => {
    // Two sessions on one memory (phone + laptop). The key is one entry with a
    // refcount, so the clock belongs to the entry.
    cache.set('s1', 'mem1', key(1));
    cache.set('s2', 'mem1', key(1));
    expect(cache.refCount('mem1')).toBe(2);
    advance(DEFAULT_SESSION_KEY_TTL_MS + 1);
    expect(cache.sweepExpired()).toBe(1);
    expect(cache.refCount('mem1')).toBe(0);
  });
});

describe('the sweep has its OWN loop (#1120 review)', () => {
  it('evicts on its own timer, with no reaper involved', async () => {
    // The first draft swept inside the session reaper's tick. That loop is
    // gated on DISABLE_SESSION_REAPER, so a deployment with the reaper off got
    // no key eviction at all — SESSION_KEY_CACHE_TTL_MS silently inert and
    // keys immortal, which is the exact defect #1114 set out to remove
    // surviving in the one configuration nobody would check.
    //
    // An eviction policy for key material must not be reachable through
    // another subsystem's off switch. This test drives the loop directly, so
    // it fails if the sweep is ever folded back into someone else's tick.
    globalCache.clear();
    globalCache.set('s1', 'mem1', key(9));
    expect(globalCache.hasMemory('mem1')).toBe(true);

    const loop = startSessionKeySweepLoop(10);
    try {
      advance(DEFAULT_SESSION_KEY_TTL_MS + 1000);
      await vi.advanceTimersByTimeAsync(30);
      expect(globalCache.hasMemory('mem1')).toBe(false);
    } finally {
      loop.stop();
      globalCache.clear();
    }
  });
});

describe('the sweep is actually WIRED, and not behind the reaper switch', () => {
  /**
   * A source-level assertion, and the reason it is worth one: the defect Codex
   * found on #1120 was not in the sweep — it was in WHERE the sweep was
   * started. Every behavioural test above passes with the loop never started
   * at all, because they drive it directly. So the only thing that can catch a
   * regression here is a check on the wiring itself.
   *
   * Two properties, and the second is the one that was wrong:
   *   1. the loop is started in the server bootstrap at all;
   *   2. it is NOT inside the `DISABLE_SESSION_REAPER` branch — an eviction
   *      policy for key material must not be reachable through another
   *      subsystem's off switch.
   */
  it('server bootstrap starts it, outside the DISABLE_SESSION_REAPER gate', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../server.ts', import.meta.url), 'utf8');

    expect(src).toContain('startSessionKeySweepLoop()');

    // Find the reaper's gated block and assert the sweep call is not in it.
    const gate = src.indexOf("process.env.DISABLE_SESSION_REAPER !== 'true'");
    expect(gate).toBeGreaterThan(-1);
    const blockEnd = src.indexOf('\n  }', gate);
    const gatedBlock = src.slice(gate, blockEnd);
    expect(gatedBlock).not.toContain('startSessionKeySweepLoop');
  });
});

describe('an expired key is not resurrected by reading it (#1120 review)', () => {
  it('a read past the TTL returns null and drops the entry, rather than touching it', async () => {
    // The hole: touching before checking meant a caller polling SLOWER than the
    // TTL but FASTER than the sweep kept key material resident indefinitely,
    // while every single idle gap exceeded the promise. The sweep is a
    // background convenience; a TTL has to hold at the point of USE.
    const c = new SessionKeyCache();
    c.set('s1', 'mem1', key(3));

    advance(DEFAULT_SESSION_KEY_TTL_MS + 1000);
    expect(c.getByMemoryId('mem1')).toBeNull();
    expect(c.hasMemory('mem1')).toBe(false);
    // Dropped, not merely hidden: a later sweep has nothing left to find.
    expect(c.sweepExpired()).toBe(0);
    expect(c.refCount('mem1')).toBe(0);
  });

  it('polling slower than the TTL cannot keep a key alive forever', async () => {
    // The scenario stated directly, because it is the one that motivated the
    // finding and it is invisible in a single-read test.
    process.env.SESSION_KEY_CACHE_TTL_MS = String(60_000); // 1 min, well under any sweep
    const c = new SessionKeyCache();
    c.set('s1', 'mem1', key(4));

    for (let i = 0; i < 3; i++) {
      advance(90_000); // every gap exceeds the TTL
      expect(c.getByMemoryId('mem1'), `read ${i}`).toBeNull();
    }
  });

  it('CONTROL: polling FASTER than the TTL does keep it alive', async () => {
    // Without this, "expire on read" could have been implemented as "always
    // expire", and the suite above would not notice.
    process.env.SESSION_KEY_CACHE_TTL_MS = String(60_000);
    const c = new SessionKeyCache();
    c.set('s1', 'mem1', key(5));
    for (let i = 0; i < 5; i++) {
      advance(30_000);
      expect(c.getByMemoryId('mem1'), `read ${i}`).not.toBeNull();
    }
  });
});
