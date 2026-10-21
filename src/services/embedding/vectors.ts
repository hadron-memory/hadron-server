/**
 * 033-rag-vector-retrieval — raw-SQL vector storage + similarity search.
 *
 * The `node_embeddings.embedding` column is pgvector `vector(768)`, which the
 * Prisma client can't read or write (Unsupported type). All access therefore
 * goes through `$executeRaw`/`$queryRaw` here. A vector is bound as a text
 * literal `[a,b,c]` and cast `::vector`.
 */

import type { PrismaClient } from '../../generated/prisma/index.js';
import { Prisma } from '../../generated/prisma/index.js';
import { generateId } from '../../lib/id.js';

/** Format a number[] as a pgvector text literal: `[0.1,0.2,...]`. */
export function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(',')}]`;
}

export interface AbstractVectorRow {
  nodeId: string;
  memoryId: string;
  provider: string;
  model: string;
  dim: number;
  embedding: number[];
}

/**
 * The latest-wins precondition (#1025, PR review).
 *
 * `embedNode` captures `nodes.embedding_pending_at` when it claims work and
 * re-checks it before writing, so a slower worker holding an older vector does
 * not overwrite a newer one. That check was a separate statement, leaving a
 * TOCTOU window: a newer worker could commit its vector AND clear the marker
 * between the check and the write, after which the stale write landed last and
 * won. Passing the captured marker down closes it — the guard is evaluated as
 * part of the write itself.
 *
 * `undefined` means "no precondition" (callers outside the sweep, and tests).
 * `null` is a real value: it matches a node whose marker is cleared, which is
 * why the comparison is `IS NOT DISTINCT FROM` rather than `=`.
 */
export type PendingAtGuard = Date | null | undefined;

/**
 * `AT TIME ZONE 'UTC'` is load-bearing, not decoration. The column is
 * `timestamp(3)` (no zone) holding UTC, while Prisma binds a JS `Date` as
 * `timestamptz` — so a bare comparison makes Postgres coerce one side using the
 * SESSION time zone and the two silently disagree wherever that is not UTC.
 * Lifting the column to `timestamptz` as UTC compares the instants both sides
 * actually mean. `IS NOT DISTINCT FROM` (not `=`) so a cleared marker — NULL on
 * both sides — matches.
 */
const pendingGuard = (expected: PendingAtGuard) =>
  expected === undefined
    ? Prisma.sql`TRUE`
    : Prisma.sql`(n.embedding_pending_at AT TIME ZONE 'UTC') IS NOT DISTINCT FROM ${expected}`;

/**
 * Replace a node's abstract vector — a REAL upsert (#1025).
 *
 * A node carries at most one abstract vector, enforced by the PARTIAL unique
 * `node_embeddings_abstract_uniq ON node_embeddings (node_id) WHERE kind =
 * 'abstract'` (post-push.sql). Postgres can infer that index for conflict
 * resolution when the conflict target restates its predicate, which is what the
 * `WHERE kind = 'abstract'` after the column list is doing — it is the INDEX
 * PREDICATE for inference, not a filter on the row being written.
 *
 * This replaced a DELETE-then-INSERT pair wrapped in a transaction, which was
 * not an upsert and raced. Under READ COMMITTED two concurrent re-embeds of one
 * node — a write-path re-embed interleaving with the `embedding_pending_at`
 * sweep is the ordinary way they meet — collided on that unique: A deletes and
 * inserts; B's delete WAITS on A's lock, then re-evaluates, finds the row
 * already gone and deletes NOTHING; B's insert then violates the unique and the
 * whole re-embed fails 23505. (Lock-wait then unique violation — not a
 * deadlock, which Postgres reports as 40P01.)
 *
 * What that costs is a STALE vector, not a missing one: the loser's transaction
 * rolls back, so the winner's row stays committed and the node remains
 * searchable — on whichever text won. The node is left flagged
 * `embedding_failed_at`, and since vector search does not filter on that flag,
 * nothing about the search result reveals it. That is what made it invisible
 * until a corpus validate surfaced it.
 *
 * The transaction is gone with the DELETE, deliberately. Its documented purpose
 * (PR-219 review) was to roll the DELETE back if the INSERT failed, so the node
 * never briefly carried no abstract vector. A single upserting statement has no
 * such window to protect: the row is never deleted, only overwritten in place.
 *
 * @returns whether a row was written — `false` means the node moved memory
 *   or the latest-wins guard rejected an older content version.
 */
export async function upsertAbstractVector(
  db: PrismaClient,
  row: AbstractVectorRow,
  expectedPendingAt?: PendingAtGuard,
): Promise<boolean> {
  // INSERT ... SELECT rather than VALUES so the guard is part of the same
  // statement. Lock the node as the chunk writer does: without the lock, this
  // SELECT can read an old marker before a revival commits, then wait on the
  // vector's unique/FK constraint and insert stale bytes AFTER revival's
  // transactional delete. The row lock makes the guard re-check the committed
  // marker after waiting. NO KEY UPDATE admits the INSERT's FK KEY SHARE lock.
  // #409: memory identity is a second guard: an old null marker also matches
  // null after a move into an unindexed memory, but the source is no longer valid.
  const written = await db.$executeRaw(Prisma.sql`
    INSERT INTO node_embeddings (id, node_id, memory_id, kind, provider, model, dim, embedding, created_at)
    SELECT ${generateId()}, ${row.nodeId}, ${row.memoryId}, 'abstract', ${row.provider}, ${row.model}, ${row.dim}, ${toVectorLiteral(row.embedding)}::vector, now()
    FROM nodes n
    WHERE n.id = ${row.nodeId} AND n.memory_id = ${row.memoryId} AND ${pendingGuard(expectedPendingAt)}
    FOR NO KEY UPDATE OF n
    ON CONFLICT (node_id) WHERE kind = 'abstract'
    DO UPDATE SET
      memory_id  = EXCLUDED.memory_id,
      provider   = EXCLUDED.provider,
      model      = EXCLUDED.model,
      dim        = EXCLUDED.dim,
      embedding  = EXCLUDED.embedding,
      created_at = now()
  `);
  return written > 0;
}

/** Delete all of a node's vectors (re-index / disable / cleared abstract). */
export async function deleteNodeVectors(db: PrismaClient, nodeId: string): Promise<void> {
  await db.$executeRaw`DELETE FROM node_embeddings WHERE node_id = ${nodeId}`;
}

/**
 * Delete just the chunk vectors for a node (kind='chunk'). Used when content is
 * cleared — the empty-set arm of a rebuild.
 *
 * Takes the SAME node lock and the SAME latest-wins guard as
 * {@link upsertChunkVectors} (#1025, PR review). It is the other half of one
 * operation — "rebuild this node's chunks, where the new set happens to be
 * empty" — so leaving it unlocked would let a clear race a populated rebuild
 * and strand whichever landed first, which is exactly the hole locking the
 * other arm was meant to close.
 *
 * @returns whether the delete ran — `false` means the guard rejected it.
 */
export async function deleteNodeChunkVectors(
  db: PrismaClient,
  nodeId: string,
  expectedPendingAt?: PendingAtGuard,
): Promise<boolean> {
  return db.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
      SELECT n.id FROM nodes n
      WHERE n.id = ${nodeId} AND ${pendingGuard(expectedPendingAt)}
      FOR NO KEY UPDATE
    `);
    if (locked.length === 0) return false;
    await tx.$executeRaw`DELETE FROM node_embeddings WHERE node_id = ${nodeId} AND kind = 'chunk'`;
    return true;
  });
}

