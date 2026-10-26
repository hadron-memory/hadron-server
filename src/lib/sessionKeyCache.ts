import type { SessionType } from '../generated/prisma/index.js';
import type { EncryptionKey } from './crypto.js';
import { getRequestKey } from './requestKeys.js';
import { idleWindowMsFor, DEFAULT_SESSION_IDLE_WINDOW_MS } from './sessionActivity.js';

/** Types the TTL default ranges over — the same set the windows are keyed on. */
const SESSION_TYPES_FOR_TTL: SessionType[] = ['DEVELOPER', 'CHATBOT', 'AUTOMATION', 'EDGE'];

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
  /** Epoch ms of the last `set` or successful lookup — the TTL clock below. */
  lastUsedAt: number;
}

/**
 * How long an unused key stays resident (#1114).
 *
 * **This cache had no expiry of its own.** A key was released when the last
 * holding session ENDED, and for an abandoned session that meant when the
 * reaper's inactivity rule ended it — so the eviction policy for process-held
 * key material was a side effect of a durable record's lifecycle. Removing that
 * rule would have made these keys immortal, which is why the finding stands on
 * its own: a cache should never have depended on that, and the dependence was
 * invisible while something else happened to end sessions.
 *
 * The default INHERITS the deployment's configured idle windows rather than
 * being a fixed 24h (#1120 review, Codex P2). The fixed value silently changed
 * retention for anyone who had tuned one: a fleet on a 48h window kept keys
 * ~48h before this change and would have dropped to 24h, and one on a short
 * window would have had its keys held far LONGER than it had chosen — a
 * security-relevant regression in the direction nobody would notice.
 *
 * The widest configured window is used, and the imprecision is stated rather
 * than hidden: an entry is keyed by MEMORY and may be held by sessions of
 * different types, so there is no single per-type window that is correct for
 * it. Widest preserves availability (a key never disappears earlier than the
 * old lifecycle would have released it) and is the safe direction for a cache
 * whose early eviction breaks decryption mid-stint. `SESSION_KEY_CACHE_TTL_MS`
 * overrides it outright for a deployment that wants the retention decided
 * independently of liveness.
 */
export const DEFAULT_SESSION_KEY_TTL_MS = DEFAULT_SESSION_IDLE_WINDOW_MS;

function ttlMs(): number {
  const raw = process.env.SESSION_KEY_CACHE_TTL_MS;
  if (raw !== undefined && raw.trim() !== '') {
    const n = Number(raw);
    if (Number.isInteger(n) && n > 0) return n;
  }
  // Inherit the deployment's own idle tuning — see the constant's docstring.
  return Math.max(...SESSION_TYPES_FOR_TTL.map((t) => idleWindowMsFor(t)));
}

/**
 * Ruling DY-4: the re-unlock hint a locked-memory error carries. The key cache
 * TTL stays a separate security setting, so after a quiet stretch a memory
 * that WAS unlocked reads as locked again with no lock call having happened.
 * Saying so turns a puzzling failure into a one-step remedy.
 */
export function sessionKeyReleasedHint(): string {
  const hours = Math.round((ttlMs() / 3_600_000) * 10) / 10;
  return (
    `If this memory was unlocked earlier, its key was released after ${hours}h unused ` +
    '(the key-cache TTL, a security setting); unlock it again with hadron_unlock_memory.'
  );
}

