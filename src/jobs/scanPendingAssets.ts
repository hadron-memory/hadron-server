/**
 * scanPendingAssets — retry sweep for asset scan work (#896).
 *
 * The primary scan is INLINE at completeAssetUpload; this sweep exists
 * so a scanner outage, engine error, or server crash mid-upload leaves
 * a retried row instead of a permanently-undownloadable asset (the
 * exact dead-end #896 was opened about, just narrower).
 *
 * Queueing follows the #882 embedding-queue pattern: `scanDueAt` is a
 * future-dated stamp that IS the queue. The sweep selects rows whose
 * stamp is due (SQL-level, oldest first) and EVERY touch pushes the
 * stamp forward — a scan attempt to its backoff slot, an
 * encrypted-no-session-key deferral to a short recheck slot — so no
 * class of row can monopolize a batch and starve the rest (PR-908
 * review, Codex P1). Two kinds of work share the queue:
 *
 *   PENDING rows → scan retry (exponential backoff 5min → 6h via
 *                  scanAttempts; retried indefinitely — PENDING is
 *                  fail-closed, giving up recreates the dead-end).
 *   BLOCKED rows → purge retry for object bytes that survived a failed
 *                  delete (scanDueAt is cleared only when the object
 *                  store confirms the delete).
 *
 * Encrypted memories: the row's storage_key is ciphertext under the
 * memory SESSION key, so the sweep can only reach those bytes while a
 * session key is cached (janitorAssets / purge.ts posture). Their
 * normal scan path is the inline one, which runs while the plaintext
 * key is still in hand; here they are deferred on a short recheck
 * cadence WITHOUT burning a scan attempt.
 *
 * Run via:
 *   tsx src/jobs/scanPendingAssets.ts
 */

import type { PrismaClient } from '../generated/prisma/index.js';
import { db as defaultDb } from '../integrations/db/client.js';
import { isScanConfigured } from '../lib/scanClient.js';
import { scanAssetRow, purgeBlockedObject } from '../lib/asset/scan.js';
import { decryptStorageKey } from '../lib/asset/encryption.js';
import { sessionKeyCache } from '../lib/sessionKeyCache.js';
import { logAssetEvent } from '../lib/asset/audit.js';

/** Recheck cadence for rows the sweep cannot decrypt (encrypted memory,
 * no cached session key). Short and constant: a session key can appear
 * at any moment, and the recheck costs one row update, not a tool call. */
export const ENCRYPTED_RECHECK_MS = 15 * 60 * 1000;

/** Per-sweep batch cap: bounds one sweep's tool load; the next sweep
 * continues where this one left off (oldest-due-first order, and every
 * touched row's stamp moves forward). */
const SWEEP_BATCH_SIZE = 100;

export interface ScanSweepOutcome {
  /** Tool not configured — nothing to do. */
  skipped: boolean;
  examined: number;
  cleaned: number;
  blocked: number;
  /** Attempted but inconclusive (tool unavailable) — still PENDING. */
  inconclusive: number;
  /** Encrypted with no cached session key — restamped for recheck. */
  deferred: number;
  /** BLOCKED purge retries that confirmed the bytes gone. */
  purged: number;
}