export interface ChunkVectorRow {
  nodeId: string;
  memoryId: string;
  provider: string;
  model: string;
  dim: number;
  chunkIndex: number;
  charStart: number;
  charEnd: number;
  chunkText: string;
  embedding: number[];
}

/**
 * Spec 033 US2 (T039) — replace a node's chunk vectors atomically.
 *
 * delete-all-then-insert-all inside a single transaction so a failed
 * insert rolls back the delete. Per FR-017, every content edit re-derives the
 * full chunk set — there's no per-chunk update path, just a clean rebuild.
 *
 * `rows` may be empty; the delete still fires so any prior chunks vanish.
 * (`embedNode` routes the content-cleared case through
 * {@link deleteNodeChunkVectors}, which now takes the same lock and guard.)
 *
 * @returns whether the rebuild ran — `false` means the populated batch's
 *   memory no longer matches the node, or the content-version guard refused it.
 *
 * ## Why the row lock (#1025)
 *
 * The same race as the abstract path, and it fails the same way: loudly, on
 * `node_embeddings_node_id_kind_chunk_index_key`. Under READ COMMITTED, writer
 * A deletes the old rows and inserts its set; writer B's DELETE blocks on A's
 * locks and, when it resumes, removes only what was in ITS statement snapshot
 * — A's brand-new rows were never in that snapshot, so they are neither
 * scanned nor removed. B then inserts `chunk_index = 0`, collides with A's, and
 * the whole rebuild fails 23505, leaving the node flagged
 * `embedding_failed_at`.
 *
 * An `ON CONFLICT` upsert is NOT the fix here, unlike the abstract path: the
 * chunk set is rebuilt wholesale and the new set may be SHORTER than the old
 * one, so upserting by index would silently strand the tail (`chunk_index` 5..9
 * of a set that is now 5 long) as vectors of content that no longer exists.
 * Delete-then-insert is the right shape; it just has to be serialized.
 *
 * `FOR NO KEY UPDATE`, not `FOR UPDATE`, deliberately — the inserts below
 * FK-reference this same row, and an FK check takes `FOR KEY SHARE`, which `NO
 * KEY UPDATE` admits and `UPDATE` would block against (the deadlock class
 * already documented on `withRoleWriteLock`).
 */
