/**
 * mintAssetDownloadUrl — issue a short-TTL presigned GET URL for an
 * asset. Gates on uploader scope, scan_status = CLEAN, and (for
 * encrypted memories) availability of the session decryption key.
 *
 * Spec: spec-kits/specs/004-asset-upload/contracts/controller-api.md
 *
 * Per FR-011 / FR-013 / FR-016. The decrypted `storage_key` lives only
 * on the request stack — never logged, never cached.
 */

import type { PrismaClient } from '../../generated/prisma/index.js';
import { mintGetUrl } from '../../integrations/r2/client.js';
import { logAssetEvent } from '../../lib/asset/audit.js';
import { decryptStorageKey } from '../../lib/asset/encryption.js';
import { sessionKeyCache } from '../../lib/sessionKeyCache.js';
import { AssetUploadError } from './beginAssetUpload.js';
import type { AssetCallerContext } from './beginAssetUpload.js';

const DEFAULT_TTL_SECONDS = 5 * 60;
const MAX_TTL_SECONDS = 60 * 60; // 1 hour ceiling

export interface MintAssetDownloadUrlInput {
  assetId: string;
  ttlSeconds?: number;
}

export interface MintAssetDownloadUrlResult {
  url: string;
  expiresAt: Date;
  filename: string;
  mimeType: string;
  sizeBytes: number;
}

export async function mintAssetDownloadUrl(
  db: PrismaClient,
  caller: AssetCallerContext,
  input: MintAssetDownloadUrlInput,
): Promise<MintAssetDownloadUrlResult> {
  const ttl = Math.min(
    MAX_TTL_SECONDS,
    Math.max(1, input.ttlSeconds ?? DEFAULT_TTL_SECONDS),
  );

  const asset = await db.asset.findUnique({
    where: { id: input.assetId },
  });
  if (!asset || asset.deletedAt) {
    throw new AssetUploadError('NOT_FOUND', 'asset not found');
  }

  // Per-user scope: the asset's uploader is the only one who can
  // mint a download URL in v1 (sharing is out of scope per
  // 010-summary Decision E).
  if (asset.uploadedBy !== caller.userId) {
    throw new AssetUploadError(
      'PERMISSION_DENIED',
      'asset belongs to a different user',
    );
  }

  // FR-013 — gate on scan_status.
  if (asset.scanStatus === 'PENDING') {
    throw new AssetUploadError(
      'SCAN_PENDING',
      'asset has not been scanned yet',
    );
  }
  if (asset.scanStatus === 'BLOCKED') {
    throw new AssetUploadError('SCAN_BLOCKED', 'asset blocked by scan');
  }

  // FR-014 / FR-015 / FR-016 — decrypt storage_key on the request
  // stack for encrypted memories. Returns the typed error matching
  // spec 001's pattern when the session key is missing.
  const memory = await db.memory.findUniqueOrThrow({
    where: { id: asset.memoryId },
    select: { id: true, isEncrypted: true },
  });
  const sessionKey = memory.isEncrypted
    ? sessionKeyCache.getByMemoryId(memory.id)
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

  const url = await mintGetUrl({
    key: plainStorageKey,
    ttlSeconds: ttl,
    responseContentDisposition: `attachment; filename="${asset.filename.replace(/"/g, '')}"`,
    responseContentType: asset.mimeType,
  });
  const expiresAt = new Date(Date.now() + ttl * 1000);

  logAssetEvent({
    operation: 'download-url-issued',
    assetId: asset.id,
    memoryId: asset.memoryId,
    userId: caller.userId,
    appId: caller.appId ?? null,
    ttlSeconds: ttl,
  });

  return {
    url,
    expiresAt,
    filename: asset.filename,
    mimeType: asset.mimeType,
    sizeBytes: asset.sizeBytes,
  };
}
