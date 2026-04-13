import type { EncryptionKey } from './crypto.js';

/**
 * In-memory, ref-counted cache mapping session IDs to the data keys needed to
 * decrypt the memory content a session operates on. Keys are **never**
 * persisted — they live only in this process and only as long as at least one
 * session references the underlying memory.
 *
 * Ref counting: multiple concurrent sessions may share the same memory (a
 * user on phone + laptop, for example). Each session start increments the
 * refcount; each end decrements it. When it hits zero, the key is evicted.
 *
 * The module exports a process-wide singleton (`sessionKeyCache`) that the
 * resolvers and middleware share.
 */

interface MemoryKeyEntry {
  key: EncryptionKey;
  sessionIds: Set<string>;
}

export class SessionKeyCache {
  private byMemory = new Map<string, MemoryKeyEntry>();
  private sessionToMemory = new Map<string, string>();

  /**
   * Register a data key for a session. If the memory already has an active
   * key, the new call must present the same key material — mismatches throw.
   * This protects against a caller accidentally passing the wrong key for a
   * user with concurrent sessions.
   */
  set(sessionId: string, memoryId: string, key: EncryptionKey): void {
    const existing = this.byMemory.get(memoryId);
    if (existing) {
      if (!existing.key.raw.equals(key.raw)) {
        throw new Error('Session key conflict: different key provided for an active memory');
      }
      existing.sessionIds.add(sessionId);
    } else {
      this.byMemory.set(memoryId, { key, sessionIds: new Set([sessionId]) });
    }
    this.sessionToMemory.set(sessionId, memoryId);
  }

  /** Look up the key for a given memory; null if no session is active. */
  getByMemoryId(memoryId: string): EncryptionKey | null {
    return this.byMemory.get(memoryId)?.key ?? null;
  }

  /** True if the cache has any active session for the given memory. */
  hasMemory(memoryId: string): boolean {
    return this.byMemory.has(memoryId);
  }

  /**
   * Evict a session's reference. If this was the last session holding the
   * memory's key, the key is removed from the cache.
   */
  evict(sessionId: string): void {
    const memoryId = this.sessionToMemory.get(sessionId);
    if (!memoryId) return;
    this.sessionToMemory.delete(sessionId);
    const entry = this.byMemory.get(memoryId);
    if (!entry) return;
    entry.sessionIds.delete(sessionId);
    if (entry.sessionIds.size === 0) {
      this.byMemory.delete(memoryId);
    }
  }

  /** How many sessions currently hold a key for this memory. */
  refCount(memoryId: string): number {
    return this.byMemory.get(memoryId)?.sessionIds.size ?? 0;
  }

  /** Clear everything. Intended for tests only. */
  clear(): void {
    this.byMemory.clear();
    this.sessionToMemory.clear();
  }
}

export const sessionKeyCache = new SessionKeyCache();
