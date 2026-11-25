/**
 * #5124 (follow-up (b) of #5017's re-gate; cor:dmo:060:13): a memory's files are soft-deleted with the memory, in the same transaction and
 * at the same instant, so the retention janitor reclaims their bytes and then their rows after the window, and the `assetBytes` count
 * (which excludes a file's own soft delete) drains on its own. Before this, deleting a memory touched no Asset row, so its bytes were
 * row-protected for ever and kept counting against the owner's cap.
 *
 * Call it AFTER the memory row's own lock and delete, so every memory-delete path takes memory then assets, the order the asset doors use.
 * Only live rows are touched: a file already soft-deleted keeps its own instant (its own window started earlier).
 */
import type { Prisma } from '../../generated/prisma/index.js';

export async function softDeleteMemoryAssets(tx: Prisma.TransactionClient, memoryId: string, at: Date): Promise<number> {
  const { count } = await tx.asset.updateMany({ where: { memoryId, deletedAt: null }, data: { deletedAt: at } });
  return count;
}
