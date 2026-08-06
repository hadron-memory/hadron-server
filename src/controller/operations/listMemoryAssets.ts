/**
 * listMemoryAssets — v2 memory-addressed asset listing per spec
 * 006-asset-upload-redesign.
 *
 * Returns assets attached to the specified memory. Authorization is
 * the MEMORY's read gate (canReadMemory) — an Asset is bound to a
 * Memory (cor:dmo:060:10), so whoever may read the memory may see the
 * files attached to it. `mine: true` narrows to the caller's own
 * uploads; it is a FILTER, not the gate.
 *
 * History: spec 004 additionally filtered `uploadedBy = caller`, which
 * made assets private to their uploader. That predated cross-user
 * visibility and had two costs — an org member could not see a file a
 * colleague attached to a shared memory, and a run-created asset
 * (uploadedBy NULL, hadron_store_file) was invisible to everyone. The
 * gate is now the memory's, matching every other memory-bound read.
 *
 * Replaces v1's listAgentAssets in the v2 surface.
 */

import type { Asset, PrismaClient } from '../../generated/prisma/index.js';
import { canReadMemory } from '../../mcp/access-control.js';
import { logAssetEvent } from '../../lib/asset/audit.js';
import { resolveMemoryRef } from '../../lib/entityRef/memoryRef.js';
import { AssetUploadError } from './beginAssetUpload.js';

const DEFAULT_COUNT = 20;
const MAX_COUNT = 100;

export interface ListMemoryAssetsInput {
  memoryId: string;
  mimeType?: string;
  skip?: number;
  count?: number;
  includeDeleted?: boolean;
  /**
   * Narrow to the caller's own uploads. A filter on top of the memory
   * read gate, never a substitute for it. Default false (every asset
   * in the memory).
   */
  mine?: boolean;
}

export interface ListMemoryAssetsCaller {
  userId: string;
  appId?: string;
  roles?: ('OWNER' | 'ADMIN' | 'CONTRIBUTOR' | 'READER')[];
  organizationId?: string;
}

export interface ListMemoryAssetsResult {
  assets: Asset[];
  total: number;
  hasMore: boolean;
}

export async function listMemoryAssets(
  db: PrismaClient,
  caller: ListMemoryAssetsCaller,
  input: ListMemoryAssetsInput,
): Promise<ListMemoryAssetsResult> {
  const skip = Math.max(0, input.skip ?? 0);
  const count = Math.min(MAX_COUNT, Math.max(1, input.count ?? DEFAULT_COUNT));

  // 007-entity-id-or-urn: input.memoryId may be a raw ID, a bare URN,
  // or a prefixed URN. Resolve to a definite ID first so all
  // subsequent checks operate on a consistent shape.
  let memoryId: string;
  try {
    ({ id: memoryId } = await resolveMemoryRef(db, input.memoryId));
  } catch {
    throw new AssetUploadError('NOT_FOUND', 'memory not found');
  }

  const readOk = await canReadMemory(
    db,
    {
      userId: caller.userId,
      appId: caller.appId,
      roles: caller.roles,
      organizationId: caller.organizationId,
    },
    memoryId,
  );
  if (!readOk) {
    throw new AssetUploadError(
      'PERMISSION_DENIED',
      'caller does not have read access to memory',
    );
  }

  const where = {
    memoryId: memoryId,
    ...(input.mine ? { uploadedBy: caller.userId } : {}),
    ...(input.includeDeleted ? {} : { deletedAt: null }),
    ...(input.mimeType ? { mimeType: input.mimeType } : {}),
  };

  const [total, assets] = await Promise.all([
    db.asset.count({ where }),
    db.asset.findMany({
      where,
      orderBy: { uploadedAt: 'desc' },
      skip,
      take: count,
    }),
  ]);

  logAssetEvent({
    operation: 'listed',
    agentId: null,
    memoryId: memoryId,
    userId: caller.userId,
    appId: caller.appId ?? null,
    count: assets.length,
  });

  return {
    assets,
    total,
    hasMore: skip + assets.length < total,
  };
}
