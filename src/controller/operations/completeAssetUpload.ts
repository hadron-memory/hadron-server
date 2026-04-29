/**
 * completeAssetUpload — verify the bytes landed in R2, persist the
 * Asset row (with `storage_key` encrypted in encrypted memories),
 * and return the new row.
 *
 * Spec: spec-kits/specs/004-asset-upload/contracts/controller-api.md
 *
 * Per FR-009: HeadObject's the uploaded key, verifies size + MIME
 * against the begin-upload promise, deletes the orphaned R2 object
 * on mismatch.
 *
 * Per FR-014: encrypts `storage_key` at rest for encrypted memories.
 */

import type { Asset, PrismaClient } from '../../generated/prisma/index.js';
import { consumeUpload } from '../../lib/asset/uploadRegistry.js';
import { logAssetEvent } from '../../lib/asset/audit.js';
import { encryptStorageKeyForMemory } from '../../lib/asset/encryption.js';
import { headObject, deleteObject } from '../../integrations/r2/client.js';
import { sessionKeyCache } from '../../lib/sessionKeyCache.js';
import { AssetUploadError } from './beginAssetUpload.js';
import type { AssetCallerContext } from './beginAssetUpload.js';

export interface CompleteAssetUploadInput {
  uploadId: string;
}

export async function completeAssetUpload(
  db: PrismaClient,
  caller: AssetCallerContext,
  input: CompleteAssetUploadInput,
): Promise<Asset> {
  const entry = consumeUpload(input.uploadId);
  if (!entry) {
    throw new AssetUploadError(
      'NOT_FOUND',
      'upload ticket expired or unknown',
    );
  }
  // The caller must be the same identity that requested the begin —
  // both userId and (when present) appId must match.
  if (entry.userId !== caller.userId) {
    throw new AssetUploadError(
      'PERMISSION_DENIED',
      'upload ticket does not belong to caller',
    );
  }
  const callerAppId = caller.appId ?? null;
  if (entry.appId !== callerAppId) {
    throw new AssetUploadError(
      'PERMISSION_DENIED',
      'upload ticket does not belong to caller app',
    );
  }

  // FR-009 — verify what landed against what was promised.
  const head = await headObject(entry.storageKey);
  if (!head.exists) {
    throw new AssetUploadError(
      'NOT_FOUND',
      'no object found at storage key — did the PUT succeed?',
    );
  }
  if (
    head.contentLength != null &&
    head.contentLength !== entry.expectedSizeBytes
  ) {
    await deleteObject(entry.storageKey).catch(() => {});
    throw new AssetUploadError(
      'INVALID_INPUT',
      `uploaded size ${head.contentLength} does not match ticket size ${entry.expectedSizeBytes}`,
    );
  }
  if (head.contentType && head.contentType !== entry.mimeType) {
    await deleteObject(entry.storageKey).catch(() => {});
    throw new AssetUploadError(
      'INVALID_INPUT',
      `uploaded mime "${head.contentType}" does not match ticket mime "${entry.mimeType}"`,
    );
  }

  // FR-014 — encrypt storage_key at rest for encrypted memories.
  const memory = await db.memory.findUniqueOrThrow({
    where: { id: entry.memoryId },
    select: { id: true, isEncrypted: true },
  });
  let storedStorageKey = entry.storageKey;
  if (memory.isEncrypted) {
    const key = sessionKeyCache.getByMemoryId(memory.id);
    if (!key) {
      // The PUT already succeeded; clean up the orphan and surface the
      // typed error matching the edge-conditions pattern.
      await deleteObject(entry.storageKey).catch(() => {});
      throw new AssetUploadError(
        'MEMORY_ENCRYPTED_NO_KEY',
        'encrypted memory has no active session key; cannot persist asset',
      );
    }
    storedStorageKey = encryptStorageKeyForMemory(
      entry.storageKey,
      memory,
      key,
    );
  }

  // In dev, allow tests to skip the scan loop end-to-end.
  const autoClean = process.env.HADRON_ASSET_SCAN_AUTO_CLEAN === 'true';

  const asset = await db.asset.create({
    data: {
      id: entry.assetId,
      memoryId: entry.memoryId,
      filename: entry.filename,
      mimeType: entry.mimeType,
      sizeBytes: entry.expectedSizeBytes,
      storageKey: storedStorageKey,
      scanStatus: autoClean ? 'CLEAN' : 'PENDING',
      description: entry.description,
      uploadedBy: entry.userId,
    },
  });

  logAssetEvent({
    operation: 'upload-completed',
    assetId: asset.id,
    agentId: entry.agentId,
    memoryId: entry.memoryId,
    userId: caller.userId,
    appId: callerAppId,
    bytes: entry.expectedSizeBytes,
  });

  return asset;
}
