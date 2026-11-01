-- #887: operational passage state; no backfill, existing rows remain NULL.
ALTER TABLE "nodes" ADD COLUMN "embedding_truncated_chunks" INTEGER;
