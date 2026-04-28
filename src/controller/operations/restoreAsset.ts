// restoreAsset — clear data.deletedAt + data.purgeAt before the janitor
// purges. Admin-only. Returns null if the asset is already purged.
//
// Spec: hadron-portal/specs/001-asset-upload/research.md §R-013

import type { PrismaClient, Node } from '../../generated/prisma/index.js';
import {
  decryptNodeFields,
  encryptNodeFieldsWithKey,
  getMemoryEncryptionInfo,
} from '../../lib/nodeCrypto.js';
import { sessionKeyCache } from '../../lib/sessionKeyCache.js';
import { logAssetEvent } from '../../lib/asset/audit.js';
import { serializeJson, deserializeJson } from '../../integrations/db/provider.js';
import type { AppContext } from './beginAssetUpload.js';
import { AssetUploadError } from './beginAssetUpload.js';

export interface RestoreAssetInput {
  assetId: string;
}

export async function restoreAsset(
  db: PrismaClient,
  caller: AppContext,
  input: RestoreAssetInput,
  isAdminFor: (
    db: PrismaClient,
    userId: string,
    organizationId: string,
  ) => Promise<boolean>,
): Promise<Node | null> {
  const node = await db.node.findUnique({
    where: { id: input.assetId },
    select: {
      id: true,
      memoryId: true,
      nodeType: true,
      createdBy: true,
      data: true,
      deletedAt: true,
      memory: { select: { organizationId: true } },
    },
  });

  if (!node || node.nodeType !== 'asset' || node.deletedAt) return null;

  const isAdmin = await isAdminFor(db, caller.userId, node.memory.organizationId);
  if (!isAdmin) {
    throw new AssetUploadError('PERMISSION_DENIED', 'admin role required');
  }

  const memoryEnc = await getMemoryEncryptionInfo(db, node.memoryId);
  const decrypted = decryptNodeFields({ data: node.data }, memoryEnc);
  const data = parseObject(decrypted.data);
  if (!data) {
    throw new AssetUploadError('INVALID_INPUT', 'asset data unreadable');
  }
  if (!data.deletedAt) return null;

  delete data.deletedAt;
  delete data.purgeAt;

  const reEncrypted = memoryEnc.isEncrypted
    ? (() => {
        const key = sessionKeyCache.getByMemoryId(memoryEnc.id);
        if (!key) {
          throw new AssetUploadError(
            'PERMISSION_DENIED',
            'no active session key for this encrypted memory',
          );
        }
        return encryptNodeFieldsWithKey({ data }, key);
      })()
    : { data };

  const updated = await db.node.update({
    where: { id: node.id },
    data: { data: serializeJson(reEncrypted.data) as never },
  });

  logAssetEvent({
    operation: 'restored',
    assetId: node.id,
    memoryId: node.memoryId,
    userId: caller.userId,
    appId: caller.appId,
  });

  return updated;
}

function parseObject(raw: unknown): Record<string, unknown> | null {
  if (typeof raw === 'string') {
    try {
      return deserializeJson(raw) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
  if (raw && typeof raw === 'object') return { ...(raw as Record<string, unknown>) };
  return null;
}
