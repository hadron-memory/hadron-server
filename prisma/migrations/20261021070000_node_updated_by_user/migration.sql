-- #2176: the User behind a node's last authored edit, beside updated_by_worker_id / updated_by_agent_id (#1610).
-- Nullable, no FK, no backfill: nodes edited before this stay unattributed (null = unknown).
ALTER TABLE "nodes" ADD COLUMN "updated_by_user_id" TEXT;
