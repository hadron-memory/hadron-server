/**
 * Asset malware-scan orchestration (#896).
 *
 * One entry point, `scanAssetRow`, shared by the two scan paths:
 *   - inline: completeAssetUpload calls it right after the verified
 *     bytes are promoted and the PENDING row exists — while the
 *     PLAINTEXT storage key is still in hand, which is what makes
 *     encrypted-memory assets scannable at all (their storage_key
 *     column is encrypted under the memory session key afterwards);
 *   - sweep: scanPendingAssets retries rows the inline pass could not
 *     settle (tool down, engine error, server crash mid-upload).
 *
 * Transition rules (spec cor:dmo:060:10 — downloads only once the scan
 * is clean):
 *   clean       → scanStatus CLEAN; `scan-flipped` audit event.
 *   infected    → scanStatus BLOCKED + scanSignature; the OBJECT BYTES
 *                 are deleted (known malware never sits in the bucket)
 *                 while the ROW is kept as an audit tombstone
 *                 (Holger, 2026-08-08). If the delete itself fails,
 *                 `scanDueAt` stays set so the sweep RETRIES the purge.
 *   unavailable → row stays PENDING; `scanDueAt` pushed to the next
 *                 backoff slot for the sweep.
 *
 * Every transition is a GUARDED updateMany conditioned on the state it
 * consumes (PR-908 review, Copilot): overlapping workers — inline vs
 * sweep, or future multiple replicas — can race on the same row, and a
 * slow clean verdict must never revive a BLOCKED tombstone. Terminal
 * states are never overwritten; a lost claim re-reads and reports the
 * winner's verdict.
 *
 * The scan always runs against the PROMOTED key via a short-TTL
 * presigned GET. Never scan the staging key: the presigned PUT stays
 * valid for its whole TTL, so bytes at staging can be swapped after
 * any check that runs there (the PR #897 Codex P1 race). The promoted
 * key was never presigned for writing.
 */

import type { Asset, PrismaClient } from '../../generated/prisma/index.js';
import { deleteObject, mintGetUrl } from '../../integrations/r2/client.js';
import { scanUrl } from '../scanClient.js';
import { logAssetEvent } from './audit.js';

/** TTL of the presigned GET handed to the scan tool. Generous next to
 * the client's 60s round-trip timeout, and far under the 24h orphan
 * min-age, so a scan URL can never outlive interest in the object. */
export const SCAN_GET_TTL_SECONDS = 5 * 60;

/** First-retry backoff; doubles per attempt. */
export const SCAN_RETRY_BASE_MS = 5 * 60 * 1000;
/** Backoff ceiling — a long-stuck row is still retried every 6h. */
export const SCAN_RETRY_MAX_MS = 6 * 60 * 60 * 1000;
/** Retry cadence for a BLOCKED row whose object purge failed. */
export const PURGE_RETRY_MS = 30 * 60 * 1000;

/** Exponential backoff for attempt N (1-based): 5min → 6h cap. */
export function scanBackoffMs(attempts: number): number {
  return Math.min(SCAN_RETRY_BASE_MS * 2 ** Math.max(attempts - 1, 0), SCAN_RETRY_MAX_MS);
}

export type ScanRowResult = 'CLEAN' | 'BLOCKED' | 'PENDING';

/** Re-read the row after a lost claim and report the winner's state. */
async function settledStatus(db: PrismaClient, assetId: string): Promise<ScanRowResult> {
  const row = await db.asset.findUnique({
    where: { id: assetId },
    select: { scanStatus: true },
  });
  return (row?.scanStatus ?? 'PENDING') as ScanRowResult;
}

/**
 * Scan one PENDING asset row's bytes and apply the verdict. Returns the
 * resulting scanStatus. Never throws for operational failures — those
 * leave the row PENDING (attempt recorded, next retry stamped) for the
 * sweep.
 *
 * `plainStorageKey` MUST be the decrypted object key of the PROMOTED
 * object (callers on the encrypted path decrypt before calling).
 */
