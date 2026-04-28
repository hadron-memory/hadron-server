// mintAssetDownloadUrl — issue a short-TTL presigned GET URL for an asset.
// Gates on uploader scope (FR-014) and scanStatus="clean" (FR-013).
//
// Spec: hadron-portal/specs/001-asset-upload/contracts/graphql.md

import type { PrismaClient } from '../../generated/prisma/index.js';
import {
  decryptNodeFields,
  getMemoryEncryptionInfo,
} from '../../lib/nodeCrypto.js';
import { mintGetUrl } from '../../integrations/r2/client.js';
import { logAssetEvent } from '../../lib/asset/audit.js';
import { deserializeJson } from '../../integrations/db/provider.js';
import type { AppContext } from './beginAssetUpload.js';
import { AssetUploadError } from './beginAssetUpload.js';

const DEFAULT_TTL_SECONDS = 5 * 60;
const MAX_TTL_SECONDS = 5 * 60;

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

interface AssetData {
  filename: string;
  mimeType: string;
  sizeBytes: number;
  storageKey: string;
  scanStatus: string;
  deletedAt?: string;
}

export async function mintAssetDownloadUrl(
  db: PrismaClient,
  caller: AppContext,
  input: MintAssetDownloadUrlInput,
): Promise<MintAssetDownloadUrlResult> {
  const ttl = Math.min(
    MAX_TTL_SECONDS,
    Math.max(1, input.ttlSeconds ?? DEFAULT_TTL_SECONDS),
  );

  const node = await db.node.findUnique({
    where: { id: input.assetId },
    select: {
      id: true,
      memoryId: true,
      nodeType: true,
      createdBy: true,
      data: true,
      deletedAt: true,
    },
  });

  if (!node || node.nodeType !== 'asset' || node.deletedAt) {
    throw new AssetUploadError('NOT_FOUND', 'asset not found');
  }
  if (node.createdBy !== caller.userId) {
    throw new AssetUploadError(
      'PERMISSION_DENIED',
      'asset belongs to a different user',
    );
  }

  const memoryEnc = await getMemoryEncryptionInfo(db, node.memoryId);
  const decrypted = decryptNodeFields({ data: node.data }, memoryEnc);
  const data = parseAssetData(decrypted.data);
  if (!data) {
    throw new AssetUploadError('INVALID_INPUT', 'asset data unreadable');
  }
  if (data.deletedAt) {
    throw new AssetUploadError('NOT_FOUND', 'asset is soft-deleted');
  }
  if (data.scanStatus === 'pending') {
    throw new AssetUploadError(
      'SCAN_PENDING',
      'asset has not been scanned yet',
    );
  }
  if (data.scanStatus === 'blocked') {
    throw new AssetUploadError('SCAN_BLOCKED', 'asset blocked by scan');
  }

  const url = await mintGetUrl({
    key: data.storageKey,
    ttlSeconds: ttl,
    responseContentDisposition: `attachment; filename="${data.filename.replace(/"/g, '')}"`,
    responseContentType: data.mimeType,
  });

  const expiresAt = new Date(Date.now() + ttl * 1000);

  logAssetEvent({
    operation: 'download-url-issued',
    assetId: node.id,
    memoryId: node.memoryId,
    userId: caller.userId,
    appId: caller.appId,
    ttlSeconds: ttl,
  });

  return {
    url,
    expiresAt,
    filename: data.filename,
    mimeType: data.mimeType,
    sizeBytes: data.sizeBytes,
  };
}

function parseAssetData(raw: unknown): AssetData | null {
  let obj: Record<string, unknown> | null = null;
  if (typeof raw === 'string') {
    try {
      obj = deserializeJson(raw) as Record<string, unknown>;
    } catch {
      return null;
    }
  } else if (raw && typeof raw === 'object') {
    obj = raw as Record<string, unknown>;
  }
  if (!obj) return null;
  if (
    typeof obj.filename !== 'string' ||
    typeof obj.mimeType !== 'string' ||
    typeof obj.sizeBytes !== 'number' ||
    typeof obj.storageKey !== 'string' ||
    typeof obj.scanStatus !== 'string'
  ) {
    return null;
  }
  return obj as unknown as AssetData;
}
