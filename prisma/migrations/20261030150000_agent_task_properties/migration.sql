-- #2420 (cor:agt:050:28): an agent task's own optional `properties` JSON object. Nullable and additive: existing
-- rows read null, no backfill. "A JSON object within 16 KiB, valid against the team's schema" is the application's
-- check (src/lib/agentTasks/properties.ts), made on every write path.
ALTER TABLE "agent_tasks" ADD COLUMN IF NOT EXISTS "properties" JSONB;
