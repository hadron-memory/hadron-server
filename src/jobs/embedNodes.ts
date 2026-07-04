/**
 * 033-rag-vector-retrieval — embedding worker (interim Postgres-backed queue).
 *
 * `embedNode` is the transport-agnostic unit of work (FR-010): given a node it
 * (re-)computes its vectors and clears/updates the durable markers. The
 * write-path prompt-drain calls it with in-closure plaintext; the periodic
 * sweep (`drainEmbeddingQueue` / `startEmbeddingWorkerLoop`) calls it off the
 * stored row for retries, restarts, and backfill.
 *
 * Mirrors the `cleanupAnonymousMemories` job shape.
 */

import type { PrismaClient } from '../generated/prisma/index.js';
import type { EmbeddingClient } from '../lib/embedding/index.js';
import { getEmbeddingClient, isEmbeddingConfigured } from '../lib/embedding/index.js';
import { isCiphertext } from '../lib/crypto.js';
import {
  upsertAbstractVector,
  upsertChunkVectors,
  deleteNodeVectors,
  deleteNodeChunkVectors,
} from '../services/embedding/vectors.js';
import { chunkNode } from '../lib/chunking.js';

export interface EmbedPlaintext {
  content?: string | null;
  abstract?: string | null;
}

export type EmbedOutcome =
  | 'embedded'
  | 'skipped' // index disabled / nothing to embed / node gone / superseded
  | 'failed-permanent'
  | 'failed-transient';

const DEFAULT_MAX_ATTEMPTS = 5;

/**
 * (Re-)embed one node. Idempotent. When `plaintext` is supplied (prompt-drain),
 * it is used as the source — works for encrypted memories too. When omitted
 * (sweep), the stored row is used; an encrypted-at-rest value (`enc:v1:` marker)
 * cannot be embedded and is a PERMANENT failure pending #206.
 */
