import { openThreadsVectorSql } from '../../lib/comments/openThreads.js';
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
export type PendingAtGuard = Date | string | null | undefined;

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
    : typeof expected === 'string'
      ? Prisma.sql`n.embedding_work_token = ${expected}::uuid AND n.deleted_at IS NULL`
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
    SELECT ${generateId()}, ${row.nodeId}, ${row.memoryId}, 'abstract', ${row.provider}, ${row.model}, ${row.dim}, ${toVectorLiteral(row.embedding)}::vector, (now() AT TIME ZONE 'UTC')::timestamp(3)
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
      created_at = (now() AT TIME ZONE 'UTC')::timestamp(3)
  `);
  return written > 0;
}

/** Delete all of a node's vectors (re-index / disable / cleared abstract). */
export async function deleteNodeVectors(db: PrismaClient, nodeId: string, expected?: PendingAtGuard): Promise<void> {
  if (expected === undefined) {
    await db.$transaction(async tx => {
      await tx.$executeRaw`SELECT id FROM nodes WHERE id = ${nodeId} FOR NO KEY UPDATE`;
      await tx.$executeRaw`DELETE FROM node_embeddings WHERE node_id = ${nodeId}`;
      await tx.$executeRaw`UPDATE nodes SET embedding_truncated_chunks = NULL WHERE id = ${nodeId}`;
    });
    return;
  }
  await db.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
      SELECT n.id FROM nodes n WHERE n.id = ${nodeId} AND ${pendingGuard(expected)} FOR NO KEY UPDATE
    `);
    if (rows.length) {
      await tx.$executeRaw`DELETE FROM node_embeddings WHERE node_id = ${nodeId}`;
      await tx.$executeRaw`UPDATE nodes SET embedding_truncated_chunks = NULL WHERE id = ${nodeId}`;
    }
  });
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
  return deleteNodeKindVectors(db, nodeId, 'chunk', expectedPendingAt);
}

/** The empty abstract arm needs the same authoritative token guard as an UPSERT. */
export async function deleteNodeAbstractVector(
  db: PrismaClient,
  nodeId: string,
  expectedPendingAt?: PendingAtGuard,
): Promise<boolean> {
  return deleteNodeKindVectors(db, nodeId, 'abstract', expectedPendingAt);
}

async function deleteNodeKindVectors(
  db: PrismaClient,
  nodeId: string,
  kind: 'chunk' | 'abstract',
  expectedPendingAt?: PendingAtGuard,
): Promise<boolean> {
  return db.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
      SELECT n.id FROM nodes n
      WHERE n.id = ${nodeId} AND ${pendingGuard(expectedPendingAt)}
      FOR NO KEY UPDATE
    `);
    if (locked.length === 0) return false;
    await tx.$executeRaw`DELETE FROM node_embeddings WHERE node_id = ${nodeId} AND kind = ${kind}::"EmbeddingKind"`;
    if (kind === 'chunk') await tx.$executeRaw`UPDATE nodes SET embedding_truncated_chunks = NULL WHERE id = ${nodeId}`;
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
  omittedChunks: number | null = null,
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
        VALUES (${generateId()}, ${row.nodeId}, ${row.memoryId}, 'chunk', ${row.provider}, ${row.model}, ${row.dim}, ${row.chunkIndex}, ${row.charStart}, ${row.charEnd}, ${row.chunkText}, ${toVectorLiteral(row.embedding)}::vector, (now() AT TIME ZONE 'UTC')::timestamp(3))
      `;
    }
    await tx.$executeRaw`UPDATE nodes SET embedding_truncated_chunks = ${rows.length ? omittedChunks : null} WHERE id = ${nodeId}`;
    return true;
  });
}

/** Delete every vector for a memory (revoke / disable). */
export async function deleteMemoryVectors(db: PrismaClient, memoryId: string): Promise<void> {
  await db.$transaction(async tx => {
    await tx.node.updateMany({ where: { memoryId, OR: [{ embeddingPendingAt: { not: null } }, { embeddingWorkToken: { not: null } }, { embeddingTruncatedChunks: { not: null } }] }, data: { embeddingPendingAt: null, embeddingWorkToken: null, embeddingTruncatedChunks: null } });
    await tx.$executeRaw`DELETE FROM node_embeddings WHERE memory_id = ${memoryId}`;
  });
}

