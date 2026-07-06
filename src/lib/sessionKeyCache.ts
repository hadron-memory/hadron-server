import type { EncryptionKey } from './crypto.js';
import { getRequestKey } from './requestKeys.js';

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
  // One session may hold keys for SEVERAL memories (spec 041: a request
  // staging keys for multiple encrypted memories via the unlock header) —
  // a Set per session, so evict() releases every reference.
  private sessionToMemories = new Map<string, Set<string>>();

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
    let memories = this.sessionToMemories.get(sessionId);
    if (!memories) {
      memories = new Set();
      this.sessionToMemories.set(sessionId, memories);
    }
    memories.add(memoryId);
  }

  /**
   * Look up the key for a given memory; null if none is available. The
   * CURRENT REQUEST's staged keys (x-hadron-memory-keys header, spec 041)
   * take precedence and are visible only inside that request's async
   * context — a concurrent request for the same memory sees nothing
   * (PR-514 review, Codex P1). Session-lived keys come from the global map.
   */
  getByMemoryId(memoryId: string): EncryptionKey | null {
    return getRequestKey(memoryId) ?? this.byMemory.get(memoryId)?.key ?? null;
  }

  /** True if a key is available for the given memory (request or session). */
  hasMemory(memoryId: string): boolean {
    return getRequestKey(memoryId) != null || this.byMemory.has(memoryId);
  }

  /**
   * Evict a session's references. If this was the last session holding a
   * memory's key, the key is removed from the cache.
   */
  evict(sessionId: string): void {
    const memories = this.sessionToMemories.get(sessionId);
    if (!memories) return;
    this.sessionToMemories.delete(sessionId);
    for (const memoryId of memories) {
      const entry = this.byMemory.get(memoryId);
      if (!entry) continue;
      entry.sessionIds.delete(sessionId);
      if (entry.sessionIds.size === 0) {
        this.byMemory.delete(memoryId);
      }
    }
  }

  /** How many sessions currently hold a key for this memory. */
  refCount(memoryId: string): number {
    return this.byMemory.get(memoryId)?.sessionIds.size ?? 0;
  }

  /** Clear everything. Intended for tests only. */
  clear(): void {
    this.byMemory.clear();
    this.sessionToMemories.clear();
  }
}

export const sessionKeyCache = new SessionKeyCache();
