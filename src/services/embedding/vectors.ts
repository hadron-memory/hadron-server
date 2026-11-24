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
 * #2772 — the work budget of ONE vector search (every statement of it gets what is left), in milliseconds (`SET LOCAL statement_timeout`), env
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

/** Extra time Prisma's transaction clock gets beyond the statement budget (setup round-trips, commit). */
export const VECTOR_TX_MARGIN_MS = 5000;
/** The longest one vector transaction waits for a pooled connection (never more than the budget left). */
export const VECTOR_TX_MAX_WAIT_MS = 2000;
/** The widest ANN `LIMIT` the iterative loop asks for; past it the exact statement ranks the page. */
export const VECTOR_ANN_MAX_K = 20000;
/**
 * BLIND P1 (#4665, ruling Ada): the widest `offset + limit` window one vector search ranks and returns to the app. Offset has no
 * ceiling and no new refusal; a window past this many rows is cut here and the search says `stopped_early`, so neither the
 * transfer, the hydration `IN` list nor the app-side sort grows with a caller's offset.
 */
export const VECTOR_WINDOW_ROWS_MAX = 20000;
let windowRowsMax = VECTOR_WINDOW_ROWS_MAX;
/** Test seam: lower the window cap (null restores it). */
export function setVectorWindowRowsMaxForTests(n: number | null): void { windowRowsMax = n ?? VECTOR_WINDOW_ROWS_MAX; }

/** Test seam: force the pgvector-version answer (null restores the real probe). */
export function setIterativeScanSupportForTests(v: boolean | null): void {
  iterativeScanOverride = v;
  iterativeScanProbe = null;
}

const PROBE_SQL = Prisma.sql`SELECT extversion FROM pg_extension WHERE extname = 'vector'`;
let probeSql: Prisma.Sql = PROBE_SQL;
/** Test seam (#4938, BLIND P2 at 548c0cb9): replace the probe's statement, e.g. with one that raises a SQL error (null restores it). */
export function setIterativeScanProbeSqlForTests(sql: Prisma.Sql | null): void {
  probeSql = sql ?? PROBE_SQL;
  iterativeScanProbe = null;
}

/**
 * #2772 — does this database's pgvector support the iterative index scan? Read once per process from
 * `pg_extension`; on an older version (or a failed read) it logs ONE `vector.iterative_scan_unsupported` line and
 * the search uses the exact scan instead, still under the work budget. This never refuses to start anything.
 */
