/**
 * 033-rag-vector-retrieval — write-path embedding enqueue + prompt-drain.
 *
 * Called from every node write surface (GraphQL upsertNode, MCP
 * hadron_create_node/hadron_update_node, importer, restoreNodeRevision). When the memory is
 * vector-indexed it sets the durable `embeddingPendingAt` marker (the recovery
 * net) and, if an embedding endpoint is configured, fires a `setImmediate`
 * prompt-drain that embeds using the in-closure PLAINTEXT — so encrypted
 * memories embed correctly at write time without a session key (FR-027).
 *
 * Never throws onto the caller's request path.
 */

import type { Prisma, PrismaClient } from '../../generated/prisma/index.js';
import { isEmbeddingConfigured } from '../../lib/embedding/index.js';
import { embedNode, EMBED_WAKE_SUBJECT, type EmbedPlaintext } from '../../jobs/embedNodes.js';
import { getBusClient } from '../../lib/bus/index.js';
import { memoryIsVectorIndexed, SYSTEM_MEMORY_CLASS } from '../../lib/embedding/indexing.js';

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

/** Invalidate an old embed on revival without queuing work for an unindexed memory. */
export function pendingAtForRevival(previous: Date | null, indexed: boolean): Date | null {
  // `indexed` is memoryIsVectorIndexed(memory): a system memory is always indexed (#2199).
  if (!indexed) return null;
  const now = Date.now();
  return new Date(now === previous?.getTime() ? now + 1 : now);
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
      select: { vectorIndexEnabled: true, class: true },
    });
    if (!memory || !memoryIsVectorIndexed(memory)) return;

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

    // Bus wake-up (spec 039): covers what the prompt-drain can't — a crash
    // between marker and drain, transient prompt-drain failures (bus
    // redelivery beats sweep ticks), and work distribution once multiple
    // instances share the queue group. The listener is idempotent (a marker
    // the prompt-drain already cleared resolves to a cheap skip).
    //
    // This deliberately does NOT ride evt.node.written.v1 (PR-507 review):
    // the wake is only reliable when published AFTER the durable marker
    // stamp above, and that ordering exists solely inside this function —
    // the write paths fire the fact event concurrently with this enqueue,
    // so an event-borne wake can race the stamp, ack on "no marker", and
    // leave the node to the slow sweep. Module-internal job, by design.
    void publishEmbedWake({ nodeId: args.nodeId });

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

/**
 * An abstract with nothing to embed, as the drain judges it (`abstractText.trim() === ''`): empty or only JavaScript
 * whitespace — tab, newline and the other line terminators, NBSP, the Unicode space separators, the BOM. Postgres
 * `btrim` strips spaces only, so the SQL side spells the class out; a divergence would re-stamp a node forever.
 */
export const BLANK_ABSTRACT_REGEX = '^[\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff]*$';

/**
 * #2199 — one BOUNDED, resumable step of the system-memory summary backfill. Inspects at most `limit` live nodes of
 * `memoryId` after `afterNodeId` (node id order) and stamps the ones that need a summary vector: an abstract that is not
 * blank, no abstract vector yet, not already queued, not failed (a failed embed is re-driven by `retryFailedEmbeddings`,
 * and a node with no abstract is never requeued just because it has no vector). The cursor is the last INSPECTED id,
 * so it advances over rows that were skipped too: a window of nothing-to-do rows still makes progress, and no eligible
 * row is passed over. Idempotent: the stamp re-checks eligibility in the write, so a node queued, edited or deleted
 * since the read is left alone, and a re-run stamps only what is still missing.
 */
export async function stampMemoryEmbeddingsBatch(
  db: PrismaClient,
  memoryId: string,
  opts: { limit: number; afterNodeId?: string | null; dryRun?: boolean },
): Promise<{ inspected: number; eligible: number; stamped: number; nextAfterNodeId: string | null; done: boolean }> {
  const limit = Math.max(1, Math.floor(opts.limit));
  const after = opts.afterNodeId ?? '';
  const rows = await db.$queryRaw<{ id: string; eligible: boolean }[]>`
    SELECT n.id,
      (n.abstract IS NOT NULL AND n.abstract !~ ${BLANK_ABSTRACT_REGEX}
        AND n.embedding_pending_at IS NULL AND n.embedding_failed_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM node_embeddings e WHERE e.node_id = n.id AND e.kind = 'abstract')) AS eligible
    FROM nodes n
    JOIN memories m ON m.id = n.memory_id
    WHERE n.memory_id = ${memoryId} AND n.deleted_at IS NULL AND n.id > ${after}
      AND m.deleted_at IS NULL AND m.class = ${SYSTEM_MEMORY_CLASS}::"MemoryClass"
    ORDER BY n.id
    LIMIT ${limit}`;
  const eligibleIds = rows.filter((r) => r.eligible).map((r) => r.id);
  let stamped = 0;
  if (!opts.dryRun && eligibleIds.length > 0) {
    const res = await db.node.updateMany({
      // Re-asserted in the write: a node queued, failed or deleted since the read is not touched.
      // ...and the PARENT is re-asserted too: a memory soft-deleted (deleteAgent) or no longer system since the read
      // keeps live node rows, and those must not be queued.
      where: {
        id: { in: eligibleIds }, memoryId, deletedAt: null, embeddingPendingAt: null, embeddingFailedAt: null,
        memory: { deletedAt: null, class: SYSTEM_MEMORY_CLASS },
      },
      data: { embeddingPendingAt: new Date(), embeddingFailedAt: null, embeddingError: null, embeddingAttempts: 0 },
    });
    stamped = res.count;
    if (stamped > 0) void publishEmbedWake({});
  }
  return {
    inspected: rows.length,
    eligible: eligibleIds.length,
    stamped,
    nextAfterNodeId: rows.length > 0 ? rows[rows.length - 1]!.id : opts.afterNodeId ?? null,
    done: rows.length < limit,
  };
}

/**
 * Re-drive every FAILED embed in a memory (#882 — the operator recovery
 * surface behind the retryFailedEmbeddings mutation). Targets nodes with
 * `embeddingFailedAt` set, which covers both shapes: permanent-class
 * failures whose pending marker was cleared (previously recoverable only by
 * hand-written SQL) and retryable-class failures sitting out a backoff
 * (made immediately eligible). Resets the failure state exactly like a
 * fresh write would. The caller pings the bus after its transaction commits,
 * so the prompt drain can see the durable marker. Returns the count re-stamped.
 */
export async function restampFailedEmbeddings(
  db: PrismaClient | Prisma.TransactionClient,
  memoryId: string,
): Promise<number> {
  const res = await db.node.updateMany({
    where: { memoryId, deletedAt: null, embeddingFailedAt: { not: null } },
    data: {
      embeddingPendingAt: new Date(),
      embeddingFailedAt: null,
      embeddingError: null,
      embeddingAttempts: 0,
    },
  });
  return res.count;
}
