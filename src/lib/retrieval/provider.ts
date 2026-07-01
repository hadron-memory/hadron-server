/**
 * Node retrieval seam (D14 / cor:rag:010:02). Callers (the findNodes resolver,
 * the MCP find-nodes tool) depend on this interface, not on Postgres directly,
 * so the engine can be swapped for another database later. The interface is the
 * portability guarantee — NOT feature parity: the Postgres impl leans on native
 * FTS (ts_rank_cd) and pgvector, which another backend would reimplement,
 * possibly at lower fidelity.
 */
import type { PrismaClient } from '../../generated/prisma/index.js';
import type { VectorHit, ChunkHit } from '../../services/embedding/vectors.js';

export type { VectorHit, ChunkHit };

/** Node fields carried in the weighted tsvector (lexical search). Ordered by weight class. */
export type LexicalField =
  | 'name' | 'alias'            // class A
  | 'loc' | 'tags'             // class B
  | 'description' | 'abstract' // class C
  | 'content' | 'properties' | 'data'; // class D

export interface LexicalHit {
  nodeId: string;
  score: number;
}

export interface LexicalSearchOpts {
  db: PrismaClient;
  /** Boolean surface grammar (see tsquery.ts). */
  query: string;
  memoryIds: string[];
  /** Weight-mask: only these fields' weight classes contribute to the score. Omit = all. */
  fields?: LexicalField[];
  /** Include soft-deleted nodes in candidates (default false). */
  includeDeleted?: boolean;
  limit: number;
}

export interface RegexSearchOpts {
  db: PrismaClient;
  /** POSIX regex (case-insensitive `~*`). */
  pattern: string;
  memoryIds: string[];
  fields?: LexicalField[];
  /** Include soft-deleted nodes in candidates (default false). */
  includeDeleted?: boolean;
  limit: number;
}

export interface VectorSearchOpts {
  db: PrismaClient;
  queryEmbedding: number[];
  memoryIds: string[];
  limit: number;
}

export interface NodeRetrievalProvider {
  lexicalSearch(opts: LexicalSearchOpts): Promise<LexicalHit[]>;
  regexSearch(opts: RegexSearchOpts): Promise<LexicalHit[]>;
  vectorSearch(opts: VectorSearchOpts): Promise<VectorHit[]>;
  vectorSearchChunks(opts: VectorSearchOpts): Promise<ChunkHit[]>;
}