/** A different key is already live for the memory: a fixed-text, retryable refusal (#1789), not a fault. */
export class SessionKeyConflictError extends Error {
  constructor() {
    super('Session key conflict: different key provided for an active memory');
    this.name = 'SessionKeyConflictError';
  }
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
        throw new SessionKeyConflictError();
      }
      existing.sessionIds.add(sessionId);
      existing.lastUsedAt = Date.now();
    } else {
      this.byMemory.set(memoryId, {
        key,
        sessionIds: new Set([sessionId]),
        lastUsedAt: Date.now(),
      });
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
    const staged = getRequestKey(memoryId);
    if (staged) return staged;
    const entry = this.byMemory.get(memoryId);
    if (!entry) return null;
    // EXPIRE BEFORE TOUCHING (#1120 review, Codex P2). Touching first meant a
    // read after the TTL but before the next sweep returned the key AND reset
    // its clock — so a caller polling slower than the TTL and faster than the
    // sweep kept key material resident forever, while every idle gap exceeded
    // the promise. The sweep is a background convenience; the TTL has to hold
    // at the point of USE or it is not a TTL.
    if (this.isExpired(entry)) {
      this.dropEntry(memoryId, entry);
      return null;
    }
    // Touch on READ, not only on set: the TTL is an idle timer, so a memory
    // being actively decrypted must never expire under its own session.
    entry.lastUsedAt = Date.now();
    return entry.key;
  }

  /**
   * True if a key is available for the given memory (request or session).
   *
   * Routed through `getByMemoryId` so an EXPIRED entry answers false here too
   * — two readers of one cache must not disagree about whether a key exists.
   */
  hasMemory(memoryId: string): boolean {
    return getRequestKey(memoryId) != null || this.getByMemoryId(memoryId) != null;
  }

  /**
   * Release ONE memory's key from a session (spec 041 hadron_lock_memory)
   * without touching the session's other keys. Removes the key entirely
   * when this was the last holding session.
   */
  release(sessionId: string, memoryId: string): void {
    const memories = this.sessionToMemories.get(sessionId);
    if (!memories?.delete(memoryId)) return;
    if (memories.size === 0) this.sessionToMemories.delete(sessionId);
    const entry = this.byMemory.get(memoryId);
    if (!entry) return;
    entry.sessionIds.delete(sessionId);
    if (entry.sessionIds.size === 0) this.byMemory.delete(memoryId);
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

  /**
   * Drop every key untouched for longer than the TTL, whatever the state of the
   * sessions holding it (#1114).
   *
   * The session references are dropped with it: a session whose key expired is
   * simply no longer holding one, which is the honest state. It does NOT end
   * the session — ending is an act, and a cache has no business inferring one.
   *
   * Returns the number of memories evicted, so a caller can log a real number.
   */
  sweepExpired(now: number = Date.now()): number {
    let evicted = 0;
    for (const [memoryId, entry] of this.byMemory) {
      if (!this.isExpired(entry, now)) continue;
      this.dropEntry(memoryId, entry);
      evicted++;
    }
    return evicted;
  }

  /**
   * Strictly older than the cutoff: at EXACTLY the TTL a key has not yet been
   * "untouched for LONGER than the TTL" (#1120 review, Copilot). Shared by the
   * sweep and the read path so the two cannot disagree about what expired
   * means.
   */
  private isExpired(entry: MemoryKeyEntry, now: number = Date.now()): boolean {
    return entry.lastUsedAt < now - ttlMs();
  }

  /** Remove one memory's key and every session reference to it. */
  private dropEntry(memoryId: string, entry: MemoryKeyEntry): void {
    this.byMemory.delete(memoryId);
    for (const sessionId of entry.sessionIds) {
      const memories = this.sessionToMemories.get(sessionId);
      if (!memories?.delete(memoryId)) continue;
      if (memories.size === 0) this.sessionToMemories.delete(sessionId);
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

/** Handle for the sweep loop, so a test can stop it without leaking a timer. */
export interface SessionKeySweepLoop {
  stop: () => void;
}

/**
 * Run the cache's TTL sweep on its OWN timer (#1120 review, Codex P2).
 *
 * The first draft swept inside the session reaper's tick, on the reasoning
 * that the tick was "a convenient clock, not a lifecycle dependency". That
 * reasoning was fine and the placement was still wrong: the reaper loop is
 * gated on `DISABLE_SESSION_REAPER`, so any deployment that turned the reaper
 * off got no key eviction at all — `SESSION_KEY_CACHE_TTL_MS` silently inert
 * and keys immortal, which is the exact defect #1114 set out to remove,
 * surviving in the one configuration nobody would think to check.
 *
 * A cache's eviction policy must not be reachable through another subsystem's
 * off switch. Hence its own loop, started unconditionally outside tests.
 */
export function startSessionKeySweepLoop(intervalMs?: number): SessionKeySweepLoop {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  // CADENCE FOLLOWS THE TTL (#1120 review, Codex P2). A fixed 15-minute tick
  // left key material resident for up to 15 minutes past its advertised
  // retention whenever the TTL was configured shorter than that — the
  // point-of-use check makes it unusable, but "cannot be used" and "is not in
  // process memory" are different promises, and for key material it is the
  // second one that was advertised.
  //
  // Re-derived on every tick rather than once at start, so a TTL read from the
  // environment at runtime is honoured without a restart, and clamped: half the
  // TTL is prompt enough, a floor keeps a tiny TTL from spinning the loop, and
  // the 15-minute ceiling is what a long TTL costs nothing to keep.
  const cadence = (): number => {
    if (intervalMs !== undefined) return intervalMs;
    return Math.min(15 * 60 * 1000, Math.max(1000, Math.floor(ttlMs() / 2)));
  };

  const tick = () => {
    if (stopped) return;
    const evicted = sessionKeyCache.sweepExpired();
    if (evicted > 0) {
      // eslint-disable-next-line no-console
      console.log(`[session-keys] evicted ${evicted} idle memory key(s)`);
    }
    schedule();
  };

  const schedule = () => {
    if (stopped) return;
    timer = setTimeout(tick, cadence());
    timer.unref?.();
  };

  schedule();
  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}

