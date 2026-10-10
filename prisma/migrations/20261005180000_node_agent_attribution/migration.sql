-- #1610: record the Worker / Agent behind node writes, beside the user.
-- Nullable, no FK, no backfill: historical rows stay unattributed.
ALTER TABLE "nodes"
  ADD COLUMN "created_by_worker_id" TEXT,
  ADD COLUMN "created_by_agent_id" TEXT,
  ADD COLUMN "updated_by_worker_id" TEXT,
  ADD COLUMN "updated_by_agent_id" TEXT;

ALTER TABLE "node_revisions"
  ADD COLUMN "edited_by_worker_id" TEXT,
  ADD COLUMN "edited_by_agent_id" TEXT;
