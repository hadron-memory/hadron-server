/**
 * janitorAssets — purge soft-deleted assets whose 24h recovery window
 * has elapsed. Deletes the R2 object first, then hard-deletes the
 * asset row. Safe to re-run; idempotent.
 *
 * Spec: spec-kits/specs/004-asset-upload/contracts/controller-api.md
 *       spec FR-018.
 *
 * Run via:
 *   tsx src/jobs/janitorAssets.ts
 *
 * TODO: orphan-key reaping (R2 objects with no matching Asset row)
 * requires ListObjectsV2 paging. Out of scope for v1; tracked
 * separately.
 */

import type { PrismaClient } from '../generated/prisma/index.js';
import { db as defaultDb } from '../integrations/db/client.js';
import { deleteObject } from '../integrations/r2/client.js';
import { logAssetEvent } from '../lib/asset/audit.js';
import { decryptStorageKey } from '../lib/asset/encryption.js';
import { sessionKeyCache } from '../lib/sessionKeyCache.js';
import { ASSET_RETENTION_WINDOW_MS } from '../lib/asset/retention.js';

export interface JanitorOutcome {
  scanned: number;
  purged: number;
  errors: number;
}

export async function runAssetJanitor(
  db: PrismaClient = defaultDb,
  now: Date = new Date(),
): Promise<JanitorOutcome> {
  const cutoff = new Date(now.getTime() - ASSET_RETENTION_WINDOW_MS);
  const candidates = await db.asset.findMany({
    where: { deletedAt: { not: null, lte: cutoff } },
    include: {
      memory: { select: { id: true, isEncrypted: true } },
    },
  });

  let scanned = 0;
  let purged = 0;
  let errors = 0;

  for (const asset of candidates) {
    scanned += 1;
    try {
      // Decrypt storage_key if needed — janitor needs the plaintext
      // key to delete the R2 object. If the memory is encrypted and
      // we lack the session key, skip this row (we can't safely
      // delete the bytes without their key); the next scheduled run
      // tries again.
      const sessionKey = asset.memory.isEncrypted
        ? sessionKeyCache.getByMemoryId(asset.memory.id)
        : null;
      let plainStorageKey: string;
      try {
        plainStorageKey = decryptStorageKey(asset.storageKey, sessionKey);
      } catch {
        errors += 1;
        logAssetEvent({
          operation: 'purged',
          assetId: asset.id,
          memoryId: asset.memoryId,
          error: 'cannot decrypt storage_key — encrypted memory with no active session key',
        });
        continue;
      }

      await deleteObject(plainStorageKey);
      await db.asset.delete({ where: { id: asset.id } });
      logAssetEvent({
        operation: 'purged',
        assetId: asset.id,
        memoryId: asset.memoryId,
        userId: asset.uploadedBy,
        bytes: asset.sizeBytes,
      });
      purged += 1;
    } catch (e) {
      errors += 1;
      logAssetEvent({
        operation: 'purged',
        assetId: asset.id,
        memoryId: asset.memoryId,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return { scanned, purged, errors };
}

// Allow `tsx src/jobs/janitorAssets.ts` to run the janitor directly.
if (import.meta.url === `file://${process.argv[1]}`) {
  runAssetJanitor()
    .then((outcome) => {
      // eslint-disable-next-line no-console
      console.log(JSON.stringify({ ...outcome, ranAt: new Date().toISOString() }));
      process.exit(outcome.errors > 0 ? 1 : 0);
    })
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error(err);
      process.exit(1);
    });
}
