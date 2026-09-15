-- Spec 049 Phase 3b (D-2026-09-13-004) — a headless run's scope.
--
-- A trigger (schedule, webhook) MAY name a scope; it is SNAPSHOTTED onto the run
-- at mint as the scope's ordered memory-id list, for the same reason `policy` is
-- snapshotted: a run must not change meaning because someone edited a scope
-- mid-flight. A spawned child inherits its parent's snapshot. NULL ⇒ `app`, the
-- App's attached memories (no "default named scope for headless runs").
--
-- SCOPE DATA ONLY: the snapshot is never an access grant. Every consumer
-- re-intersects it with the run principal's CURRENT access
-- (`resolveRunScope`, src/lib/scopes.ts), so a membership revoked after mint
-- takes its memories out of the run's view on the next hop.
--
-- The trigger FKs are ON DELETE SET NULL (a deleted scope leaves the trigger
-- on `app`); the snapshot is a JSON copy and references nothing.

ALTER TABLE "agent_schedules" ADD COLUMN IF NOT EXISTS "scope_id" TEXT;
CREATE INDEX IF NOT EXISTS "agent_schedules_scope_id_idx" ON "agent_schedules" ("scope_id");
ALTER TABLE "agent_schedules"
    ADD CONSTRAINT "agent_schedules_scope_id_fkey"
    FOREIGN KEY ("scope_id") REFERENCES "scopes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "agent_webhooks" ADD COLUMN IF NOT EXISTS "scope_id" TEXT;
CREATE INDEX IF NOT EXISTS "agent_webhooks_scope_id_idx" ON "agent_webhooks" ("scope_id");
ALTER TABLE "agent_webhooks"
    ADD CONSTRAINT "agent_webhooks_scope_id_fkey"
    FOREIGN KEY ("scope_id") REFERENCES "scopes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "app_runs" ADD COLUMN IF NOT EXISTS "scope_snapshot" JSONB;
