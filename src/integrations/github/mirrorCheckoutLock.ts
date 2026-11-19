/**
 * Serialize work on one Memory's Git checkout across server processes.
 *
 * A process-local queue cannot protect a checkout shared by two workers, and
 * Prisma's pooled connection cannot safely hold a session advisory lock: the
 * unlock might run on a different connection. Use one dedicated PostgreSQL
 * session for the whole Git operation. Closing it releases the lock even when
 * the process dies before the explicit unlock.
 */

import { createHash } from 'crypto';
import { Client } from 'pg';

/**
 * R206: the memory is encrypted, or became so before this operation took its
 * row fence. Callers translate it into their typed refusal.
 */
export class EncryptedMemoryFenceError extends Error {
  constructor() {
    super('ENCRYPTED_GIT_SYNC_UNAVAILABLE');
    this.name = 'EncryptedMemoryFenceError';
  }
}

export function mirrorCheckoutLockKey(memoryId: string): string {
  return createHash('sha256')
    .update(`hadron:git-mirror:${memoryId}`)
    .digest()
    .readBigInt64BE()
    .toString();
}

// A burst of Node/Edge events for one Memory must not open one PostgreSQL
// session per waiting event. Only the head of each local queue reaches the
// database; PostgreSQL still serializes heads from different server processes.
const localTails = new Map<string, Promise<void>>();

export async function withMirrorCheckoutLock<T>(
  memoryId: string,
  work: () => Promise<T>,
  opts: { fenceEncryption?: boolean } = {},
): Promise<T> {
  const previous = localTails.get(memoryId) ?? Promise.resolve();
  let release!: () => void;
  const turn = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.then(() => turn);
  localTails.set(memoryId, tail);
  await previous;
  try {
    return await withPostgresMirrorCheckoutLock(memoryId, work, opts.fenceEncryption === true);
  } finally {
    release();
    if (localTails.get(memoryId) === tail) localTails.delete(memoryId);
  }
}

async function withPostgresMirrorCheckoutLock<T>(
  memoryId: string,
  work: () => Promise<T>,
  fenceEncryption: boolean,
): Promise<T> {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  // pg emits an idle-connection error if the database disappears while Git is
  // running. Log it instead of letting an uncaught EventEmitter error kill the
  // process. Failure/reconciliation after a lost lock is tracked by #430.
  client.on('error', (error) => {
    console.error('[git-mirror] Checkout lock connection lost:', error);
  });
  await client.connect();
  const key = mirrorCheckoutLockKey(memoryId);
  let locked = false;
  try {
    await client.query('SELECT pg_advisory_lock($1::bigint)', [key]);
    locked = true;
    if (!fenceEncryption) return await work();
    // R206: hold a KEY SHARE row lock on the Memory for the WHOLE operation.
    // Every encryption flip takes the row FOR UPDATE (encryptMemory, the
    // anonymous promotion), which conflicts with it, so a conversion either
    // commits before this check (typed refusal) or waits until the operation —
    // snapshot, render, commit and push — has finished. KEY SHARE conflicts with
    // nothing else, so ordinary updates to the row are not delayed.
    await client.query('BEGIN');
    try {
      const fence = await client.query<{ is_encrypted: boolean }>(
        'SELECT is_encrypted FROM memories WHERE id = $1 FOR KEY SHARE', [memoryId]);
      if (fence.rows[0]?.is_encrypted) throw new EncryptedMemoryFenceError();
      const result = await work();
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    }
  } finally {
    try {
      if (locked) await client.query('SELECT pg_advisory_unlock($1::bigint)', [key]);
    } finally {
      await client.end();
    }
  }
}
