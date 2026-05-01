/**
 * restoreAsset — clear `deleted_at` for an asset that's still within
 * the 24h retention window. Returns ASSET_BYTES_GONE if the janitor
 * has already swept the R2 object (i.e. the object no longer exists),
 * even when the row is still within the soft-delete window.
 *
 * Spec: spec-kits/specs/004-asset-upload/contracts/controller-api.md
 *
 * Per FR-019. Caller must be the uploader OR an org admin.
 */

import type { Asset, PrismaClient } from '../../generated/prisma/index.js';
import { headObject } from '../../integrations/r2/client.js';
import { logAssetEvent } from '../../lib/asset/audit.js';
import { decryptStorageKey } from '../../lib/asset/encryption.js';
import { sessionKeyCache } from '../../lib/sessionKeyCache.js';
import {
  ASSET_RETENTION_WINDOW_MS,
  isWithinRetentionWindow,
} from '../../lib/asset/retention.js';
import { AssetUploadError } from './beginAssetUpload.js';
import type { AssetCallerContext } from './beginAssetUpload.js';
import type { IsAdminFor } from './softDeleteAsset.js';

export interface RestoreAssetInput {
  assetId: string;
}

export async function restoreAsset(
  db: PrismaClient,
  caller: AssetCallerContext,
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
    throw new AssetUploadError(
      'ASSET_BYTES_GONE',
      'R2 object has already been swept; cannot restore',
    );
  }

  const updated = await db.asset.update({
    where: { id: asset.id },
    data: { deletedAt: null },
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
