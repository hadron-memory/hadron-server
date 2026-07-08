-- Spawn / fan-out (plan-spawn, D-2026-05-09-018/-019).
-- spawn: parent-side fan-out config + exactly-once callback claim state
--   {processItem, callback?, itemCallback?, itemKey, total, dispatching?, callbackFiredAt?}
-- SPAWN trigger kind: children + callback runs are first-class in audit.
-- parent_run_id index: completion checks + child listings.

ALTER TABLE "app_runs" ADD COLUMN "spawn" JSONB;
ALTER TYPE "AppRunTriggerKind" ADD VALUE IF NOT EXISTS 'SPAWN';
CREATE INDEX "app_runs_parent_run_id_idx" ON "app_runs"("parent_run_id");
