import { embeddingEligibleSql, isRawChatNode } from './rawChat.js';
import { randomUUID } from 'node:crypto';
import type { Prisma } from '../../generated/prisma/index.js';
import { memoryIsVectorIndexed } from '../../lib/embedding/indexing.js';

/** internal#4/R132: diagnostic only; never includes content, key material or caller identity. */
export const FRESH_PLAINTEXT_REQUIRED = 'Embedding pending: fresh authorized plaintext is required.';

/** Existing move/batch transaction owns these rows; UUID is generated per row in SQL. */
export async function resetEmbeddingObligations(
  tx: Prisma.TransactionClient,
  ids: string[],
  indexed: boolean,
): Promise<void> {
  if (!ids.length) return;
  await tx.$executeRaw`
    UPDATE nodes SET
      embedding_pending_at = CASE WHEN ${indexed} AND ${embeddingEligibleSql()} THEN CURRENT_TIMESTAMP AT TIME ZONE 'UTC' ELSE NULL END,
      embedding_work_token = CASE WHEN ${indexed} AND ${embeddingEligibleSql()} THEN gen_random_uuid() ELSE NULL END,
      embedding_failed_at = NULL,
      embedding_error = CASE WHEN ${indexed} AND ${embeddingEligibleSql()}
        AND (SELECT is_encrypted FROM memories WHERE id = nodes.memory_id)
        THEN ${FRESH_PLAINTEXT_REQUIRED} ELSE NULL END,
      embedding_attempts = 0
    WHERE id = ANY(${ids}::text[])
  `;
}

/** Caller owns the writing transaction. No post-commit per-node DB fan-out is permitted. */
export async function stampEmbeddingObligation(
  tx: Prisma.TransactionClient,
  nodeId: string,
  memoryId: string,
): Promise<string | null> {
  const memory = await tx.memory.findUnique({
    where: { id: memoryId }, select: { class: true, vectorIndexEnabled: true, isEncrypted: true, deletedAt: true },
  });
  const node = await tx.node.findUnique({ where: { id: nodeId }, select: { nodeType: true, loc: true } });
  const token = node && !isRawChatNode(node) && memory && memoryIsVectorIndexed(memory) && !memory.deletedAt ? randomUUID() : null;
  const res = await tx.node.updateMany({
    where: { id: nodeId, memoryId, deletedAt: null },
    data: {
      embeddingPendingAt: token ? new Date() : null,
      embeddingWorkToken: token,
      embeddingFailedAt: null,
      embeddingError: token && memory?.isEncrypted ? FRESH_PLAINTEXT_REQUIRED : null,
      embeddingAttempts: 0,
    },
  });
  return res.count ? token : null;
}
