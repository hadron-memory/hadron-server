-- #2438: key stored automations by entry node id. The literal URN column
-- stays (display/audit address + the legacy resolution path for rows never
-- re-adopted); the id column is what launches resolve by once the trigger
-- is (re-)adopted under the id-keyed pin format. Nullable on purpose: rows
-- minted before this deploy keep verifying under their stored pin's URN
-- identity, and adoption/launch stamps the id going forward.
ALTER TABLE "app_runs" ADD COLUMN "entry_node_id" TEXT;
ALTER TABLE "agent_schedules" ADD COLUMN "entry_node_id" TEXT;
ALTER TABLE "agent_webhooks" ADD COLUMN "entry_node_id" TEXT;
