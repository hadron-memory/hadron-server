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
 * Replace a node's abstract vector (delete existing kind='abstract', insert one).
 *
 * Wrapped in a transaction so a failed INSERT (transient network, constraint,
 * etc.) rolls back the DELETE — otherwise the node would briefly carry no
 * abstract vector and reads would miss until the next successful sweep
 * (PR-219 review).
 */
export async function upsertAbstractVector(
  db: PrismaClient,
  row: AbstractVectorRow,
): Promise<void> {
  await db.$transaction(async (tx) => {
    await tx.$executeRaw`DELETE FROM node_embeddings WHERE node_id = ${row.nodeId} AND kind = 'abstract'`;
    await tx.$executeRaw`
      INSERT INTO node_embeddings (id, node_id, memory_id, kind, provider, model, dim, embedding, created_at)
      VALUES (${generateId()}, ${row.nodeId}, ${row.memoryId}, 'abstract', ${row.provider}, ${row.model}, ${row.dim}, ${toVectorLiteral(row.embedding)}::vector, now())
    `;
  });
}

/** Delete all of a node's vectors (re-index / disable / cleared abstract). */
export async function deleteNodeVectors(db: PrismaClient, nodeId: string): Promise<void> {
  await db.$executeRaw`DELETE FROM node_embeddings WHERE node_id = ${nodeId}`;
}

/** Delete just the chunk vectors for a node (kind='chunk'). Used when content cleared. */
export async function deleteNodeChunkVectors(db: PrismaClient, nodeId: string): Promise<void> {
  await db.$executeRaw`DELETE FROM node_embeddings WHERE node_id = ${nodeId} AND kind = 'chunk'`;
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
 * insert rolls back the delete (same posture as upsertAbstractVector).
 * Per FR-017, every content edit re-derives the full chunk set — there's
 * no per-chunk update path, just a clean rebuild.
 *
 * `rows` may be empty (content cleared); the delete still fires so any
 * prior chunks vanish.
 */
export async function upsertChunkVectors(
  db: PrismaClient,
  nodeId: string,
  rows: ChunkVectorRow[],
): Promise<void> {
  await db.$transaction(async (tx) => {
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
  });
}

/** Delete every vector for a memory (revoke / disable). */
export async function deleteMemoryVectors(db: PrismaClient, memoryId: string): Promise<void> {
  await db.$executeRaw`DELETE FROM node_embeddings WHERE memory_id = ${memoryId}`;
}

export interface VectorHit {
  nodeId: string;
  score: number; // cosine similarity in [0,1]-ish (1 - distance)
}

/**
 * Node-level vector search (D-R5/FR-022 default granularity). The ANN scan is
 * the index-using inner query (HNSW serves `ORDER BY <=> LIMIT`); we over-fetch
 * candidates, then dedupe to nodes (best vector per node) and drop soft-deleted.
 */
export async function vectorSearchNodes(
  db: PrismaClient,
  opts: {
    memoryIds: string[];
    queryEmbedding: number[];
    limit: number;
    candidateFactor?: number;
  },
): Promise<VectorHit[]> {
  if (opts.memoryIds.length === 0) return [];
  const qvec = toVectorLiteral(opts.queryEmbedding);
  const k = opts.limit;
  const candidateK = Math.max(k, k * (opts.candidateFactor ?? 10));
  const rows = await db.$queryRaw<{ node_id: string; distance: number }[]>`
    WITH ann AS (
      SELECT ne.node_id, ne.embedding <=> ${qvec}::vector AS distance
      FROM node_embeddings ne
      WHERE ne.memory_id IN (${Prisma.join(opts.memoryIds)})
      ORDER BY ne.embedding <=> ${qvec}::vector
      LIMIT ${candidateK}
    )
    SELECT a.node_id, MIN(a.distance) AS distance
    FROM ann a
    JOIN nodes n ON n.id = a.node_id AND n.deleted_at IS NULL
    GROUP BY a.node_id
    ORDER BY distance ASC
    LIMIT ${k}
  `;
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
  },
): Promise<ChunkHit[]> {
  if (opts.memoryIds.length === 0) return [];
  const qvec = toVectorLiteral(opts.queryEmbedding);
  const k = opts.limit;
  // Over-fetch to absorb soft-deleted-node losses + reach the top-k
  // chunks even when same-node chunks cluster near the top.
  const candidateK = Math.max(k, k * (opts.candidateFactor ?? 10));
  const rows = await db.$queryRaw<
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
    JOIN nodes n ON n.id = ne.node_id AND n.deleted_at IS NULL
    WHERE ne.memory_id IN (${Prisma.join(opts.memoryIds)}) AND ne.kind = 'chunk'
    ORDER BY ne.embedding <=> ${qvec}::vector
    LIMIT ${candidateK}
  `;
  return rows.slice(0, k).map((r) => ({
    nodeId: r.node_id,
    chunkIndex: Number(r.chunk_index),
    charStart: Number(r.char_start),
    charEnd: Number(r.char_end),
    chunkText: r.chunk_text,
    score: 1 - Number(r.distance),
  }));
}
