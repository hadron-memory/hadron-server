// completeAssetUpload — verify the bytes landed in R2, persist the asset
// node with scanStatus="pending" (or "clean" if HADRON_ASSET_SCAN_AUTO_CLEAN
// is set in dev), and return the new node.
//
// Spec: hadron-portal/specs/001-asset-upload/contracts/graphql.md

import type { PrismaClient, Node } from '../../generated/prisma/index.js';
import { consumeUpload } from '../../lib/asset/uploadRegistry.js';
import { ensureAssetsParent } from '../../lib/asset/parent.js';
import { logAssetEvent } from '../../lib/asset/audit.js';
import { headObject, deleteObject } from '../../integrations/r2/client.js';
import {
  encryptNodeFields,
  getMemoryEncryptionInfo,
} from '../../lib/nodeCrypto.js';
import { serializeJson, serializeTags } from '../../integrations/db/provider.js';
import type { AppContext } from './beginAssetUpload.js';
import { AssetUploadError } from './beginAssetUpload.js';

export interface CompleteAssetUploadInput {
  uploadId: string;
}

export async function completeAssetUpload(
  db: PrismaClient,
  caller: AppContext,
  input: CompleteAssetUploadInput,
): Promise<Node> {
  const entry = consumeUpload(input.uploadId);
  if (!entry) {
    throw new AssetUploadError('NOT_FOUND', 'upload ticket expired or unknown');
  }
  if (entry.appId !== caller.appId || entry.userId !== caller.userId) {
    throw new AssetUploadError(
      'PERMISSION_DENIED',
      'upload ticket does not belong to caller',
    );
  }

  const head = await headObject(entry.storageKey);
  if (!head.exists) {
    throw new AssetUploadError(
      'NOT_FOUND',
      'no object found at storage key — did the PUT succeed?',
    );
  }
  if (head.contentLength != null && head.contentLength !== entry.expectedSizeBytes) {
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

  await ensureAssetsParent(db, entry.memoryId);

  const autoClean = process.env.HADRON_ASSET_SCAN_AUTO_CLEAN === 'true';
  const data = {
    filename: entry.filename,
    mimeType: entry.mimeType,
    sizeBytes: entry.expectedSizeBytes,
    storageKey: entry.storageKey,
    uploadedAt: new Date().toISOString(),
    uploadedBy: entry.userId,
    description: entry.description,
    scanStatus: autoClean ? ('clean' as const) : ('pending' as const),
    ...(autoClean ? { scanCheckedAt: new Date().toISOString() } : {}),
  };

  const memoryEncryption = await getMemoryEncryptionInfo(db, entry.memoryId);
  const encrypted = encryptNodeFields({ data }, memoryEncryption);

  const node = await db.node.create({
    data: {
      id: entry.assetId,
      memoryId: entry.memoryId,
      loc: `assets:${entry.assetId}`,
      name: entry.filename,
      nodeType: 'asset',
      description: entry.description,
      data: serializeJson(encrypted.data) as never,
      tags: serializeTags([]) as string[],
      createdBy: entry.userId,
    },
  });

  logAssetEvent({
    operation: 'upload-completed',
    assetId: entry.assetId,
    agentId: entry.agentId,
    memoryId: entry.memoryId,
    userId: entry.userId,
    appId: entry.appId,
    bytes: entry.expectedSizeBytes,
  });

  return node;
}

export { AssetUploadError };