/**
 * #2199 — drop only the CONTENT-CHUNK vectors of a memory, keeping its summary (abstract) vectors. A system memory's
 * summary index cannot be switched off, so disabling its passages or changing the source manages chunk rows only.
 */
export async function deleteMemoryChunkVectors(db: PrismaClient, memoryId: string): Promise<void> {
  await db.$transaction(async tx => {
    await tx.$executeRaw`UPDATE nodes SET embedding_truncated_chunks = NULL,
      embedding_work_token = CASE WHEN embedding_pending_at IS NOT NULL THEN gen_random_uuid() ELSE NULL END
      WHERE memory_id = ${memoryId}
        AND (embedding_truncated_chunks IS NOT NULL OR embedding_pending_at IS NOT NULL OR embedding_work_token IS NOT NULL)`;
    await tx.$executeRaw`DELETE FROM node_embeddings WHERE memory_id = ${memoryId} AND kind = 'chunk'`;
  });
}

/**
 * #2772 (ruling 0150, cor:api:090:04) — the HNSW scan horizon, per iteration. pgvector's HNSW visits at most
 * `hnsw.ef_search` candidates per scan step (default 40); with `hnsw.iterative_scan` the scan keeps stepping until
 * the filtered query has its rows, so this is only the per-iteration width and NEVER a result cap. Never below the
 * default, at most pgvector's maximum of 1000.
 */
export function hnswEfSearchFor(candidateK: number): number {
  return Math.min(Math.max(Math.trunc(candidateK), 40), 1000);
}

/**
 * #2772 — the deepest page (offset + limit, in nodes) whose order the HNSW index can stand behind: pgvector's
 * `hnsw.ef_search` maximum. A page that reaches past it is ranked by the exact statement instead of
 * returning the index's approximate order (ruling 0150, cor:api:090:04 "the true page").
 */
export const VECTOR_INDEX_ORDER_WINDOW = 1000;

/** #2772: default statement budget for one vector or hybrid vector statement. */
export const VECTOR_SEARCH_DEFAULT_TIMEOUT_MS = 5000;

/**
 * #2772 — the work budget of ONE vector statement, in milliseconds (`SET LOCAL statement_timeout`), env
 * `VECTOR_SEARCH_TIMEOUT_MS`, read per call. Only a positive safe integer counts: 0 means "no timeout" to
 * Postgres, so 0, negatives, fractions and junk fall back to the default instead of widening the bound
 * (same shape as `REGEX_SEARCH_TIMEOUT_MS`, #415).
 */
export function vectorSearchTimeoutMs(): number {
  const raw = process.env.VECTOR_SEARCH_TIMEOUT_MS;
  if (raw == null || raw.trim() === '') return VECTOR_SEARCH_DEFAULT_TIMEOUT_MS;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 && n <= 2_147_483_647 ? n : VECTOR_SEARCH_DEFAULT_TIMEOUT_MS;
}

/** pgvector introduced `hnsw.iterative_scan` in 0.8.0. */
export function pgvectorSupportsIterativeScan(version: string | null | undefined): boolean {
  const m = /^(\d+)\.(\d+)/.exec((version ?? '').trim());
  if (!m) return false;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  return major > 0 || minor >= 8;
}

let iterativeScanProbe: Promise<boolean> | null = null;
let iterativeScanOverride: boolean | null = null;

/** Test seam: force the pgvector-version answer (null restores the real probe). */
export function setIterativeScanSupportForTests(v: boolean | null): void {
  iterativeScanOverride = v;
  iterativeScanProbe = null;
}

/**
 * #2772 — does this database's pgvector support the iterative index scan? Read once per process from
 * `pg_extension`; on an older version (or a failed read) it logs ONE `vector.iterative_scan_unsupported` line and
 * the search uses the exact scan instead, still under the work budget. This never refuses to start anything.
 */
