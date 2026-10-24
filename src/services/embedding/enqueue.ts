import { embeddingEligibleSql } from './rawChat.js';
/**
 * 033-rag-vector-retrieval — write-path embedding enqueue + prompt-drain.
 *
 * Called from every node write surface (GraphQL upsertNode, MCP
 * hadron_create_node/hadron_update_node, importer, restoreNodeRevision). When the memory is
 * vector-indexed the writer has already stamped a durable obligation in its
 * transaction. After commit, a free dispatcher slot may use the writer's plaintext.
 * Saturation retains no plaintext job: ordinary work recovers via the sweep;
 * encrypted work awaits fresh authorized plaintext (R132).
 *
 * Never throws onto the caller's request path.
 */

import type { Prisma, PrismaClient } from '../../generated/prisma/index.js';
import { isEmbeddingConfigured } from '../../lib/embedding/index.js';
import { randomUUID } from 'node:crypto';
import { embeddingDispatcher, embedNode, EMBED_WAKE_SUBJECT, type EmbedPlaintext } from '../../jobs/embedNodes.js';
import { getBusClient } from '../../lib/bus/index.js';
import { SYSTEM_MEMORY_CLASS } from '../../lib/embedding/indexing.js';

/**
 * Fire-and-forget bus wake-up (spec 039). Never throws — a broker outage
 * must not break the write path; the durable marker + sweep remain the
 * recovery net. The idempotency key is intentionally UNIQUE per publish
 * (dedup only needs to guard broker-level republish retries, not distinct
 * enqueues of the same node).
 */
let publishing: Promise<void> | null = null;
let publishDirty = false;
let publishClosed = false;

/** One shared in-flight publish, no id/payload queue; Postgres owns every obligation. */
export function publishEmbedWake(_payload: { nodeId?: string }): Promise<void> {
  if (publishClosed) return Promise.resolve();
  if (publishing) { publishDirty = true; return publishing; }
  publishing = (async () => {
    try {
      const bus = await getBusClient();
      if (bus) await bus.publish(EMBED_WAKE_SUBJECT, {}, { idempotencyKey: randomUUID() });
    } catch (error) {
      console.error('[embed-enqueue] bus wake failed; durable sweep remains:', error);
    }
  })().finally(() => {
    publishing = null;
    if (publishDirty && !publishClosed) { publishDirty = false; void publishEmbedWake({}); }
  });
  return publishing;
}

/** Close synchronously, retain at most the already admitted publish, and wait boundedly. */
export async function stopEmbeddingPublisher(graceMs = 5_000): Promise<boolean> {
  publishClosed = true;
  publishDirty = false;
  if (!publishing) return true;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      publishing.then(() => true),
      new Promise<boolean>(resolve => { deadline = setTimeout(() => resolve(false), graceMs); }),
    ]);
  } finally { if (deadline) clearTimeout(deadline); }
}

export interface EnqueueArgs {
  nodeId: string;
  memoryId: string;
  /** Captured in the writer transaction. Never re-read a newer token for this plaintext. */
  workToken: string | null;
  /** Plaintext content/abstract from the write — used by the prompt-drain. */
  plaintext: EmbedPlaintext;
}

/** Bulk ordinary writers need one wake, not a list of plaintext jobs or per-row promises. */
export function wakeEmbeddingQueue(db: PrismaClient): void {
  void publishEmbedWake({});
  if (isEmbeddingConfigured()) embeddingDispatcher(db).nudge();
}

/** Invalidate an old embed on revival without queuing work for an unindexed memory. */
export function pendingAtForRevival(previous: Date | null, indexed: boolean): Date | null {
  // `indexed` is memoryIsVectorIndexed(memory): a system memory is always indexed (#2199).
  if (!indexed) return null;
  const now = Date.now();
  return new Date(now === previous?.getTime() ? now + 1 : now);
}

/**
 * Offer an already committed obligation to bounded local admission and coalesce
 * a recovery wake. This function performs no database or endpoint operations.
 */
