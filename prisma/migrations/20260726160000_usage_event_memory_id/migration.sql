-- #796 — attribute usage events to a memory DIRECTLY, so the attribution
-- survives node deletion.
--
-- Memory-scoped analytics previously reached the memory by joining through the
-- `node` relation, and `usage_events.node_id` is SET NULL on node deletion — so
-- a memory silently lost every event whose node had been deleted. The new
-- column is stored at write time like `node_loc`, with no FK (a SET NULL FK
-- would reintroduce the same loss on memory deletion).

-- AlterTable (nullable — the additive column applies cleanly to a populated
-- table, and pre-existing rows whose node is already gone stay NULL).
ALTER TABLE "usage_events" ADD COLUMN "memory_id" TEXT;

-- Backfill from the still-resolvable node relation. Best effort by definition:
-- rows whose node was deleted BEFORE this migration have node_id NULL and are
-- unrecoverable — there is nothing left to attribute them from.
UPDATE "usage_events" e
SET "memory_id" = n."memory_id"
FROM "nodes" n
WHERE e."node_id" = n."id" AND e."memory_id" IS NULL;

-- CreateIndex — the two `usageActivity` scopes (memory-wide and own-activity),
-- composite on created_at so a bucketed window is an index range scan.
CREATE INDEX "usage_events_memory_id_created_at_idx" ON "usage_events"("memory_id", "created_at");
CREATE INDEX "usage_events_user_id_created_at_idx" ON "usage_events"("user_id", "created_at");

-- DropIndex — (user_id, created_at) prefix-covers every lookup the bare
-- (user_id) index served, so keeping both only costs write throughput.
DROP INDEX IF EXISTS "usage_events_user_id_idx";
