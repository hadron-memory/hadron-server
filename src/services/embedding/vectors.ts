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

/** Replace a node's abstract vector (delete existing kind='abstract', insert one). */
export async function upsertAbstractVector(
  db: PrismaClient,
  row: AbstractVectorRow,
): Promise<void> {
  await db.$executeRaw`DELETE FROM node_embeddings WHERE node_id = ${row.nodeId} AND kind = 'abstract'`;
  await db.$executeRaw`
    INSERT INTO node_embeddings (id, node_id, memory_id, kind, provider, model, dim, embedding, created_at)
    VALUES (${generateId()}, ${row.nodeId}, ${row.memoryId}, 'abstract', ${row.provider}, ${row.model}, ${row.dim}, ${toVectorLiteral(row.embedding)}::vector, now())
  `;
}

/** Delete all of a node's vectors (re-index / disable / cleared abstract). */
export async function deleteNodeVectors(db: PrismaClient, nodeId: string): Promise<void> {
  await db.$executeRaw`DELETE FROM node_embeddings WHERE node_id = ${nodeId}`;
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