export async function embedNode(
  db: PrismaClient,
  nodeId: string,
  plaintext?: EmbedPlaintext,
  client?: EmbeddingClient,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
): Promise<EmbedOutcome> {
  const node = await db.node.findUnique({
    where: { id: nodeId },
    select: {
      id: true,
      abstract: true,
      content: true,
      deletedAt: true,
      embeddingPendingAt: true,
      embeddingAttempts: true,
      memory: {
        select: {
          id: true,
          vectorIndexEnabled: true,
          embeddingSource: true,
          isEncrypted: true,
          // 033 US2 — chunk config dials.
          chunkTokens: true,
          chunkOverlap: true,
          forceFixedSize: true,
        },
      },
    },
  });
  if (!node || node.deletedAt) return 'skipped';
  const memory = node.memory;
  const capturedPendingAt = node.embeddingPendingAt;

  // Index disabled: drop any stale vectors and clear the marker.
  if (!memory.vectorIndexEnabled) {
    await deleteNodeVectors(db, nodeId);
    await clearMarkers(db, nodeId, capturedPendingAt);
    return 'skipped';
  }

  const wantAbstract =
    memory.embeddingSource === 'abstract' || memory.embeddingSource === 'both';
  // 033 US2 — content-chunks ships now (alongside `both`).
  const wantChunks =
    memory.embeddingSource === 'contentChunks' || memory.embeddingSource === 'both';

  try {
    if (wantAbstract) {
      const abstractText =
        plaintext?.abstract !== undefined ? plaintext.abstract : node.abstract;

      if (memory.isEncrypted && abstractText != null && isCiphertext(abstractText)) {
        // Sweep on a GraphQL-encrypted node: no plaintext, no session key (#206).
        await markPermanentFailure(db, nodeId, 'encrypted-no-plaintext (#206)');
        return 'failed-permanent';
      }

      if (abstractText == null || abstractText.trim() === '') {
        // Nothing to embed — ensure no stale abstract vector lingers.
        // Use deleteNodeVectors when ONLY abstract is wanted; otherwise
        // a targeted delete-abstract via the chunk-path's transactional
        // delete-then-insert would clobber the chunks. Since the chunk
        // path runs its own delete-and-insert for kind='chunk' below,
        // it's safe to just delete all-vectors here when wantAbstract
        // alone is true — but when wantChunks is also true, we need to
        // preserve chunks. Special-case both:
        if (!wantChunks) {
          await deleteNodeVectors(db, nodeId);
        } else {
          // Targeted: drop the abstract row only; chunks survive.
          await db.$executeRaw`DELETE FROM node_embeddings WHERE node_id = ${nodeId} AND kind = 'abstract'`;
        }
      } else {
        const c = client ?? getEmbeddingClient();
        const [vec] = await c.embed([abstractText], 'document');
        if (!vec) {
          throw new Error('Embedding client returned no vector.');
        }
        // Latest-wins guard on the UPSERT (not just the clear): re-check
        // `embeddingPendingAt` in the DB right before writing. PR-219
        // review (Gemini high) — without this, two concurrent
        // prompt-drains race to INSERT and the slower one's older vector
        // silently overwrites the newer one.
        const fresh = await db.node.findUnique({
          where: { id: nodeId },
          select: { embeddingPendingAt: true },
        });
        if (fresh?.embeddingPendingAt?.getTime() !== capturedPendingAt?.getTime()) {
          return 'skipped';
        }
        await upsertAbstractVector(db, {
          nodeId,
          memoryId: memory.id,
          provider: c.provider,
          model: c.model,
          dim: c.dim,
          embedding: vec,
        });
      }
    }

    if (wantChunks) {
      // Spec 033 US2 T040 — chunk path. Mirror the abstract-path checks:
      // encrypted-no-plaintext is a permanent failure; empty content
      // clears the chunk vectors; otherwise chunk, embed, upsert.
      const contentText =
        plaintext?.content !== undefined ? plaintext.content : node.content;

      if (memory.isEncrypted && contentText != null && isCiphertext(contentText)) {
        await markPermanentFailure(db, nodeId, 'encrypted-no-plaintext (#206)');
        return 'failed-permanent';
      }

      if (contentText == null || contentText.trim() === '') {
        await deleteNodeChunkVectors(db, nodeId);
      } else {
        const chunks = chunkNode(contentText, {
          chunkTokens: memory.chunkTokens ?? undefined,
          chunkOverlap: memory.chunkOverlap ?? undefined,
          forceFixedSize: memory.forceFixedSize,
        });
        if (chunks.length === 0) {
          await deleteNodeChunkVectors(db, nodeId);
        } else {
          const c = client ?? getEmbeddingClient();
          const vectors = await c.embed(
            chunks.map((ch) => ch.text),
            'document',
          );
          if (vectors.length !== chunks.length) {
            throw new Error(
              `Embedding client returned ${vectors.length} vectors for ${chunks.length} chunks.`,
            );
          }
          // Same latest-wins guard before the upsert.
          const fresh = await db.node.findUnique({
            where: { id: nodeId },
            select: { embeddingPendingAt: true },
          });
          if (fresh?.embeddingPendingAt?.getTime() !== capturedPendingAt?.getTime()) {
            return 'skipped';
          }
          await upsertChunkVectors(
            db,
            nodeId,
            chunks.map((ch, i) => ({
              nodeId,
              memoryId: memory.id,
              provider: c.provider,
              model: c.model,
              dim: c.dim,
              chunkIndex: ch.chunkIndex,
              charStart: ch.charStart,
              charEnd: ch.charEnd,
              chunkText: ch.text,
              embedding: vectors[i],
            })),
          );
        }
      }
    }

    // Latest-wins: only clear the marker if no newer write re-stamped it while
    // we were embedding (optimistic guard on the captured embeddingPendingAt).
    const cleared = await clearMarkers(db, nodeId, capturedPendingAt);
    return cleared ? 'embedded' : 'skipped';
  } catch (err) {
    // Same latest-wins guard on the failure path (PR-219 review, Gemini high):
    // if a newer write has re-stamped embeddingPendingAt, this failure record
    // would mask a fresh attempt that's already in flight or queued.
    await markTransientFailure(
      db,
      node.id,
      capturedPendingAt,
      node.embeddingAttempts,
      maxAttempts,
      String(err),
    );
    return 'failed-transient';
  }
}

/** Clear markers iff embeddingPendingAt is still the captured value (latest-wins). */
async function clearMarkers(
  db: PrismaClient,
  nodeId: string,
  capturedPendingAt: Date | null,
): Promise<boolean> {
  const res = await db.node.updateMany({
    where: { id: nodeId, embeddingPendingAt: capturedPendingAt },
    data: {
      embeddingPendingAt: null,
      embeddingFailedAt: null,
      embeddingError: null,
      embeddingAttempts: 0,
    },
  });
  return res.count > 0;
}

async function markPermanentFailure(
  db: PrismaClient,
  nodeId: string,
  error: string,
): Promise<void> {
  // Permanent: clear pending so the sweep never re-selects it; keep failedAt as a record.
  await db.node.update({
    where: { id: nodeId },
    data: { embeddingPendingAt: null, embeddingFailedAt: new Date(), embeddingError: error },
  });
}

