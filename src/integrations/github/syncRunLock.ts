/**
 * #3571 (ruling 0223, cor:int:010:01): the sync-run lock that tells a running sync from an abandoned SYNCING status.
 *
 * Every git-sync attempt holds `hashtext('hadron:git-sync:' || memoryId)` SHARED, as a session advisory lock on its
 * own dedicated connection, from before it stamps SYNCING until after its final OK/ERROR write. Those three writes in
 * syncGraphFromGithub are the only writers of `memories.sync_status`, so every writer that can leave a row SYNCING
 * holds the lock while it does. Shared, so concurrent syncs of one memory do not start waiting on each other.
 *
 * The reconciliation (reconcileSyncing.ts) takes the same key EXCLUSIVELY with a try, inside its transaction: if any
 * sync holds it, the row is skipped, never waited on or overwritten. A process that dies mid-sync drops its
 * connection and Postgres releases the lock, so "SYNCING with no holder" means abandoned. A sync that starts while a
 * reconciliation holds the key waits only for that short transaction, then stamps SYNCING as usual.
 *
 * A dedicated connection, not the pooled Prisma client: a session lock lives on the connection that took it, and a
 * pooled client gives no guarantee that the release runs on the same one.
 */
import { Client } from 'pg';

export const SYNC_RUN_LOCK_PREFIX = 'hadron:git-sync:';

/** The lock key's text for a memory; hashed with Postgres's hashtext() on both sides. */
export function syncRunLockKey(memoryId: string): string {
  return `${SYNC_RUN_LOCK_PREFIX}${memoryId}`;
}

/**
 * Take the memory's sync-run lock SHARED, waiting while a reconciliation holds it exclusively. Returns the release,
 * which unlocks and closes the connection and never throws (a failed release still ends the connection, which frees
 * the lock).
 */
export async function acquireSyncRunLock(memoryId: string): Promise<() => Promise<void>> {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  // #4719 SEC10 F1: pg emits an idle-connection error if the database drops this connection while the sync runs; an
  // unhandled EventEmitter error would exit the server process (mirrorCheckoutLock.ts has the same listener). A lost
  // connection releases the lock with it, so the row then reads as abandoned, which is what it would be if this
  // process died: the reconciliation may set it to PENDING, and the sync's own final status write still lands after.
  client.on('error', (error) => {
    console.error('[git-sync] sync-run lock connection lost', { message: error.message });
  });
  await client.connect();
  try {
    await client.query('SELECT pg_advisory_lock_shared(hashtext($1))', [syncRunLockKey(memoryId)]);
  } catch (error) {
    await client.end().catch(() => {});
    throw error;
  }
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    try {
      await client.query('SELECT pg_advisory_unlock_shared(hashtext($1))', [syncRunLockKey(memoryId)]);
    } catch {
      // Ending the connection below releases the lock regardless.
    } finally {
      await client.end().catch(() => {});
    }
  };
}
