-- #621 — Memory.maxRevCount: per-node cap on retained NodeRevision rows.
-- On each new revision the oldest overflow is pruned (see createNodeRevision in
-- src/lib/nodeRevisionSnapshot.ts). Default 10; must be >= 1.

ALTER TABLE "memories" ADD COLUMN "max_rev_count" INTEGER NOT NULL DEFAULT 10;

-- Backstop for the API-level validation (mirrors chk_memory_chunk_tokens_positive).
ALTER TABLE "memories" DROP CONSTRAINT IF EXISTS "chk_memory_max_rev_count_positive";
ALTER TABLE "memories"
  ADD CONSTRAINT "chk_memory_max_rev_count_positive"
  CHECK ("max_rev_count" >= 1);
