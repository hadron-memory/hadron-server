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
 * This sweep only ever acts on a tombstone — a row whose `deletedAt` has
 * aged out. Objects with NO row at all (cascaded deletes, encrypted
 * memories, abandoned uploads) are the orphan reaper's job:
 * `src/jobs/reapOrphanAssetObjects.ts` (#889).
 */

import type { PrismaClient } from '../generated/prisma/index.js';
import { db as defaultDb } from '../integrations/db/client.js';
import { deleteObject } from '../integrations/r2/client.js';
import { logAssetEvent } from '../lib/asset/audit.js';
import { decryptStorageKey } from '../lib/asset/encryption.js';
import { sessionKeyCache } from '../lib/sessionKeyCache.js';
import { ASSET_RETENTION_WINDOW_MS } from '../lib/asset/retention.js';
import { withSweepLock, type SweepLockResult } from '../lib/sweepLock.js';

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
      // 006-asset-upload-redesign: Asset.memory is nullable for staged
      // assets, but the soft-delete sweep above only matches attached
      // assets (staged assets are deleted via the staging-TTL janitor
      // path, which lives elsewhere). The null check is a defensive
      // assertion — in practice this branch is unreachable.
      if (!asset.memory) {
        errors += 1;
        logAssetEvent({
          operation: 'purged',
          assetId: asset.id,
          memoryId: asset.memoryId,
          error: 'janitor saw a staged-but-soft-deleted asset (unexpected state)',
        });
        continue;
      }
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
      // deleteMany, not delete: an overlapping run (a lost sweep lock, or two
      // processes) can have removed the row after our findMany. Count 0 means
      // "already purged" and is neither an error nor a second audit event.
      // The object delete above is idempotent, and its order before the row
      // delete is kept so a failed object delete leaves the row to retry.
      const { count } = await db.asset.deleteMany({ where: { id: asset.id } });
      if (count > 0) {
        logAssetEvent({
          operation: 'purged',
          assetId: asset.id,
          memoryId: asset.memoryId,
          userId: asset.uploadedBy,
          bytes: asset.sizeBytes,
        });
        purged += 1;
      }
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

/**
 * One scheduled tick: skip when another process holds the janitor lock (#445).
 * The lock only suppresses duplicate work. It is not what makes overlap safe:
 * the body above is (idempotent object delete + guarded row delete), so a lock
 * lost mid-sweep costs at most a redundant object delete.
 */
export function runAssetJanitorTick(
  db: PrismaClient = defaultDb,
): Promise<SweepLockResult<JanitorOutcome>> {
  return withSweepLock('asset-janitor', () => runAssetJanitor(db));
}

/**
 * Run the asset janitor on an interval for the server's lifetime.
 *
 * Until this existed the janitor had no scheduler at all — it was
 * reachable only by running the file by hand, so in practice every
 * soft-deleted asset's bytes stayed in the object store indefinitely
 * and the 24h recovery window never actually expired. Mirrors the
 * `startAnonymousMemoryCleanupLoop` shape.
 *
 * Default cadence is hourly, which is well under the 24h retention
 * window it enforces — the exact period only affects how promptly
 * bytes leave the bucket after their window closes.
 */
export function startAssetJanitorLoop(
  db?: PrismaClient,
  intervalMs = 60 * 60 * 1000,
  initialDelayMs = 5 * 60 * 1000,
): NodeJS.Timeout {
  const run = async () => {
    try {
      const result = await runAssetJanitorTick(db);
      if (!result.ran) return;
      const outcome = result.value;
      if (outcome.purged > 0 || outcome.errors > 0) {
        // eslint-disable-next-line no-console
        console.log(
          `[janitor:assets] purged ${outcome.purged}, errors ${outcome.errors}`,
        );
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[janitor:assets] sweep failed:', err);
    }
  };

  // Same timer shape as the anonymous-memory cleanup loop: the initial
  // timeout is returned so callers can cancel it; the interval that
  // replaces it lives for the server's lifetime by design.
  let timer: NodeJS.Timeout;
  const initial = setTimeout(() => {
    void run();
    timer = setInterval(() => void run(), intervalMs);
    void timer;
  }, initialDelayMs);
  return initial;
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