export async function runAssetScanSweep(
  db: PrismaClient = defaultDb,
  now: Date = new Date(),
): Promise<ScanSweepOutcome> {
  const outcome: ScanSweepOutcome = {
    skipped: false,
    examined: 0,
    cleaned: 0,
    blocked: 0,
    inconclusive: 0,
    deferred: 0,
    purged: 0,
  };
  if (!isScanConfigured()) {
    return { ...outcome, skipped: true };
  }

  // Due rows only, oldest due first. Staged assets (memoryId NULL) are
  // excluded — completion rejects them today (US4), so none can exist
  // with bytes worth scanning. Soft-deleted rows belong to the janitor.
  const candidates = await db.asset.findMany({
    where: {
      scanDueAt: { lte: now },
      scanStatus: { in: ['PENDING', 'BLOCKED'] },
      deletedAt: null,
      memoryId: { not: null },
    },
    orderBy: { scanDueAt: 'asc' },
    take: SWEEP_BATCH_SIZE,
    include: { memory: { select: { id: true, isEncrypted: true } } },
  });

  for (const asset of candidates) {
    outcome.examined += 1;

    // Janitor/purge posture: encrypted memory + no cached session key
    // ⇒ we cannot locate the bytes. Restamp to a short recheck slot —
    // WITHOUT burning a scan attempt — so the row rotates behind other
    // due work instead of re-heading the batch every run.
    const sessionKey = asset.memory?.isEncrypted
      ? sessionKeyCache.getByMemoryId(asset.memory.id)
      : null;
    let plainStorageKey: string;
    try {
      plainStorageKey = decryptStorageKey(asset.storageKey, sessionKey);
    } catch {
      outcome.deferred += 1;
      await db.asset.updateMany({
        where: { id: asset.id, scanStatus: asset.scanStatus },
        data: { scanDueAt: new Date(now.getTime() + ENCRYPTED_RECHECK_MS) },
      });
      logAssetEvent({
        operation: 'scan-flipped',
        assetId: asset.id,
        memoryId: asset.memoryId,
        scanStatusFrom: asset.scanStatus,
        scanStatusTo: asset.scanStatus,
        reason: 'sweep deferred: encrypted memory with no active session key',
      });
      continue;
    }

    if (asset.scanStatus === 'BLOCKED') {
      // Purge retry: the verdict is settled; only the bytes linger.
      if (await purgeBlockedObject(db, asset.id, plainStorageKey)) {
        outcome.purged += 1;
      }
      continue;
    }

    const result = await scanAssetRow(db, asset, plainStorageKey, {
      source: 'sweep',
    });
    if (result === 'CLEAN') outcome.cleaned += 1;
    else if (result === 'BLOCKED') outcome.blocked += 1;
    else outcome.inconclusive += 1;
  }

  return outcome;
}

/**
 * Run the scan sweep on an interval for the server's lifetime. Same
 * timer shape as startAssetJanitorLoop, plus an in-flight guard: a
 * degraded scanner can stretch one sweep past the interval (100 scans
 * × 60s timeout ≫ 10min), and overlapping runs would re-select the
 * same rows and multiply tool load exactly when it can least afford it
 * (PR-908 review). The 10-minute cadence bounds how long an
 * inline-scan outage delays a first retry; per-row `scanDueAt` stamps
 * bound tool load on long-stuck rows.
 */
export function startAssetScanSweepLoop(
  db?: PrismaClient,
  intervalMs = 10 * 60 * 1000,
  initialDelayMs = 2 * 60 * 1000,
): NodeJS.Timeout {
  let inFlight = false;
  const run = async () => {
    if (inFlight) return;
    inFlight = true;
    try {
      const o = await runAssetScanSweep(db);
      if (o.cleaned > 0 || o.blocked > 0 || o.inconclusive > 0 || o.purged > 0) {
        // eslint-disable-next-line no-console
        console.log(
          `[sweep:asset-scan] cleaned ${o.cleaned}, blocked ${o.blocked}, inconclusive ${o.inconclusive}, deferred ${o.deferred}, purged ${o.purged}`,
        );
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[sweep:asset-scan] sweep failed:', err);
    } finally {
      inFlight = false;
    }
  };

  let timer: NodeJS.Timeout;
  const initial = setTimeout(() => {
    void run();
    timer = setInterval(() => void run(), intervalMs);
    void timer;
  }, initialDelayMs);
  return initial;
}

// Allow `tsx src/jobs/scanPendingAssets.ts` to run one sweep directly.
if (import.meta.url === `file://${process.argv[1]}`) {
  runAssetScanSweep()
    .then((o) => {
      // eslint-disable-next-line no-console
      console.log(JSON.stringify({ ...o, ranAt: new Date().toISOString() }));
      process.exit(0);
    })
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error(err);
      process.exit(1);
    });
}
