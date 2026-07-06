/**
 * Spec 041 — request-scoped unlock keys (PR-514 review, Codex P1 ×2).
 *
 * Keys supplied via the x-hadron-memory-keys header must be visible ONLY to
 * the request that sent them. Instead of staging them in the process-wide
 * sessionKeyCache (where a concurrent request for the same memory would see
 * them, and an aborted response could strand them), they live in an
 * AsyncLocalStorage store established per request:
 *
 *   - sessionKeyCache.getByMemoryId consults this store FIRST, so every
 *     existing encrypt/decrypt call site is request-scoped automatically.
 *   - The store is unreachable the moment the request's async context ends
 *     — finished, aborted, or crashed. No eviction bookkeeping exists to
 *     get wrong.
 *
 * Long-lived keys (agent sessions, the MCP unlock in PR-2) keep using the
 * global cache — their lifetime IS the session, which has explicit
 * eviction.
 */

import { AsyncLocalStorage } from 'async_hooks';
import type { EncryptionKey } from './crypto.js';

export const requestKeyStorage = new AsyncLocalStorage<Map<string, EncryptionKey>>();

/** The current request's staged key for a memory, if any. */
export function getRequestKey(memoryId: string): EncryptionKey | null {
  return requestKeyStorage.getStore()?.get(memoryId) ?? null;
}

/** Stage a key into the CURRENT request's store. Throws outside a request scope. */
export function setRequestKey(memoryId: string, key: EncryptionKey): void {
  const store = requestKeyStorage.getStore();
  if (!store) {
    throw new Error('setRequestKey called outside a request key scope');
  }
  store.set(memoryId, key);
}
