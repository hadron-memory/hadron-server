import { isRawChatNode } from '../services/embedding/rawChat.js';
import { randomUUID } from 'node:crypto';
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

import { FRESH_PLAINTEXT_REQUIRED } from '../services/embedding/obligation.js';
import { EmbeddingDispatcher } from '../services/embedding/dispatcher.js';
import { COMMENT_NODE_TYPE } from '../lib/comments/index.js';
import { embeddingKindsWanted, memoryIsVectorIndexed, INDEXED_MEMORY_WHERE } from '../lib/embedding/indexing.js';
import { Prisma } from '../generated/prisma/index.js';
import type { PrismaClient } from '../generated/prisma/index.js';
import type { EmbeddingClient } from '../lib/embedding/index.js';
import {
  classifyEmbedError,
  getEmbeddingClient,
  isEmbeddingConfigured,
} from '../lib/embedding/index.js';
import { isCiphertext } from '../lib/crypto.js';
import {
  upsertAbstractVector,
  upsertChunkVectors,
  deleteNodeVectors,
  deleteNodeChunkVectors,
  deleteNodeAbstractVector,
} from '../services/embedding/vectors.js';
import { chunkNode } from '../lib/chunking.js';
import { recordLlmUsage } from '../lib/metering/index.js';

export interface EmbedPlaintext {
  content?: string | null;
  abstract?: string | null;
}

export type EmbedOutcome =
  | 'embedded'
  | 'skipped' // index disabled / nothing to embed / node gone / superseded
  | 'failed-permanent'
  | 'failed-transient';

/**
 * Retry-backoff dials for retryable failures (#882). A failed attempt
 * reschedules the node by future-dating `embeddingPendingAt` (the drain only
 * selects rows whose stamp is due): delay = base * 2^(attempts-1), capped at
 * `retryMaxMs`. There is NO terminal give-up for the retryable class — a
 * transient infrastructure blip must never permanently remove a node from
 * the vector index. The pre-#882 design capped attempts at 5 (all ~2.5
 * minutes apart), which is exactly how 65 nodes of the specs corpus fell
 * out of the index for good.
 */
export interface EmbedRetryOpts {
  /** internal#4: a prompt must carry its writer-captured obligation, never adopt a newer row token. */
  workToken?: string;
  /** First-retry delay in ms (default 60s). Tests pass 0 for immediacy. */
  retryBaseMs?: number;
  /** Backoff ceiling in ms (default 6h). */
  retryMaxMs?: number;
}

// cor:rag:010:01 — tunable passage count, independent of per-memory chunk size.
export const MAX_NODE_PASSAGE_CHUNKS = 256;

const DEFAULT_RETRY_BASE_MS = 60_000;
const DEFAULT_RETRY_MAX_MS = 6 * 60 * 60 * 1000;

/**
 * (Re-)embed one node. Idempotent. When `plaintext` is supplied (prompt-drain),
 * it is used as the source — works for encrypted memories too. When omitted
 * (sweep), the stored row is used; an encrypted-at-rest value (`enc:v1:` marker)
 * cannot be embedded and is a PERMANENT failure pending #206.
 *
 * Failure handling (#882): errors are classified via `classifyEmbedError`.
 * Permanent-class errors (deterministic 4xx, dimension mismatch, encrypted-
 * no-plaintext) clear the pending marker immediately — retrying cannot help;
 * recovery is an operator fix + `retryFailedEmbeddings`. Retryable-class
 * errors reschedule with exponential backoff and never give up.
 */