export async function upsertChunkVectors(
  db: PrismaClient,
  nodeId: string,
  rows: ChunkVectorRow[],
  expectedPendingAt?: PendingAtGuard,
): Promise<boolean> {
  return db.$transaction(async (tx) => {
    // Lock and guard in ONE statement, so the marker is judged under the lock:
    // checking it first and locking after would reopen the TOCTOU the guard
    // exists to close.
    const locked = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
      SELECT n.id FROM nodes n
      WHERE n.id = ${nodeId} AND ${pendingGuard(expectedPendingAt)}
        ${rows.length ? Prisma.sql`AND n.memory_id = ${rows[0].memoryId}` : Prisma.empty}
      FOR NO KEY UPDATE
    `);
    if (locked.length === 0) return false;
    await tx.$executeRaw`DELETE FROM node_embeddings WHERE node_id = ${nodeId} AND kind = 'chunk'`;
    for (const row of rows) {
      // One INSERT per chunk (no multi-row pgvector parameter syntax via
      // Prisma raw). N is bounded by content length / chunkTokens; for
      // a 100k-char document with the 512-token default that's ~50 inserts.
      await tx.$executeRaw`
        INSERT INTO node_embeddings (id, node_id, memory_id, kind, provider, model, dim, chunk_index, char_start, char_end, chunk_text, embedding, created_at)
        VALUES (${generateId()}, ${row.nodeId}, ${row.memoryId}, 'chunk', ${row.provider}, ${row.model}, ${row.dim}, ${row.chunkIndex}, ${row.charStart}, ${row.charEnd}, ${row.chunkText}, ${toVectorLiteral(row.embedding)}::vector, now())
      `;
    }
    return true;
  });
}

/** Delete every vector for a memory (revoke / disable). */
export async function deleteMemoryVectors(db: PrismaClient, memoryId: string): Promise<void> {
  await db.$executeRaw`DELETE FROM node_embeddings WHERE memory_id = ${memoryId}`;
}

/**
 * #2199 — drop only the CONTENT-CHUNK vectors of a memory, keeping its summary (abstract) vectors. A system memory's
 * summary index cannot be switched off, so disabling its passages or changing the source manages chunk rows only.
 */
export async function deleteMemoryChunkVectors(db: PrismaClient, memoryId: string): Promise<void> {
  await db.$executeRaw`DELETE FROM node_embeddings WHERE memory_id = ${memoryId} AND kind = 'chunk'`;
}

/**
 * #1345 review (@codex round 6) — is a vector window PROVABLY complete?
 *
 * Only when it returned every eligible row — measured against an INDEPENDENT
 * count, because a short ANN result is not evidence: when the planner uses the
 * HNSW index, pgvector applies `memory_id IN (…)` to the candidates the scan
 * visits (at most `hnsw.ef_search`; iterative scans are not enabled here), so a
 * selective filter can return fewer rows than LIMIT with matches still deeper —
 * and the final LIMIT truncated nothing. Anything else is "not exhausted",
 * which only costs a wider (bounded) retry.
 */
export function vectorWindowExhausted(w: { windowRows: number; eligibleRows: number; truncated: boolean }): boolean {
  return !w.truncated && w.windowRows >= w.eligibleRows;
}

/**
 * #1345 review (@codex round 7) — the HNSW scan horizon for a window of
 * `candidateK` rows. pgvector's HNSW visits at most `hnsw.ef_search`
 * candidates (default 40), so without this a wider LIMIT never looked any
 * deeper and filtered widening only repeated the same scan. Tracking the window
 * (never below the default, capped at pgvector's max of 1000) makes a wider
 * window a deeper scan. Beyond 1000, filtered recall stays approximate (iterative
 * scans are the follow-up).
 */
export function hnswEfSearchFor(candidateK: number): number {
  return Math.min(Math.max(Math.trunc(candidateK), 40), 1000);
}

/** Run a vector query with the HNSW horizon set for its window (SET LOCAL: this transaction only). */
async function withEfSearch<T>(db: PrismaClient, candidateK: number, query: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL hnsw.ef_search = ${hnswEfSearchFor(candidateK)}`);
    return query(tx);
  });
}