export async function scanAssetRow(
  db: PrismaClient,
  asset: Pick<Asset, 'id' | 'memoryId' | 'filename' | 'sizeBytes' | 'scanAttempts'>,
  plainStorageKey: string,
  context: {
    userId?: string | null;
    appId?: string | null;
    source: 'inline' | 'sweep';
  },
): Promise<ScanRowResult> {
  const now = new Date();
  const attempt = {
    scanAttempts: { increment: 1 },
    scannedAt: now,
  } as const;

  let outcome: Awaited<ReturnType<typeof scanUrl>>;
  try {
    const url = await mintGetUrl({
      key: plainStorageKey,
      ttlSeconds: SCAN_GET_TTL_SECONDS,
    });
    outcome = await scanUrl({
      url,
      sizeBytes: asset.sizeBytes,
      filename: asset.filename,
    });
  } catch (err) {
    // Presign failure (storage unconfigured mid-flight, etc.) — same
    // posture as an unreachable tool.
    outcome = {
      verdict: 'unavailable',
      reason: `could not presign scan URL: ${String(err)}`,
    };
  }

  if (outcome.verdict === 'clean') {
    const claimed = await db.asset.updateMany({
      where: { id: asset.id, scanStatus: 'PENDING' },
      data: { ...attempt, scanStatus: 'CLEAN', scanDueAt: null },
    });
    if (claimed.count === 0) return settledStatus(db, asset.id);
    logAssetEvent({
      operation: 'scan-flipped',
      assetId: asset.id,
      memoryId: asset.memoryId,
      userId: context.userId ?? null,
      appId: context.appId ?? null,
      scanStatusFrom: 'PENDING',
      scanStatusTo: 'CLEAN',
      reason: `scan ${context.source}`,
    });
    return 'CLEAN';
  }

  if (outcome.verdict === 'infected') {
    // Claim first (PENDING → BLOCKED gates every download path at
    // once), then purge. scanDueAt stays STAMPED until the purge is
    // confirmed — a failed delete must leave a retryable trail, not a
    // swallowed error (PR-908 review): the sweep retries the purge for
    // BLOCKED rows whose scanDueAt is set.
    const claimed = await db.asset.updateMany({
      where: { id: asset.id, scanStatus: 'PENDING' },
      data: {
        ...attempt,
        scanStatus: 'BLOCKED',
        scanSignature: outcome.signature,
        scanDueAt: now,
      },
    });
    if (claimed.count === 0) return settledStatus(db, asset.id);

    const purged = await purgeBlockedObject(db, asset.id, plainStorageKey);
    logAssetEvent({
      operation: 'scan-flipped',
      assetId: asset.id,
      memoryId: asset.memoryId,
      userId: context.userId ?? null,
      appId: context.appId ?? null,
      scanStatusFrom: 'PENDING',
      scanStatusTo: 'BLOCKED',
      reason: `scan ${context.source}: ${outcome.signature ?? 'unnamed signature'}`,
      ...(purged ? {} : { error: 'object purge failed; sweep will retry' }),
    });
    return 'BLOCKED';
  }

  // unavailable — bookkeeping only; stamp the next retry slot.
  const nextDue = new Date(now.getTime() + scanBackoffMs(asset.scanAttempts + 1));
  await db.asset.updateMany({
    where: { id: asset.id, scanStatus: 'PENDING' },
    data: { ...attempt, scanDueAt: nextDue },
  });
  logAssetEvent({
    operation: 'scan-flipped',
    assetId: asset.id,
    memoryId: asset.memoryId,
    scanStatusFrom: 'PENDING',
    scanStatusTo: 'PENDING',
    reason: `scan ${context.source} attempt ${asset.scanAttempts + 1} inconclusive`,
    error: outcome.reason,
  });
  return 'PENDING';
}

/**
 * Delete a BLOCKED row's object bytes and clear its due stamp on
 * success; on failure stamp the next purge retry. Returns whether the
 * bytes are confirmed gone. Shared by the infected transition above
 * and the sweep's purge-retry path.
 */
export async function purgeBlockedObject(
  db: PrismaClient,
  assetId: string,
  plainStorageKey: string,
): Promise<boolean> {
  try {
    await deleteObject(plainStorageKey);
  } catch {
    await db.asset.updateMany({
      where: { id: assetId, scanStatus: 'BLOCKED' },
      data: { scanDueAt: new Date(Date.now() + PURGE_RETRY_MS) },
    });
    return false;
  }
  await db.asset.updateMany({
    where: { id: assetId, scanStatus: 'BLOCKED' },
    data: { scanDueAt: null },
  });
  return true;
}
