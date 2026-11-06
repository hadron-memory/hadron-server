/**
 * restoreAsset — clear `deleted_at` for an asset that's still within
 * the 24h retention window. Returns ASSET_BYTES_GONE if the janitor
 * has already swept the R2 object (i.e. the object no longer exists),
 * even when the row is still within the soft-delete window.
 *
 * Spec: spec-kits/specs/004-asset-upload/contracts/controller-api.md
 *
 * Per FR-019. Caller needs current Memory write access and must be the
 * uploader or an admin of the Memory's current organization.
 */

import type { Asset, PrismaClient } from '../../generated/prisma/index.js';
import { headObject } from '../../integrations/r2/client.js';
import { reportAssetBytesMissing } from '../../lib/asset/bytesMissingAlarm.js';
import { logAssetEvent } from '../../lib/asset/audit.js';
import { decryptStorageKey } from '../../lib/asset/encryption.js';
import { sessionKeyCache } from '../../lib/sessionKeyCache.js';
import {
  ASSET_RETENTION_WINDOW_MS,
  isWithinRetentionWindow,
} from '../../lib/asset/retention.js';
import { AssetUploadError } from './beginAssetUpload.js';
import type { AssetCallerContextV2 } from './beginAssetUpload.js';
import type { IsAdminFor } from './softDeleteAsset.js';
import { requireCurrentAssetMemoryWrite } from './assetMemoryWriteGate.js';

export interface RestoreAssetInput {
  assetId: string;
}

export async function restoreAsset(
  db: PrismaClient,
  caller: AssetCallerContextV2,
  input: RestoreAssetInput,
  isAdminFor: IsAdminFor,
): Promise<Asset> {
  const asset = await db.asset.findUnique({
    where: { id: input.assetId },
    include: {
      memory: { select: { id: true, isEncrypted: true, organizationId: true } },
    },
  });
  if (!asset) {
    throw new AssetUploadError('NOT_FOUND', 'asset not found');
  }
  // 006-asset-upload-redesign: Asset.memory is nullable to support
  // staging. Restore only applies to soft-deleted *attached* assets;
  // staged assets that were swept by the staging-TTL janitor cannot
  // be restored (their bytes are gone, same as ASSET_BYTES_GONE).
  if (!asset.memory) {
    throw new AssetUploadError('NOT_FOUND', 'asset has no memory to restore to');
  }
  if (!asset.memory.organizationId) {
    // isAdminFor is an org-admin check — not yet modeled for a user-owned memory.
    throw new AssetUploadError('NOT_FOUND', 'asset restore is not supported for a user-owned memory yet');
  }
  if (!asset.deletedAt) {
    throw new AssetUploadError('ASSET_NOT_DELETED', 'asset is not soft-deleted');
  }
  if (!isWithinRetentionWindow(asset.deletedAt)) {
    // Past the window — the janitor either has run or will imminently.
    // Either way, the row is no longer restorable from a user-facing
    // perspective.
    throw new AssetUploadError(
      'ASSET_BYTES_GONE',
      `retention window of ${ASSET_RETENTION_WINDOW_MS / 1000}s expired`,
    );
  }

  const isUploader = asset.uploadedBy === caller.userId;
  const isAdmin = isUploader
    ? false
    : await isAdminFor(db, caller.userId, asset.memory.organizationId);
  if (!isUploader && !isAdmin) {
    throw new AssetUploadError(
      'PERMISSION_DENIED',
      'caller is not the uploader or an org admin',
    );
  }

  // Refuse a former tenant before probing the R2 object. The final write
  // repeats this gate under its own lock because a transfer may follow HEAD.
  await db.$transaction((tx) => requireCurrentAssetMemoryWrite(tx, caller, asset.memoryId!));

  // Verify the R2 bytes are still there. If the janitor swept ahead of
  // schedule (or a race lost), we can't actually recover the asset; tell
  // the caller honestly.
  const sessionKey = asset.memory.isEncrypted
    ? sessionKeyCache.getByMemoryId(asset.memory.id)
    : null;
  let plainStorageKey: string;
  try {
    plainStorageKey = decryptStorageKey(asset.storageKey, sessionKey);
  } catch {
    throw new AssetUploadError(
      'MEMORY_ENCRYPTED_NO_KEY',
      'encrypted memory has no active session key',
    );
  }
  const head = await headObject(plainStorageKey);
  if (!head.exists) {
    // #1140: the row is INSIDE its retention window, so the bytes were meant to
    // be here. That is server-state inconsistency (unlike the expired branch
    // above, where gone is expected), so alarm where it is discovered.
    reportAssetBytesMissing({ assetId: asset.id, memoryId: asset.memory.id, source: 'restore' });
    throw new AssetUploadError(
      'ASSET_BYTES_GONE',
      'asset bytes are missing from storage although the row is within its retention window; cannot restore',
    );
  }

  const updated = await db.$transaction(async (tx) => {
    const memory = await requireCurrentAssetMemoryWrite(tx, caller, asset.memoryId!);
    if (!memory.organizationId) {
      throw new AssetUploadError('NOT_FOUND', 'asset restore is not supported for a user-owned memory yet');
    }
    const current = await tx.asset.findUnique({
      where: { id: asset.id }, select: { id: true, memoryId: true, deletedAt: true, uploadedBy: true },
    });
    if (!current || current.memoryId !== memory.id) {
      throw new AssetUploadError('NOT_FOUND', 'asset not found');
    }
    if (!current.deletedAt) {
      throw new AssetUploadError('ASSET_NOT_DELETED', 'asset is not soft-deleted');
    }
    if (!isWithinRetentionWindow(current.deletedAt)) {
      throw new AssetUploadError('ASSET_BYTES_GONE', `retention window of ${ASSET_RETENTION_WINDOW_MS / 1000}s expired`);
    }
    const isCurrentUploader = current.uploadedBy === caller.userId;
    const isCurrentAdmin = isCurrentUploader ? false : await isAdminFor(tx as PrismaClient, caller.userId, memory.organizationId);
    if (!isCurrentUploader && !isCurrentAdmin) {
      throw new AssetUploadError('PERMISSION_DENIED', 'caller is not the uploader or an org admin');
    }
    return tx.asset.update({
      where: { id: current.id }, data: { deletedAt: null },
    });
  });

  logAssetEvent({
    operation: 'restored',
    assetId: asset.id,
    memoryId: asset.memoryId,
    userId: caller.userId,
    appId: caller.appId ?? null,
  });

  return updated;
}
