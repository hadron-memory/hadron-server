/**
 * scanPendingAssets — retry sweep for assets stuck in scanStatus
 * PENDING (#896).
 *
 * The primary scan is INLINE at completeAssetUpload; this sweep exists
 * so a scanner outage, engine error, or server crash mid-upload leaves
 * a retried row instead of a permanently-undownloadable asset (the
 * exact dead-end #896 was opened about, just narrower).
 *
 * Per-row exponential backoff via (scanAttempts, scannedAt): a row is
 * due when `scannedAt + min(5min * 2^(attempts-1), 6h)` has passed
 * (never-attempted rows are due immediately). Rows are retried
 * indefinitely — a PENDING row is already fail-closed (no download
 * path serves it), so the only cost of retrying forever is one cheap
 * scan call per backoff period, and giving up would recreate the
 * dead-end.
 *
 * Encrypted memories: the row's storage_key is ciphertext under the
 * memory SESSION key, so the sweep can only reach those bytes while a
 * session key happens to be cached (same posture as janitorAssets /
 * purge.ts). Their normal scan path is the inline one, which runs
 * while the plaintext key is still in hand.
 *
 * Run via:
 *   tsx src/jobs/scanPendingAssets.ts
 */

import type { PrismaClient } from '../generated/prisma/index.js';
import { db as defaultDb } from '../integrations/db/client.js';
import { isScanConfigured } from '../lib/scanClient.js';
import { scanAssetRow } from '../lib/asset/scan.js';
import { decryptStorageKey } from '../lib/asset/encryption.js';
import { sessionKeyCache } from '../lib/sessionKeyCache.js';
import { logAssetEvent } from '../lib/asset/audit.js';

/** First-retry backoff; doubles per attempt. */
export const SCAN_RETRY_BASE_MS = 5 * 60 * 1000;
/** Backoff ceiling — a long-stuck row is still retried every 6h. */
export const SCAN_RETRY_MAX_MS = 6 * 60 * 60 * 1000;
/** Per-sweep batch cap: bounds one sweep's tool load; the next sweep
 * continues where this one left off (oldest-attempt-first order). */
const SWEEP_BATCH_SIZE = 100;

export interface ScanSweepOutcome {
  /** Tool not configured — nothing to do. */
  skipped: boolean;
  examined: number;
  cleaned: number;
  blocked: number;
  /** Attempted but inconclusive (tool unavailable) — still PENDING. */
  inconclusive: number;
  /** Not yet due, or encrypted with no cached session key. */
  deferred: number;
}

/** When a row with `attempts` prior attempts becomes due again. */
export function nextDueAt(scannedAt: Date, attempts: number): Date {
  const backoff = Math.min(
    SCAN_RETRY_BASE_MS * 2 ** Math.max(attempts - 1, 0),
    SCAN_RETRY_MAX_MS,
  );
  return new Date(scannedAt.getTime() + backoff);
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
  };
  if (!isScanConfigured()) {
    return { ...outcome, skipped: true };
  }

  // Oldest-attempt-first so a busy deployment drains fairly; staged
  // assets (memoryId NULL) are excluded — completion rejects them
  // today (US4), so none can exist with bytes worth scanning.
  const candidates = await db.asset.findMany({
    where: {
      scanStatus: 'PENDING',
      deletedAt: null,
      memoryId: { not: null },
    },
    orderBy: { scannedAt: { sort: 'asc', nulls: 'first' } },
    take: SWEEP_BATCH_SIZE,
    include: { memory: { select: { id: true, isEncrypted: true } } },
  });

  for (const asset of candidates) {
    outcome.examined += 1;

    if (asset.scannedAt && now < nextDueAt(asset.scannedAt, asset.scanAttempts)) {
      outcome.deferred += 1;
      continue;
    }

    // Janitor/purge posture: encrypted memory + no cached session key
    // ⇒ we cannot locate the bytes; defer without burning an attempt.
    const sessionKey = asset.memory?.isEncrypted
      ? sessionKeyCache.getByMemoryId(asset.memory.id)
      : null;
    let plainStorageKey: string;
    try {
      plainStorageKey = decryptStorageKey(asset.storageKey, sessionKey);
    } catch {
      outcome.deferred += 1;
      logAssetEvent({
        operation: 'scan-flipped',
        assetId: asset.id,
        memoryId: asset.memoryId,
        scanStatusFrom: 'PENDING',
        scanStatusTo: 'PENDING',
        reason: 'sweep deferred: encrypted memory with no active session key',
      });
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
 * timer shape as startAssetJanitorLoop. The 10-minute cadence bounds
 * how long an inline-scan outage delays a first retry; per-row backoff
 * bounds tool load on long-stuck rows.
 */
export function startAssetScanSweepLoop(
  db?: PrismaClient,
  intervalMs = 10 * 60 * 1000,
  initialDelayMs = 2 * 60 * 1000,
): NodeJS.Timeout {
  const run = async () => {
    try {
      const o = await runAssetScanSweep(db);
      if (o.cleaned > 0 || o.blocked > 0 || o.inconclusive > 0) {
        // eslint-disable-next-line no-console
        console.log(
          `[sweep:asset-scan] cleaned ${o.cleaned}, blocked ${o.blocked}, inconclusive ${o.inconclusive}, deferred ${o.deferred}`,
        );
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[sweep:asset-scan] sweep failed:', err);
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
