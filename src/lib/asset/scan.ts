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
 *                 (Holger, 2026-08-08). `scan-flipped` audit event.
 *   unavailable → row stays PENDING; attempt bookkeeping only. The
 *                 sweep retries with exponential backoff.
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

export type ScanRowResult = 'CLEAN' | 'BLOCKED' | 'PENDING';

/**
 * Scan one PENDING asset row's bytes and apply the verdict. Returns the
 * resulting scanStatus. Never throws for operational failures — those
 * leave the row PENDING (attempt recorded) for the sweep to retry.
 *
 * `plainStorageKey` MUST be the decrypted object key of the PROMOTED
 * object (callers on the encrypted path decrypt before calling).
 */
export async function scanAssetRow(
  db: PrismaClient,
  asset: Pick<
    Asset,
    'id' | 'memoryId' | 'filename' | 'sizeBytes' | 'scanAttempts'
  >,
  plainStorageKey: string,
  context: {
    userId?: string | null;
    appId?: string | null;
    source: 'inline' | 'sweep';
  },
): Promise<ScanRowResult> {
  const attempt = {
    scanAttempts: { increment: 1 },
    scannedAt: new Date(),
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
    await db.asset.update({
      where: { id: asset.id },
      data: { ...attempt, scanStatus: 'CLEAN' },
    });
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
    await db.asset.update({
      where: { id: asset.id },
      data: {
        ...attempt,
        scanStatus: 'BLOCKED',
        scanSignature: outcome.signature,
      },
    });
    // Known malware never sits in the bucket: delete the bytes now, keep
    // the BLOCKED row as the audit tombstone. Best-effort — if the store
    // is briefly unreachable the BLOCKED row already gates every
    // download path, and the object is unreferenced garbage the moment
    // the row says BLOCKED.
    let purgeError: string | undefined;
    await deleteObject(plainStorageKey).catch((e) => {
      purgeError = e instanceof Error ? e.message : String(e);
    });
    logAssetEvent({
      operation: 'scan-flipped',
      assetId: asset.id,
      memoryId: asset.memoryId,
      userId: context.userId ?? null,
      appId: context.appId ?? null,
      scanStatusFrom: 'PENDING',
      scanStatusTo: 'BLOCKED',
      reason: `scan ${context.source}: ${outcome.signature ?? 'unnamed signature'}`,
      ...(purgeError
        ? { error: `object purge failed (bytes remain, row gates): ${purgeError}` }
        : {}),
    });
    return 'BLOCKED';
  }

  // unavailable — bookkeeping only; the sweep's backoff reads these.
  await db.asset.update({ where: { id: asset.id }, data: attempt });
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