export function iterativeScanSupported(db: PrismaClient): Promise<boolean> {
  if (iterativeScanOverride != null) {
    if (!iterativeScanOverride) logIterativeUnsupported('stubbed');
    return Promise.resolve(iterativeScanOverride);
  }
  iterativeScanProbe ??= (async () => {
    let version: string | null = null;
    try {
      const rows = await db.$queryRaw<{ extversion: string }[]>`SELECT extversion FROM pg_extension WHERE extname = 'vector'`;
      version = rows[0]?.extversion ?? null;
    } catch {
      version = null;
    }
    const ok = pgvectorSupportsIterativeScan(version);
    if (!ok) logIterativeUnsupported(version ?? 'unknown');
    return ok;
  })();
  return iterativeScanProbe;
}

let loggedIterativeUnsupported = false;
function logIterativeUnsupported(version: string): void {
  if (loggedIterativeUnsupported) return;
  loggedIterativeUnsupported = true;
  console.error(`vector.iterative_scan_unsupported pgvector=${version} required=0.8.0 — vector search uses the exact scan (correct at any size, bounded by VECTOR_SEARCH_TIMEOUT_MS)`);
}

/** Test seam: re-arm the once-per-process log line. */
export function resetIterativeScanLogForTests(): void {
  loggedIterativeUnsupported = false;
}

/** Boot hook: probe the version so the one log line appears at startup. Never throws, never refuses. */
export async function checkPgvectorAtBoot(db: PrismaClient): Promise<void> {
  try { await iterativeScanSupported(db); } catch { /* a boot probe must never stop the server */ }
}

/** A cancelled statement (SQLSTATE 57014) is the early stop of cor:api:090:04, never an error to the caller. */
export function isStatementTimeout(e: unknown): boolean {
  const err = e as { code?: string; meta?: { code?: string; message?: string }; message?: string } | null;
  return err?.meta?.code === '57014' || /statement timeout/i.test(String(err?.message ?? '')) || /statement timeout/i.test(String(err?.meta?.message ?? ''));
}

/**
 * Run one vector statement group in a transaction under the work budget: `SET LOCAL` statement_timeout, the
 * per-iteration horizon and (pgvector >= 0.8.0) the strict-order iterative scan, all of which die with the
 * transaction and never reach a pooled connection's session.
 */
