-- 033-rag-vector-retrieval — vector/semantic retrieval over Hadron memory.
--
-- Intent (per constitution II — record migration intent here):
--   * Enable pgvector and add the vector index surface: a `node_embeddings`
--     table (one abstract row + N chunk rows per node), durable embedding
--     markers on `nodes`, and per-memory vector-index config on `memories`.
--   * The HNSW index, the abstract partial-unique index, the partial marker
--     indexes, and the CHECK constraints are NOT expressible in the Prisma
--     schema, so they are authored here (and mirrored in prisma/post-push.sql
--     + src/test/globalSetup.ts for the db-push'd dev/test DBs).
--
-- pgvector must be installed in the Postgres server before this runs
-- (prod: via hadron-cloud / baragaun-cloud compose; dev/test: package/image).

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS vector;

-- CreateEnum
CREATE TYPE "EmbeddingSource" AS ENUM ('abstract', 'content_chunks', 'both');

-- CreateEnum
CREATE TYPE "EmbeddingKind" AS ENUM ('abstract', 'chunk');

-- AlterTable (per-memory vector-index config)
ALTER TABLE "memories"
  ADD COLUMN "vector_index_enabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "embedding_source" "EmbeddingSource" NOT NULL DEFAULT 'abstract',
  ADD COLUMN "chunk_tokens" INTEGER,
  ADD COLUMN "chunk_overlap" INTEGER,
  ADD COLUMN "force_fixed_size" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "vector_index_encrypted_ack_at" TIMESTAMP(3);

-- AlterTable (durable embedding-queue markers)
ALTER TABLE "nodes"
  ADD COLUMN "embedding_pending_at" TIMESTAMP(3),
  ADD COLUMN "embedding_failed_at" TIMESTAMP(3),
  ADD COLUMN "embedding_attempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "embedding_error" TEXT;

-- CreateTable
CREATE TABLE "node_embeddings" (
    "id" TEXT NOT NULL,
    "node_id" TEXT NOT NULL,
    "memory_id" TEXT NOT NULL,
    "kind" "EmbeddingKind" NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "dim" INTEGER NOT NULL,
    "chunk_index" INTEGER,
    "char_start" INTEGER,
    "char_end" INTEGER,
    "chunk_text" TEXT,
    -- Nullable to match the Prisma schema (a required Unsupported field breaks
    -- the $allModels client extension). Rows are only ever inserted via raw SQL,
    -- which always supplies the vector.
    "embedding" vector(768),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "node_embeddings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "node_embeddings_node_id_kind_chunk_index_key" ON "node_embeddings"("node_id", "kind", "chunk_index");

-- CreateIndex
CREATE INDEX "node_embeddings_node_id_idx" ON "node_embeddings"("node_id");

-- CreateIndex
CREATE INDEX "node_embeddings_memory_id_idx" ON "node_embeddings"("memory_id");

-- AddForeignKey
ALTER TABLE "node_embeddings" ADD CONSTRAINT "node_embeddings_node_id_fkey" FOREIGN KEY ("node_id") REFERENCES "nodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "node_embeddings" ADD CONSTRAINT "node_embeddings_memory_id_fkey" FOREIGN KEY ("memory_id") REFERENCES "memories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─── Raw SQL Prisma can't express (mirrored in post-push.sql + globalSetup.ts) ───

-- HNSW index for cosine similarity (build params pinned to pgvector defaults).
CREATE INDEX IF NOT EXISTS "node_embeddings_embedding_hnsw"
  ON "node_embeddings" USING hnsw ("embedding" vector_cosine_ops) WITH (m = 16, ef_construction = 64);

-- One abstract vector per node. The composite unique index above can't enforce
-- this (NULL chunk_index ⇒ NULLs distinct in Postgres), so a partial unique does.
CREATE UNIQUE INDEX IF NOT EXISTS "node_embeddings_abstract_uniq"
  ON "node_embeddings" ("node_id") WHERE "kind" = 'abstract';

-- Partial indexes keep the worker's "find work" sweep cheap (scans only marked rows).
CREATE INDEX IF NOT EXISTS "nodes_embedding_pending_idx"
  ON "nodes" ("embedding_pending_at") WHERE "embedding_pending_at" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "nodes_embedding_failed_idx"
  ON "nodes" ("embedding_failed_at") WHERE "embedding_failed_at" IS NOT NULL;

-- CHECK constraints (structural backstops; constitution S5).
-- FR-026: an encrypted memory cannot have the index enabled without a recorded
-- disclosure acknowledgment.
ALTER TABLE "memories" DROP CONSTRAINT IF EXISTS "chk_memory_vector_encrypted_ack";
ALTER TABLE "memories" ADD CONSTRAINT "chk_memory_vector_encrypted_ack"
  CHECK (NOT ("is_encrypted" AND "vector_index_enabled") OR "vector_index_encrypted_ack_at" IS NOT NULL);

-- FR-003 sanity: positive window, valid overlap.
ALTER TABLE "memories" DROP CONSTRAINT IF EXISTS "chk_memory_chunk_tokens_positive";
ALTER TABLE "memories" ADD CONSTRAINT "chk_memory_chunk_tokens_positive"
  CHECK ("chunk_tokens" IS NULL OR "chunk_tokens" > 0);

ALTER TABLE "memories" DROP CONSTRAINT IF EXISTS "chk_memory_chunk_overlap_valid";
ALTER TABLE "memories" ADD CONSTRAINT "chk_memory_chunk_overlap_valid"
  CHECK ("chunk_overlap" IS NULL OR ("chunk_overlap" >= 0 AND ("chunk_tokens" IS NULL OR "chunk_overlap" < "chunk_tokens")));
