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
import { upsertAbstractVector, deleteNodeVectors } from '../services/embedding/vectors.js';

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
        select: { id: true, vectorIndexEnabled: true, embeddingSource: true, isEncrypted: true },
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
  // content-chunks is US2; US1 indexes abstracts only.

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
        await deleteNodeVectors(db, nodeId);
      } else {
        const c = client ?? getEmbeddingClient();
        const [vec] = await c.embed([abstractText], 'document');
        // Defensive: an empty/malformed embed response yields `undefined`,
        // which would TypeError in `toVectorLiteral`. Treat as a transient
        // failure so the sweep retries (PR-219 review).
        if (!vec) {
          throw new Error('Embedding client returned no vector.');
        }
        // Latest-wins guard on the UPSERT (not just the clear): re-check
        // `embeddingPendingAt` in the DB right before writing. If a newer
        // write has re-stamped it while we were embedding, our vector is
        // stale by definition — skip the write so the newer prompt-drain's
        // result wins (PR-219 review, Gemini high). Without this, two
        // concurrent prompt-drains race to INSERT and the slower one's
        // older vector silently overwrites the newer one.
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
  opts: { batchSize?: number; maxAttempts?: number } = {},
): Promise<DrainResult> {
  if (!isEmbeddingConfigured()) return { embedded: 0, failed: 0, skipped: 0 };
  const batchSize = opts.batchSize ?? 25;
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const client = getEmbeddingClient();

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