async function markTransientFailure(
  db: PrismaClient,
  nodeId: string,
  capturedPendingAt: Date | null,
  priorAttempts: number,
  maxAttempts: number,
  error: string,
): Promise<void> {
  const attempts = priorAttempts + 1;
  const giveUp = attempts >= maxAttempts;
  // Optimistic guard: only stamp the failure if embeddingPendingAt is still
  // the value we captured at the start of this attempt. A newer write that
  // re-stamped it has either already retried successfully or has its own
  // attempt in flight; either way our stale failure shouldn't clobber it.
  // updateMany returns count=0 silently when the WHERE doesn't match.
  //
  // On giveUp we clear embeddingPendingAt but leave embeddingAttempts at
  // the cap value. A future operator-driven retry (manual SQL re-stamp,
  // not via enqueueNodeEmbedding which resets attempts to 0) would be
  // silently excluded by drainEmbeddingQueue's `attempts < maxAttempts`
  // filter. Manual interventions MUST reset attempts to 0 too — the
  // documented contract.
  await db.node.updateMany({
    where: { id: nodeId, embeddingPendingAt: capturedPendingAt },
    data: {
      embeddingFailedAt: new Date(),
      embeddingAttempts: attempts,
      embeddingError: error,
      // On give-up, clear pending so it's no longer retried (failedAt remains).
      ...(giveUp ? { embeddingPendingAt: null } : {}),
    },
  });
}

export interface DrainResult {
  embedded: number;
  failed: number;
  skipped: number;
}

/**
 * Drain a batch of marked nodes (the sweep). `embeddingPendingAt` is the work
 * signal; nodes that have exhausted the attempts cap are excluded.
 */
export async function drainEmbeddingQueue(
  db: PrismaClient,
  opts: { batchSize?: number; maxAttempts?: number; client?: EmbeddingClient } = {},
): Promise<DrainResult> {
  if (!isEmbeddingConfigured()) return { embedded: 0, failed: 0, skipped: 0 };
  const batchSize = opts.batchSize ?? 25;
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const client = opts.client ?? getEmbeddingClient();

  const pending = await db.node.findMany({
    where: { embeddingPendingAt: { not: null }, embeddingAttempts: { lt: maxAttempts } },
    orderBy: { embeddingPendingAt: 'asc' },
    take: batchSize,
    select: { id: true },
  });

  const result: DrainResult = { embedded: 0, failed: 0, skipped: 0 };
  for (const n of pending) {
    const outcome = await embedNode(db, n.id, undefined, client, maxAttempts);
    if (outcome === 'embedded') result.embedded += 1;
    else if (outcome === 'failed-permanent' || outcome === 'failed-transient') result.failed += 1;
    else result.skipped += 1;
  }
  return result;
}

/**
 * Start the periodic sweep loop (setTimeout initial delay → setInterval).
 * No-op-ish when no embedding endpoint is configured (drain returns early).
 * Returns the initial timer so callers can clearTimeout in tests/shutdown.
 */
export function startEmbeddingWorkerLoop(
  db: PrismaClient,
  opts: { intervalMs?: number; initialDelayMs?: number; batchSize?: number } = {},
): NodeJS.Timeout {
  const intervalMs = opts.intervalMs ?? 30_000;
  const initialDelayMs = opts.initialDelayMs ?? 5_000;
  const run = async () => {
    try {
      const r = await drainEmbeddingQueue(db, { batchSize: opts.batchSize });
      if (r.embedded || r.failed) {
        console.log(`[embed-worker] embedded=${r.embedded} failed=${r.failed} skipped=${r.skipped}`);
      }
    } catch (err) {
      console.error('[embed-worker] drain error:', err);
    }
  };
  return setTimeout(() => {
    void run();
    setInterval(() => void run(), intervalMs);
  }, initialDelayMs);
}

// ── Bus wake-up (spec 039 — first same-process job listener) ────────────────
//
// Subject `embed.wake.v1` on the platform bus. Payload { nodeId } wakes a
// check-and-embed for one node; an EMPTY payload is a drain ping (published
// after a backfill stamp) that drains the whole queue without waiting for
// sweep ticks. Everything is idempotent off the durable marker columns —
// duplicate deliveries and bus-vs-sweep races resolve to skips (the
// at-least-once contract in src/lib/bus/types.ts). With no broker configured
// the listener simply never starts and the sweep alone drains the queue
// (D-2026-06-17-004). The write-path prompt-drain is NOT replaced: it embeds
// encrypted memories from in-closure plaintext, which no bus message can
// carry.

import { getBusClient } from '../lib/bus/index.js';

export const EMBED_WAKE_SUBJECT = 'embed.wake.v1';
export const EMBED_QUEUE_GROUP = 'embed-worker';

export interface EmbedWakePayload {
  nodeId?: string;
}