async function withVectorBudget<T>(
  db: PrismaClient, candidateK: number, iterative: boolean, query: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = ${vectorSearchTimeoutMs()}`);
    await tx.$executeRawUnsafe(`SET LOCAL hnsw.ef_search = ${hnswEfSearchFor(candidateK)}`);
    if (iterative) {
      await tx.$executeRawUnsafe(`SET LOCAL hnsw.iterative_scan = strict_order`);
      // The work budget above, not a tuple count, ends a search.
      await tx.$executeRawUnsafe(`SET LOCAL hnsw.max_scan_tuples = 2147483647`);
    }
    return query(tx);
  });
}

/**
 * #2772 — rank under the ruling-0150 contract: NO candidate cap. The iterative index scan walks the HNSW index
 * until the filtered, access-scoped statement has `need` rows; when it ends short, an independent count of the
 * eligible vectors says whether that is the whole set, and if not the same eligibility runs EXACTLY, at any size.
 * Anything that cannot finish inside the work budget stops EARLY and says so (`stopped`): the rows already
 * ranked are a valid prefix of the true ranking, never presented as a complete page.
 */
async function rankUnderBudget<R>(
  db: PrismaClient,
  o: {
    need: number;
    k0: number;
    distinctCount: (rows: R[]) => number;
    ann: (tx: Prisma.TransactionClient, k: number) => Promise<R[]>;
    exact: (tx: Prisma.TransactionClient) => Promise<R[]>;
    count: (tx: Prisma.TransactionClient) => Promise<number>;
    rawLength?: (rows: R[]) => number;
  },
): Promise<{ rows: R[]; exhausted: boolean; stopped: boolean }> {
  let best: R[] = [];
  const iterative = await iterativeScanSupported(db);
  try {
    if (iterative) {
      let k = Math.max(o.k0, 1);
      for (;;) {
        const rows = await withVectorBudget(db, k, true, (tx) => o.ann(tx, k));
        best = rows;
        if (o.distinctCount(rows) >= o.need) {
          if (o.need <= VECTOR_INDEX_ORDER_WINDOW) return { rows, exhausted: false, stopped: false };
          // Past the index's widest horizon the order of a FULL page is the index's approximate order, which
          // nothing in the statement can check (the count only catches a scan that ends short). Ruling 0150
          // asks for the true page, so rank it exactly; the cost grows with the offset (see the PR's EXPLAIN).
          best = await withVectorBudget(db, 40, false, (tx) => o.exact(tx));
          return { rows: best, exhausted: o.distinctCount(best) < o.need, stopped: false };
        }
        if (rows.length < k) break; // short: the whole set, or an index walk that ended early (checked below)
        k *= 4;
      }
      const eligible = await withVectorBudget(db, 40, true, (tx) => o.count(tx));
      if (best.length >= eligible) return { rows: best, exhausted: true, stopped: false };
    }
    best = await withVectorBudget(db, 40, false, (tx) => o.exact(tx));
    return { rows: best, exhausted: o.distinctCount(best) < o.need, stopped: false };
  } catch (e) {
    if (!isStatementTimeout(e)) throw e;
    return { rows: best, exhausted: false, stopped: true };
  }
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
    hasOpenThreads?: boolean | null;
    syntheticCommentMemoryIds?: string[];
    /** #2421: constrain summary search before ANN ranking. */
    abstractOnly?: boolean;
    candidateNodeIds?: string[];
    /** #1345 / #2772 — told whether the ranking is provably complete, and whether the search stopped early (work budget). */
    onWindow?: (w: { exhausted: boolean; stoppedEarly?: boolean }) => void;
    /** #2772 — the structured filters, the caller's exclusions and the deleted rule, as a `AND ne.node_id IN (…)` fragment inside the ranking statement. */
    filterSql?: Prisma.Sql;
    /** #1608 — content, comments or both (see the doc above). Absent = ALL (no restriction). */
    scope?: 'CONTENT' | 'COMMENTS' | 'ALL';
  },
): Promise<VectorHit[]> {
  if (opts.memoryIds.length === 0) {
    opts.onWindow?.({ exhausted: true });
    return [];
  }
  const candidateSql = opts.candidateNodeIds == null ? Prisma.empty : opts.candidateNodeIds.length
    ? Prisma.sql`AND ne.node_id IN (${Prisma.join(opts.candidateNodeIds)})` : Prisma.sql`AND FALSE`;
  const abstractSql = opts.abstractOnly ? Prisma.sql`AND ne.kind = 'abstract'` : Prisma.empty;
  const threadSql = openThreadsVectorSql(opts.hasOpenThreads, opts.syntheticCommentMemoryIds);
  const qvec = toVectorLiteral(opts.queryEmbedding);
  const k = opts.limit;
  if (opts.scope === 'COMMENTS') {
    const rows = await db.$queryRaw<{ node_id: string; distance: number }[]>`
      SELECT ne.node_id, MIN(ne.embedding <=> ${qvec}::vector) AS distance
      FROM node_embeddings ne
      JOIN nodes n ON n.id = ne.node_id AND n.memory_id = ne.memory_id AND n.deleted_at IS NULL AND n.node_type = 'comment'
      WHERE ne.memory_id IN (${Prisma.join(opts.memoryIds)}) ${NOT_A_STUB} ${candidateSql} ${abstractSql} ${threadSql} ${opts.filterSql ?? Prisma.empty}
      GROUP BY ne.node_id
      ORDER BY distance ASC
      LIMIT ${k}`;
    // Exact ranking, but a LIMITed prefix: exhausted only when it came back
    // short (#1674 review, Jane P2-3). A caller post-filtering the page widens
    // k and re-asks.
    opts.onWindow?.({ exhausted: rows.length < k });
    return rows.map((r) => ({ nodeId: r.node_id, score: 1 - Number(r.distance) }));
  }
  // CONTENT excludes comments INSIDE the candidate scan, before any limit
  // (#1674 review, Jane P2-2): a comment vector can never take a candidate
  // slot from eligible content. ALL ranks everything except stub comments.
  const scopeSql = opts.scope === 'CONTENT' ? Prisma.sql`AND n.node_type <> 'comment'` : Prisma.empty;
  // #2772: with the structured filters in the query the filter owns the deleted predicate (an includeDeleted
  // search keeps recoverable tombstones); without them a soft-deleted node is never a hit.
  const deletedSql = opts.filterSql ? Prisma.empty : Prisma.sql`AND n.deleted_at IS NULL`;
  // ONE eligibility fragment serves the iterative scan, the independent count and the exact scan (#3054), so the
  // three can never disagree on scope. The structured filters and the access scope (`memoryIds`) ride in it,
  // before any offset/limit picks the page (#2772, cor:api:090:04).
  const eligibleFrom = Prisma.sql`FROM node_embeddings ne
      JOIN nodes n ON n.id = ne.node_id AND n.memory_id = ne.memory_id ${deletedSql} ${scopeSql}
      WHERE ne.memory_id IN (${Prisma.join(opts.memoryIds)}) ${NOT_A_STUB} ${candidateSql} ${abstractSql} ${threadSql} ${opts.filterSql ?? Prisma.empty}`;
  type NodeRow = { node_id: string; distance: number };
  const distinctNodes = (rows: NodeRow[]) => new Set(rows.map((r) => r.node_id)).size;
  const ranked = await rankUnderBudget<NodeRow>(db, {
    need: k,
    k0: Math.max(k, k * (opts.candidateFactor ?? 10)),
    distinctCount: distinctNodes,
    // Raw vectors in distance order; a node's best vector is its first appearance, so the first `k` distinct nodes
    // are exact once `k` of them are present.
    ann: (tx, kk) => tx.$queryRaw<NodeRow[]>`
      SELECT ne.node_id, ne.embedding <=> ${qvec}::vector AS distance
      ${eligibleFrom}
      ORDER BY ne.embedding <=> ${qvec}::vector
      LIMIT ${kk}`,
    // A MATERIALIZED CTE has no ORDER BY, so the HNSW index cannot serve it on any plan: every eligible row is
    // ranked, at any size (no row bound), under the work budget.
    exact: (tx) => tx.$queryRaw<NodeRow[]>`
      WITH cand AS MATERIALIZED (
        SELECT ne.node_id, ne.embedding <=> ${qvec}::vector AS distance
        ${eligibleFrom}
      )
      SELECT node_id, MIN(distance) AS distance FROM cand GROUP BY node_id ORDER BY distance ASC, node_id ASC LIMIT ${k}`,
    count: async (tx) => Number((await tx.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n ${eligibleFrom}`)[0]?.n ?? 0),
  });
  const best = new Map<string, number>();
  for (const r of ranked.rows) if (!best.has(r.node_id)) best.set(r.node_id, Number(r.distance));
  const hits = [...best].slice(0, k).map(([nodeId, d]) => ({ nodeId, score: 1 - d }));
  opts.onWindow?.({ exhausted: ranked.exhausted, stoppedEarly: ranked.stopped });
  return hits;
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
    hasOpenThreads?: boolean | null;
    syntheticCommentMemoryIds?: string[];
    /** #1345 / #2772 — see vectorSearchNodes. */
    onWindow?: (w: { exhausted: boolean; stoppedEarly?: boolean }) => void;
    /** #2772 — see vectorSearchNodes. */
    filterSql?: Prisma.Sql;
    /** #1608 — content, comments or both; COMMENTS ranks exactly. Absent = ALL. */
    scope?: 'CONTENT' | 'COMMENTS' | 'ALL';
  },
): Promise<ChunkHit[]> {
  if (opts.memoryIds.length === 0) {
    opts.onWindow?.({ exhausted: true });
    return [];
  }
  const threadSql = openThreadsVectorSql(opts.hasOpenThreads, opts.syntheticCommentMemoryIds);
  const qvec = toVectorLiteral(opts.queryEmbedding);
  const k = opts.limit;
  if (opts.scope === 'COMMENTS') {
    const rows = await db.$queryRaw<{ node_id: string; chunk_index: number; char_start: number; char_end: number; chunk_text: string; distance: number }[]>`
      SELECT ne.node_id, ne.chunk_index, ne.char_start, ne.char_end, ne.chunk_text,
             ne.embedding <=> ${qvec}::vector AS distance
      FROM node_embeddings ne
      JOIN nodes n ON n.id = ne.node_id AND n.memory_id = ne.memory_id AND n.deleted_at IS NULL AND n.node_type = 'comment'
      WHERE ne.memory_id IN (${Prisma.join(opts.memoryIds)}) AND ne.kind = 'chunk' ${NOT_A_STUB} ${threadSql} ${opts.filterSql ?? Prisma.empty}
      ORDER BY distance ASC
      LIMIT ${k}`;
    opts.onWindow?.({ exhausted: rows.length < k });
    return rows.map((r) => ({
      nodeId: r.node_id, chunkIndex: Number(r.chunk_index), charStart: Number(r.char_start),
      charEnd: Number(r.char_end), chunkText: r.chunk_text, score: 1 - Number(r.distance),
    }));
  }
  const chunkScopeSql = opts.scope === 'CONTENT' ? Prisma.sql`AND n.node_type <> 'comment'` : Prisma.empty;
  const deletedSql = opts.filterSql ? Prisma.empty : Prisma.sql`AND n.deleted_at IS NULL`;
  // #3054 / #2772: one eligibility fragment for the iterative scan, the count and the exact scan; the structured
  // filters and the access scope ride in it, before the page is chosen.
  const eligibleFrom = Prisma.sql`FROM node_embeddings ne
    JOIN nodes n ON n.id = ne.node_id AND n.memory_id = ne.memory_id ${deletedSql} ${chunkScopeSql}
    WHERE ne.memory_id IN (${Prisma.join(opts.memoryIds)}) AND ne.kind = 'chunk' ${NOT_A_STUB} ${threadSql} ${opts.filterSql ?? Prisma.empty}`;
  type ChunkRow = { node_id: string; chunk_index: number; char_start: number; char_end: number; chunk_text: string; distance: number };
  const ranked = await rankUnderBudget<ChunkRow>(db, {
    need: k,
    k0: k,
    distinctCount: (rows) => rows.length,
    ann: (tx, kk) => tx.$queryRaw<ChunkRow[]>`
      SELECT ne.node_id, ne.chunk_index, ne.char_start, ne.char_end, ne.chunk_text,
             ne.embedding <=> ${qvec}::vector AS distance
      ${eligibleFrom}
      ORDER BY ne.embedding <=> ${qvec}::vector
      LIMIT ${kk}`,
    exact: (tx) => tx.$queryRaw<ChunkRow[]>`
      WITH cand AS MATERIALIZED (
        SELECT ne.node_id, ne.chunk_index, ne.char_start, ne.char_end, ne.chunk_text,
               ne.embedding <=> ${qvec}::vector AS distance
        ${eligibleFrom}
      )
      SELECT * FROM cand ORDER BY distance ASC LIMIT ${k}`,
    count: async (tx) => Number((await tx.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n ${eligibleFrom}`)[0]?.n ?? 0),
  });
  opts.onWindow?.({ exhausted: ranked.exhausted, stoppedEarly: ranked.stopped });
  return ranked.rows.slice(0, k).map((r) => ({
    nodeId: r.node_id,
    chunkIndex: Number(r.chunk_index),
    charStart: Number(r.char_start),
    charEnd: Number(r.char_end),
    chunkText: r.chunk_text,
    score: 1 - Number(r.distance),
  }));
}