export async function enqueueNodeEmbedding(
  db: PrismaClient,
  args: EnqueueArgs,
): Promise<void> {
  // The authoritative transaction already stamped the obligation. No per-node enqueue
  // SELECT/UPDATE/publish promises can fan out here, even under saturation.
  if (!args.workToken) return;
  // Another worker may have an endpoint even when this process does not.
  if (!isEmbeddingConfigured()) { void publishEmbedWake({}); return; }
  const dispatcher = embeddingDispatcher(db);
  const admitted = dispatcher.tryRun(args.nodeId, () => embedNode(db, args.nodeId, args.plaintext, undefined, { workToken: args.workToken! }));
  // An admitted prompt already owns this obligation. Its completion nudges recovery;
  // an immediate local nudge OR echoed bus wake would reserve the other free slot
  // against the next prompt.
  // Rejected work still asks the shared durable drain to recover ordinary overflow.
  if (!admitted) { dispatcher.nudge(); void publishEmbedWake({}); }
}

/**
 * Stamp `embeddingPendingAt` on every live node of a memory (backfill / re-index
 * on opt-in or config change — FR-004/FR-008). Returns the count stamped.
 */
export async function backfillMemoryEmbeddings(
  db: PrismaClient,
  memoryId: string,
): Promise<number> {
  const count = await db.$executeRaw`
    UPDATE nodes SET embedding_pending_at = CURRENT_TIMESTAMP AT TIME ZONE 'UTC',
      embedding_work_token = gen_random_uuid(), embedding_failed_at = NULL,
      embedding_error = CASE WHEN (SELECT is_encrypted FROM memories WHERE id = ${memoryId})
        THEN 'Embedding pending: fresh authorized plaintext is required.' ELSE NULL END,
      embedding_attempts = 0
    WHERE memory_id = ${memoryId} AND deleted_at IS NULL AND ${embeddingEligibleSql()}
      AND EXISTS (SELECT 1 FROM memories WHERE id = ${memoryId} AND (vector_index_enabled = true OR class = 'system') AND deleted_at IS NULL)
  `;
  // Drain ping (empty payload): the bus listener drains the whole queue now
  // instead of trickling it out at sweep pace — the big win for re-indexing
  // a large memory. Fire-and-forget; the sweep remains the fallback.
  void publishEmbedWake({});
  return count;
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
      (n.abstract IS NOT NULL AND n.abstract !~ ${BLANK_ABSTRACT_REGEX} AND ${embeddingEligibleSql('n')}
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
    stamped = await db.$executeRaw`
      UPDATE nodes AS n SET
        embedding_pending_at = CURRENT_TIMESTAMP AT TIME ZONE 'UTC',
        embedding_work_token = gen_random_uuid(), embedding_failed_at = NULL,
        embedding_error = CASE WHEN (SELECT is_encrypted FROM memories WHERE id = ${memoryId})
          THEN 'Embedding pending: fresh authorized plaintext is required.' ELSE NULL END,
        embedding_attempts = 0
      WHERE n.id = ANY(${eligibleIds}::text[]) AND n.memory_id = ${memoryId}
        AND n.deleted_at IS NULL AND ${embeddingEligibleSql('n')} AND n.embedding_pending_at IS NULL AND n.embedding_failed_at IS NULL
        AND EXISTS (SELECT 1 FROM memories m WHERE m.id = n.memory_id
          AND m.deleted_at IS NULL AND m.class = ${SYSTEM_MEMORY_CLASS}::"MemoryClass")
    `;
    // This helper may be inside the operator's transaction. Its caller wakes
    // only after commit; no pre-commit publish or independent drain escapes it.
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
  return db.$executeRaw`
    UPDATE nodes SET embedding_pending_at = CURRENT_TIMESTAMP AT TIME ZONE 'UTC',
      embedding_work_token = gen_random_uuid(), embedding_failed_at = NULL,
      embedding_error = CASE WHEN (SELECT is_encrypted FROM memories WHERE id = ${memoryId})
        THEN 'Embedding pending: fresh authorized plaintext is required.' ELSE NULL END,
      embedding_attempts = 0
    WHERE memory_id = ${memoryId} AND deleted_at IS NULL AND ${embeddingEligibleSql()} AND embedding_failed_at IS NOT NULL
      AND EXISTS (SELECT 1 FROM memories WHERE id = ${memoryId} AND (vector_index_enabled = true OR class = 'system') AND deleted_at IS NULL)
  `;
}
