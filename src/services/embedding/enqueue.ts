/**
 * 033-rag-vector-retrieval — write-path embedding enqueue + prompt-drain.
 *
 * Called from every node write surface (GraphQL upsertNode, MCP
 * h-add-node/h-update-node, importer, restoreNodeVersion). When the memory is
 * vector-indexed it sets the durable `embeddingPendingAt` marker (the recovery
 * net) and, if an embedding endpoint is configured, fires a `setImmediate`
 * prompt-drain that embeds using the in-closure PLAINTEXT — so encrypted
 * memories embed correctly at write time without a session key (FR-027).
 *
 * Never throws onto the caller's request path.
 */

import type { PrismaClient } from '../../generated/prisma/index.js';
import { isEmbeddingConfigured } from '../../lib/embedding/index.js';
import { embedNode, type EmbedPlaintext } from '../../jobs/embedNodes.js';

export interface EnqueueArgs {
  nodeId: string;
  memoryId: string;
  /** Plaintext content/abstract from the write — used by the prompt-drain. */
  plaintext: EmbedPlaintext;
}

/**
 * Mark a node for (re-)embedding and kick off the prompt-drain. No-op for
 * memories that aren't vector-indexed (one cheap SELECT, then return).
 */
export async function enqueueNodeEmbedding(
  db: PrismaClient,
  args: EnqueueArgs,
): Promise<void> {
  try {
    const memory = await db.memory.findUnique({
      where: { id: args.memoryId },
      select: { vectorIndexEnabled: true },
    });
    if (!memory?.vectorIndexEnabled) return;

    // Durable marker (recovery net): fresh attempt resets failure state.
    await db.node.update({
      where: { id: args.nodeId },
      data: {
        embeddingPendingAt: new Date(),
        embeddingFailedAt: null,
        embeddingError: null,
        embeddingAttempts: 0,
      },
    });

    // Prompt-drain: embed now with in-closure plaintext, off the request path.
    // Only when an endpoint is configured — otherwise leave it for the sweep
    // (also endpoint-guarded) so we don't burn the attempts cap on a missing
    // endpoint.
    if (isEmbeddingConfigured()) {
      setImmediate(() => {
        embedNode(db, args.nodeId, args.plaintext).catch((err) => {
          console.error('[embed-enqueue] prompt-drain error:', err);
        });
      });
    }
  } catch (err) {
    // Enqueue failures must never break the write. The sweep will recover any
    // node whose marker was set; if even the marker write failed, a later edit
    // or a manual backfill re-stamps it.
    console.error('[embed-enqueue] error:', err);
  }
}

/**
 * Stamp `embeddingPendingAt` on every live node of a memory (backfill / re-index
 * on opt-in or config change — FR-004/FR-008). Returns the count stamped.
 */
export async function backfillMemoryEmbeddings(
  db: PrismaClient,
  memoryId: string,
): Promise<number> {
  const res = await db.node.updateMany({
    where: { memoryId, deletedAt: null },
    data: {
      embeddingPendingAt: new Date(),
      embeddingFailedAt: null,
      embeddingError: null,
      embeddingAttempts: 0,
    },
  });
  return res.count;
}