export async function embedNode(
  db: PrismaClient,
  nodeId: string,
  plaintext?: EmbedPlaintext,
  client?: EmbeddingClient,
  retryOpts: EmbedRetryOpts = {},
): Promise<EmbedOutcome> {
  const node = await db.node.findUnique({
    where: { id: nodeId },
    select: {
      id: true,
      loc: true,
      abstract: true,
      content: true,
      nodeType: true,
      deletedAt: true,
      embeddingPendingAt: true,
      embeddingWorkToken: true,
      // #1608 — a comment's stub state (a deleted-with-replies stub is never indexed).
      commentMeta: { select: { retractedAt: true } },
      embeddingAttempts: true,
      memory: {
        select: {
          id: true,
          // 046-usage-metering: billable org for the embedding usage event.
          organizationId: true,
          class: true,
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
  const capturedWorkToken = node.embeddingWorkToken;
  if (!capturedWorkToken || !capturedPendingAt
    || (retryOpts.workToken !== undefined && retryOpts.workToken !== capturedWorkToken)) return 'skipped';
  // Excluded turns never reach plaintext selection or an embedding provider.
  // Clear only this obligation; existing vectors require the separately reviewed
  // purge plan and are deliberately left untouched by this build (#1282).
  if (isRawChatNode(node)) {
    await clearMarkers(db, nodeId, capturedWorkToken);
    return 'skipped';
  }
  if (capturedPendingAt.getTime() > Date.now()) return 'skipped';
  // R132: a keyless worker cannot recover this plaintext. Preserve the explicit pending
  // diagnostic and obligation; only a fresh authorized plaintext prompt can serve it.
  if (memory.isEncrypted && plaintext === undefined) return 'skipped';

  // #1608 (cor:dmo:110:08) — a comment's searchable text is its BODY, whatever
  // the memory's embeddingSource: a comment has no abstract, so the default
  // abstract-only index would otherwise never hold it (#1674 review, Jane
  // P2-1). A stub (#1721: deleted, kept for its replies) is never indexed; its vectors go.
  const isComment = node.nodeType === COMMENT_NODE_TYPE;
  if (isComment && node.commentMeta?.retractedAt) {
    await deleteNodeVectors(db, nodeId, capturedWorkToken);
    await clearMarkers(db, nodeId, capturedWorkToken);
    return 'skipped';
  }

  // Not indexed: retain #2199 system-summary semantics under the captured UUID.
  if (!memoryIsVectorIndexed(memory)) {
    await deleteNodeVectors(db, nodeId, capturedWorkToken);
    await clearMarkers(db, nodeId, capturedWorkToken);
    return 'skipped';
  }

  // #2199: the one definition of what this memory is embedded for (a system memory: summary always, passages by setting).
  const { abstract: wantAbstract, chunks: wantChunks } = embeddingKindsWanted(memory);

  // 046-usage-metering (FR-007): what this call actually sent to the
  // embedding endpoint, for the usage event written on success.
  let embeddedChars = 0;
  let usedClient: EmbeddingClient | null = null;

  try {
    if (!wantChunks && !(await deleteNodeChunkVectors(db, nodeId, capturedWorkToken))) return 'skipped';
    if (wantAbstract) {
      const abstractText = isComment
        ? (plaintext?.content !== undefined ? plaintext.content : node.content)
        : plaintext?.abstract !== undefined ? plaintext.abstract : node.abstract;

      if (memory.isEncrypted && abstractText != null && isCiphertext(abstractText)) {
        // Sweep on a GraphQL-encrypted node: no plaintext, no session key (#206).
        return 'skipped'; // R132: explicit pending requires fresh authorized plaintext.
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
          await deleteNodeVectors(db, nodeId, capturedWorkToken);
        } else {
          // Targeted: drop the abstract row only; chunks survive.
          if (!(await deleteNodeAbstractVector(db, nodeId, capturedWorkToken))) return 'skipped';
        }
      } else {
        const c = client ?? getEmbeddingClient();
        const [vec] = await c.embed([abstractText], 'document');
        if (!vec) {
          throw new Error('Embedding client returned no vector.');
        }
        embeddedChars += abstractText.length;
        usedClient = c;
        // Latest-wins guard on the UPSERT (not just the clear): re-check
        // `embeddingWorkToken` in the DB right before writing. PR-219
        // review (Gemini high) — without this, two concurrent
        // prompt-drains race to INSERT and the slower one's older vector
        // silently overwrites the newer one.
        const fresh = await db.node.findUnique({
          where: { id: nodeId },
          select: { embeddingWorkToken: true },
        });
        if (fresh?.embeddingWorkToken !== capturedWorkToken) {
          return 'skipped';
        }
        // The pre-check above is a cheap early-out; THIS is the authoritative
        // guard — evaluated inside the write, so a newer edit landing between
        // the two cannot be overwritten (#1025 PR review).
        const wrote = await upsertAbstractVector(
          db,
          {
            nodeId,
            memoryId: memory.id,
            provider: c.provider,
            model: c.model,
            dim: c.dim,
            embedding: vec,
          },
          capturedWorkToken,
        );
        if (!wrote) return 'skipped';
      }
    }

    if (wantChunks) {
      // Spec 033 US2 T040 — chunk path. Mirror the abstract-path checks:
      // unavailable encrypted plaintext leaves the obligation pending (R132);
      // empty plaintext clears the chunk vectors; otherwise chunk, embed, upsert.
      const contentText =
        plaintext?.content !== undefined ? plaintext.content : node.content;

      if (memory.isEncrypted && contentText != null && isCiphertext(contentText)) {
        return 'skipped'; // Never consume an encrypted obligation without usable plaintext.
      }

      if (contentText == null || contentText.trim() === '') {
        if (!(await deleteNodeChunkVectors(db, nodeId, capturedWorkToken))) return 'skipped';
      } else {
        const allChunks = chunkNode(contentText, {
          chunkTokens: memory.chunkTokens ?? undefined,
          chunkOverlap: memory.chunkOverlap ?? undefined,
          forceFixedSize: memory.forceFixedSize,
        });
        const chunks = allChunks.slice(0, MAX_NODE_PASSAGE_CHUNKS);
        const omittedChunks = allChunks.length - chunks.length;
        if (chunks.length === 0) {
          if (!(await deleteNodeChunkVectors(db, nodeId, capturedWorkToken))) return 'skipped';
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
          embeddedChars += chunks.reduce((sum, ch) => sum + ch.text.length, 0);
          usedClient = c;
          // Same latest-wins guard before the upsert.
          const fresh = await db.node.findUnique({
            where: { id: nodeId },
            select: { embeddingWorkToken: true },
          });
          if (fresh?.embeddingWorkToken !== capturedWorkToken) {
            return 'skipped';
          }
          const wroteChunks = await upsertChunkVectors(
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
            capturedWorkToken,
            omittedChunks || null,
          );
          if (!wroteChunks) return 'skipped';
        }
      }
    }

    // Latest-wins: only clear the marker if no newer write re-stamped it while
    // we were embedding (optimistic guard on the captured work token).
    const cleared = await clearMarkers(db, nodeId, capturedWorkToken);
    if (cleared && usedClient && embeddedChars > 0) {
      // 046-usage-metering (FR-007): one event per embedded node. tokensIn is
      // the standard ~4-chars/token ESTIMATE (the endpoint returns no usage);
      // exactness isn't required — this is observability parity, and the
      // (provider, model) pair is typically unpriced (infra-shaped cost).
      // Embedding infra is host-configured (EMBEDDING_* env) ⇒ platform key.
      await recordLlmUsage(db, {
        type: 'embedding',
        nodeLoc: node.loc,
        nodeId,
        memoryId: memory.id, // #796
        organizationId: memory.organizationId,
        provider: usedClient.provider,
        model: usedClient.model,
        tokensIn: Math.ceil(embeddedChars / 4),
        tokensOut: 0,
        keyOwnerType: 'HADRON_SERVER',
      });
    }
    return cleared ? 'embedded' : 'skipped';
  } catch (err) {
    // Same latest-wins guard on the failure path (PR-219 review, Gemini high):
    // if a newer write has replaced the work token, this failure record
    // would mask a fresh attempt that's already in flight or queued.
    if (classifyEmbedError(err) === 'permanent') {
      // Deterministic rejection (4xx, dimension mismatch): retrying the same
      // payload fails identically, so stop immediately (#882). Recovery is an
      // operator/config fix + retryFailedEmbeddings.
      await markPermanentFailure(db, node.id, String(err), capturedWorkToken);
      return 'failed-permanent';
    }
    await markRetryableFailure(
      db,
      node.id,
      capturedWorkToken,
      node.embeddingAttempts,
      retryOpts,
      memory.isEncrypted ? FRESH_PLAINTEXT_REQUIRED : String(err),
    );
    return 'failed-transient';
  }
}

/** Clear markers iff the writer-captured work token still owns this obligation. */
async function clearMarkers(
  db: PrismaClient,
  nodeId: string,
  capturedWorkToken: string,
): Promise<boolean> {
  const res = await db.node.updateMany({
    where: { id: nodeId, embeddingWorkToken: capturedWorkToken },
    data: {
      embeddingPendingAt: null,
      embeddingWorkToken: null,
      embeddingFailedAt: null,
      embeddingError: null,
      embeddingAttempts: 0,
    },
  });
  return res.count > 0;
}

/**
 * Record a permanent-class failure: clear pending so the sweep never
 * re-selects it; keep failedAt/error as the record. Recovery is the
 * `retryFailedEmbeddings` mutation (or a fresh write, which re-stamps via
 * stampEmbeddingObligation). Guarded by the captured `embeddingWorkToken`
 * (latest-wins) — a newer write's re-stamp means a fresh attempt owns the
 * markers and this stale failure must not clobber it.
 */
async function markPermanentFailure(
  db: PrismaClient,
  nodeId: string,
  error: string,
  capturedWorkToken: string,
): Promise<void> {
  await db.node.updateMany({
    where: { id: nodeId, embeddingWorkToken: capturedWorkToken },
    data: { embeddingPendingAt: null, embeddingWorkToken: null, embeddingFailedAt: new Date(), embeddingError: error },
  });
}

/**
 * Record a retryable-class failure and reschedule with exponential backoff
 * (#882): `embeddingPendingAt` is future-dated by base * 2^(attempts-1)
 * (capped at retryMaxMs), and the drain only selects rows whose stamp is
 * due. There is deliberately NO give-up: `embeddingAttempts` keeps counting
 * for observability and backoff computation, but a retryable failure never
 * removes the node from the queue — the pre-#882 5-attempt cap is how a
 * transient endpoint blip silently dropped 65 spec nodes from the index.
 *
 * Optimistic guard: only stamp if embeddingWorkToken is still the value
 * captured at the start of this attempt. A newer write that re-stamped it
 * has either already retried successfully or has its own attempt in flight;
 * either way this stale failure shouldn't clobber it. updateMany returns
 * count=0 silently when the WHERE doesn't match.
 */
async function markRetryableFailure(
  db: PrismaClient,
  nodeId: string,
  capturedWorkToken: string,
  priorAttempts: number,
  retryOpts: EmbedRetryOpts,
  error: string,
): Promise<void> {
  const attempts = priorAttempts + 1;
  const baseMs = retryOpts.retryBaseMs ?? DEFAULT_RETRY_BASE_MS;
  const maxMs = retryOpts.retryMaxMs ?? DEFAULT_RETRY_MAX_MS;
  // Exponent clamped so a long-failing node can't overflow the arithmetic.
  const delayMs = Math.min(baseMs * 2 ** Math.min(attempts - 1, 20), maxMs);
  await db.node.updateMany({
    where: { id: nodeId, embeddingWorkToken: capturedWorkToken },
    data: {
      embeddingFailedAt: new Date(),
      embeddingAttempts: attempts,
      embeddingError: error,
      embeddingPendingAt: new Date(Date.now() + delayMs),
      embeddingWorkToken: randomUUID(),
    },
  });
}

export interface DrainResult {
  embedded: number;
  failed: number;
  skipped: number;
}

// ── Fair batch selection (#887 Slice 1) ─────────────────────────────────────
//
// The queue used to drain in strict global `embeddingPendingAt ASC` order, so
// one memory's old backlog (bulk import, backfill, a retryFailedEmbeddings
// re-drive) formed a head-of-line convoy that filled every batch ahead of
// other memories' due fresh writes. Selection is now round-robin across
// memories with due work: each round takes the OLDEST unselected due node of
// every remaining memory (DISTINCT ON (memory_id)), rounds repeat until the
// batch fills, and the cycle's start rotates to just after the last memory
// that received a slot — so successive batches keep advancing around the
// memories even when there are more due memories than batch slots (a fixed
// first-page subset cannot starve the rest: every eligible memory is served
// within ⌈M / batchSize⌉ batches). Within a memory the order is
// oldest-due-first with a deterministic id tie-break, and future-dated
// backed-off rows are never selected to manufacture fairness — the due
// filter is unchanged (#882).
//
// The rotation cursor is process-local. All production entry paths use one
// dispatcher control reservation. It consumes the bounded candidate-ID batch
// before advancing to another selection, so an admitted pipeline cap cannot
// silently discard the memories over which this cursor advanced. Processes
// rotate independently; this is fairness, not a fleet lease or exactly-once.

let drainRotationMemoryId: string | null = null;

interface DuePick {
  id: string;
  memory_id: string;
}

/**
 * Select up to `batchSize` due node ids, round-robin across memories (see
 * the block comment above). Pure selection: markers, ordering guarantees
 * within a memory, and the due-stamp filter are all that matter here — the
 * embed loop below owns outcomes.
 */
async function selectFairDueBatch(db: PrismaClient, batchSize: number): Promise<string[]> {
  // Bind the due-stamp bound as an ISO-UTC STRING, never a JS Date: the
  // column is `timestamp` (UTC wall time, as Prisma's ORM writes it), and a
  // Date binds as timestamptz — PG then converts it through the SESSION
  // timezone (e.g. Europe/Berlin) before comparing, a two-hour skew that
  // would admit future-dated backoff rows. The string casts to `timestamp`
  // keeping its UTC wall time, independent of the session timezone.
  const nowUtc = new Date().toISOString();
  const selected: string[] = [];
  const excluded = new Set<string>();
  let lastServed = drainRotationMemoryId;

  while (selected.length < batchSize) {
    const remaining = batchSize - selected.length;
    const excludeSql = excluded.size
      ? Prisma.sql` AND id NOT IN (${Prisma.join([...excluded])})`
      : Prisma.empty;

    const round = (memoryFilter: Prisma.Sql, limit: number) =>
      db.$queryRaw<DuePick[]>(Prisma.sql`
        SELECT DISTINCT ON (memory_id) id, memory_id
        FROM nodes
        WHERE embedding_pending_at <= ${nowUtc}::timestamp
          AND embedding_work_token IS NOT NULL AND deleted_at IS NULL
          AND EXISTS (SELECT 1 FROM memories m WHERE m.id = nodes.memory_id
            AND m.deleted_at IS NULL AND (m.vector_index_enabled = true OR m.class = 'system') AND m.is_encrypted = false)${memoryFilter}${excludeSql}
        ORDER BY memory_id, embedding_pending_at ASC, id ASC
        LIMIT ${limit}
      `);

    // One round: the oldest unselected due node of each remaining memory,
    // starting the cycle just after the last memory served (wrapping around
    // the memory_id ring when the after-cursor half comes up short).
    let rows: DuePick[];
    if (lastServed === null) {
      rows = await round(Prisma.empty, remaining);
    } else {
      rows = await round(Prisma.sql` AND memory_id > ${lastServed}`, remaining);
      if (rows.length < remaining) {
        rows = rows.concat(
          await round(Prisma.sql` AND memory_id <= ${lastServed}`, remaining - rows.length),
        );
      }
    }
    if (rows.length === 0) break; // no memory has unselected due work left

    for (const r of rows) {
      if (selected.length >= batchSize) break;
      selected.push(r.id);
      excluded.add(r.id);
      lastServed = r.memory_id;
    }

    // Single-memory fast path: one row per round is all the round-robin can
    // produce when exactly one memory has due work — no other memory awaits
    // service, so fill the rest of the batch in plain oldest-first order.
    if (rows.length === 1 && selected.length < batchSize) {
      const fill = await db.$queryRaw<{ id: string }[]>(Prisma.sql`
        SELECT id FROM nodes
        WHERE embedding_pending_at <= ${nowUtc}::timestamp
          AND embedding_work_token IS NOT NULL AND deleted_at IS NULL
          AND EXISTS (SELECT 1 FROM memories m WHERE m.id = nodes.memory_id
            AND m.deleted_at IS NULL AND (m.vector_index_enabled = true OR m.class = 'system') AND m.is_encrypted = false) AND id NOT IN (${Prisma.join([...excluded])})
        ORDER BY embedding_pending_at ASC, id ASC
        LIMIT ${batchSize - selected.length}
      `);
      selected.push(...fill.map((f) => f.id));
      break;
    }
  }

  if (selected.length > 0) drainRotationMemoryId = lastServed;
  return selected;
}

/**
 * Drain a batch of marked nodes (the sweep). `embeddingPendingAt` is the work
 * signal; a row whose stamp is future-dated is a backed-off retry that is not
 * yet due (#882) — the `lte: now` filter in the selection excludes it (and,
 * being a comparison, never matches NULL). Selection is round-robin across
 * memories (#887 Slice 1) — see selectFairDueBatch.
 */
export async function drainEmbeddingQueue(
  db: PrismaClient,
  opts: { batchSize?: number; client?: EmbeddingClient } & EmbedRetryOpts = {},
): Promise<DrainResult> {
  if (!isEmbeddingConfigured()) return { embedded: 0, failed: 0, skipped: 0 };
  const outcomes = await embeddingDispatcher(db).drainWith(
    (nodeId) => embedNode(db, nodeId, undefined, opts.client, opts), opts.batchSize,
  );
  const result: DrainResult = { embedded: 0, failed: 0, skipped: 0 };
  for (const outcome of outcomes) {
    if (outcome === 'embedded') result.embedded++;
    else if (outcome === 'failed-permanent' || outcome === 'failed-transient') result.failed++;
    else result.skipped++;
  }
  return result;
}

/**
 * Periodic wakes use the shared selector rather than spawning overlapping drains.
 * stopEmbeddingWorker owns the current timer and bounded lifecycle teardown.
 */
let sharedDispatcher: EmbeddingDispatcher | undefined;
const workerTimers = new WeakMap<object, NodeJS.Timeout>();
const busStops = new WeakMap<object, () => Promise<void>>();

export function embeddingDispatcher(db: PrismaClient): EmbeddingDispatcher {
  // Process-wide, not keyed by a client/transaction wrapper that could multiply
  // admission capacity. The production selector uses the first pooled client.
  if (!sharedDispatcher) {
    sharedDispatcher = new EmbeddingDispatcher({
      select: (limit) => selectFairDueBatch(db, limit),
      run: (id) => embedNode(db, id),
      onError: (error) => console.error('[embed-worker] bounded worker failed:', error),
    });
  }
  return sharedDispatcher;
}

/** Admission remains closed if the migration/producer cut left runnable legacy obligations. */
export async function assertEmbeddingObligationsReconciled(db: PrismaClient): Promise<void> {
  const legacy = await db.node.count({ where: {
    deletedAt: null, embeddingPendingAt: { not: null }, embeddingWorkToken: null,
    memory: { deletedAt: null, ...INDEXED_MEMORY_WHERE },
  } });
  if (legacy) {
    await embeddingDispatcher(db).stop(0);
    throw new Error('Embedding worker admission closed: unreconciled legacy obligations.');
  }
}

export function startEmbeddingWorkerLoop(
  db: PrismaClient,
  opts: { intervalMs?: number; initialDelayMs?: number; batchSize?: number } = {},
): NodeJS.Timeout {
  const tick = () => {
    if (isEmbeddingConfigured()) embeddingDispatcher(db).nudge();
    workerTimers.set(db, setTimeout(tick, opts.intervalMs ?? 30_000));
  };
  const timer = setTimeout(tick, opts.initialDelayMs ?? 5_000);
  workerTimers.set(db, timer);
  return timer;
}

export async function stopEmbeddingWorker(db: PrismaClient, graceMs = 5_000): Promise<boolean> {
  const timer = workerTimers.get(db);
  if (timer) clearTimeout(timer);
  workerTimers.delete(db);
  const stopBus = busStops.get(db);
  busStops.delete(db);
  // Close admission synchronously before waiting for broker teardown.
  const settled = embeddingDispatcher(db).stop(graceMs);
  let deadline: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      Promise.all([settled, stopBus ? stopBus().then(() => true, () => false) : true])
        .then(([jobs, bus]) => jobs && bus),
      new Promise<boolean>((resolve) => { deadline = setTimeout(() => resolve(false), Math.max(0, graceMs)); }),
    ]);
  } finally { if (deadline) clearTimeout(deadline); }
}

// ── Bus wake-up (spec 039 — first same-process job listener) ────────────────
//
// Subject `embed.wake.v1` only nudges the shared selector. Legacy { nodeId }
// hints remain valid but store no per-message job. Work and retry identity live
// in Postgres; the broker is optional. Encrypted work can use only an admitted
// fresh plaintext prompt, never a broker payload or a keyless sweep (R132).

import { getBusClient } from '../lib/bus/index.js';

export const EMBED_WAKE_SUBJECT = 'embed.wake.v1';
export const EMBED_QUEUE_GROUP = 'embed-worker';

export interface EmbedWakePayload {
  nodeId?: string;
}

/**
 * Validate and coalesce one wake, then ack. Durable backoff, not broker
 * redelivery timing, schedules retryable work.
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
  // Any valid wake uses one shared admission path, including node-specific hints.
  embeddingDispatcher(db).nudge();
}

/**
 * Start the same-process bus listener. Resolves to the unsubscribe function,
 * or null when the bus is off (NATS_URL unset / broker unreachable) — the
 * sweep loop is the fallback either way.
 *
 * Embedding deliberately does NOT subscribe to evt.node.written.v1 (PR-507
 * review): its wake must be ordered AFTER the durable marker stamp, which
 * only enqueueNodeEmbedding can guarantee (see the comment there). The
 * event serves modules without a write-path ordering dependency (git
 * mirror).
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
  // Shutdown may race subscription establishment; do not resurrect a stopped listener.
  if (embeddingDispatcher(db).state().closed) { await unsubscribe(); return null; }
  busStops.set(db, unsubscribe);
  console.log(`[embed-worker] bus listener active on ${EMBED_WAKE_SUBJECT}`);
  return unsubscribe;
}
