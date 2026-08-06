/**
 * mintAssetDownloadUrl — issue a short-TTL presigned GET URL for an
 * asset. Gates on the holding memory's read access, scan_status =
 * CLEAN, and (for encrypted memories) availability of the session
 * decryption key.
 *
 * Spec: spec-kits/specs/004-asset-upload/contracts/controller-api.md
 *
 * Per FR-011 / FR-013 / FR-016. The decrypted `storage_key` lives only
 * on the request stack — never logged, never cached.
 */

import type { PrismaClient } from '../../generated/prisma/index.js';
import { mintGetUrl } from '../../integrations/r2/client.js';
import { canReadMemory } from '../../mcp/access-control.js';
import { logAssetEvent } from '../../lib/asset/audit.js';
import { decryptStorageKey } from '../../lib/asset/encryption.js';
import { sessionKeyCache } from '../../lib/sessionKeyCache.js';
import { AssetUploadError } from './beginAssetUpload.js';
import type { AssetCallerContextV2 } from './beginAssetUpload.js';

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
  caller: AssetCallerContextV2,
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

  // 006-asset-upload-redesign: Asset.memoryId is nullable for staged
  // assets. Mint-download-url is meaningful only for attached assets;
  // a staged asset has bytes but the encryption tier follows the
  // attached memory, so a staged asset's URL is not yet defined.
  // Checked BEFORE the read gate — the gate IS the memory's, so there
  // is nothing to authorize against until the asset has one.
  if (!asset.memoryId) {
    throw new AssetUploadError('NOT_FOUND', 'asset is staged (not attached to a memory)');
  }

  // Authorization is the MEMORY's read gate. An Asset is bound to a
  // Memory (cor:dmo:060:10), so whoever may read the memory may
  // download the files attached to it.
  //
  // This replaces spec 004's `asset.uploadedBy === caller.userId`
  // check, which was uploader-identity scoping from before cross-user
  // visibility existed. It denied an org member a colleague's file in
  // a memory they can read, and — because `uploadedBy` is NULL for
  // run-created assets (hadron_store_file) — `null !== userId` made
  // every server-authored asset permanently undownloadable by anyone.
  //
  // Unreadable reports NOT_FOUND, not PERMISSION_DENIED: a distinct
  // "exists but forbidden" answer is an existence oracle over asset
  // ids, and callers have no legitimate use for the distinction.
  const readOk = await canReadMemory(
    db,
    {
      userId: caller.userId,
      appId: caller.appId,
      roles: caller.roles,
      organizationId: caller.organizationId,
    },
    asset.memoryId,
  );
  if (!readOk) {
    throw new AssetUploadError('NOT_FOUND', 'asset not found');
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
    select: { id: true, isEncrypted: true, deletedAt: true },
  });
  // A soft-deleted memory is terminal (there is no restore mutation) and
  // its contents are gone from every normal read surface — so its assets
  // are not downloadable either. canReadMemory does not itself filter
  // deletedAt, so this has to be explicit. Same rule the public hotlink
  // route applies (PR #888 review, Codex P1).
  if (memory.deletedAt) {
    throw new AssetUploadError('NOT_FOUND', 'asset not found');
  }
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