export function iterativeScanSupported(
  db: Pick<PrismaClient, '$queryRaw' | '$executeRaw'> | Prisma.TransactionClient,
  opts: { inTransaction?: boolean } = {},
): Promise<boolean> {
  if (iterativeScanOverride != null) {
    if (!iterativeScanOverride) logIterativeUnsupported('stubbed');
    return Promise.resolve(iterativeScanOverride);
  }
  iterativeScanProbe ??= (async () => {
    let version: string | null;
    // #4938 BLIND P2 (Billie, at 548c0cb9): inside a transaction a failed statement aborts it (25P02), so the caught
    // failure below would still refuse every statement after it. A SAVEPOINT around the probe lets the catch roll back to
    // it and leave the caller's transaction usable for the exact scan. Only a cold probe pays for it: a cached answer
    // never reaches this closure.
    const inTx = opts.inTransaction === true;
    try {
      if (inTx) await db.$executeRaw`SAVEPOINT vector_version_probe`;
      const rows = await db.$queryRaw<{ extversion: string }[]>(probeSql);
      if (inTx) await db.$executeRaw`RELEASE SAVEPOINT vector_version_probe`;
      version = rows[0]?.extversion ?? null;
    } catch {
      if (inTx) {
        // A rollback that fails too (the connection is gone, or the transaction's own clock ended it) leaves the
        // transaction unusable: the caller's next statement then fails loudly with the real cause. Never throw from here:
        // this probe's promise is shared, and another request awaiting it must not inherit this transaction's failure.
        try { await db.$executeRaw`ROLLBACK TO SAVEPOINT vector_version_probe`; } catch { /* surfaced by the next statement */ }
      }
      // A failed read says nothing about the version (the database may not be reachable yet at boot): do NOT
      // remember it, so the next search probes again instead of running every query exact until restart.
      iterativeScanProbe = null;
      console.error('vector.iterative_scan_probe_failed — using the exact scan for this call; the probe is retried on the next');
      return false;
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

/**
 * A cancelled statement (SQLSTATE 57014) is the early stop of cor:api:090:04, never an error to the caller.
 *
 * `phase` (#4779, Bridget P3-2 on #4665) says where a P2028 came from, so the classification no longer rests on Prisma's
 * message text: `'waiting'` = the transaction never started (its callback never ran), so `maxWait` ran out acquiring a
 * connection, which is pool pressure and must reach error alerting; `'running'` = the callback was running, so Prisma's own
 * interactive-transaction clock expired, which is the search running out of time. Without a phase the message decides, as before.
 */
export function isStatementTimeout(e: unknown, phase?: 'waiting' | 'running'): boolean {
  const err = e as { code?: string; meta?: { code?: string; message?: string }; message?: string } | null;
  const text = `${err?.message ?? ''} ${err?.meta?.message ?? ''}`;
  // A cancel by the user or an administrator (shutdown, pg_cancel_backend) is not the work budget running out.
  if (/user request/i.test(text)) return false;
  // P2028: Prisma's own interactive-transaction clock expired. It is margined past the budget below, but if it
  // still wins the race the search ran out of time all the same.
  // BLIND P2 (#4665, Abigail): P2028 is ALSO what Prisma raises when `maxWait` runs out acquiring a connection ("Unable to
  // start a transaction in the given time"), which is pool pressure, not the work budget: it must reach error alerting.
  if (err?.code === 'P2028') return phase ? phase === 'running' : !/unable to start a transaction/i.test(text);
  return err?.meta?.code === '57014' || /statement timeout/i.test(text);
}

/**
 * Clock slack for "the request deadline has passed" when Prisma reports the connection-wait timeout (BLIND F5): Prisma
 * fires that timeout on its own timer, which can run a few milliseconds ahead of ours, so a wait that ended AT the deadline
 * must not read as one that ended before it.
 */
const DEADLINE_CLOCK_SLACK_MS = 25;

/**
 * #4779 (BLIND P2-1, Elena) — the early-stop test for one budgeted vector transaction. Besides {@link isStatementTimeout}:
 * a P2028 raised while still WAITING for a connection is the early stop, not a pool error, when the wait was cut short by
 * the request's deadline (`txMs` below the ordinary `VECTOR_TX_MAX_WAIT_MS`): the budget ran out while queued, which is
 * the work budget ending the search (cor:api:090:04), not the pool failing. A wait that had its full `maxWait` and still
 * timed out stays an error that reaches alerting.
 */
function isVectorEarlyStop(e: unknown, phase: 'waiting' | 'running', txMs: number, deadline: number, cappedByRequest: boolean): boolean {
  if (isStatementTimeout(e, phase)) return true;
  const err = e as { code?: string; message?: string; meta?: { message?: string } } | null;
  // BLIND N2 (Elena): only Prisma's connection-wait timeout (not any Transaction API error), only when the wait was
  // capped by the request's deadline (not the ordinary maxWait), and only when that deadline has in fact passed.
  const stop = err?.code === 'P2028'
    // #4938: `phase === 'waiting'` is implied, not pinned: a P2028 in phase 'running' already returned true through
    // isStatementTimeout(e, 'running') above, so this term changes no outcome (the gate's equivalence proof).
    && phase === 'waiting'
    && /unable to start a transaction/i.test(`${err.message ?? ''} ${err.meta?.message ?? ''}`)
    // BLIND F6 (Elena): the REQUEST deadline (`deadlineAt`) must be what bound the wait, not merely a budget below the
    // ordinary maxWait (a small VECTOR_SEARCH_TIMEOUT_MS with no request deadline is still pool pressure).
    && cappedByRequest && txMs < VECTOR_TX_MAX_WAIT_MS && Date.now() >= deadline - DEADLINE_CLOCK_SLACK_MS;
  if (stop) notePoolWaitEarlyStop();
  return stop;
}

/**
 * #4938 F5 (Elena, BLIND on #4928 at 5ad0665b) — a pool wait the request deadline cut short is the early stop, so it never
 * reaches error alerting; when that happens on every request (a saturated pool, or a budget below `VECTOR_TX_MAX_WAIT_MS`)
 * pool pressure would be silent. Count every such stop and log one fixed line, at most once a minute, carrying the count
 * since the last line: visible to log alerting, never one line per request.
 */
let poolWaitEarlyStops = 0;
let poolWaitLoggedAt = 0;
export const POOL_WAIT_LOG_INTERVAL_MS = 60_000;
function notePoolWaitEarlyStop(): void {
  poolWaitEarlyStops++;
  const now = Date.now();
  if (now - poolWaitLoggedAt < POOL_WAIT_LOG_INTERVAL_MS) return;
  poolWaitLoggedAt = now;
  console.warn(`vector.pool_wait_early_stop count=${poolWaitEarlyStops} — vector searches stopped early while waiting for a pooled connection (the request deadline ended the wait)`);
  poolWaitEarlyStops = 0;
}
/** Test seam: re-arm the once-a-minute line and zero its count. */
export function resetPoolWaitEarlyStopLogForTests(): void { poolWaitEarlyStops = 0; poolWaitLoggedAt = 0; }

/** Prisma options for one budgeted vector transaction: its clock runs past the budget so Postgres ends the statement first. */
function vectorTxOptions(budgetMs: number): { timeout: number; maxWait: number } {
  // Prisma's interactive-transaction clock defaults to 5 s, the same as the default budget, and the SET LOCAL
  // round-trips already spend part of it: give it room past the statement budget so Postgres ends the statement.
  return { timeout: budgetMs + VECTOR_TX_MARGIN_MS, maxWait: Math.min(budgetMs, VECTOR_TX_MAX_WAIT_MS) };
}

/**
 * Point the transaction's settings at the NEXT statement: `SET LOCAL` statement_timeout (what is left of the request's
 * budget, measured now, after the connection was acquired, so pool wait is never handed to a statement a second time,
 * BLIND P2 #4665) and the per-iteration HNSW horizon. All of it dies with the transaction and never reaches a pooled
 * connection's session. Re-issued before every statement of the one shared transaction (#4779 P2-2).
 */
async function setVectorStatement(tx: Prisma.TransactionClient, stmtMs: number, candidateK: number): Promise<void> {
  await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = ${stmtMs}`);
  await tx.$executeRawUnsafe(`SET LOCAL hnsw.ef_search = ${hnswEfSearchFor(candidateK)}`);
}

/** pgvector >= 0.8.0: the strict-order iterative scan, ended by the work budget rather than a tuple count. Once per transaction. */
async function setIterativeScan(tx: Prisma.TransactionClient): Promise<void> {
  await tx.$executeRawUnsafe(`SET LOCAL hnsw.iterative_scan = strict_order`);
  await tx.$executeRawUnsafe(`SET LOCAL hnsw.max_scan_tuples = 2147483647`);
}

/**
 * The request-wide budget clock: every statement gets what is LEFT of ONE budget, so the env variable bounds the search,
 * not each statement of a loop. Past the deadline it throws the statement-timeout shape, which is the early stop.
 *
 * #4779 (BLIND P2-2, Bianca): `deadlineAt` (epoch ms) is the REQUEST's deadline when one request makes several vector
 * calls (a hybrid page's vector leg, its rank lookups and a re-ranking all share it, set once by the resolver); a call
 * never gets more than what is left of it, so one budget bounds the whole request, not each call.
 */
function budgetClock(budgetMs: number, deadlineAt?: number): { left: () => number; txMs: number; deadline: number; cappedByRequest: boolean } {
  const own = Date.now() + budgetMs;
  const deadline = deadlineAt == null ? own : Math.min(own, deadlineAt);
  const cappedByRequest = deadlineAt != null && deadlineAt < own;
  const left = () => {
    const ms = deadline - Date.now();
    if (ms < 1) throw Object.assign(new Error('canceling statement due to statement timeout'), { meta: { code: '57014' } });
    return Math.trunc(ms);
  };
  return { left, txMs: Math.max(1, Math.trunc(deadline - Date.now())), deadline, cappedByRequest };
}

/**
 * #4779 (P3-6, Byron on #4665) — one vector statement that is not ranked through {@link rankUnderBudget} (the COMMENTS
 * scope's exact statements) under the same work budget, in one transaction. A timeout is the early stop: `stopped`.
 */
async function oneStatementUnderBudget<R>(
  db: PrismaClient, query: (tx: Prisma.TransactionClient) => Promise<R[]>, deadlineAt?: number,
): Promise<{ rows: R[]; stopped: boolean }> {
  let phase: 'waiting' | 'running' = 'waiting';
  let txMs = Number.POSITIVE_INFINITY;
  let deadline = Number.POSITIVE_INFINITY;
  let cappedByRequest = false;
  try {
    const clock = budgetClock(vectorSearchTimeoutMs(), deadlineAt);
    const left = clock.left;
    txMs = clock.txMs;
    deadline = clock.deadline;
    cappedByRequest = clock.cappedByRequest;
    left(); // a request whose deadline already passed stops here, before taking a connection
    const rows = await db.$transaction(async (tx) => {
      phase = 'running';
      await setVectorStatement(tx, left(), 40);
      return query(tx);
    }, vectorTxOptions(txMs));
    return { rows, stopped: false };
  } catch (e) {
    if (!isVectorEarlyStop(e, phase, txMs, deadline, cappedByRequest)) throw e;
    return { rows: [], stopped: true };
  }
}

let smallScopeRows = 20000;
/**
 * A scope whose OWN eligible vectors number at most this many is ranked EXACTLY, never through the global HNSW walk.
 * The walk visits every tenant's vectors (the index is global; `memory_id` is filtered on visited tuples), so for a small
 * scope its cost, and whether it finishes inside the budget, would depend on how much OTHER tenants' content sits near the
 * query vector: an oracle the caller must not have, and a way for a small tenant's search to come back empty. The exact
 * statement's cost is a function of the caller's own eligible rows only. Bounded by the capped count below.
 */
export function vectorSmallScopeRows(): number { return smallScopeRows; }
/** Test seam: move the small-scope threshold (null restores the default). */
export function setVectorSmallScopeRowsForTests(n: number | null): void { smallScopeRows = n ?? 20000; }

let annMaxK = VECTOR_ANN_MAX_K;
/** Test seam (#4779, Riana P3-5 on #4665): lower the ANN widening ceiling so its numeric boundary can be pinned (null restores it). */
export function setVectorAnnMaxKForTests(n: number | null): void { annMaxK = n ?? VECTOR_ANN_MAX_K; }

/**
 * #2772 — rank under the ruling-0150 contract: NO candidate cap. The iterative index scan walks the HNSW index
 * until the filtered, access-scoped statement has `need` rows; when it ends short, an independent count of the
 * eligible vectors says whether that is the whole set, and if not the same eligibility runs EXACTLY, at any size.
 * Anything that cannot finish inside the work budget stops EARLY and says so (`stopped`). The rows returned then
 * are what the index had ranked when it stopped: HNSW is approximate even under strict_order, so they are NOT promised to
 * be a prefix of the true ranking (a different page is possible), and a full ANN page past the index's order window is
 * discarded rather than returned. They are never presented as a complete page.
 *
 * #4779:
 * - P2-2: the count, every widening and the exact statement share ONE interactive transaction (one pooled connection,
 *   one `maxWait`), with `statement_timeout` re-issued before each statement as what is left of the one budget. A search
 *   used to open up to ~7 transactions in sequence, each a fresh chance to time out waiting for the pool (P2028, an
 *   internal error by design). A pool wait is still an error, told apart by phase (`isStatementTimeout`).
 * - P3-3: ANN rows are put in the exact statement's total order (`tieOrder`: distance, then the row's stable key), and a
 *   page is taken from the walk only when no tie at the page's last distance can continue past the rows the walk
 *   returned (`distanceOf` of the last raw row is beyond it). Otherwise the walk widens, so pages never repeat or skip
 *   rows among equal distances.
 *
 * Callers use {@link vectorSearchNodes} / {@link vectorSearchChunks}.
 */
async function rankUnderBudget<R>(
  db: PrismaClient,
  o: {
    need: number;
    k0: number;
    distinctCount: (rows: R[]) => number;
    ann: (tx: Prisma.TransactionClient, k: number) => Promise<R[]>;
    exact: (tx: Prisma.TransactionClient) => Promise<R[]>;
    /** The caller's own eligible vectors, counted up to `cap` (never more than `cap` rows are visited). */
    count: (tx: Prisma.TransactionClient, cap: number) => Promise<number>;
    /** The exact statement's ORDER BY, applied to the walk's rows (P3-3). */
    tieOrder: (a: R, b: R) => number;
    distanceOf: (r: R) => number;
    /** The distance of the `need`-th distinct result in rows already in `tieOrder` (undefined when fewer). */
    pageEdge: (sorted: R[], need: number) => number | undefined;
    /** #4779 (BLIND P2-2): the request's deadline (see budgetClock). */
    deadlineAt?: number;
  },
): Promise<{ rows: R[]; exhausted: boolean; stopped: boolean }> {
  let best: R[] = [];
  let phase: 'waiting' | 'running' = 'waiting';
  let txMs = Number.POSITIVE_INFINITY;
  let deadline = Number.POSITIVE_INFINITY;
  let cappedByRequest = false;
  try {
    const clock = budgetClock(vectorSearchTimeoutMs(), o.deadlineAt);
    const left = clock.left;
    txMs = clock.txMs;
    deadline = clock.deadline;
    cappedByRequest = clock.cappedByRequest;
    left(); // a request whose deadline already passed stops here, before taking a connection (or probing)
    return await db.$transaction(async (tx) => {
      phase = 'running';
      // #4938 N2 (Celine, QA on #4928): the version probe runs INSIDE the budgeted transaction, first, so its wait for a
      // connection is this transaction's deadline-capped `maxWait`. Outside it, a cold probe (a fresh process, or a failed
      // one, which is not cached) waited Prisma's `pool_timeout` (10 s by default) on a saturated pool, whatever the deadline.
      // It runs before any SET LOCAL: with no statement_timeout of its own it cannot be cut mid-transaction (a failed
      // statement would abort the transaction under every statement after it); the transaction's own clock bounds it.
      const iterative = await iterativeScanSupported(tx, { inTransaction: true });
      if (iterative) {
        // Set once for the shared transaction, so it is also in force for the exact statement below (BLIND F7): harmless,
        // since that statement ranks a MATERIALIZED CTE with no ORDER BY the HNSW index could serve.
        await setIterativeScan(tx);
        // The caller's OWN eligible set, counted up to the small-scope bound (cost bounded by that bound, not by the
        // index). A small scope never walks the global HNSW index (see vectorSmallScopeRows); a large one does.
        const cap = vectorSmallScopeRows();
        await setVectorStatement(tx, left(), 40);
        const eligible = await o.count(tx, cap + 1);
        // A page deeper than the index's widest horizon (VECTOR_INDEX_ORDER_WINDOW) can never be served by the walk: the order of
        // a full page past it is the index's approximate order, so ruling 0150's true page is ranked exactly. Walking the index
        // first would only be thrown away (BLIND round 3 P2-1), so such a page goes straight to the exact statement.
        if (eligible > cap && o.need <= VECTOR_INDEX_ORDER_WINDOW) {
          let k = Math.max(o.k0, 1);
          for (;;) {
            // A hard ceiling on the widening: past it the exact statement decides.
            if (k > annMaxK) break;
            await setVectorStatement(tx, left(), k);
            const raw = await o.ann(tx, k);
            const rows = raw.slice().sort(o.tieOrder);
            best = rows;
            if (o.distinctCount(rows) >= o.need) {
              const edge = o.pageEdge(rows, o.need);
              const last = raw.length ? o.distanceOf(raw[raw.length - 1]!) : undefined;
              // The walk ended short (it returned everything) or its last row lies beyond the page's last distance: no
              // tie at that distance can be missing, so the page is in total order.
              if (raw.length < k || edge === undefined || last === undefined || last > edge) {
                return { rows, exhausted: false, stopped: false };
              }
            } else if (raw.length < k) break; // the walk ended short of the set: the exact statement decides
            k *= 4;
          }
        }
      }
      await setVectorStatement(tx, left(), 40);
      best = await o.exact(tx);
      return { rows: best, exhausted: o.distinctCount(best) < o.need, stopped: false };
    }, vectorTxOptions(txMs));
  } catch (e) {
    if (!isVectorEarlyStop(e, phase, txMs, deadline, cappedByRequest)) throw e;
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

/**
 * #4779 (P3-6, Byron on #4665) — the deleted rule of the COMMENTS scope. It is the shared filter's own tombstone rule, not a
 * divergence from it: that rule admits a tombstone only where `node_type <> 'comment'` (postgres.ts `tombstoneMemoryIds`;
 * cor:dmo:110), so for every comment row it reduces to `deleted_at IS NULL`. It stays in the statement, beside the shared
 * filter, because the filter fragment does not always carry the rule: an `includeDeleted` search with no tombstone list
 * compiles NO deleted predicate (`vectorFilterSql`), and a deleted comment must never be a hit whatever the caller asked.
 */
const COMMENT_NOT_DELETED = Prisma.sql`AND n.deleted_at IS NULL`;

export interface VectorHit {
  nodeId: string;
  score: number; // cosine similarity in [0,1]-ish (1 - distance)
}

/** The eligibility inputs of a node-level vector ranking (shared by {@link vectorSearchNodes} and {@link vectorRanksOf}). */
export interface NodeVectorScope {
  memoryIds: string[];
  queryEmbedding: number[];
  hasOpenThreads?: boolean | null;
  syntheticCommentMemoryIds?: string[];
  /** #2421: constrain summary search before ANN ranking. */
  abstractOnly?: boolean;
  candidateNodeIds?: string[];
  /** #2772 — the structured filters, the caller's exclusions and the deleted rule, as a `AND ne.node_id IN (…)` fragment inside the ranking statement. */
  filterSql?: Prisma.Sql;
  /** #1608 — content, comments or both (see vectorSearchNodes). Absent = ALL (no restriction). */
  scope?: 'CONTENT' | 'COMMENTS' | 'ALL';
  /** #4779 (BLIND P2-2): the request's one deadline, epoch ms (see budgetClock). Absent = this call's own budget. */
  deadlineAt?: number;
}

/**
 * ONE eligibility fragment (`FROM … WHERE …` over `node_embeddings ne` joined to `nodes n`) per scope, so the walk, the
 * count, the exact statement, the COMMENTS statement and the #4779 rank lookup can never disagree on what is eligible
 * (#3054). The structured filters and the access scope ride in it, before any offset/limit picks the page (#2772,
 * cor:api:090:04).
 */
function nodeVectorEligibility(opts: NodeVectorScope): Prisma.Sql {
  const candidateSql = opts.candidateNodeIds == null ? Prisma.empty : opts.candidateNodeIds.length
    ? Prisma.sql`AND ne.node_id IN (${Prisma.join(opts.candidateNodeIds)})` : Prisma.sql`AND FALSE`;
  const abstractSql = opts.abstractOnly ? Prisma.sql`AND ne.kind = 'abstract'` : Prisma.empty;
  const threadSql = openThreadsVectorSql(opts.hasOpenThreads, opts.syntheticCommentMemoryIds);
  const tail = Prisma.sql`WHERE ne.memory_id IN (${Prisma.join(opts.memoryIds)}) ${NOT_A_STUB} ${candidateSql} ${abstractSql} ${threadSql} ${opts.filterSql ?? Prisma.empty}`;
  if (opts.scope === 'COMMENTS') {
    return Prisma.sql`FROM node_embeddings ne
      JOIN nodes n ON n.id = ne.node_id AND n.memory_id = ne.memory_id ${COMMENT_NOT_DELETED} AND n.node_type = 'comment'
      ${tail}`;
  }
  // #2772: with the structured filters in the query the filter owns the deleted predicate (an includeDeleted
  // search keeps recoverable tombstones); without them a soft-deleted node is never a hit.
  const deletedSql = opts.filterSql ? Prisma.empty : Prisma.sql`AND n.deleted_at IS NULL`;
  // CONTENT excludes comments INSIDE the candidate scan, before any limit
  // (#1674 review, Jane P2-2): a comment vector can never take a candidate
  // slot from eligible content. ALL ranks everything except stub comments.
  const scopeSql = opts.scope === 'CONTENT' ? Prisma.sql`AND n.node_type <> 'comment'` : Prisma.empty;
  return Prisma.sql`FROM node_embeddings ne
      JOIN nodes n ON n.id = ne.node_id AND n.memory_id = ne.memory_id ${deletedSql} ${scopeSql}
      ${tail}`;
}

/**
 * #4779 (P3-4, Vera's FIT condition 4c; certified fusion accepted in team chat #140476) — the EXACT node-level vector rank
 * of each named node: its 1-based position in the order {@link vectorSearchNodes}' exact statement uses (best distance,
 * then node id) over the SAME eligibility. Hybrid search asks it for keyword hits the vector page did not reach, so their
 * vector RRF term is known rather than bounded and the fused page can be certified. A node with no eligible vector is
 * absent from the map (its vector term is exactly zero). One statement under the work budget; a timeout is `stopped`.
 * Its cost is one exact ranking of the scope, the same as the deep-page exact statement.
 */
export async function vectorRanksOf(
  db: PrismaClient, opts: NodeVectorScope & { nodeIds: string[] },
): Promise<{ ranks: Map<string, number>; stopped: boolean }> {
  if (opts.memoryIds.length === 0 || opts.nodeIds.length === 0) return { ranks: new Map(), stopped: false };
  const qvec = toVectorLiteral(opts.queryEmbedding);
  const { rows, stopped } = await oneStatementUnderBudget(db, (tx) => tx.$queryRaw<{ node_id: string; rank: number }[]>`
    WITH best AS MATERIALIZED (
      SELECT ne.node_id, MIN(ne.embedding <=> ${qvec}::vector) AS distance
      ${nodeVectorEligibility(opts)}
      GROUP BY ne.node_id
    )
    SELECT node_id, rank FROM (
      SELECT node_id, ROW_NUMBER() OVER (ORDER BY distance ASC, node_id ASC)::int AS rank FROM best
    ) ranked
    WHERE node_id IN (${Prisma.join(opts.nodeIds)})`, opts.deadlineAt);
  return { ranks: new Map(rows.map((r) => [r.node_id, Number(r.rank)])), stopped };
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
  opts: NodeVectorScope & {
    limit: number;
    candidateFactor?: number;
    /** #1345 / #2772 — told whether the ranking is provably complete, and whether the search stopped early (work budget). */
    onWindow?: (w: { exhausted: boolean; stoppedEarly?: boolean }) => void;
  },
): Promise<VectorHit[]> {
  if (opts.memoryIds.length === 0) {
    opts.onWindow?.({ exhausted: true });
    return [];
  }
  const eligibleFrom = nodeVectorEligibility(opts);
  const qvec = toVectorLiteral(opts.queryEmbedding);
  const windowCut = opts.limit > windowRowsMax;
  const k = Math.min(opts.limit, windowRowsMax);
  // #4779 (Bridget P3-2 on #4665): when the window cuts the request, ONE row past it is ranked, so a result of exactly
  // `k` rows (complete) is told apart from a cut one (a row beyond the window exists) instead of both reading as cut.
  const kAsk = windowCut ? k + 1 : k;
  if (opts.scope === 'COMMENTS') {
    // #4779 (P3-6, Byron on #4665): under the work budget like every other vector statement; a timeout is the early stop.
    const { rows, stopped } = await oneStatementUnderBudget(db, (tx) => tx.$queryRaw<{ node_id: string; distance: number }[]>`
      SELECT ne.node_id, MIN(ne.embedding <=> ${qvec}::vector) AS distance
      ${eligibleFrom}
      GROUP BY ne.node_id
      ORDER BY distance ASC, ne.node_id ASC
      LIMIT ${kAsk}`, opts.deadlineAt);
    // Exact ranking, but a LIMITed prefix: exhausted only when it came back
    // short (#1674 review, Jane P2-3). A caller post-filtering the page widens
    // k and re-asks.
    const cut = windowCut && rows.length > k;
    opts.onWindow?.({ exhausted: !stopped && !cut && rows.length < kAsk, stoppedEarly: stopped || cut });
    return rows.slice(0, k).map((r) => ({ nodeId: r.node_id, score: 1 - Number(r.distance) }));
  }
  type NodeRow = { node_id: string; distance: number };
  const distinctNodes = (rows: NodeRow[]) => new Set(rows.map((r) => r.node_id)).size;
  const ranked = await rankUnderBudget<NodeRow>(db, {
    deadlineAt: opts.deadlineAt,
    need: kAsk,
    k0: Math.max(kAsk, kAsk * (opts.candidateFactor ?? 10)),
    distinctCount: distinctNodes,
    // Must match the exact statement's `ORDER BY distance ASC, node_id ASC` below (BLIND P3-7: keep the two in step).
    tieOrder: (a, b) => Number(a.distance) - Number(b.distance) || (a.node_id < b.node_id ? -1 : a.node_id > b.node_id ? 1 : 0),
    distanceOf: (r) => Number(r.distance),
    // A node's best vector is its first appearance in total order: the `need`-th distinct node's distance.
    pageEdge: (sorted, need) => {
      const seen = new Set<string>();
      for (const r of sorted) { if (!seen.has(r.node_id)) { seen.add(r.node_id); if (seen.size === need) return Number(r.distance); } }
      return undefined;
    },
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
      SELECT node_id, MIN(distance) AS distance FROM cand GROUP BY node_id ORDER BY distance ASC, node_id ASC LIMIT ${kAsk}`,
    count: async (tx, cap) => Number((await tx.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM (SELECT 1 ${eligibleFrom} LIMIT ${cap}) capped`)[0]?.n ?? 0),
  });
  const best = new Map<string, number>();
  for (const r of ranked.rows) if (!best.has(r.node_id)) best.set(r.node_id, Number(r.distance));
  const cutLost = windowCut && best.size > k; // the window is only a loss when a row past it exists (#4779)
  const hits = [...best].slice(0, k).map(([nodeId, d]) => ({ nodeId, score: 1 - d }));
  opts.onWindow?.({ exhausted: !cutLost && ranked.exhausted, stoppedEarly: ranked.stopped || cutLost });
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

/** The chunk path's scope: the parts of {@link vectorSearchChunks}' options its eligibility reads. */
export interface ChunkVectorScope {
  memoryIds: string[];
  hasOpenThreads?: boolean | null;
  syntheticCommentMemoryIds?: string[];
  /** #2772 — the structured filters, the caller's exclusions and the deleted rule (see NodeVectorScope.filterSql). */
  filterSql?: Prisma.Sql;
  /** #1608 — content, comments or both. Absent = ALL. */
  scope?: 'CONTENT' | 'COMMENTS' | 'ALL';
}

/**
 * #4938 F8 — ONE chunk eligibility fragment (`FROM … WHERE …` over `node_embeddings ne` joined to `nodes n`) per scope, the
 * chunk counterpart of {@link nodeVectorEligibility}: the COMMENTS statement and the content walk, count and exact
 * statement all read it, so the two scopes cannot drift apart on the stub rule, the open-thread filter, the access scope or
 * the caller's filter (#3054's warning). It differs per scope only where the scope does:
 * - COMMENTS: comment rows, with {@link COMMENT_NOT_DELETED} whatever the filter says (a deleted comment never ranks);
 * - CONTENT / ALL: the filter owns the deleted predicate when there is one (an includeDeleted search keeps recoverable
 *   tombstones), and CONTENT excludes comments inside the scan, before any limit.
 */
export function chunkVectorEligibility(opts: ChunkVectorScope): Prisma.Sql {
  const threadSql = openThreadsVectorSql(opts.hasOpenThreads, opts.syntheticCommentMemoryIds);
  const tail = Prisma.sql`WHERE ne.memory_id IN (${Prisma.join(opts.memoryIds)}) AND ne.kind = 'chunk' ${NOT_A_STUB} ${threadSql} ${opts.filterSql ?? Prisma.empty}`;
  if (opts.scope === 'COMMENTS') {
    return Prisma.sql`FROM node_embeddings ne
      JOIN nodes n ON n.id = ne.node_id AND n.memory_id = ne.memory_id ${COMMENT_NOT_DELETED} AND n.node_type = 'comment'
      ${tail}`;
  }
  const deletedSql = opts.filterSql ? Prisma.empty : Prisma.sql`AND n.deleted_at IS NULL`;
  const scopeSql = opts.scope === 'CONTENT' ? Prisma.sql`AND n.node_type <> 'comment'` : Prisma.empty;
  return Prisma.sql`FROM node_embeddings ne
    JOIN nodes n ON n.id = ne.node_id AND n.memory_id = ne.memory_id ${deletedSql} ${scopeSql}
    ${tail}`;
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
    /** #4779 (BLIND P2-2): the request's one deadline (see budgetClock). */
    deadlineAt?: number;
  },
): Promise<ChunkHit[]> {
  if (opts.memoryIds.length === 0) {
    opts.onWindow?.({ exhausted: true });
    return [];
  }
  const eligibleFrom = chunkVectorEligibility(opts);
  const qvec = toVectorLiteral(opts.queryEmbedding);
  const windowCut = opts.limit > windowRowsMax;
  const k = Math.min(opts.limit, windowRowsMax);
  const kAsk = windowCut ? k + 1 : k; // #4779: see vectorSearchNodes
  if (opts.scope === 'COMMENTS') {
    // #4779 (P3-6): budgeted, as in vectorSearchNodes; the deleted rule is COMMENT_NOT_DELETED.
    const { rows, stopped } = await oneStatementUnderBudget(db, (tx) => tx.$queryRaw<{ node_id: string; chunk_index: number; char_start: number; char_end: number; chunk_text: string; distance: number }[]>`
      SELECT ne.node_id, ne.chunk_index, ne.char_start, ne.char_end, ne.chunk_text,
             ne.embedding <=> ${qvec}::vector AS distance
      ${eligibleFrom}
      ORDER BY distance ASC, ne.node_id ASC, ne.chunk_index ASC
      LIMIT ${kAsk}`, opts.deadlineAt);
    const cut = windowCut && rows.length > k;
    opts.onWindow?.({ exhausted: !stopped && !cut && rows.length < kAsk, stoppedEarly: stopped || cut });
    return rows.slice(0, k).map((r) => ({
      nodeId: r.node_id, chunkIndex: Number(r.chunk_index), charStart: Number(r.char_start),
      charEnd: Number(r.char_end), chunkText: r.chunk_text, score: 1 - Number(r.distance),
    }));
  }
  type ChunkRow = { node_id: string; chunk_index: number; char_start: number; char_end: number; chunk_text: string; distance: number };
  const ranked = await rankUnderBudget<ChunkRow>(db, {
    deadlineAt: opts.deadlineAt,
    need: kAsk,
    k0: kAsk,
    distinctCount: (rows) => rows.length,
    // Must match the exact statement's `ORDER BY distance ASC, node_id ASC, chunk_index ASC` below (BLIND P3-7).
    tieOrder: (a, b) => Number(a.distance) - Number(b.distance)
      || (a.node_id < b.node_id ? -1 : a.node_id > b.node_id ? 1 : 0)
      || Number(a.chunk_index) - Number(b.chunk_index),
    distanceOf: (r) => Number(r.distance),
    pageEdge: (sorted, need) => (sorted.length >= need ? Number(sorted[need - 1]!.distance) : undefined),
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
      SELECT * FROM cand ORDER BY distance ASC, node_id ASC, chunk_index ASC LIMIT ${kAsk}`,
    count: async (tx, cap) => Number((await tx.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM (SELECT 1 ${eligibleFrom} LIMIT ${cap}) capped`)[0]?.n ?? 0),
  });
  const cutLost = windowCut && ranked.rows.length > k; // the window is only a loss when a row past it exists (#4779)
  opts.onWindow?.({ exhausted: !cutLost && ranked.exhausted, stoppedEarly: ranked.stopped || cutLost });
  return ranked.rows.slice(0, k).map((r) => ({
    nodeId: r.node_id,
    chunkIndex: Number(r.chunk_index),
    charStart: Number(r.char_start),
    charEnd: Number(r.char_end),
    chunkText: r.chunk_text,
    score: 1 - Number(r.distance),
  }));
}
