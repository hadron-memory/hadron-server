/**
 * Object-store purging for assets whose DB rows are about to disappear.
 *
 * **The problem this solves.** `Asset.memoryId` is `onDelete: Cascade`,
 * so hard-deleting a Memory silently takes its Asset ROWS with it —
 * but nothing deletes the OBJECTS. The bytes stay in the bucket
 * forever, unreferenced and unfindable, because the only record of
 * their storage key went away with the row. Account deletion
 * (deleteUser hard-deletes the target's owned memories) was leaking
 * every file those memories held.
 *
 * **Why keys are collected before the delete, not after.** The storage
 * key lives only on the Asset row. Once the cascade fires there is no
 * way to learn what to delete — no reverse index, and (for encrypted
 * memories) no way to recover the plaintext key at all. So collection
 * must happen inside the same transaction, ahead of the cascade, and
 * the returned keys are deleted after it commits.
 *
 * **Why deletion is post-commit and best-effort.** External I/O must
 * not ride a retried SERIALIZABLE transaction body, and a dead object
 * store must not block an account deletion the user asked for. The DB
 * effect is durable either way; a failed object delete logs and leaves
 * an orphan, which is a storage-cost problem, not a correctness or
 * privacy one — the row it was reachable through is already gone. This
 * mirrors the provider-sidecar teardown in deleteUser.
 *
 * **Encrypted memories are the known gap.** A storage key in an
 * encrypted memory is itself encrypted, and decrypting it needs that
 * memory's session key — which a deletion path generally does not
 * hold. Those keys are reported separately rather than silently
 * dropped, so the caller can log them as known-orphaned. Their bytes
 * are reclaimed by the bucket-side sweep in
 * `src/jobs/reapOrphanAssetObjects.ts` (#889), which matches plaintext
 * object keys against asset PKs and so never needs to decrypt anything
 * — the catch-all for every leak path at once, this one included.
 */

import type { PrismaClient } from '../../generated/prisma/index.js';
import { deleteObject } from '../../integrations/r2/client.js';
import { decryptStorageKey } from '../../lib/asset/encryption.js';
import { sessionKeyCache } from '../../lib/sessionKeyCache.js';
import { logAssetEvent } from './audit.js';

export interface CollectedAssetKeys {
  /** Plaintext storage keys ready to delete from the object store. */
  keys: string[];
  /**
   * Asset ids whose storage key could not be decrypted (encrypted
   * memory, no session key). Their bytes will be orphaned.
   */
  undecryptable: string[];
}

/**
 * Collect the plaintext object-store keys of every asset held by the
 * given memories. Call INSIDE the deleting transaction, before the
 * cascade removes the rows.
 *
 * `tx` is a transaction client; typed loosely so this works with both
 * `PrismaClient` and the `$transaction` callback client.
 */
export async function collectAssetKeysForMemories(
  tx: Pick<PrismaClient, 'asset' | 'memory'>,
  memoryIds: string[],
): Promise<CollectedAssetKeys> {
  if (memoryIds.length === 0) return { keys: [], undecryptable: [] };

  const assets = await tx.asset.findMany({
    where: { memoryId: { in: memoryIds } },
    select: { id: true, storageKey: true, memoryId: true },
  });
  if (assets.length === 0) return { keys: [], undecryptable: [] };

  const memories = await tx.memory.findMany({
    where: { id: { in: memoryIds } },
    select: { id: true, isEncrypted: true },
  });
  const encrypted = new Map(memories.map((m) => [m.id, m.isEncrypted]));

  const keys: string[] = [];
  const undecryptable: string[] = [];
  for (const asset of assets) {
    const isEncrypted = asset.memoryId ? encrypted.get(asset.memoryId) : false;
    const sessionKey =
      isEncrypted && asset.memoryId
        ? sessionKeyCache.getByMemoryId(asset.memoryId)
        : null;
    try {
      keys.push(decryptStorageKey(asset.storageKey, sessionKey));
    } catch {
      undecryptable.push(asset.id);
    }
  }
  return { keys, undecryptable };
}

/**
 * Delete collected objects from the object store. Call AFTER the
 * transaction commits. Never throws — see the module header on why a
 * failed object delete must not fail the deletion it belongs to.
 */
export async function purgeCollectedAssetObjects(
  collected: CollectedAssetKeys,
  reason: string,
): Promise<void> {
  for (const id of collected.undecryptable) {
    logAssetEvent({
      operation: 'purged',
      assetId: id,
      error: 'storage key undecryptable (encrypted memory, no session key) — object orphaned',
      reason,
    });
  }
  for (const key of collected.keys) {
    try {
      await deleteObject(key);
    } catch (err) {
      logAssetEvent({
        operation: 'purged',
        error: `object delete failed: ${String(err)}`,
        reason,
      });
    }
  }
  if (collected.keys.length > 0) {
    logAssetEvent({
      operation: 'purged',
      count: collected.keys.length,
      reason,
    });
  }
}