/**
 * #1608 — a comment stub (#1721: deleted, kept for its replies) is never a vector hit, whatever the
 * index still holds: concealment must not wait for the asynchronous vector
 * cleanup (#1674 review, Jane P2-4). Correlated on `n` (the nodes row); a
 * non-comment has no meta row and passes.
 */
const NOT_A_STUB = Prisma.sql`AND NOT EXISTS (SELECT 1 FROM comment_meta cm_stub
      WHERE cm_stub.node_id = n.id AND cm_stub.retracted_at IS NOT NULL)`;

export interface VectorHit {
  nodeId: string;
  score: number; // cosine similarity in [0,1]-ish (1 - distance)
}

/**
 * Node-level vector search (D-R5/FR-022 default granularity). The ANN scan is
 * the index-using inner query (HNSW serves `ORDER BY <=> LIMIT`); we over-fetch
 * candidates, then dedupe to nodes (best vector per node) and drop soft-deleted.
 *
 * #1608 — `commentsOnly` ranks comment vectors EXACTLY instead (a filtered
 * scan, no ANN window), so a comments-only search returns every matching
 * comment however many content vectors outrank it (cor:dmo:110:08). Comments
 * are a small set beside a memory's content, which keeps the scan cheap.
 */
export async function vectorSearchNodes(
  db: PrismaClient,
  opts: {
    memoryIds: string[];
    queryEmbedding: number[];
    limit: number;
    candidateFactor?: number;
    /** #1345 — told whether the raw ANN window was exhausted (see below). */
    onWindow?: (w: { exhausted: boolean }) => void;
    /** #1608 — content, comments or both (see the doc above). Absent = ALL (no restriction). */
    scope?: 'CONTENT' | 'COMMENTS' | 'ALL';
  },
): Promise<VectorHit[]> {
  if (opts.memoryIds.length === 0) {
    opts.onWindow?.({ exhausted: true });
    return [];
  }
  const qvec = toVectorLiteral(opts.queryEmbedding);
  const k = opts.limit;
  if (opts.scope === 'COMMENTS') {
    const rows = await db.$queryRaw<{ node_id: string; distance: number }[]>`
      SELECT ne.node_id, MIN(ne.embedding <=> ${qvec}::vector) AS distance
      FROM node_embeddings ne
      JOIN nodes n ON n.id = ne.node_id AND n.memory_id = ne.memory_id AND n.deleted_at IS NULL AND n.node_type = 'comment'
      WHERE ne.memory_id IN (${Prisma.join(opts.memoryIds)}) ${NOT_A_STUB}
      GROUP BY ne.node_id
      ORDER BY distance ASC
      LIMIT ${k}`;
    // Exact ranking, but a LIMITed prefix: exhausted only when it came back
    // short (#1674 review, Jane P2-3). A caller post-filtering the page widens
    // k and re-asks.
    opts.onWindow?.({ exhausted: rows.length < k });
    return rows.map((r) => ({ nodeId: r.node_id, score: 1 - Number(r.distance) }));
  }
  // CONTENT excludes comments INSIDE the ANN candidate scan, before its cap
  // (#1674 review, Jane P2-2): a comment vector can never take a candidate
  // slot from eligible content. ALL ranks everything except stub comments.
  const scopeSql = opts.scope === 'CONTENT' ? Prisma.sql`AND n.node_type <> 'comment'` : Prisma.empty;
  const candidateK = Math.max(k, k * (opts.candidateFactor ?? 10));
  // `ann_rows` is the RAW candidate count, before the node dedup (a window full
  // of one node's chunks dedupes to one hit, #1345 review). Exhaustion compares
  // it with an independent eligible count — see vectorWindowExhausted.
  const rows = await withEfSearch(db, candidateK, (tx) => tx.$queryRaw<{ node_id: string; distance: number; ann_rows: number }[]>`
    WITH ann AS (
      SELECT ne.node_id, ne.embedding <=> ${qvec}::vector AS distance
      FROM node_embeddings ne
      JOIN nodes n ON n.id = ne.node_id AND n.memory_id = ne.memory_id ${scopeSql}
      WHERE ne.memory_id IN (${Prisma.join(opts.memoryIds)}) ${NOT_A_STUB}
      ORDER BY ne.embedding <=> ${qvec}::vector
      LIMIT ${candidateK}
    )
    SELECT a.node_id, MIN(a.distance) AS distance, (SELECT count(*) FROM ann)::int AS ann_rows
    FROM ann a
    JOIN nodes n ON n.id = a.node_id AND n.deleted_at IS NULL
    GROUP BY a.node_id
    ORDER BY distance ASC
    LIMIT ${k}
  `);
  if (opts.onWindow) {
    const truncated = rows.length >= k;
    // No row carries ann_rows when the join left nothing; the window count is
    // unknown then, so only an empty scope can be called exhausted.
    const windowRows = rows.length > 0 ? Number(rows[0].ann_rows) : 0;
    let exhausted = false;
    if (!truncated && (rows.length === 0 || windowRows < candidateK)) {
      const [c] = await db.$queryRaw<{ n: number }[]>`
        SELECT count(*)::int AS n FROM node_embeddings ne
        JOIN nodes n ON n.id = ne.node_id AND n.memory_id = ne.memory_id ${scopeSql}
        WHERE ne.memory_id IN (${Prisma.join(opts.memoryIds)}) ${NOT_A_STUB}`;
      const eligibleRows = Number(c?.n ?? 0);
      exhausted = rows.length === 0 ? eligibleRows === 0 : vectorWindowExhausted({ windowRows, eligibleRows, truncated });
    }
    opts.onWindow({ exhausted });
  }
  return rows.map((r) => ({ nodeId: r.node_id, score: 1 - Number(r.distance) }));
}

