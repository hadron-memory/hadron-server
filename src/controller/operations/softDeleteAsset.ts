/**
 * softDeleteAsset — set the asset's `deleted_at` column. The R2
 * object is retained for 24h (the retention window); the janitor
 * sweeps after.
 *
 * Spec: spec-kits/specs/004-asset-upload/contracts/controller-api.md
 *
 * Per FR-017/FR-022. Caller must be the uploader OR an org admin.
 */

import type { Asset, PrismaClient } from '../../generated/prisma/index.js';
import { logAssetEvent } from '../../lib/asset/audit.js';
import { AssetUploadError } from './beginAssetUpload.js';
import type { AssetCallerContext } from './beginAssetUpload.js';

export interface SoftDeleteAssetInput {
  assetId: string;
}

export type IsAdminFor = (
  db: PrismaClient,
  userId: string,
  organizationId: string,
) => Promise<boolean>;

export async function softDeleteAsset(
  db: PrismaClient,
  caller: AssetCallerContext,
  input: SoftDeleteAssetInput,
  isAdminFor: IsAdminFor,
): Promise<Asset> {
  const asset = await db.asset.findUnique({
    where: { id: input.assetId },
    include: {
      memory: { select: { organizationId: true } },
    },
  });
  if (!asset || asset.deletedAt) {
    throw new AssetUploadError('NOT_FOUND', 'asset not found');
  }
  // 006-asset-upload-redesign: Asset.memory is nullable to support
  // staging. softDelete only applies to attached assets — staged
  // assets are managed via the staging-TTL janitor sweep, not soft
  // delete. Reject explicitly to give a clear error.
  if (!asset.memory) {
    throw new AssetUploadError('INVALID_INPUT', 'cannot soft-delete a staged (unattached) asset');
  }
  if (!asset.memory.organizationId) {
    // isAdminFor is an org-admin check — not yet modeled for a user-owned memory.
    throw new AssetUploadError('NOT_FOUND', 'asset soft-delete is not supported for a user-owned memory yet');
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

  const updated = await db.asset.update({
    where: { id: asset.id },
    data: { deletedAt: new Date() },
  });

  logAssetEvent({
    operation: 'soft-deleted',
    assetId: asset.id,
    memoryId: asset.memoryId,
    userId: caller.userId,
    appId: caller.appId ?? null,
  });

  return updated;
}
