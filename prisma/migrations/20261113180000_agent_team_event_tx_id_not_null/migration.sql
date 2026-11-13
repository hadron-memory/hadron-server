-- #4111 — agent_team_events.tx_id becomes NOT NULL (contract section A, "NULL prevention"). A NULL key on a cursor row
-- makes the changed-since read's `(tx_id, created_at, id) > cursor` comparison NULL, so every later page is empty.
--
-- Expand/contract inside ONE transaction:
--   1. backfill NULL -> '0' (a legacy key: '0' sorts first by created_at then id, exactly as the #4084 rows do);
--   2. CHECK (tx_id IS NOT NULL) NOT VALID, then VALIDATE (proves the backfill left no NULL);
--   3. SET NOT NULL (Postgres uses the validated check, so no second scan), then drop the check.
-- The DEFAULT pg_current_xact_id() is kept: a producer that omits tx_id (every one does, including the image before
-- this one) still gets a key, so this is compatible with the previous server image.
--
-- The append-only trigger refuses any change outside the acknowledgement columns, tx_id included. It is disabled for
-- the backfill only, inside this transaction: DISABLE TRIGGER holds SHARE ROW EXCLUSIVE until COMMIT, so no other
-- writer can run while it is off, and a failure rolls the disable back with everything else.
BEGIN;

ALTER TABLE "agent_team_events" DISABLE TRIGGER "agent_team_event_append_only";
UPDATE "agent_team_events" SET "tx_id" = '0'::xid8 WHERE "tx_id" IS NULL;
ALTER TABLE "agent_team_events" ENABLE TRIGGER "agent_team_event_append_only";

ALTER TABLE "agent_team_events" ADD CONSTRAINT "agent_team_events_tx_id_not_null" CHECK ("tx_id" IS NOT NULL) NOT VALID;
ALTER TABLE "agent_team_events" VALIDATE CONSTRAINT "agent_team_events_tx_id_not_null";
ALTER TABLE "agent_team_events" ALTER COLUMN "tx_id" SET NOT NULL;
ALTER TABLE "agent_team_events" DROP CONSTRAINT "agent_team_events_tx_id_not_null";

COMMIT;