// A drain ping processes at most this many batches before yielding back to
// the bus (re-published pings / the sweep pick up any remainder). Guards
// against a pathological queue where skipped rows retain their marker.
const MAX_DRAIN_BATCHES = 200;

/**
 * Handle one wake-up. Throws ONLY on a transient single-node failure so the
 * bus redelivers with its delay (faster + capped-by-max_deliver retry, vs
 * waiting out sweep ticks); everything else resolves (ack).
 */
export async function handleEmbedWake(
  db: PrismaClient,
  payload: unknown,
  client?: EmbeddingClient,
): Promise<void> {
  // Payload validation (PR-489 review): a malformed message (null, string,
  // array, non-string nodeId) must NOT be mistaken for a drain ping — that
  // would turn junk into an expensive full-queue drain. Log + ack; the
  // durable markers mean nothing is lost.
  if (payload == null || typeof payload !== 'object' || Array.isArray(payload)) {
    console.warn('[embed-worker] ignoring malformed embed.wake payload:', payload);
    return;
  }
  const { nodeId } = payload as EmbedWakePayload;
  if (nodeId !== undefined && typeof nodeId !== 'string') {
    console.warn('[embed-worker] ignoring embed.wake with non-string nodeId');
    return;
  }
  // No endpoint configured → nothing this process can do; ack and leave the
  // marker for the sweep once configuration arrives (same posture as drain).
  if (!isEmbeddingConfigured()) return;
  if (nodeId) {
    // Idempotency gate: embedNode itself embeds unconditionally (the sweep
    // pre-filters on the marker; the prompt-drain runs right after setting
    // it), so the wake-up checks the marker here — a node the prompt-drain
    // or sweep already drained resolves to one cheap SELECT, not a re-embed
    // (the at-least-once duplicate-delivery contract).
    const row = await db.node.findUnique({
      where: { id: nodeId },
      select: { embeddingPendingAt: true, memory: { select: { isEncrypted: true } } },
    });
    if (!row?.embeddingPendingAt) return;
    // Encrypted memory: PUNT (PR-489 review, Codex P2). The wake arrives
    // within milliseconds of the write — while the prompt-drain (which holds
    // the plaintext this bus message cannot carry) may still be in flight.
    // A plaintext-less embedNode here would record a PERMANENT
    // encrypted-no-plaintext failure (#206) and clear the marker, and the
    // prompt-drain's latest-wins guard would then skip its write — leaving
    // the node unembedded. The prompt-drain owns encrypted embeds; the sweep
    // keeps its documented #206 behavior for crash recovery.
    if (row.memory.isEncrypted) return;
    const outcome = await embedNode(db, nodeId, undefined, client);
    if (outcome === 'failed-transient') {
      throw new Error(`transient embed failure for node ${nodeId} — nak for redelivery`);
    }
    return;
  }
  // Drain ping: pull full batches until the queue comes up short.
  const batchSize = 25;
  for (let i = 0; i < MAX_DRAIN_BATCHES; i++) {
    const r = await drainEmbeddingQueue(db, { batchSize, ...(client ? { client } : {}) });
    const processed = r.embedded + r.failed + r.skipped;
    if (r.failed > 0) {
      // Failed rows RETAIN their marker with an old pendingAt, so the next
      // batch would re-select exactly them and burn the attempts cap within
      // milliseconds (PR-489 review, Gemini). Stop the tight loop instead:
      // on a full batch, THROW so the bus redelivers this ping after the
      // nak delay (spaced retries, max_deliver-capped); on a short batch
      // the queue is nearly done — return and let the sweep's cadence
      // handle the stragglers.
      if (processed === batchSize) {
        throw new Error('embed drain paused after failures — nak for spaced continuation');
      }
      return;
    }
    if (processed < batchSize) return;
  }
  console.warn('[embed-worker] drain ping hit the batch cap — remainder left to the sweep');
}

/**
 * Start the same-process bus listener. Resolves to the unsubscribe function,
 * or null when the bus is off (NATS_URL unset / broker unreachable) — the
 * sweep loop is the fallback either way.
 */
export async function startEmbeddingBusListener(
  db: PrismaClient,
): Promise<(() => Promise<void>) | null> {
  const bus = await getBusClient();
  if (!bus) return null;
  const unsubscribe = await bus.subscribeQueue(
    EMBED_WAKE_SUBJECT,
    EMBED_QUEUE_GROUP,
    async (msg) => {
      // Pass the payload through UNCOERCED — handleEmbedWake validates the
      // shape itself, so a JSON null can't masquerade as a drain ping
      // (PR-489 review).
      await handleEmbedWake(db, msg.payload);
    },
  );
  console.log(`[embed-worker] bus listener active on ${EMBED_WAKE_SUBJECT}`);
  return unsubscribe;
}
