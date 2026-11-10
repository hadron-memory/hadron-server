/**
 * #445 — duplicate suppression for a periodic sweep across server processes.
 *
 * One DEDICATED PostgreSQL session holds a session advisory lock for the whole
 * run, the precedent being integrations/github/mirrorCheckoutLock.ts: Prisma's
 * pooled connection cannot hold a session lock (the unlock might run on another
 * connection), and an interactive transaction would pin a pool connection and
 * hit the 5s transaction timeout. This takes ZERO pool connections and has no
 * timeout, so `fn` keeps using the outer client.
 *
 * What it is NOT: an exactly-once guarantee. Losing the session (database
 * restart, network) drops the lock while `fn` runs, so every sweep body must
 * stay safe if two runs overlap. Each caller needs its own overlap-safety
 * argument; there is deliberately no blanket wrapper over the other sweeps.
 *
 * Acquisition is non-blocking (`pg_try_advisory_lock`) AND bounded in time: the
 * connect and the lock/unlock queries each give up after `acquireTimeoutMs`, so a
 * network that silently drops packets cannot leave a tick pending while later
 * ticks pile up behind it. If the lock session cannot be opened or the lock query
 * fails or times out, the tick is logged and skipped (fail-closed for a
 * destructive sweep; the next tick retries). The limit covers only the lock
 * session's own statements, never `fn`: a sweep may run as long as it needs.
 */

import { createHash } from 'crypto';
import { Client } from 'pg';

/** Namespace disjoint from 'hadron:git-mirror:'. `name` must be a source constant, never tenant input. */
export function sweepLockKey(name: string): string {
  return createHash('sha256')
    .update(`hadron:sweep:${name}`)
    .digest()
    .readBigInt64BE()
    .toString();
}

export type SweepLockResult<T> = { ran: true; value: T } | { ran: false };

/** Default bound on opening the lock session and on each of its statements. */
export const SWEEP_LOCK_ACQUIRE_TIMEOUT_MS = 5000;

export async function withSweepLock<T>(
  name: string, fn: () => Promise<T>, opts: { acquireTimeoutMs?: number } = {},
): Promise<SweepLockResult<T>> {
  const acquireTimeoutMs = opts.acquireTimeoutMs ?? SWEEP_LOCK_ACQUIRE_TIMEOUT_MS;
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: acquireTimeoutMs,
    query_timeout: acquireTimeoutMs,
  });
  // An idle-connection error (database gone while fn runs) must not kill the
  // process as an uncaught EventEmitter error; the lock is dropped with it.
  client.on('error', (error) => {
    console.error(`[sweep-lock] ${name}: lock connection lost:`, error);
  });
  const key = sweepLockKey(name);
  let locked = false;
  try {
    try {
      await client.connect();
      const res = await client.query<{ got: boolean }>('SELECT pg_try_advisory_lock($1::bigint) AS got', [key]);
      locked = res.rows[0]?.got === true;
    } catch (error) {
      console.error(`[sweep-lock] ${name}: could not take the lock, skipping this tick:`, error);
      return { ran: false };
    }
    if (!locked) return { ran: false };
    return { ran: true, value: await fn() };
  } finally {
    try {
      if (locked) await client.query('SELECT pg_advisory_unlock($1::bigint)', [key]);
    } catch {
      // Session already gone: closing it released the lock.
    } finally {
      // `end()` waits on the socket; a dead one must not hold the tick open either.
      await Promise.race([
        client.end().catch(() => {}),
        new Promise<void>((done) => setTimeout(done, acquireTimeoutMs).unref()),
      ]);
    }
  }
}
