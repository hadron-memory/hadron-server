import { GraphQLError } from 'graphql';
import type { Memory, Prisma } from '../../../generated/prisma/index.js';
import { softDeleteMemoryAssets } from '../../../lib/asset/memoryDelete.js';
import { isInstallMemoryRow } from '../../../lib/auth/installMemory.js';
import { lockMemoryForChannelChange } from '../../../lib/channels.js';
import { assertNoMintedCorpusRemoval } from '../../../lib/mintedSpecPermanence.js';
import { lockInstallAuthorityFirst } from './installMemory.js';
import type { Context } from './resolvers.helpers.js';

/**
 * The transactional half of `deleteMemory`: everything it does once the caller has been judged outside the transaction. Shared by the
 * resolver and by the #5394 hand-run deletion script (`scripts/db/delete-no-app-chat-memories-5394.ts`), so the script deletes through
 * exactly the resolver's path and takes exactly what it takes, nothing more:
 *   - the memory row's `deleted_at` (a soft delete; a re-delete changes nothing, FR-014 idempotency);
 *   - the memory's live assets' `deleted_at`, at the same instant (#5124), so the asset janitor purges their bytes after its window.
 * It refuses, writing nothing, while the memory hosts a live Channel (`MEMORY_HOSTS_CHANNEL`, spec 049 §8.5) or holds a minted spec or a
 * question (`assertNoMintedCorpusRemoval`, #1468). Nodes, edges, chat roots and messages, subscriptions and member rows are not touched:
 * they stay behind the tombstoned memory, as for every deleteMemory.
 *
 * `authorize` re-judges the caller against the row read under its `FOR UPDATE` lock (a transfer may commit between the outer check and
 * this transaction). Lock order is unchanged from the resolver: install authority, the Channel lock, the memory row.
 *
 * Returns true when this call wrote the tombstone, false when the memory was already deleted.
 */
export async function deleteMemoryInTx(
  tx: Prisma.TransactionClient,
  ctx: Context,
  memoryId: string,
  authorize: (tx: Prisma.TransactionClient, current: Memory) => Promise<void>,
): Promise<boolean> {
  // #2044: an install memory's authority before the memory row lock below.
  await lockInstallAuthorityFirst(tx, ctx, memoryId);
  // Spec 049 §8.5: a memory hosting a live Channel is not deleted around
  // the Channel — delete the Channel through its own operation first.
  // Checked and tombstoned under the memory-level lock Channel creation
  // also takes (`lockMemoryForChannelChange`), so a Channel cannot land
  // between the check and the tombstone (Copilot on PR #1165, round 2).
  await lockMemoryForChannelChange(tx, memoryId);
  // A transfer can commit after the first authorization and before this
  // transaction starts. Lock and recheck the current owner before the
  // tombstone write; the pre-transfer caller must not delete the new
  // tenant's memory after waiting on the row.
  await tx.$queryRaw`SELECT id FROM memories WHERE id = ${memoryId} FOR UPDATE`;
  const current = await tx.memory.findUniqueOrThrow({ where: { id: memoryId } });
  await authorize(tx, current);
  if (current.class === 'system' && !isInstallMemoryRow(current)) {
    throw new Error('Cannot delete an agent system memory directly. Delete the owning agent instead.');
  }
  const hosted = await tx.channel.findFirst({
    where: { memoryId, deletedAt: null },
    select: { id: true, name: true, loc: true },
  });
  if (hosted) {
    throw new GraphQLError(
      `This memory hosts Channel "${hosted.name}" (${hosted.loc}); delete the Channel first (deleteChannel).`,
      { extensions: { code: 'MEMORY_HOSTS_CHANNEL', channelId: hosted.id } },
    );
  }
  // Spec 013 FR-014: idempotency. A re-delete on an already-soft-deleted
  // memory returns true without overwriting the original deletedAt. The
  // conditional updateMany closes the read-then-write race so deletedAt is
  // set once. Secrets are org/user-owned only (#696), so there are no
  // memory-scoped secrets to sweep here anymore.
  //
  // #1468 — deleting a mint-stamped corpus removes every spec in it.
  // FOR UPDATE, not the update's own NO KEY UPDATE (Codex on #1475):
  // it conflicts with the FK KEY SHARE every node insert or move-in
  // takes and with the FOR SHARE a write takes when it marks a spec
  // (lockMintedSpecUnmarks), so no spec can appear between the scan
  // below and the tombstone. The guard's FOR SHARE re-enters. A
  // re-delete removes nothing, so it stays idempotent and unguarded.
  const [row] = await tx.$queryRaw<Array<{ deleted_at: Date | null }>>`
    SELECT deleted_at FROM memories WHERE id = ${memoryId} FOR UPDATE`;
  if (row && row.deleted_at === null) {
    await assertNoMintedCorpusRemoval(tx, memoryId, 'delete the corpus', { includeTombstones: false });
  }
  const deletedAt = new Date();
  const { count } = await tx.memory.updateMany({
    where: { id: memoryId, deletedAt: null },
    data: { deletedAt },
  });
  // #5124: the memory's files go with it, at the same instant, so the janitor reclaims them. A re-delete touches nothing.
  if (count === 1) await softDeleteMemoryAssets(tx, memoryId, deletedAt);
  return count === 1;
}
