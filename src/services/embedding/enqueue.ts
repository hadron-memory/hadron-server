/**
 * 033-rag-vector-retrieval — write-path embedding enqueue + prompt-drain.
 *
 * Called from every node write surface (GraphQL upsertNode, MCP
 * hadron_create_node/hadron_update_node, importer, restoreNodeVersion). When the memory is
 * vector-indexed it sets the durable `embeddingPendingAt` marker (the recovery
 * net) and, if an embedding endpoint is configured, fires a `setImmediate`
 * prompt-drain that embeds using the in-closure PLAINTEXT — so encrypted
 * memories embed correctly at write time without a session key (FR-027).
 *
 * Never throws onto the caller's request path.
 */

import type { PrismaClient } from '../../generated/prisma/index.js';
import { isEmbeddingConfigured } from '../../lib/embedding/index.js';
import { embedNode, EMBED_WAKE_SUBJECT, type EmbedPlaintext } from '../../jobs/embedNodes.js';
import { getBusClient } from '../../lib/bus/index.js';

/**
 * Fire-and-forget bus wake-up (spec 039). Never throws — a broker outage
 * must not break the write path; the durable marker + sweep remain the
 * recovery net. The idempotency key is intentionally UNIQUE per publish
 * (dedup only needs to guard broker-level republish retries, not distinct
 * enqueues of the same node).
 */
export async function publishEmbedWake(payload: { nodeId?: string }): Promise<void> {
  try {
    const bus = await getBusClient();
    if (!bus) return;
    await bus.publish(EMBED_WAKE_SUBJECT, payload, {
      idempotencyKey: `${payload.nodeId ?? 'drain'}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
    });
  } catch (err) {
    console.error('[embed-enqueue] bus publish error (sweep will recover):', err);
  }
}

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
    // updateMany (not update) so a node deleted between the write and this
    // async enqueue is a no-op, not a thrown "record not found".
    await db.node.updateMany({
      where: { id: args.nodeId },
      data: {
        embeddingPendingAt: new Date(),
        embeddingFailedAt: null,
        embeddingError: null,
        embeddingAttempts: 0,
      },
    });

    // No per-node bus wake here anymore (event pivot): the write paths emit
    // `evt.node.written.v1` and the embedding module subscribes — cross-
    // instance wakes ride the platform event, not a module-specific publish.
    // The drain ping below (backfill) keeps `embed.wake.v1`: that's a job
    // command, not a fact.

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
  // Drain ping (empty payload): the bus listener drains the whole queue now
  // instead of trickling it out at sweep pace — the big win for re-indexing
  // a large memory. Fire-and-forget; the sweep remains the fallback.
  void publishEmbedWake({});
  return res.count;
}
