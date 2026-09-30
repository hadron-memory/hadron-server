-- #1483: keep authored edge metadata while Git sync waits for a target.
-- Existing unresolved rows default to NULL, matching their old representation.
ALTER TABLE "pending_edges"
  ADD COLUMN "description" TEXT,
  ADD COLUMN "data" JSONB;
