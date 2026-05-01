/**
 * Asset-upload gate helpers.
 *
 * v1 (spec 004): per-App gate via `App.agentTools` allowlist.
 * v2 (spec 006): per-Memory gate via `Memory.acceptsUploads` flag.
 *
 * Both helpers coexist during the v1 deprecation window. v1 paths
 * call `assertAssetToolEnabled`; v2 paths call
 * `assertMemoryAcceptsUploads`.
 */

import type { App, PrismaClient } from '../../generated/prisma/index.js';

// ─── v1: per-App gate ─────────────────────────────────────────────────

/** Canonical key for the asset-upload tool in `App.agentTools` (v1). */
export const ASSET_UPLOAD_TOOL_KEY = 'asset:upload';

export class ToolNotEnabledError extends Error {
  constructor(public toolKey: string) {
    super(`TOOL_NOT_ENABLED: ${toolKey}`);
    this.name = 'ToolNotEnabledError';
  }
}

/**
 * Returns true iff the App has the asset-upload tool enabled.
 * Pure check; no side-effects. v1 path.
 */
export function isAssetToolEnabled(app: Pick<App, 'agentTools'>): boolean {
  return app.agentTools.includes(ASSET_UPLOAD_TOOL_KEY);
}

/**
 * Throws ToolNotEnabledError if the App does not have the asset-upload
 * tool enabled. v1 path. Use only on v1 code paths during deprecation.
 */
export function assertAssetToolEnabled(
  app: Pick<App, 'agentTools'>,
): void {
  if (!isAssetToolEnabled(app)) {
    throw new ToolNotEnabledError(ASSET_UPLOAD_TOOL_KEY);
  }
}

// ─── v2: per-Memory gate ──────────────────────────────────────────────

export class MemoryNotAcceptingUploadsError extends Error {
  constructor(public memoryId: string) {
    super(`MEMORY_NOT_ACCEPTING_UPLOADS: ${memoryId}`);
    this.name = 'MemoryNotAcceptingUploadsError';
  }
}

export class MemoryNotFoundError extends Error {
  constructor(public memoryId: string) {
    super(`MEMORY_NOT_FOUND: ${memoryId}`);
    this.name = 'MemoryNotFoundError';
  }
}

/**
 * Throws if the memory does not exist or does not accept uploads.
 *
 * v2 path. Call as the storage-policy gate before any operation that
 * creates or moves an Asset row whose `memory_id` points at this
 * memory: `beginAssetUpload(memoryId)`, `attachAssetToMemory`,
 * `moveAssetToMemory`. Skip when the operation stages (memory_id will
 * be NULL) — the gate has nothing to enforce.
 *
 * Performs a single SELECT on the memories table; the caller is
 * expected to do its own access-control check (write access for the
 * caller user) separately. The two checks have different concerns:
 * acceptsUploads is a memory-level storage policy, write-access is a
 * caller-level authorization check.
 */
export async function assertMemoryAcceptsUploads(
  db: Pick<PrismaClient, 'memory'>,
  memoryId: string,
): Promise<void> {
  const memory = await db.memory.findUnique({
    where: { id: memoryId },
    select: { id: true, acceptsUploads: true, deletedAt: true },
  });
  if (!memory || memory.deletedAt) {
    throw new MemoryNotFoundError(memoryId);
  }
  if (!memory.acceptsUploads) {
    throw new MemoryNotAcceptingUploadsError(memoryId);
  }
}