export interface ChunkHit {
  nodeId: string;
  chunkIndex: number;
  charStart: number;
  charEnd: number;
  chunkText: string;
  score: number; // cosine similarity in [0,1]-ish (1 - distance)
}

/**
 * Spec 033 US2 (T041) — chunk-level vector search returning passages.
 *
 * Returns one row per matching chunk vector (NOT collapsed to node),
 * carrying the locator metadata a RAG consumer needs for
 * context-stuffing: span text + character offset + chunk index + parent
 * node URN (the caller resolves node URN from `nodeId`).
 *
 * Implementation matches embedding-worker.md's "chunk-level" query:
 * ORDER BY <=> cosine-distance LIMIT $candidateK, with the memoryIds +
 * kind='chunk' filter narrowing the index walk. Soft-deleted nodes are
 * filtered via the JOIN, then we truncate to k.
 */
export async function vectorSearchChunks(
  db: PrismaClient,
  opts: {
    memoryIds: string[];
    queryEmbedding: number[];
    limit: number;
    candidateFactor?: number;
    /** #1345 — told whether the chunk window was exhausted (fewer rows than it asked for). */
    onWindow?: (w: { exhausted: boolean }) => void;
    /** #1608 — content, comments or both; COMMENTS ranks exactly. Absent = ALL. */
    scope?: 'CONTENT' | 'COMMENTS' | 'ALL';
  },
): Promise<ChunkHit[]> {
  if (opts.memoryIds.length === 0) {
    opts.onWindow?.({ exhausted: true });
    return [];
  }
  const qvec = toVectorLiteral(opts.queryEmbedding);
  const k = opts.limit;
  if (opts.scope === 'COMMENTS') {
    const rows = await db.$queryRaw<{ node_id: string; chunk_index: number; char_start: number; char_end: number; chunk_text: string; distance: number }[]>`
      SELECT ne.node_id, ne.chunk_index, ne.char_start, ne.char_end, ne.chunk_text,
             ne.embedding <=> ${qvec}::vector AS distance
      FROM node_embeddings ne
      JOIN nodes n ON n.id = ne.node_id AND n.memory_id = ne.memory_id AND n.deleted_at IS NULL AND n.node_type = 'comment'
      WHERE ne.memory_id IN (${Prisma.join(opts.memoryIds)}) AND ne.kind = 'chunk' ${NOT_A_STUB}
      ORDER BY distance ASC
      LIMIT ${k}`;
    opts.onWindow?.({ exhausted: rows.length < k });
    return rows.map((r) => ({
      nodeId: r.node_id, chunkIndex: Number(r.chunk_index), charStart: Number(r.char_start),
      charEnd: Number(r.char_end), chunkText: r.chunk_text, score: 1 - Number(r.distance),
    }));
  }
  // Over-fetch to absorb soft-deleted-node losses + reach the top-k
  // chunks even when same-node chunks cluster near the top.
  const candidateK = Math.max(k, k * (opts.candidateFactor ?? 10));
  const chunkScopeSql = opts.scope === 'CONTENT' ? Prisma.sql`AND n.node_type <> 'comment'` : Prisma.empty;
  const rows = await withEfSearch(db, candidateK, (tx) => tx.$queryRaw<
    {
      node_id: string;
      chunk_index: number;
      char_start: number;
      char_end: number;
      chunk_text: string;
      distance: number;
    }[]
  >`
    SELECT ne.node_id, ne.chunk_index, ne.char_start, ne.char_end, ne.chunk_text,
           ne.embedding <=> ${qvec}::vector AS distance
    FROM node_embeddings ne
    JOIN nodes n ON n.id = ne.node_id AND n.memory_id = ne.memory_id AND n.deleted_at IS NULL ${chunkScopeSql}
    WHERE ne.memory_id IN (${Prisma.join(opts.memoryIds)}) AND ne.kind = 'chunk' ${NOT_A_STUB}
    ORDER BY ne.embedding <=> ${qvec}::vector
    LIMIT ${candidateK}
  `);
  // Exhausted = every eligible chunk (independent count; see
  // vectorWindowExhausted) was fetched AND fits in `k` (the slice truncates nothing).
  if (opts.onWindow) {
    const truncated = rows.length > k;
    let exhausted = false;
    if (!truncated && rows.length < candidateK) {
      const [c] = await db.$queryRaw<{ n: number }[]>`
        SELECT count(*)::int AS n FROM node_embeddings ne
        JOIN nodes n ON n.id = ne.node_id AND n.memory_id = ne.memory_id AND n.deleted_at IS NULL ${chunkScopeSql}
        WHERE ne.memory_id IN (${Prisma.join(opts.memoryIds)}) AND ne.kind = 'chunk' ${NOT_A_STUB}`;
      exhausted = vectorWindowExhausted({ windowRows: rows.length, eligibleRows: Number(c?.n ?? 0), truncated });
    }
    opts.onWindow({ exhausted });
  }
  return rows.slice(0, k).map((r) => ({
    nodeId: r.node_id,
    chunkIndex: Number(r.chunk_index),
    charStart: Number(r.char_start),
    charEnd: Number(r.char_end),
    chunkText: r.chunk_text,
    score: 1 - Number(r.distance),
  }));
}
